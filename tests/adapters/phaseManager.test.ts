import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseManager } from "../../src/adapters/phaseManager.js";
import {
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";
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

function createInput(
  overrides: Partial<ManagedProviderSessionInput> = {},
): ManagedProviderSessionInput {
  return {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Start",
    initialCompletionMarker: "INITIAL_DONE",
    async validate() {},
    ...overrides,
  };
}

function createManager(options: {
  input?: Partial<ManagedProviderSessionInput>;
  onPrompt?: (prompt: string) => void | Promise<void>;
  onFinalize?: () => void | Promise<void>;
  events?: ManagedProviderSessionEvent[];
  logger?: Logger;
}) {
  const events = options.events ?? [];

  return createPhaseManager({
    provider: getBuiltInProviderIdentity("codex"),
    source: "hooks",
    structured: true,
    logger: options.logger,
    input: createInput({
      onProviderEvent(event) {
        events.push(event);
      },
      ...options.input,
    }),
    submitPrompt: options.onPrompt ?? (() => {}),
    finalize: options.onFinalize ?? (() => {}),
  });
}

test("phase manager traces forwarded events without leaking submitted message bodies", async () => {
  const { entries, logger } = createCapturingLogger();
  const secret = "SECRET-forwarded-provider-event";
  const manager = createManager({
    logger,
    input: {
      phase: {
        id: "initial-phase",
      },
    },
  });

  await manager.handleEvent({ type: "session-start" });
  await manager.handleEvent({
    type: "submitted-user-message",
    message: `Managed prompt ${secret}`,
    origin: "managed",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "still working",
  });
  await manager.handleEvent({
    type: "session-completed",
    exitCode: 0,
    signal: null,
  });

  const forwardedEvents = entries.filter((entry) =>
    /provider event/i.test(entry.msg),
  );

  assert.deepEqual(
    forwardedEvents.map((entry) => entry.context?.context?.type),
    [
      "session-start",
      "submitted-user-message",
      "turn-completed",
      "session-completed",
    ],
  );
  assert.deepEqual(
    forwardedEvents.map((entry) => ({
      source: entry.context?.context?.source,
      structured: entry.context?.context?.structured,
      phaseId: entry.context?.context?.phaseId,
    })),
    [
      { source: "hooks", structured: true, phaseId: "initial-phase" },
      { source: "hooks", structured: true, phaseId: "initial-phase" },
      { source: "hooks", structured: true, phaseId: "initial-phase" },
      { source: "hooks", structured: true, phaseId: "initial-phase" },
    ],
  );
  assert.equal(forwardedEvents[1]?.context?.context?.origin, "managed");
  assert.equal(
    forwardedEvents[1]?.context?.context?.messageLength,
    `Managed prompt ${secret}`.length,
  );
  assert.doesNotMatch(JSON.stringify(forwardedEvents), new RegExp(secret));
});

test("phase manager traces marker matches and structured turn-boundary misses", async () => {
  const { entries, logger } = createCapturingLogger();
  const manager = createManager({
    logger,
    input: {
      phase: {
        id: "initial-phase",
      },
      initialCompletionMarker: "INITIAL_DONE",
      initialTerminalCompletionMarker: "NO_MORE_TASKS",
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "still working",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "all work complete NO_MORE_TASKS",
  });

  const miss = entries.find((entry) => /marker miss/i.test(entry.msg));
  const match = entries.find((entry) => /marker matched/i.test(entry.msg));

  assert.equal(miss?.level, "debug");
  assert.deepEqual(miss?.context?.context, {
    providerId: "codex",
    phaseId: "initial-phase",
    source: "hooks",
    structured: true,
  });
  assert.equal(match?.level, "debug");
  assert.deepEqual(match?.context?.context, {
    providerId: "codex",
    phaseId: "initial-phase",
    source: "hooks",
    structured: true,
    matchedMarker: "NO_MORE_TASKS",
    isTerminalCompletionMarker: true,
  });
});

test("phase manager traces phase transitions across continuations, repair, and finalization", async () => {
  const { entries, logger } = createCapturingLogger();
  const validationFailure = new Error("artifact invalid");
  let continuationValidateCalls = 0;
  const manager = createManager({
    logger,
    input: {
      phase: {
        id: "initial-phase",
      },
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {},
      continuations: [
        {
          phase: {
            id: "prd-phase",
          },
          prompt: "Write the PRD.",
          completionMarker: "PRD_DONE",
          async validate() {
            continuationValidateCalls += 1;

            if (continuationValidateCalls === 1) {
              throw validationFailure;
            }
          },
          repair: {
            phase: {
              id: "prd-repair-phase",
              attempt: 1,
            },
            completionMarker: "REPAIR_DONE",
            renderPrompt(error) {
              assert.equal(error, validationFailure);
              return "Repair the PRD.";
            },
            mapFailure(error) {
              return error;
            },
          },
        },
      ],
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "INITIAL_DONE",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "PRD_DONE",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "REPAIR_DONE",
  });

  const transitions = entries.filter((entry) => /phase transition/i.test(entry.msg));

  assert.deepEqual(
    transitions.map((entry) => ({
      from: entry.context?.context?.from,
      to: entry.context?.context?.to,
      fromPhaseId: entry.context?.context?.fromPhaseId,
      toPhaseId: entry.context?.context?.toPhaseId,
      source: entry.context?.context?.source,
      structured: entry.context?.context?.structured,
    })),
    [
      {
        from: "initial",
        to: "continuation-1",
        fromPhaseId: "initial-phase",
        toPhaseId: "prd-phase",
        source: "hooks",
        structured: true,
      },
      {
        from: "continuation-1",
        to: "repair-1",
        fromPhaseId: "prd-phase",
        toPhaseId: "prd-repair-phase",
        source: "hooks",
        structured: true,
      },
      {
        from: "repair-1",
        to: "continuation-1",
        fromPhaseId: "prd-repair-phase",
        toPhaseId: "prd-phase",
        source: "hooks",
        structured: true,
      },
      {
        from: "continuation-1",
        to: "finalized",
        fromPhaseId: "prd-phase",
        toPhaseId: undefined,
        source: "hooks",
        structured: true,
      },
    ],
  );
});

test("phase manager keeps no-logger default behavior unchanged", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  let finalizeCalls = 0;
  const manager = createManager({
    events,
    onFinalize() {
      finalizeCalls += 1;
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "INITIAL_DONE",
  });

  assert.equal(finalizeCalls, 1);
  assert.equal(manager.isFinalized(), true);
  assert.equal(manager.matchedCompletionMarker(), "INITIAL_DONE");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "turn-completed");
});

test("phase manager stamps forwarded hook events with the active initial phase", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  const manager = createManager({
    events,
    input: {
      phase: {
        id: "initial-phase",
      },
    },
  });

  await manager.handleEvent({ type: "session-start" });
  await manager.handleEvent({
    type: "submitted-user-message",
    message: "Start",
    origin: "unknown",
    providerSessionId: "session-123",
  });

  assert.deepEqual(events, [
    {
      type: "session-start",
      provider: getBuiltInProviderIdentity("codex"),
      source: "hooks",
      structured: true,
      phaseId: "initial-phase",
    },
    {
      type: "submitted-user-message",
      message: "Start",
      origin: "unknown",
      provider: getBuiltInProviderIdentity("codex"),
      source: "hooks",
      structured: true,
      phaseId: "initial-phase",
      providerSessionId: "session-123",
    },
  ]);
});

test("phase manager ignores turn completions without the active completion marker", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  let validateCalls = 0;
  let finalizeCalls = 0;
  const manager = createManager({
    events,
    input: {
      async validate() {
        validateCalls += 1;
      },
    },
    onFinalize() {
      finalizeCalls += 1;
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "still working",
  });

  assert.equal(validateCalls, 0);
  assert.equal(finalizeCalls, 0);
  assert.equal(manager.isFinalized(), false);
  assert.deepEqual(
    events.map((event) => event.phaseId),
    ["initial"],
  );
});

test("phase manager observes structured completion markers only from assistant turn boundaries", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  let validateCalls = 0;
  let finalizeCalls = 0;
  const manager = createManager({
    events,
    input: {
      async validate() {
        validateCalls += 1;
      },
    },
    onFinalize() {
      finalizeCalls += 1;
    },
  });

  await manager.handleEvent({
    type: "submitted-user-message",
    message: "User pasted INITIAL_DONE",
    origin: "human",
  });
  await manager.handleEvent({
    type: "session-completed",
    exitCode: 0,
    signal: null,
  });

  assert.equal(validateCalls, 0);
  assert.equal(finalizeCalls, 0);
  assert.equal(manager.isFinalized(), false);

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "Provider accepted the answers INITIAL_DONE",
  });

  assert.equal(validateCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(manager.isFinalized(), true);
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.phaseId}`),
    [
      "submitted-user-message:initial",
      "session-completed:initial",
      "turn-completed:initial",
    ],
  );
});

test("phase manager completes a structured turn with the terminal marker", async () => {
  let validateCalls = 0;
  let finalizeCalls = 0;
  const manager = createManager({
    input: {
      initialTerminalCompletionMarker: "NO_MORE_TASKS",
      async validate() {
        validateCalls += 1;
      },
    },
    onFinalize() {
      finalizeCalls += 1;
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "Provider found no more work NO_MORE_TASKS",
  });

  assert.equal(validateCalls, 1);
  assert.equal(finalizeCalls, 1);
  assert.equal(manager.isFinalized(), true);
  assert.equal(manager.matchedCompletionMarker(), "NO_MORE_TASKS");
});

test("phase manager gives terminal marker precedence when both structured markers appear", async () => {
  const manager = createManager({
    input: {
      initialCompletionMarker: "ITERATION_DONE",
      initialTerminalCompletionMarker: "NO_MORE_TASKS",
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "Completed one issue ITERATION_DONE NO_MORE_TASKS",
  });

  assert.equal(manager.isFinalized(), true);
  assert.equal(manager.matchedCompletionMarker(), "NO_MORE_TASKS");
});

test("phase manager validates a marker-matching turn once and finalizes when no continuations remain", async () => {
  const ordering: string[] = [];
  const manager = createManager({
    input: {
      async validate() {
        ordering.push("validate");
      },
    },
    onFinalize() {
      ordering.push("finalize");
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "done INITIAL_DONE",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "duplicate INITIAL_DONE",
  });

  assert.deepEqual(ordering, ["validate", "finalize"]);
  assert.equal(manager.isFinalized(), true);
});

test("phase manager advances to a continuation after successful validation", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  const prompts: string[] = [];
  const ordering: string[] = [];
  const manager = createManager({
    events,
    onPrompt(prompt) {
      prompts.push(prompt);
    },
    input: {
      phase: {
        id: "grill-phase",
      },
      initialCompletionMarker: "GRILL_DONE",
      async validate() {
        ordering.push("grill-validate");
      },
      continuations: [
        {
          phase: {
            id: "prd-phase",
          },
          prompt: "Write the PRD.",
          completionMarker: "PRD_DONE",
          onStart() {
            ordering.push("prd-start");
          },
          async validate() {
            ordering.push("prd-validate");
          },
        },
      ],
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "GRILL_DONE",
  });
  await manager.handleEvent({
    type: "submitted-user-message",
    message: "Write the PRD.",
    origin: "human",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "PRD_DONE",
  });

  assert.deepEqual(ordering, [
    "grill-validate",
    "prd-start",
    "prd-validate",
  ]);
  assert.deepEqual(prompts, ["Write the PRD."]);
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.phaseId}`),
    [
      "turn-completed:grill-phase",
      "submitted-user-message:prd-phase",
      "turn-completed:prd-phase",
    ],
  );
  assert.equal(manager.isFinalized(), true);
});

