// The closed vocabulary the Harness Interface fixes. These sets are the contract
// every Adapter and every caller is written against; pinning them here fails
// loudly if a variant is added or dropped without a decision. Adding a variant is
// caught at compile time too: each array is built through `exhaustive<Union>()`,
// which fails the build when a new union member is not listed (A39) — this runtime
// pin then fixes the exact members and their order.

import assert from "node:assert/strict";
import test from "node:test";
import { createProcessAdapter } from "../../src/process/process.js";
import {
  APPROVAL_DECISIONS,
  CLAUDE_CODE_SERVED_CAPABILITIES,
  CLAUDE_CODE_INPUT_RULES,
  CODEX_INPUT_RULES,
  CODEX_SERVED_CAPABILITIES,
  CONTROL_REJECTIONS,
  discoverClaudeCode,
  discoverCodex,
  HARNESS_PLATFORMS,
  LOST_UNKNOWNS,
  TURN_EVENT_KINDS,
  TURN_ORIGINS,
  TURN_RESULT_KINDS,
} from "../../src/harness/harness.js";

test("m10-audit-retired-seam-vocabulary: the closed vocabulary sets are exactly what the Interface fixes", () => {
  assert.deepEqual([...HARNESS_PLATFORMS], ["windows", "macos", "linux"]);
  assert.deepEqual([...TURN_ORIGINS], ["managed", "human"]);
  assert.deepEqual([...APPROVAL_DECISIONS], ["allow", "deny"]);
  assert.deepEqual(
    [...CONTROL_REJECTIONS],
    ["unsupported", "expired", "already-settled", "shape-mismatch"],
  );
  assert.deepEqual(
    [...TURN_RESULT_KINDS],
    ["not-started", "completed", "failed", "interrupted", "lost"],
  );
  assert.deepEqual(
    [...LOST_UNKNOWNS],
    ["acceptance", "completion", "interruption"],
  );
  assert.deepEqual(
    [...TURN_EVENT_KINDS],
    [
      "session",
      "agent-call",
      "elicitation-declined",
      "assistant-content",
      "tool-call",
      "tool-partial",
      "tool-preview",
      "turn-diff-preview",
      "turn-diff",
      "request-raised",
      "request-answered",
      "request-expired",
      "message-preview",
      "thought",
      "thought-preview",
      "context",
      "usage",
      "model",
      "steer",
    ],
  );
});

test("Codex discovery shares configured-then-PATH order and served capabilities", () => {
  const resolved: string[] = [];
  const discovery = discoverCodex(createProcessAdapter(), {
    configuredExecutable: "configured-codex",
    env: { SECANT_CODEX: "ignored-env-codex" },
    platform: "win32",
    resolve(name) {
      resolved.push(name);
      return name === "codex" ? "/bin/codex" : undefined;
    },
  });

  assert.deepEqual(resolved, ["configured-codex", "codex"]);
  assert.equal(discovery.kind, "found");
  if (discovery.kind !== "found") throw new Error("unreachable");
  assert.equal(discovery.attempt.source, "path");
  assert.deepEqual(CODEX_SERVED_CAPABILITIES, {
    "agent-turn": true,
    "interactive-turns": true,
    agentCalls: true,
  });
});

test("Claude Code discovery shares configured-then-PATH order and served capabilities", () => {
  const resolved: string[] = [];
  const discovery = discoverClaudeCode(createProcessAdapter(), {
    configuredExecutable: "configured-claude",
    env: { SECANT_CLAUDE_CODE: "ignored-env-claude" },
    platform: "win32",
    resolve(name) {
      resolved.push(name);
      return name === "claude" ? "/bin/claude" : undefined;
    },
  });

  assert.deepEqual(resolved, ["configured-claude", "claude"]);
  assert.equal(discovery.kind, "found");
  if (discovery.kind !== "found") throw new Error("unreachable");
  assert.equal(discovery.attempt.source, "path");
  assert.deepEqual(CLAUDE_CODE_SERVED_CAPABILITIES, {
    "agent-turn": true,
    "interactive-turns": true,
    agentCalls: true,
  });
});

test("Adapters declare frozen transport-independent input rules (#358)", () => {
  assert.deepEqual(CLAUDE_CODE_INPUT_RULES, [
    {
      kind: "reserved-leading-words",
      words: [
        "/clear",
        "/new",
        "/reset",
        "/resume",
        "/continue",
        "/fork",
        "/model",
        "/effort",
        "/fast",
        "/config",
      ],
    },
  ]);
  assert.deepEqual(CODEX_INPUT_RULES, []);
  assert.ok(Object.isFrozen(CLAUDE_CODE_INPUT_RULES));
  assert.ok(Object.isFrozen(CLAUDE_CODE_INPUT_RULES[0]));
  assert.ok(Object.isFrozen(CLAUDE_CODE_INPUT_RULES[0]?.words));
  assert.ok(Object.isFrozen(CODEX_INPUT_RULES));
});
