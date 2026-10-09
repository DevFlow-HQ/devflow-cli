import assert from "node:assert/strict";
import test from "node:test";
import { historyTextEdges, screenHistoryPortion } from "../../src/tui/tui.js";
import { readHistoryText } from "../application/history-content-fixture.js";
import { openLiveRun } from "../helpers/liveRun.js";
import { turnFact, type TurnFactData } from "../helpers/turnFact.js";

const MB = 1_000_000;
// The Application's private text page size, mirrored once here.
const TEXT_SIZE = 4095;

/** A structured Turn diff whose detail text is about `bytes` long. */
function structuredDiff(bytes: number): TurnFactData<"turn-diff"> {
  const line = "+" + "const value = compute(input, options);".padEnd(59, " ");
  const lines = Math.ceil(bytes / (line.length + 1));
  const hunks = [];
  for (let at = 0; at < lines; at += 8)
    hunks.push({
      oldStart: at + 1,
      oldLines: 0,
      newStart: at + 1,
      newLines: 8,
      lines: Array.from(
        { length: Math.min(8, lines - at) },
        (_, i) => `${line}${at + i}`,
      ),
    });
  return {
    content: "Turn diff",
    files: [
      {
        path: "src/large.ts",
        kind: "update",
        patch: { kind: "structured", hunks },
      },
    ],
  };
}

test("m10-followup-bounded-history-cost: a structured Turn diff reads page by page in linear time with presentation edges", async (t) => {
  // Count the body units Application feeds the presentation analyser, and its passes.
  let fed = 0,
    passes = 0;
  const counted: typeof historyTextEdges = (source, start, end, resume) => {
    passes++;
    return historyTextEdges(
      (function* () {
        for (const portion of source) {
          fed += portion.length;
          yield portion;
        }
      })(),
      start,
      end,
      resume,
    );
  };
  const run = await openLiveRun(t, { historyTextEdges: counted });
  t.after(run.finish);
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  const updates = page.updates[Symbol.asyncIterator]();
  async function read(bytes: number) {
    const turnId = `turn-${bytes}`;
    assert.ok(
      run.owner.admitTurn({
        turnId,
        attemptId: "0.0:echo",
        session: "s",
        origin: "human",
        kind: "interactive-agent",
        input: "Input",
        recoveryCoordinate: "private",
        harness: "codex",
        at: new Date(),
      }).ok,
    );
    assert.ok(
      run.owner.appendTurnEvent({
        turnId,
        fact: turnFact("turn-diff", structuredDiff(bytes)),
        at: new Date(),
      }).ok,
    );
    let detail;
    while (detail === undefined) {
      const update = await updates.next();
      assert.ok(update.value?.kind === "durable");
      const snapshot = update.value.snapshot;
      assert.ok(snapshot.result.found);
      const value = snapshot.result.history.rows.at(-1)!.value;
      if (value.kind === "turn-diff" && value.detail !== undefined)
        detail = value.detail;
    }
    fed = passes = 0;
    const text = await readHistoryText(run.port, detail);
    assert.ok(text.length >= bytes);
    return { length: text.length, fed, passes };
  }
  const small = await read(MB);
  const large = await read(3 * MB);
  for (const body of [small, large]) {
    // One analyser pass per page, each resuming where the previous page ended:
    // the body is fed once, plus at most one partly read diff line per page.
    assert.equal(body.passes, Math.ceil(body.length / TEXT_SIZE));
    assert.ok(body.fed >= body.length);
    assert.ok(
      body.fed - body.length <= body.passes * 128,
      JSON.stringify(body),
    );
  }
  // Tripling the body triples the work; the old whole-body walk per page grew about ninefold.
  assert.ok(large.fed <= 3.1 * small.fed, JSON.stringify({ small, large }));
});

test("m10-followup-bounded-history-cost: resumed Port reads screen each page as whole-body screening does", async (t) => {
  const run = await openLiveRun(t, { historyTextEdges });
  t.after(run.finish);
  assert.ok(
    run.owner.admitTurn({
      turnId: "turn",
      attemptId: "0.0:echo",
      session: "s",
      origin: "human",
      kind: "interactive-agent",
      input: "Input",
      recoveryCoordinate: "private",
      harness: "codex",
      at: new Date(),
    }).ok,
  );
  // CRLF split by a CSI across the first grid line, then an OSC longer than two pages.
  const body =
    "x".repeat(4092) +
    "\r\x1b[31m\nMARK" +
    "y".repeat(4080) +
    "\r\x1b]8;;" +
    "u".repeat(9000) +
    "\x07\nLINK" +
    "z😀".repeat(3000) +
    "\x1b[1;x\nEND";
  assert.ok(
    run.owner.appendTurnEvent({
      turnId: "turn",
      fact: turnFact("assistant-content", { messageId: "m", content: body }),
      at: new Date(),
    }).ok,
  );
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  assert.ok(page.snapshot.result.found);
  const value = page.snapshot.result.history.rows.at(-1)!.value;
  assert.ok(value.kind === "message" && value.reference);
  let continuation: string | undefined,
    raw = "",
    screened = "",
    pages = 0;
  let readId: string;
  do {
    const read = await run.port.readHistoryContent({
      reference: value.reference,
      continuation,
    });
    assert.ok(read.found && read.type === "history-text");
    raw += read.content;
    screened += screenHistoryPortion(read).text;
    continuation = read.next;
    readId = read.readId;
    pages++;
  } while (continuation);
  run.port.releaseHistoryRead(readId);
  assert.ok(pages > 4);
  assert.equal(raw, body);
  // A whole body read as one portion has no edges: whole-body screening.
  const whole = screenHistoryPortion({
    found: true,
    type: "history-text",
    content: body,
    readId,
  }).text;
  assert.equal(screened, whole);
});