test("phase manager enters repair phase and submits the repair prompt after validation failure", async () => {
  const events: ManagedProviderSessionEvent[] = [];
  const prompts: string[] = [];
  const validationFailure = new Error("artifact invalid");
  let validateCalls = 0;
  const manager = createManager({
    events,
    onPrompt(prompt) {
      prompts.push(prompt);
    },
    input: {
      phase: {
        id: "initial-phase",
      },
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {
        validateCalls += 1;

        if (validateCalls === 1) {
          throw validationFailure;
        }
      },
      repair: {
        phase: {
          id: "repair-phase",
          attempt: 1,
        },
        completionMarker: "REPAIR_DONE",
        renderPrompt(error) {
          assert.equal(error, validationFailure);
          return "Repair it.";
        },
        mapFailure(error) {
          return error;
        },
      },
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "INITIAL_DONE",
  });
  await manager.handleEvent({
    type: "submitted-user-message",
    message: "Repair it.",
    origin: "human",
  });
  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "REPAIR_DONE",
  });

  assert.deepEqual(prompts, ["Repair it."]);
  assert.equal(manager.repairUsed(), true);
  assert.deepEqual(
    events.map((event) => `${event.type}:${event.phaseId}`),
    [
      "turn-completed:initial-phase",
      "submitted-user-message:repair-phase",
      "turn-completed:repair-phase",
    ],
  );
});

