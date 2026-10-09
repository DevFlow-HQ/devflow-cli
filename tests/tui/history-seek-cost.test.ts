import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import type {
  HistoryContentRead,
  HistoryTextReference,
} from "../../src/application/projection-port.js";
import { historyTextEdges } from "../../src/tui/tui.js";
import { structuredDiff } from "../application/history-content-fixture.js";
import { openLiveRun, type LiveRun } from "../helpers/liveRun.js";
import { turnFact, type TurnFactData } from "../helpers/turnFact.js";

const MB = 1_000_000;
// The Application's private text page size (as in history-bounded-cost), checkpoint
// spacing and per-traversal checkpoint cap, mirrored here.
const TEXT_SIZE = 4095;
const CHECKPOINT_PAGES = 8;
const CHECKPOINT_LIMIT = 128;

type TextRead = Extract<HistoryContentRead, { type: "history-text" }>;

/** Counts what each read feeds the presentation analyser and walks of the body's parts. */
async function countedRun(t: TestContext) {
  const counts = { fed: 0, parts: 0, checkpoints: 0 };
  const counted: typeof historyTextEdges = (source, start, end, resume) =>
    historyTextEdges(
      (function* () {
        for (const portion of source) {
          counts.fed += portion.length;
          yield portion;
        }
      })(),
      start,
      end,
      resume,
    );
  const run = await openLiveRun(t, {
    historyTextEdges: counted,
    observeHistoryContentWalk: ({ parts, checkpoints }) => {
      counts.parts += parts;
      counts.checkpoints = checkpoints;
    },
  });
  t.after(run.finish);
  return { run, counts };
}

async function openHistory(t: TestContext, run: LiveRun) {
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  t.after(page.close);
  return page.updates[Symbol.asyncIterator]();
}

let turns = 0;
/** Appends one fact in its own Turn and returns the full-text reference of the
 * row it projects, from the next published page. */
async function append(
  run: LiveRun,
  updates: Awaited<ReturnType<typeof openHistory>>,
  fact: ReturnType<typeof turnFact>,
): Promise<HistoryTextReference> {
  const turnId = `turn-${turns++}`;
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
  assert.ok(run.owner.appendTurnEvent({ turnId, fact, at: new Date() }).ok);
  for (;;) {
    const update = await updates.next();
    assert.ok(update.value?.kind === "durable");
    const snapshot = update.value.snapshot;
    assert.ok(snapshot.result.found);
    const value = snapshot.result.history.rows.at(-1)!.value;
    if (value.kind === "turn-diff" && value.detail !== undefined)
      return value.detail;
    if (value.kind === "message" && value.reference !== undefined)
      return value.reference;
  }
}
const diffFact = (diff: TurnFactData<"turn-diff">) =>
  turnFact("turn-diff", diff);
const messageFact = (content: string) =>
  turnFact("assistant-content", { messageId: `m-${turns}`, content });

async function readText(
  run: LiveRun,
  reference: HistoryTextReference,
  continuation?: string,
  signal?: AbortSignal,
): Promise<TextRead> {
  const read = await run.port.readHistoryContent({
    reference,
    continuation,
    signal,
  });
  assert.ok(read.found && read.type === "history-text", JSON.stringify(read));
  return read;
}

