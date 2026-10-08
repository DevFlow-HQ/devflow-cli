import type { SessionHistoryRow } from "../../src/application/projection-port.js";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createFake, fakeHarnessProfile } from "../harness/fake-adapter.js";
import {
  COMPLETED_DETACHED,
  launchInteractive,
  sendLiveTurn,
  interruptTurn,
} from "./interactive-agent-fixture.js";
import type {
  HarnessAdapter,
  ControlReceipt,
  SteerInput,
} from "../../src/harness/harness.js";
import { createApplication } from "../helpers/application.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";
import { readRun } from "./run-test-helpers.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("m10-audit-steer-stored-when-sent: accepted Steer waits in history and delivery replaces its row in place", async (t) => {
  const boundary = deferred();
  const { wired, runId } = await launchInteractive(t, {
    profile: fakeHarnessProfile({
      steer: { available: true, evidence: "scripted" },
    }),
    turns: [
      {
        block: true,
        steerBoundary: boundary.promise,
        result: COMPLETED_DETACHED.result,
      },
    ],
  });
  try {
    const { steer } = await sendLiveTurn(wired, runId, "send");
    assert.ok(steer.available);
    const port = wired.projectionPort;
    const view = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => view.close());
    const reader = view.updates[Symbol.asyncIterator]();
    const submission = {
      operationId: "guidance",
      operation: "steer-turn",
      input: {
        runId,
        turnId: steer.turnId,
        text: "Keep this guidance verbatim\n",
      },
    } as const;
    assert.ok(port.submit(submission).admitted);
    assert.equal((await awaitSettled(port, "guidance")).status, "applied");
    const current = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => current.close());
    assert.ok(current.snapshot.result.found);
    assert.equal(
      current.snapshot.result.history.rows.at(-1)?.value.kind,
      "steer",
    );
    const waiting = await reader.next();
    assert.ok(waiting.value?.kind === "durable");
    assert.ok(waiting.value.snapshot.result.found);
    const row = waiting.value.snapshot.result.history.rows.at(-1)!;
    assert.deepEqual(row.value, {
      kind: "steer",
      content: "Keep this guidance verbatim\n",
      delivery: "waiting",
    });
    assert.equal(row.source, "stored");
    const transcript = port.readTranscript(
      waiting.value.snapshot.result.history.transcriptExport,
    );
    assert.ok(transcript.found);
    assert.ok(!transcript.entries.some((entry) => entry.kind === "steer"));
    assert.ok(port.submit(submission).admitted);
    assert.equal((await awaitSettled(port, "guidance")).status, "applied");
    boundary.resolve();
    const delivered = await reader.next();
    assert.ok(delivered.value?.kind === "durable");
    assert.ok(delivered.value.snapshot.result.found);
    const deliveredRows: readonly SessionHistoryRow[] =
      delivered.value.snapshot.result.history.rows;
    const rows = deliveredRows.filter((row) => row.value.kind === "steer");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, row.id);
    assert.equal(rows[0]?.position, row.position);
    assert.deepEqual(rows[0]?.value, {
      kind: "steer",
      content: "Keep this guidance verbatim\n",
      delivery: "after-boundary",
    });
    const complete = port.readTranscript(
      delivered.value.snapshot.result.history.transcriptExport,
    );
    assert.ok(complete.found);
    assert.deepEqual(
      complete.entries
        .filter((entry) => entry.kind === "steer")
        .map((entry) => entry.content),
      ["Keep this guidance verbatim\n"],
    );
    await interruptTurn(wired, runId, steer.turnId, "stop");
    const rested = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => rested.close());
    assert.ok(rested.snapshot.result.found);
    assert.deepEqual(
      rested.snapshot.result.history.rows
        .filter((row) => row.value.kind === "steer")
        .map((row) => row.value),
      [
        {
          kind: "steer",
          content: "Keep this guidance verbatim\n",
          delivery: "after-boundary",
        },
      ],
    );
  } finally {
    await wired.shutdown();
  }
});