test("phase manager propagates validation failure when repair is absent", async () => {
  const validationFailure = new Error("artifact invalid");
  const manager = createManager({
    input: {
      async validate() {
        throw validationFailure;
      },
    },
  });

  await assert.rejects(
    manager.handleEvent({
      type: "turn-completed",
      assistantMessage: "INITIAL_DONE",
    }),
    validationFailure,
  );
});

test("phase manager maps repair validation failure through repair config", async () => {
  const initialFailure = new Error("artifact invalid");
  const repairFailure = new Error("still invalid");
  const mappedFailure = new Error("mapped repair failure");
  let validateCalls = 0;
  const manager = createManager({
    input: {
      async validate() {
        validateCalls += 1;

        if (validateCalls === 1) {
          throw initialFailure;
        }

        throw repairFailure;
      },
      repair: {
        completionMarker: "REPAIR_DONE",
        renderPrompt() {
          return "Repair it.";
        },
        mapFailure(error) {
          assert.equal(error, repairFailure);
          return mappedFailure;
        },
      },
    },
  });

  await manager.handleEvent({
    type: "turn-completed",
    assistantMessage: "INITIAL_DONE",
  });

  await assert.rejects(
    manager.handleEvent({
      type: "turn-completed",
      assistantMessage: "REPAIR_DONE",
    }),
    mappedFailure,
  );
});