test("m10-followup-history-seek-cost: End then Page Up walks about one page per read plus at most one checkpoint interval", async (t) => {
  const { run, counts } = await countedRun(t);
  const updates = await openHistory(t, run);
  const costs = new Map<number, { previous: number; interval: number }>();
  for (const bytes of [MB, 5 * MB]) {
    const reference = await append(
      run,
      updates,
      diffFact(structuredDiff(bytes)),
    );
    const measured = async (continuation?: string) => {
      counts.fed = counts.parts = 0;
      const read = await readText(run, reference, continuation);
      return { read, fed: counts.fed, parts: counts.parts };
    };
    const first = await measured();
    // The first `last` of a traversal walks the body once, leaving capped checkpoints.
    const last = await measured(first.read.last);
    assert.ok(last.fed >= bytes, JSON.stringify({ bytes, fed: last.fed }));
    const pages = Math.ceil(last.fed / TEXT_SIZE);
    const interval = Math.max(
      CHECKPOINT_PAGES,
      Math.ceil(pages / CHECKPOINT_LIMIT),
    );
    assert.ok(counts.checkpoints > 0);
    assert.ok(counts.checkpoints <= CHECKPOINT_LIMIT, `${counts.checkpoints}`);
    // About one diff line of 60 units plus its newline part per 30 units, and hunk headers.
    const partsPerPage = Math.ceil((TEXT_SIZE * 2.2) / 60);
    let cursor = last.read.previous;
    let current = last.read;
    let worst = 0;
    // Page Up across several checkpoint intervals.
    for (let i = 0; i < 3 * interval; i++) {
      const page = await measured(cursor);
      worst = Math.max(worst, page.fed);
      assert.ok(
        page.fed <= (interval + 1) * TEXT_SIZE + 3 * 128,
        JSON.stringify({ bytes, i, interval, fed: page.fed }),
      );
      assert.ok(
        page.parts <= 3 * (interval + 1) * partsPerPage,
        JSON.stringify({ bytes, i, interval, parts: page.parts }),
      );
      current = page.read;
      cursor = page.read.previous;
    }
    costs.set(bytes, { previous: worst, interval });
    // Home costs one page.
    const home = await measured(current.first);
    assert.ok(home.fed <= 2 * TEXT_SIZE, JSON.stringify(home.fed));
    run.port.releaseHistoryRead(home.read.readId);
    // Reading forward keeps checkpoints too, so Page Up after it never walks the
    // body again: at most one spacing, plus the page that started its spacing.
    let forward = await measured();
    for (let i = 0; i < 3 * interval; i++)
      forward = await measured(forward.read.next);
    for (let i = 0; i < 2 * interval; i++) {
      forward = await measured(forward.read.previous);
      assert.ok(
        forward.fed <= (interval + 2) * TEXT_SIZE + 3 * 128,
        JSON.stringify({ bytes, i, interval, fed: forward.fed }),
      );
    }
    run.port.releaseHistoryRead(forward.read.readId);
  }
  // Below the cap the interval is fixed, so a Page Up costs the same however large the body.
  const small = costs.get(MB)!;
  assert.equal(small.interval, CHECKPOINT_PAGES);
  // Above it, the interval widens so the cap holds.
  assert.ok(costs.get(5 * MB)!.interval > CHECKPOINT_PAGES);
});

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// CR/LF pairs split by ANSI, surrogate pairs, removable controls and a malformed CSI.
const TRICKY = [
  "\r\x1b[31m\n",
  "😀😀",
  "\r\n",
  "\x1b]0;title\x07",
  "\r\x9b31m\n",
  "\x1b[1;x",
  "\r",
  "z😀",
];

/** A message whose tricky sequences straddle every grid line, with an OSC
 * longer than a page across the second checkpoint. */
function trickyMessage(): string {
  let body = "";
  for (let line = 1; line <= 5 * CHECKPOINT_PAGES; line++) {
    const grid = line * TEXT_SIZE;
    const sequence = TRICKY[line % TRICKY.length]!;
    if (line === 2 * CHECKPOINT_PAGES) {
      body += "o".repeat(grid - 3000 - body.length) + "\r\x1b]8;;";
      body += "u".repeat(6000) + "\x07\nLINK";
      continue;
    }
    body += "x".repeat(Math.max(0, grid - 1 - (line % 3) - body.length));
    body += sequence;
  }
  return body + "END";
}

/** A structured diff whose many short lines carry the same sequences. */
function trickyDiff(): TurnFactData<"turn-diff"> {
  const next = random(520);
  const lines = Array.from({ length: 6000 }, (_, i) => {
    let line = `${i}:`;
    while (line.length < 40)
      line +=
        next() < 0.3
          ? TRICKY[Math.floor(next() * TRICKY.length)]!
          : "abcdefgh".slice(0, 1 + Math.floor(next() * 8));
    return line;
  });
  const hunks = [];
  for (let at = 0; at < lines.length; at += 50)
    hunks.push({
      oldStart: at + 1,
      oldLines: 0,
      newStart: at + 1,
      newLines: 50,
      lines: lines.slice(at, at + 50),
    });
  return {
    content: "Turn diff\r",
    files: [
      {
        path: "src/tricky.ts",
        kind: "update",
        patch: { kind: "structured", hunks },
      },
    ],
  };
}

/** Every page reached by seeks equals the same page of a fresh sequential read,
 * whose edges equal fresh analysis of the whole body. */