for (const result of ["interrupted", "lost"] as const)
  test(`m10-audit-steer-stored-when-sent: ${result} preserves accepted undelivered guidance and excludes it from transcript`, async (t) => {
    const { wired, runId } = await launchInteractive(t, {
      profile: fakeHarnessProfile({
        steer: { available: true, evidence: "scripted" },
      }),
      turns: [
        {
          block: true,
          result: COMPLETED_DETACHED.result,
          interruptResult:
            result === "lost"
              ? {
                  kind: "lost",
                  detail: {
                    unknown: "completion",
                    lastObservation: "native connection lost",
                    session: { state: "unusable", reason: "lost" },
                  },
                }
              : undefined,
        },
      ],
    });
    try {
      const { steer } = await sendLiveTurn(wired, runId, "send");
      assert.ok(steer.available);
      const port = wired.projectionPort;
      const view = port.openProjection({
        family: "session-history",
        runId,
        session: "s",
      });
      t.after(() => view.close());
      assert.ok(
        port.submit({
          operationId: "guidance",
          operation: "steer-turn",
          input: { runId, turnId: steer.turnId, text: "Undelivered guidance" },
        }).admitted,
      );
      assert.equal((await awaitSettled(port, "guidance")).status, "applied");
      const reader = view.updates[Symbol.asyncIterator]();
      const waiting = await reader.next();
      assert.ok(
        waiting.value?.kind === "durable" &&
          waiting.value.snapshot.result.found,
      );
      const row = waiting.value.snapshot.result.history.rows.at(-1)!;
      assert.deepEqual(row.value, {
        kind: "steer",
        content: "Undelivered guidance",
        delivery: "waiting",
      });
      await interruptTurn(wired, runId, steer.turnId, "stop");
      const final = port.openProjection({
        family: "session-history",
        runId,
        session: "s",
      });
      t.after(() => final.close());
      assert.ok(final.snapshot.result.found);
      assert.deepEqual(
        final.snapshot.result.history.rows
          .filter((row) => row.value.kind === "steer")
          .map((row) => row.value),
        [
          {
            kind: "steer",
            content: "Undelivered guidance",
            delivery:
              result === "interrupted" ? "not-delivered" : "unconfirmed",
          },
        ],
      );
      const transcript = port.readTranscript(
        final.snapshot.result.history.transcriptExport,
      );
      assert.ok(transcript.found);
      assert.ok(!transcript.entries.some((entry) => entry.kind === "steer"));
      for await (const update of view.updates) {
        if (update.kind !== "durable" || !update.snapshot.result.found)
          continue;
        const settled = update.snapshot.result.history.rows.find(
          (candidate) => candidate.id === row.id,
        );
        if (
          settled?.value.kind === "steer" &&
          settled.value.delivery !== "waiting"
        ) {
          assert.equal(settled.position, row.position);
          break;
        }
      }
    } finally {
      await wired.shutdown();
    }
  });

test("m10-audit-steer-stored-when-sent: crash recovery retains the real accepted send as delivery not confirmed", async (t) => {
  const { wired, runId, home } = await launchInteractive(t, {
    profile: fakeHarnessProfile({
      steer: { available: true, evidence: "scripted" },
    }),
    turns: [{ block: true, result: COMPLETED_DETACHED.result }],
  });
  try {
    const { steer } = await sendLiveTurn(wired, runId, "send");
    assert.ok(steer.available);
    const port = wired.projectionPort;
    assert.ok(
      port.submit({
        operationId: "guidance",
        operation: "steer-turn",
        input: { runId, turnId: steer.turnId, text: "Accepted before exit" },
      }).admitted,
    );
    assert.equal((await awaitSettled(port, "guidance")).status, "applied");
    const before = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => before.close());
    assert.ok(before.snapshot.result.found);
    assert.equal(
      before.snapshot.result.history.rows.at(-1)?.value.kind,
      "steer",
    );
    const workspace = readRun(port, runId).workspacePath;
    // A second Store open reconciles this process's abandoned ownership as dead.
    // No Harness terminal event or orderly Application shutdown precedes the open.
    const group = openFakeRunGroup(home, workspace);
    t.after(() => group.close());
    const reopened = createApplication({
      catalog: wired.catalog,
      runGroup: group,
      process: createFakeProcess({}),
      launchWorkspacePath: workspace,
      hostPlatform: hostPlatform(),
    });
    try {
      assert.equal(readRun(reopened.projectionPort, runId).state, "halted");
      const view = reopened.projectionPort.openProjection({
        family: "session-history",
        runId,
        session: "s",
      });
      t.after(() => view.close());
      assert.ok(view.snapshot.result.found);
      const rows = view.snapshot.result.history.rows.filter(
        (row) => row.value.kind === "steer",
      );
      assert.deepEqual(
        rows.map((row) => row.value),
        [
          {
            kind: "steer",
            content: "Accepted before exit",
            delivery: "unconfirmed",
          },
        ],
      );
      assert.equal(rows[0]?.source, "stored");
      const transcript = reopened.projectionPort.readTranscript(
        view.snapshot.result.history.transcriptExport,
      );
      assert.ok(transcript.found);
      assert.ok(!transcript.entries.some((entry) => entry.kind === "steer"));
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await wired.shutdown();
  }
});

