import assert from "node:assert/strict";
import test from "node:test";

import { createPhaseManager } from "../../src/adapters/phaseManager.js";
import {
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

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
}) {
  const events = options.events ?? [];

  return createPhaseManager({
    provider: getBuiltInProviderIdentity("codex"),
    source: "hooks",
    structured: true,
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
