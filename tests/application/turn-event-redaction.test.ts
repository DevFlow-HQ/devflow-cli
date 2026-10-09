import assert from "node:assert/strict";
import test from "node:test";
import { startPermissionBridge } from "../../src/harness/harness.js";
import {
  redactionReplay,
  LOOKALIKE,
  REPLACEMENT,
} from "../harness/redaction-replay.js";
import { launchInteractive, send } from "./interactive-agent-fixture.js";
import type { SessionHistoryRow } from "../../src/application/projection-port.js";

for (const kind of ["codex", "claude-code"] as const) {
  test(`m10-audit-turn-event-redaction: ${kind} reaches live history, Run Store and transcript only as replacements`, async (t) => {
    const bridge = await startPermissionBridge(async () => ({
      decision: "deny",
      message: "unused",
    }));
    t.after(() => bridge.close());
    const bearer = bridge.session(kind).bearer;
    const liveRows: SessionHistoryRow[] = [];
    let capture: (() => void) | undefined;
    const adapter = redactionReplay(t, kind, bearer, (event) => {
      if (
        ["message-preview", "tool-preview", "request-raised"].includes(
          event.kind,
        )
      )
        capture?.();
    });
    const { wired, runId } = await launchInteractive(
      t,
      adapter,
      undefined,
      [
        {
          id: "discuss",
          kind: "interactive-agent",
          session: "s",
          prompt: { asset: "prompts/discuss.md" },
        },
      ],
      kind,
      "gpt-6.1-sol",
    );
    t.after(() => wired.shutdown());
    const port = wired.projectionPort;
    // A pre-existing Run can contain an old token. Its canonical content is not rewritten.
    const old = wired.runGroup.createRun({
      operationId: "old-run",
      bundleSnapshotDigest: "sha256:old",
      launch: {},
      at: new Date("2026-10-01T00:00:00Z"),
    });
    const oldOwner = wired.runGroup.acquireRun(old.runId);
    assert.ok(oldOwner);
    assert.ok(
      oldOwner.admitTurn({
        turnId: "old-turn",
        attemptId: "old-attempt",
        session: "old",
        origin: "human",
        kind: "interactive-agent",
        input: bearer,
        recoveryCoordinate: "old-coordinate",
        harness: kind,
        at: new Date(),
      }).ok,
    );
    assert.ok(
      oldOwner.appendTurnEvent({
        turnId: "old-turn",
        fact: {
          kind: "assistant-content",
          data: { messageId: "old-message", content: bearer },
        },
        at: new Date(),
      }).ok,
    );
    const oldContent = oldOwner.transcript();
    oldOwner.close();
    capture = () => {
      const opened = port.openProjection({
        family: "session-history",
        runId,
        session: "s",
      });
      if (opened.snapshot.result.found)
        liveRows.push(...opened.snapshot.result.history.rows);
      opened.close();
    };
    await send(wired, runId, "redaction-turn", "discuss", LOOKALIKE);
    assert.ok(
      liveRows.some(
        (row) =>
          row.source === "preview" &&
          row.value.kind === "message" &&
          row.value.content === `reply ${REPLACEMENT} ${LOOKALIKE}`,
      ),
    );
    assert.equal(JSON.stringify(liveRows).includes(bearer), false);
    assert.equal(JSON.stringify(liveRows).includes(bearer.slice(0, 31)), false);
    const run = wired.runGroup.readRun(runId);
    assert.ok(run.ok);
    const transcript = port.readTranscript({
      type: "transcript-export",
      runId,
      session: "s",
    });
    assert.ok(transcript.found);
    assert.ok(
      transcript.entries.some(
        (entry) =>
          entry.role === "assistant" &&
          entry.content === `reply ${REPLACEMENT} ${LOOKALIKE}`,
      ),
    );
    assert.equal(
      transcript.entries.find((entry) => entry.role === "user")?.content,
      LOOKALIKE,
    );
    assert.equal(JSON.stringify(transcript).includes(bearer), false);
    // Shutdown releases the held owner before the Store reads acquire it.
    await wired.shutdown();
    const owner = wired.runGroup.acquireRun(runId);
    assert.ok(owner);
    t.after(() => owner.close());
    const stored = {
      turns: owner.turns(),
      events: owner.turnEvents(),
      transcript: owner.transcript(),
    };
    assert.equal(JSON.stringify(stored).includes(bearer), false);
    assert.ok(JSON.stringify(stored).includes(REPLACEMENT));
    const reopenedOld = wired.runGroup.acquireRun(old.runId);
    assert.ok(reopenedOld);
    t.after(() => reopenedOld.close());
    assert.deepEqual(reopenedOld.transcript(), oldContent);
    assert.ok(
      reopenedOld.transcript().every((entry) => entry.content === bearer),
    );
  });
}