function controlAdapter(
  control: (
    send: (input: SteerInput) => Promise<ControlReceipt>,
    input: SteerInput,
  ) => Promise<ControlReceipt>,
  boundary: Promise<void>,
  observed?: () => void,
): HarnessAdapter {
  const fake = createFake({
    profile: fakeHarnessProfile({
      steer: { available: true, evidence: "scripted" },
    }),
    turns: [
      {
        block: true,
        steerBoundary: boundary,
        result: COMPLETED_DETACHED.result,
      },
    ],
  })();
  return {
    ...fake,
    async prepare(options) {
      const prepared = await fake.prepare(options);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          readDefaults: () => harness.readDefaults(),
          close: () => harness.close(),
          startTurn(request) {
            const turn = harness.startTurn(request);
            if (observed !== undefined)
              turn.subscribe((event) => {
                if (event.kind === "steer") observed();
              });
            const send = turn.steer.bind(turn);
            turn.steer = (input) => control(send, input);
            return turn;
          },
        },
      };
    },
  };
}

test("m10-audit-steer-stored-when-sent: delivery before the acceptance receipt stays delivered", async (t) => {
  const boundary = deferred();
  const accepted = deferred();
  const receipt = deferred();
  const adapter = controlAdapter(async (send, input) => {
    const result = await send(input);
    accepted.resolve();
    await receipt.promise;
    return result;
  }, boundary.promise);
  const { wired, runId } = await launchInteractive(t, adapter);
  try {
    const { steer } = await sendLiveTurn(wired, runId, "send");
    assert.ok(steer.available);
    const port = wired.projectionPort;
    const view = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => view.close());
    assert.ok(
      port.submit({
        operationId: "guidance",
        operation: "steer-turn",
        input: { runId, turnId: steer.turnId, text: "Already delivered" },
      }).admitted,
    );
    await accepted.promise;
    boundary.resolve();
    const update = await view.updates[Symbol.asyncIterator]().next();
    assert.ok(
      update.value?.kind === "durable" && update.value.snapshot.result.found,
    );
    const row = update.value.snapshot.result.history.rows.at(-1)!;
    assert.deepEqual(row.value, {
      kind: "steer",
      content: "Already delivered",
      delivery: "after-boundary",
    });
    // Finish the Turn before the delayed send receipt, too.
    await interruptTurn(wired, runId, steer.turnId, "stop");
    receipt.resolve();
    assert.equal((await awaitSettled(port, "guidance")).status, "applied");
    const final = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => final.close());
    assert.ok(final.snapshot.result.found);
    assert.deepEqual(
      final.snapshot.result.history.rows
        .filter((row) => row.value.kind === "steer")
        .map((row) => row.value),
      [row.value],
    );
    const transcript = port.readTranscript(
      final.snapshot.result.history.transcriptExport,
    );
    assert.ok(transcript.found);
    assert.deepEqual(
      transcript.entries
        .filter((entry) => entry.kind === "steer")
        .map((entry) => entry.content),
      ["Already delivered"],
    );
  } finally {
    receipt.resolve();
    await wired.shutdown();
  }
});

