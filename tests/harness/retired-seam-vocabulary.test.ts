import assert from "node:assert/strict";
import test from "node:test";
import type { PreparedHarness, TurnEvent } from "../../src/harness/harness.js";
import { assistantContent } from "./conformance.js";
import {
  init,
  prepare,
  scriptedClaude,
  turnRequest,
} from "./scripted-claude.js";
import { scriptedCodexFacts } from "./scripted-codex-facts.js";
import { makeTempDir } from "../helpers/tempDir.js";

for (const name of ["claude-code", "codex"] as const) {
  test(`m10-audit-retired-seam-vocabulary: ${name} retains assistant facts and seals before completion without retired fields`, async (t) => {
    const workspace = makeTempDir("secant-retired-vocabulary-");
    let harness: PreparedHarness;
    if (name === "claude-code") {
      const native = scriptedClaude({
        answer: "confirm",
        userFrame: () => [
          init,
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "authoritative reply" }],
            },
          },
          { type: "system", subtype: "status", status: "compacting" },
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "unread terminal copy",
          },
        ],
      });
      harness = await prepare(native);
    } else {
      const adapter = scriptedCodexFacts([], workspace);
      t.after(() => adapter.close());
      const prepared = await adapter.prepare({ workspace });
      assert.ok(prepared.ok);
      harness = prepared.harness;
    }
    t.after(() => harness.close());
    const turn = harness.startTurn({
      ...turnRequest("go"),
      modelChoice: { model: "gpt-6.1-sol" },
    });
    const live: TurnEvent[] = [];
    turn.subscribe((event) => live.push(event));
    const result = await turn.result();
    assert.equal(result.kind, "completed");
    assert.equal("finalContent" in result.detail, false);
    assert.equal(
      live.some((event) => String(event.kind) === "activity"),
      false,
    );
    if (name === "claude-code")
      assert.equal(assistantContent(turn), "authoritative reply");
    else assert.match(assistantContent(turn) ?? "", /^Fixed \[sum\.mjs\]/);
    const retained: TurnEvent[] = [];
    turn.subscribe((event) => retained.push(event)).unsubscribe();
    assert.deepEqual(
      retained,
      live.filter(
        (event) =>
          ![
            "message-preview",
            "tool-preview",
            "thought-preview",
            "turn-diff-preview",
          ].includes(event.kind),
      ),
    );
    const sealed = [...live];
    await harness.close();
    assert.deepEqual(live, sealed);
    assert.strictEqual(await turn.result(), result);
  });
}
