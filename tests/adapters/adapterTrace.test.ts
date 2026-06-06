import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubmittedUserMessageTrace,
  buildTierResolutionTrace,
  buildTurnCompletedTrace,
  emitAdapterTrace,
} from "../../src/adapters/adapterTrace.js";
import type { Logger } from "../../src/logger.js";

function createCapturingLogger() {
  const entries: Array<{
    level: keyof Logger;
    msg: string;
    context: Parameters<Logger["debug"]>[1];
  }> = [];
  const logger: Logger = {
    debug: (msg, context) => entries.push({ level: "debug", msg, context }),
    info: (msg, context) => entries.push({ level: "info", msg, context }),
    warn: (msg, context) => entries.push({ level: "warn", msg, context }),
    error: (msg, context) => entries.push({ level: "error", msg, context }),
    critical: (msg, context) => {
      entries.push({ level: "critical", msg, context });
      return "err_test";
    },
  };

  return { entries, logger };
}

test("adapter trace builds tier-resolution context without run or stage correlation", () => {
  const trace = buildTierResolutionTrace({
    provider: { id: "codex", displayName: "Codex" },
    phaseId: "phase-1",
    tier: "hooks",
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
  });

  assert.match(trace.msg, /data-plane/i);
  assert.deepEqual(trace.context, {
    context: {
      providerId: "codex",
      phaseId: "phase-1",
      tier: "hooks",
      eventSource: "hooks",
      capabilities: {
        controlTransport: "pty",
        eventSource: "hooks",
        supportsProviderSessionId: true,
        supportsResume: true,
        classifiesSubmittedUserMessageOrigin: true,
      },
    },
  });
  assert.equal("runId" in trace.context, false);
  assert.equal("stage" in trace.context, false);
});

test("adapter trace event builders expose lengths but never event bodies or prompt arguments", () => {
  const secret = "SECRET-adapter-trace-token";
  const promptArgument = `do the work with ${secret}`;

  const submittedTrace = buildSubmittedUserMessageTrace({
    provider: { id: "claude", displayName: "Claude" },
    phaseId: "phase-2",
    event: {
      type: "submitted-user-message",
      message: `human pasted ${secret}`,
      origin: "human",
    },
    promptArgument,
  });
  const turnTrace = buildTurnCompletedTrace({
    provider: { id: "claude", displayName: "Claude" },
    phaseId: "phase-2",
    event: {
      type: "turn-completed",
      assistantMessage: `assistant copied ${secret}`,
    },
    promptArgument,
  });
  const serialized = JSON.stringify([submittedTrace.context, turnTrace.context]);

  assert.equal(
    submittedTrace.context.context?.messageLength,
    `human pasted ${secret}`.length,
  );
  assert.equal(
    turnTrace.context.context?.messageLength,
    `assistant copied ${secret}`.length,
  );
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /human pasted/);
  assert.doesNotMatch(serialized, /assistant copied/);
  assert.doesNotMatch(serialized, /do the work/);
});

test("emitAdapterTrace writes debug through the injected logger", () => {
  const { entries, logger } = createCapturingLogger();
  const trace = buildTierResolutionTrace({
    provider: { id: "codex", displayName: "Codex" },
    tier: "jsonl",
    capabilities: {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
  });

  emitAdapterTrace(logger, trace);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, "debug");
  assert.equal(entries[0]?.context?.context?.providerId, "codex");
  assert.equal(entries[0]?.context?.context?.tier, "jsonl");
  assert.equal(entries[0]?.context?.runId, undefined);
  assert.equal(entries[0]?.context?.stage, undefined);
});