test("m10-audit-steer-stored-when-sent: a rejected Harness receipt stores no waiting row", async (t) => {
  const adapter = controlAdapter(
    async () => ({ outcome: "rejected", reason: "expired" }),
    deferred().promise,
  );
  const { wired, runId } = await launchInteractive(t, adapter);
  try {
    const { steer } = await sendLiveTurn(wired, runId, "send");
    assert.ok(steer.available);
    const port = wired.projectionPort;
    assert.ok(
      port.submit({
        operationId: "guidance",
        operation: "steer-turn",
        input: { runId, turnId: steer.turnId, text: "Refused guidance" },
      }).admitted,
    );
    const outcome = await awaitSettled(port, "guidance");
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied")
      assert.equal(outcome.problem.code, "steer-rejected");
    const view = port.openProjection({
      family: "session-history",
      runId,
      session: "s",
    });
    t.after(() => view.close());
    assert.ok(view.snapshot.result.found);
    assert.ok(
      !view.snapshot.result.history.rows.some(
        (row) => row.value.kind === "steer",
      ),
    );
  } finally {
    await wired.shutdown();
  }
});

for (const early of [false, true])
  test(`m10-audit-steer-stored-when-sent: ${early ? "early settlement and" : "waiting"} append refusal reports unknown effects without claiming storage`, async (t) => {
    const boundary = deferred();
    const accepted = deferred();
    const receipt = deferred();
    const observed = deferred();
    const adapter = controlAdapter(
      async (send, input) => {
        const result = await send(input);
        accepted.resolve();
        if (early) await receipt.promise;
        return result;
      },
      boundary.promise,
      observed.resolve,
    );
    const { wired, runId, home } = await launchInteractive(t, adapter);
    try {
      const { steer } = await sendLiveTurn(wired, runId, "send");
      assert.ok(steer.available);
      const groups = join(home, "runs");
      const database = new Database(
        join(groups, readdirSync(groups)[0]!, runId, "run.db"),
      );
      try {
        database.exec(
          "CREATE TRIGGER refuse_steer BEFORE INSERT ON turn_event WHEN NEW.kind = 'steer' BEGIN SELECT RAISE(ABORT, 'injected Steer storage fault'); END",
        );
        const port = wired.projectionPort;
        assert.ok(
          port.submit({
            operationId: "guidance",
            operation: "steer-turn",
            input: {
              runId,
              turnId: steer.turnId,
              text: "Accepted but storage failed",
            },
          }).admitted,
        );
        if (early) {
          await accepted.promise;
          boundary.resolve();
          await observed.promise;
          receipt.resolve();
        }
        const outcome = await awaitSettled(port, "guidance");
        assert.equal(outcome.status, "not-applied");
        if (outcome.status === "not-applied") {
          assert.equal(outcome.problem.code, "steer-not-recorded");
          assert.equal(outcome.problem.possibleEffects, "unknown");
        }
        const missing = port.openProjection({
          family: "session-history",
          runId,
          session: "s",
        });
        t.after(() => missing.close());
        assert.ok(missing.snapshot.result.found);
        assert.ok(
          !missing.snapshot.result.history.rows.some(
            (row) => row.value.kind === "steer",
          ),
        );
        database.exec("DROP TRIGGER refuse_steer");
        if (!early) {
          boundary.resolve();
          await observed.promise;
          const delivered = port.openProjection({
            family: "session-history",
            runId,
            session: "s",
          });
          t.after(() => delivered.close());
          assert.ok(delivered.snapshot.result.found);
          assert.deepEqual(
            delivered.snapshot.result.history.rows
              .filter((row) => row.value.kind === "steer")
              .map((row) => row.value),
            [
              {
                kind: "steer",
                content: "Accepted but storage failed",
                delivery: "after-boundary",
              },
            ],
          );
        }
        await interruptTurn(wired, runId, steer.turnId, "stop");
        assert.equal(readRun(port, runId).state, "blocked");
      } finally {
        database.close();
      }
    } finally {
      receipt.resolve();
      await wired.shutdown();
    }
  });