async function assertSeeksReadFresh(
  run: LiveRun,
  reference: HistoryTextReference,
  seed: number,
  analysed = true,
): Promise<void> {
  const pages: { content: string; edges: unknown }[] = [];
  let continuation: string | undefined;
  let fresh: TextRead;
  do {
    fresh = await readText(run, reference, continuation);
    pages.push({ content: fresh.content, edges: fresh.edges });
    continuation = fresh.next;
  } while (continuation);
  run.port.releaseHistoryRead(fresh.readId);
  const raw = pages.map((page) => page.content).join("");
  assert.ok(pages.length > 4 * CHECKPOINT_PAGES, `${pages.length}`);
  let begin = 0;
  for (const page of pages) {
    const end = begin + page.content.length;
    const whole = analysed
      ? historyTextEdges(
          (function* () {
            for (let at = 0; at < raw.length; at += TEXT_SIZE)
              yield raw.slice(at, at + TEXT_SIZE);
          })(),
          begin,
          end,
        ).edges
      : undefined;
    assert.deepEqual(page.edges, whole, `page at ${begin}`);
    begin = end;
  }
  let read = await readText(run, reference);
  let index = 0;
  const check = (move: string) =>
    assert.deepEqual(
      { content: read.content, edges: read.edges },
      pages[index],
      `${move} to page ${index}`,
    );
  async function move(direction: "first" | "last" | "previous" | "next") {
    read = await readText(run, reference, read[direction]);
    index =
      direction === "first"
        ? 0
        : direction === "last"
          ? pages.length - 1
          : index + (direction === "next" ? 1 : -1);
    check(direction);
  }
  // End, then Page Up to the start, then a random mix of seeks and steps.
  await move("last");
  while (read.previous !== undefined) await move("previous");
  const next = random(seed);
  for (let i = 0; i < 200; i++) {
    const choices = (["first", "last", "previous", "next"] as const).filter(
      (direction) => read[direction] !== undefined,
    );
    await move(choices[Math.floor(next() * choices.length)]!);
  }
  run.port.releaseHistoryRead(read.readId);
}

test("m10-followup-history-seek-cost: seeks resumed from checkpoints read exactly as fresh whole-body reads", async (t) => {
  const run = await openLiveRun(t, { historyTextEdges });
  t.after(run.finish);
  const updates = await openHistory(t, run);
  const diff = await append(run, updates, diffFact(trickyDiff()));
  await assertSeeksReadFresh(run, diff, 1);
  const message = await append(run, updates, messageFact(trickyMessage()));
  await assertSeeksReadFresh(run, message, 2);
});

test("m10-followup-history-seek-cost: without an edge analyser, seeks read the same content", async (t) => {
  const run = await openLiveRun(t);
  t.after(run.finish);
  const updates = await openHistory(t, run);
  const diff = await append(run, updates, diffFact(trickyDiff()));
  await assertSeeksReadFresh(run, diff, 3, false);
});

test("m10-followup-history-seek-cost: an unterminated OSC costs the first End one walk of the body", async (t) => {
  const { run, counts } = await countedRun(t);
  const updates = await openHistory(t, run);
  // An OSC opened near the start never ends, so a portion's analysis scans on to the body's end.
  const body = "\x1b]8;;" + "u".repeat(40 * CHECKPOINT_PAGES * TEXT_SIZE);
  const reference = await append(run, updates, messageFact(body));
  const first = await readText(run, reference);
  counts.fed = 0;
  const last = await readText(run, reference, first.last);
  assert.ok(counts.checkpoints >= 39);
  // Checkpoint steps stop at their marks; only the final page scans to the end.
  assert.ok(counts.fed <= 2 * body.length, `${counts.fed}`);
  run.port.releaseHistoryRead(last.readId);
});

test("m10-followup-history-seek-cost: release, abort, observer close and shutdown each drop a traversal's checkpoints", async (t) => {
  const { run, counts } = await countedRun(t);
  // A second observer keeps the Run's history while the delivering one closes.
  await openHistory(t, run);
  const page = run.port.openProjection({
    family: "session-history",
    runId: run.runId,
    session: "s",
  });
  const reference = await append(
    run,
    page.updates[Symbol.asyncIterator](),
    diffFact(structuredDiff(MB)),
  );
  /** A new traversal's End, then a Page Up that resumes from its checkpoints. */
  const traverse = async (signal?: AbortSignal) => {
    const first = await readText(run, reference, undefined, signal);
    counts.fed = counts.parts = 0;
    const last = await readText(run, reference, first.last);
    const end = { fed: counts.fed, parts: counts.parts };
    const near = await readText(run, reference, last.previous);
    return { end, near };
  };
  /** The dropped traversal is gone, and a new one's End walks from the start again. */
  const assertDropped = async (dropped: TextRead, fromStart: unknown) => {
    const stale = await run.port.readHistoryContent({
      reference,
      continuation: dropped.previous,
    });
    assert.ok(!stale.found);
    assert.equal(stale.problem.code, "history-continuation-mismatch");
    const next = await traverse();
    assert.deepEqual(next.end, fromStart);
    return next;
  };
  const released = await traverse();
  const fromStart = released.end;
  assert.ok(counts.checkpoints > 0);
  assert.ok(fromStart.fed >= MB);
  run.port.releaseHistoryRead(released.near.readId);
  await assertDropped(released.near, fromStart);
  const abort = new AbortController();
  const aborted = await traverse(abort.signal);
  abort.abort();
  const open = await assertDropped(aborted.near, fromStart);
  page.close();
  const closed = await assertDropped(open.near, fromStart);
  await run.finish();
  await run.shutdown();
  const stale = await run.port.readHistoryContent({
    reference,
    continuation: closed.near.previous,
  });
  assert.ok(!stale.found);
});
