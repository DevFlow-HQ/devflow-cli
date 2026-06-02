import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionTranscriptCaptureError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionCleanupError,
  type ManagedProviderSessionEvent,
  type ManagedProviderSessionInput,
} from "../../src/adapters/managedSessionAdapter.js";
import {
  runPtyManagedSession,
  submitPtyPrompt,
  type PtyProcess,
  type PtySpawnOptions,
  type PtySpawner,
  type UserInput,
} from "../../src/adapters/ptyManagedSessionRunner.js";
import { getBuiltInProviderIdentity } from "../../src/adapters/providers.js";

function waitForAsyncHandlers(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly emitter = new EventEmitter();
  killed = false;
  isAlive = true;

  onData(listener: (data: string) => void): void {
    this.emitter.on("data", listener);
  }

  onExit(
    listener: (event: { exitCode: number; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.emitter.on("exit", listener);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  kill(): void {
    this.killed = true;
    this.isAlive = false;
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows });
  }

  emitData(data: string): void {
    this.emitter.emit("data", data);
  }

  emitExit(exitCode: number, signal: NodeJS.Signals | null = null): void {
    this.isAlive = false;
    this.emitter.emit("exit", { exitCode, signal });
  }
}

class FakePtySpawner implements PtySpawner {
  readonly process = new FakePtyProcess();
  spawnFailure?: unknown;
  calls: Array<{
    executable: string;
    args: string[];
    options: PtySpawnOptions;
  }> = [];

  spawn(
    executable: string,
    args: string[],
    options: PtySpawnOptions,
  ): PtyProcess {
    if (this.spawnFailure) {
      throw this.spawnFailure;
    }

    this.calls.push({ executable, args, options });
    return this.process;
  }
}

class FakeTerminal extends EventEmitter {
  removedResizeListeners = 0;

  constructor(
    public columns: number | undefined,
    public rows: number | undefined,
  ) {
    super();
  }

  override on(event: "resize", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "resize", listener: () => void): this {
    this.removedResizeListeners += 1;
    return super.off(event, listener);
  }

  emitResize(columns: number | undefined, rows: number | undefined): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

class FakeUserInput extends EventEmitter implements UserInput {
  readonly rawModeChanges: boolean[] = [];
  readonly removedDataListeners: Array<(chunk: Buffer | string) => void> = [];
  resumeCount = 0;
  pauseCount = 0;

  constructor(
    readonly isTTY: boolean,
    readonly isRaw = false,
  ) {
    super();
  }

  setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }

  override on(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): this {
    return super.on(event, listener);
  }

  override off(
    event: "data",
    listener: (chunk: Buffer | string) => void,
  ): this {
    this.removedDataListeners.push(listener);
    return super.off(event, listener);
  }

  resume(): void {
    this.resumeCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
  }

  emitData(chunk: Buffer | string): void {
    this.emit("data", chunk);
  }
}

test("submitPtyPrompt writes multiline prompts with bracketed paste and submit", () => {
  const writes: string[] = [];

  submitPtyPrompt(
    {
      write(data) {
        writes.push(data);
      },
    },
    "Line one\nLine two",
  );

  assert.deepEqual(writes, ["\u001b[200~Line one\nLine two\u001b[201~\r"]);
});

function createInput(
  overrides: Partial<ManagedProviderSessionInput> = {},
): ManagedProviderSessionInput {
  return {
    workingDirectory: "/tmp/devflow",
    initialPrompt: "Ship the artifact",
    initialCompletionMarker: "DEVFLOW_DONE",
    async validate() {},
    ...overrides,
  };
}

test("PTY managed-session runner mirrors raw output and validates after an ANSI-stripped completion marker", async () => {
  const spawner = new FakePtySpawner();
  const output: string[] = [];
  const validationStates: boolean[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: ["--ask-for-approval", "never"],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        validationStates.push(spawner.process.isAlive);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal: { columns: 132, rows: 43 },
    },
  );

  spawner.process.emitData("\u001b[32mworking\u001b[0m\n");
  spawner.process.emitData("DEVFLOW_\u001b[31mDONE\u001b[0m\n");

  const result = await runPromise;

  assert.deepEqual(spawner.calls, [
    {
      executable: "codex",
      args: ["--ask-for-approval", "never"],
      options: {
        cwd: "/tmp/devflow",
        cols: 132,
        rows: 43,
      },
    },
  ]);
  assert.deepEqual(output, [
    "\u001b[32mworking\u001b[0m\n",
    "DEVFLOW_\u001b[31mDONE\u001b[0m\n",
  ]);
  assert.deepEqual(validationStates, [true]);
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.deepEqual(result, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "DEVFLOW_DONE",
  });
});

test("PTY managed-session runner completes with a terminal marker from raw output", async () => {
  const spawner = new FakePtySpawner();

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "ITERATION_DONE",
      initialTerminalCompletionMarker: "NO_MORE_TASKS",
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("no active AFK work NO_MORE_TASKS\n");

  assert.deepEqual(await runPromise, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "NO_MORE_TASKS",
  });
});

test("PTY managed-session runner gives terminal marker precedence when both raw markers appear", async () => {
  const spawner = new FakePtySpawner();

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "ITERATION_DONE",
      initialTerminalCompletionMarker: "NO_MORE_TASKS",
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("finished ITERATION_DONE and terminal NO_MORE_TASKS\n");

  assert.deepEqual(await runPromise, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "NO_MORE_TASKS",
  });
});

test("PTY managed-session runner emits a fallback session-start event after successful spawn", async () => {
  const spawner = new FakePtySpawner();
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      phase: {
        id: "initial-phase",
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.deepEqual(events[0], {
    type: "session-start",
    provider: getBuiltInProviderIdentity("codex"),
    source: "pty",
    structured: false,
    phaseId: "initial-phase",
  });
});

test("PTY managed-session runner emits fallback phase ids when callers omit phase metadata", async () => {
  const spawner = new FakePtySpawner();
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "session-start" ||
          event.type === "turn-completed" ||
          event.type === "session-completed",
      )
      .map((event) => event.phaseId),
    ["initial", "initial", "initial"],
  );
});

test("PTY managed-session runner emits turn and session completion events after validation and cleanup", async () => {
  const spawner = new FakePtySpawner();
  const ordering: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      phase: {
        id: "initial-phase",
      },
      async validate() {
        ordering.push("validate");
      },
      onProviderEvent(event) {
        events.push(event);

        if (event.type === "turn-completed") {
          ordering.push("turn-completed");
        }

        if (event.type === "session-completed") {
          ordering.push("session-completed");
        }
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.deepEqual(ordering, [
    "validate",
    "turn-completed",
    "session-completed",
  ]);
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "session-start" ||
          event.type === "turn-completed" ||
          event.type === "session-completed",
      )
      .map((event) => ({
        type: event.type,
        phaseId: event.phaseId,
      })),
    [
      { type: "session-start", phaseId: "initial-phase" },
      { type: "turn-completed", phaseId: "initial-phase" },
      { type: "session-completed", phaseId: "initial-phase" },
    ],
  );
});

test("PTY managed-session runner submits generic continuations inside the same live session", async () => {
  const spawner = new FakePtySpawner();
  const validationOrder: string[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "GRILL_DONE",
      async validate() {
        validationOrder.push("grill");
      },
      continuations: [
        {
          prompt: "Synthesize the PRD.",
          completionMarker: "PRD_DONE",
          onStart() {
            validationOrder.push("prd-start");
          },
          async validate() {
            validationOrder.push("prd");
          },
        },
      ],
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("GRILL_DONE\n");
  await waitForAsyncHandlers();

  assert.deepEqual(validationOrder, ["grill", "prd-start"]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Synthesize the PRD.\u001b[201~\r",
  ]);

  spawner.process.emitData("PRD_DONE\n");
  const result = await runPromise;

  assert.deepEqual(validationOrder, ["grill", "prd-start", "prd"]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Synthesize the PRD.\u001b[201~\r",
    "/exit\n",
  ]);
  assert.equal(result.repairUsed, false);
});

test("PTY managed-session runner emits turn completion before submitting continuation prompts", async () => {
  const spawner = new FakePtySpawner();
  const ordering: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      phase: {
        id: "grill-phase",
      },
      initialCompletionMarker: "GRILL_DONE",
      async validate() {
        ordering.push("grill-validate");
      },
      onProviderEvent(event) {
        events.push(event);

        if (event.type === "turn-completed") {
          ordering.push(`turn:${event.phaseId}`);
        }
      },
      continuations: [
        {
          phase: {
            id: "prd-phase",
          },
          prompt: "Synthesize the PRD.",
          completionMarker: "PRD_DONE",
          async validate() {
            ordering.push("prd-validate");
          },
        },
      ],
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("GRILL_DONE\n");
  await waitForAsyncHandlers();

  assert.deepEqual(ordering, ["grill-validate", "turn:grill-phase"]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Synthesize the PRD.\u001b[201~\r",
  ]);

  spawner.process.emitData("PRD_DONE\n");
  await runPromise;

  assert.deepEqual(ordering, [
    "grill-validate",
    "turn:grill-phase",
    "prd-validate",
    "turn:prd-phase",
  ]);
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "turn-completed" ||
          event.type === "submitted-user-message",
      )
      .map((event) =>
        event.type === "submitted-user-message"
          ? `${event.type}:${event.phaseId}:${event.origin}:${event.message}`
          : `${event.type}:${event.phaseId}`,
      ),
    [
      "turn-completed:grill-phase",
      "submitted-user-message:prd-phase:managed:Synthesize the PRD.",
      "turn-completed:prd-phase",
    ],
  );
});

test("PTY managed-session runner captures normalized provider output without protocol markers", async () => {
  const spawner = new FakePtySpawner();
  const transcript: string[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "DEVFLOW_GRILL_DONE",
      transcript: {
        onProviderOutput(chunk) {
          transcript.push(chunk);
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("\u001b[32mQuestion one?\u001b[0m\r\n");
  spawner.process.emitData("Decision text DEVFLOW_GRILL_DONE\n");
  spawner.process.emitData("post-completion orchestration\n");

  await runPromise;

  assert.deepEqual(transcript, ["Question one?\n", "Decision text "]);
});

test("PTY managed-session runner mirrors output and transcripts without chunk-level assistant-message events", async () => {
  const spawner = new FakePtySpawner();
  const output: string[] = [];
  const transcript: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "DEVFLOW_DONE",
      transcript: {
        onProviderOutput(chunk) {
          transcript.push(chunk);
        },
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write: (chunk) => output.push(chunk) },
      terminal: {},
    },
  );

  spawner.process.emitData("\u001b[32mQuestion one?\u001b[0m\r\n");
  spawner.process.emitData("Decision text DEVFLOW_DONE\n");

  await runPromise;

  assert.deepEqual(output, [
    "\u001b[32mQuestion one?\u001b[0m\r\n",
    "Decision text DEVFLOW_DONE\n",
  ]);
  assert.deepEqual(transcript, ["Question one?\n", "Decision text "]);

  assert.equal(
    events.some((event) => event.type === "turn-completed"),
    true,
  );
  assert.deepEqual(
    events.filter((event) => event.type === "turn-completed"),
    [
      {
        type: "turn-completed",
        provider: getBuiltInProviderIdentity("codex"),
        source: "pty",
        structured: false,
        phaseId: "initial",
      },
    ],
  );
});

test("PTY managed-session runner captures raw terminal submissions without classifying their origin", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);
  const submittedMessages: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      transcript: {
        onSubmittedUserMessage(message) {
          submittedMessages.push(message);
        },
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );

  userInput.emitData("hel");
  userInput.emitData(Buffer.from("lo"));
  assert.deepEqual(submittedMessages, []);
  assert.deepEqual(
    events.filter((event) => event.type === "submitted-user-message"),
    [],
  );

  userInput.emitData("\r");
  userInput.emitData("second\n");
  userInput.emitData("\u0003");
  spawner.process.emitData("DEVFLOW_DONE\n");

  await runPromise;

  assert.deepEqual(submittedMessages, ["hello", "second"]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "submitted-user-message")
      .map((event) => `${event.origin}:${event.message}`),
    ["unknown:hello", "unknown:second"],
  );
  assert.deepEqual(spawner.process.writes, [
    "hel",
    "lo",
    "\r",
    "second",
    "\n",
    "\u0003",
    "/exit\n",
  ]);
});

test("PTY managed-session runner observes completion markers only from provider terminal output", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);
  const submittedMessages: string[] = [];
  const events: ManagedProviderSessionEvent[] = [];
  let validateCalls = 0;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("claude"),
      executable: "claude",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        validateCalls += 1;
      },
      transcript: {
        onSubmittedUserMessage(message) {
          submittedMessages.push(message);
        },
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );

  userInput.emitData("DEVFLOW_DONE\r");
  await waitForAsyncHandlers();

  assert.equal(validateCalls, 0);
  assert.deepEqual(submittedMessages, ["DEVFLOW_DONE"]);
  assert.deepEqual(
    events.filter((event) => event.type === "turn-completed"),
    [],
  );

  spawner.process.emitData("provider has finished DEVFLOW_DONE\n");

  await runPromise;

  assert.equal(validateCalls, 1);
  assert.deepEqual(
    events
      .filter((event) => event.type === "turn-completed")
      .map((event) => ({
        providerId: event.provider.id,
        source: event.source,
        structured: event.structured,
        assistantMessage:
          event.type === "turn-completed" ? event.assistantMessage : undefined,
      })),
    [
      {
        providerId: "claude",
        source: "pty",
        structured: false,
        assistantMessage: undefined,
      },
    ],
  );
});

test("PTY managed-session runner excludes repair markers from provider transcript content", async () => {
  const spawner = new FakePtySpawner();
  const transcript: string[] = [];
  let validationCount = 0;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {
        validationCount += 1;

        if (validationCount === 1) {
          throw new Error("invalid");
        }
      },
      repair: {
        completionMarker: "REPAIR_DONE",
        renderPrompt() {
          return "Repair it.";
        },
        mapFailure(error) {
          return error;
        },
      },
      transcript: {
        onProviderOutput(chunk) {
          transcript.push(chunk);
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("draft INITIAL_DONE\n");
  await waitForAsyncHandlers();
  spawner.process.emitData("fixed REPAIR_DONE\n");

  await runPromise;

  assert.deepEqual(transcript, ["draft ", "\nfixed "]);
});

test("PTY managed-session runner emits repair turn completion with repair phase metadata", async () => {
  const spawner = new FakePtySpawner();
  const events: ManagedProviderSessionEvent[] = [];
  let validationCount = 0;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      phase: {
        id: "initial-phase",
      },
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {
        validationCount += 1;

        if (validationCount === 1) {
          throw new Error("invalid");
        }
      },
      repair: {
        phase: {
          id: "repair-phase",
        },
        completionMarker: "REPAIR_DONE",
        renderPrompt() {
          return "Repair it.";
        },
        mapFailure(error) {
          return error;
        },
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("INITIAL_DONE\n");
  await waitForAsyncHandlers();
  spawner.process.emitData("REPAIR_DONE\n");

  await runPromise;

  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "turn-completed" ||
          event.type === "submitted-user-message",
      )
      .map((event) =>
        event.type === "submitted-user-message"
          ? `${event.type}:${event.phaseId}:${event.origin}:${event.message}`
          : `${event.type}:${event.phaseId}`,
      ),
    [
      "submitted-user-message:repair-phase:managed:Repair it.",
      "turn-completed:repair-phase",
    ],
  );
});

test("PTY managed-session runner maps pre-completion transcript callback failures to retryable capture errors", async () => {
  const spawner = new FakePtySpawner();
  const captureFailure = new Error("transcript write failed");

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      transcript: {
        onProviderOutput() {
          throw captureFailure;
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("Question one?\n");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof ProviderSessionTranscriptCaptureError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.cause, captureFailure);
    return true;
  });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
});

test("PTY managed-session runner maps normal provider event callback failures to retryable capture errors", async () => {
  const spawner = new FakePtySpawner();
  const captureFailure = new Error("event callback failed");

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      onProviderEvent(event) {
        if (event.type === "turn-completed") {
          throw captureFailure;
        }
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("Question one?\n");
  spawner.process.emitData("DEVFLOW_DONE\n");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof ProviderSessionEventCaptureError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.cause, captureFailure);
    return true;
  });
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
});

test("PTY managed-session runner does not emit failure-context events on launch failures", async () => {
  const spawner = new FakePtySpawner();
  const launchFailure = new Error("spawn failed");
  const events: ManagedProviderSessionEvent[] = [];
  spawner.spawnFailure = launchFailure;

  await assert.rejects(
    runPtyManagedSession(
      {
        provider: getBuiltInProviderIdentity("codex"),
        executable: "codex",
        args: [],
      },
      createInput({
        onProviderEvent(event) {
          events.push(event);
        },
      }),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        terminal: {},
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionLaunchError);
      assert.equal(error.provider.id, "codex");
      assert.equal(error.cause, launchFailure);
      return true;
    },
  );
  assert.deepEqual(events, []);
});

test("PTY managed-session runner bridges TTY stdin to the provider and restores stdin on success", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);
  let validated = false;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        validated = true;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );

  userInput.emitData(Buffer.from("typed input"));
  assert.deepEqual(spawner.process.writes, ["typed input"]);

  spawner.process.emitData("DEVFLOW_DONE\n");
  const result = await runPromise;

  assert.equal(validated, true);
  assert.equal(result.repairUsed, false);
  assert.deepEqual(spawner.process.writes, ["typed input", "/exit\n"]);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.resumeCount, 1);
  assert.equal(userInput.pauseCount, 1);
  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(userInput.removedDataListeners.length, 1);
});

test("PTY managed-session runner does not bridge stdin when stdin is not a TTY", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(false);

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );

  userInput.emitData("ignored input");
  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
  assert.deepEqual(userInput.rawModeChanges, []);
  assert.equal(userInput.resumeCount, 0);
  assert.equal(userInput.listenerCount("data"), 0);
});

test("PTY managed-session runner forwards terminal resizes while active without requiring TTY stdin", async () => {
  const spawner = new FakePtySpawner();
  const terminal = new FakeTerminal(100, 30);
  const userInput = new FakeUserInput(false);

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal,
      userInput,
    },
  );

  terminal.emitResize(120, 45);
  terminal.emitResize(undefined, 50);
  terminal.emitResize(140, undefined);
  assert.deepEqual(spawner.process.resizes, [
    { columns: 120, rows: 45 },
    { columns: 80, rows: 50 },
    { columns: 140, rows: 24 },
  ]);

  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(terminal.removedResizeListeners, 1);
});

test("PTY managed-session runner ignores terminal resizes when the PTY does not support resizing", async () => {
  const spawner = new FakePtySpawner();
  const terminal = new FakeTerminal(100, 30);
  const processWithoutResize: PtyProcess = {
    onData: spawner.process.onData.bind(spawner.process),
    onExit: spawner.process.onExit.bind(spawner.process),
    write: spawner.process.write.bind(spawner.process),
    kill: spawner.process.kill.bind(spawner.process),
  };
  spawner.spawn = (executable, args, options) => {
    spawner.calls.push({ executable, args, options });
    return processWithoutResize;
  };

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal,
    },
  );

  terminal.emitResize(120, 45);
  spawner.process.emitData("DEVFLOW_DONE\n");
  await runPromise;

  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(terminal.removedResizeListeners, 1);
});

test("PTY managed-session runner restores bridged stdin after validation failure", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);
  const terminal = new FakeTerminal(100, 30);
  const validationFailure = new Error("artifact is invalid");

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        throw validationFailure;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal,
      userInput,
    },
  );

  terminal.emitResize(120, 40);
  spawner.process.emitData("DEVFLOW_DONE\n");

  await assert.rejects(runPromise, validationFailure);
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.pauseCount, 1);
  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(terminal.removedResizeListeners, 1);
});

test("PTY managed-session runner detects markers inside the bounded rolling buffer", async () => {
  const spawner = new FakePtySpawner();
  let validated = false;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
      markerBufferLimit: 16,
    },
    createInput({
      initialCompletionMarker: "DONE",
      async validate() {
        validated = true;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("x".repeat(32));
  assert.equal(validated, false);

  spawner.process.emitData("DO");
  assert.equal(validated, false);

  spawner.process.emitData("NE");
  const result = await runPromise;

  assert.equal(validated, true);
  assert.equal(result.repairUsed, false);
  assert.equal(spawner.calls[0]?.options.cols, 80);
  assert.equal(spawner.calls[0]?.options.rows, 24);
});

test("PTY managed-session runner reports incomplete sessions before marker detection", async () => {
  const spawner = new FakePtySpawner();
  const terminal = new FakeTerminal(100, 30);
  const events: ManagedProviderSessionEvent[] = [];

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      phase: {
        id: "initial-phase",
      },
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal,
    },
  );

  terminal.emitResize(120, 40);
  spawner.process.emitData("still working\n");
  spawner.process.emitExit(1);

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof IncompleteProviderSessionError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.completionMarker, "DEVFLOW_DONE");
    assert.equal(error.exitCode, 1);
    return true;
  });
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(terminal.removedResizeListeners, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start"],
  );
});

test("PTY managed-session runner maps PTY spawn failures to typed launch errors", async () => {
  const spawner = new FakePtySpawner();
  const spawnFailure = new Error("spawn codex ENOENT");
  spawner.spawnFailure = spawnFailure;

  await assert.rejects(
    runPtyManagedSession(
      {
        provider: getBuiltInProviderIdentity("codex"),
        executable: "codex",
        args: [],
        cleanupCommand: "/exit\n",
      },
      createInput(),
      {
        ptySpawner: spawner,
        outputSink: { write() {} },
        terminal: {},
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderSessionLaunchError);
      assert.equal(error.provider.id, "codex");
      assert.equal(error.cause, spawnFailure);
      return true;
    },
  );
});

test("PTY managed-session runner reports interrupted sessions when user interruption was requested", async () => {
  const spawner = new FakePtySpawner();
  let interrupted = false;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInterrupt: {
        wasRequested() {
          return interrupted;
        },
      },
    },
  );

  interrupted = true;
  spawner.process.emitExit(130, "SIGINT");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof InterruptedProviderSessionError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.exitCode, 130);
    assert.equal(error.signal, "SIGINT");
    return true;
  });
});

test("PTY managed-session runner forwards the first Ctrl-C and reports provider exit as interrupted", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);
  const terminal = new FakeTerminal(100, 30);

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal,
      userInput,
    },
  );

  terminal.emitResize(120, 40);
  userInput.emitData("\u0003");
  assert.deepEqual(spawner.process.writes, ["\u0003"]);
  assert.equal(spawner.process.killed, false);

  spawner.process.emitExit(130, "SIGINT");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof InterruptedProviderSessionError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.exitCode, 130);
    assert.equal(error.signal, "SIGINT");
    return true;
  });
  assert.deepEqual(spawner.process.resizes, [{ columns: 120, rows: 40 }]);
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.listenerCount("data"), 0);
  assert.equal(terminal.listenerCount("resize"), 0);
  assert.equal(terminal.removedResizeListeners, 1);
});

test("PTY managed-session runner kills the provider and reports interruption on a second Ctrl-C", async () => {
  const spawner = new FakePtySpawner();
  const userInput = new FakeUserInput(true);

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput(),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
      userInput,
    },
  );

  userInput.emitData("\u0003");
  userInput.emitData(Buffer.from("\u0003"));

  assert.deepEqual(spawner.process.writes, ["\u0003"]);
  assert.equal(spawner.process.killed, true);

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof InterruptedProviderSessionError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, "SIGINT");
    return true;
  });
  assert.deepEqual(userInput.rawModeChanges, [true, false]);
  assert.equal(userInput.pauseCount, 1);
  assert.equal(userInput.listenerCount("data"), 0);
});

test("PTY managed-session runner surfaces cleanup failures after valid output", async () => {
  const spawner = new FakePtySpawner();
  const cleanupFailure = new Error("write failed");
  const events: ManagedProviderSessionEvent[] = [];
  spawner.process.write = () => {
    throw cleanupFailure;
  };

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      onProviderEvent(event) {
        events.push(event);
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");

  await assert.rejects(runPromise, (error: unknown) => {
    assert.ok(error instanceof ProviderSessionCleanupError);
    assert.equal(error.provider.id, "codex");
    assert.equal(error.cause, cleanupFailure);
    return true;
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["session-start", "turn-completed"],
  );
});

test("PTY managed-session runner repairs invalid artifacts inside the same session", async () => {
  const spawner = new FakePtySpawner();
  const validationStates: boolean[] = [];
  const validationFailure = new Error("artifact is invalid");

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {
        validationStates.push(spawner.process.isAlive);

        if (validationStates.length === 1) {
          throw validationFailure;
        }
      },
      repair: {
        completionMarker: "REPAIR_DONE",
        renderPrompt(error) {
          assert.equal(error, validationFailure);
          return "Repair the artifact.\nKeep the provider session open.";
        },
        mapFailure(error) {
          return new Error(`repair failed: ${error.message}`);
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("INITIAL_DONE\n");
  await waitForAsyncHandlers();
  assert.equal(spawner.process.killed, false);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Repair the artifact.\nKeep the provider session open.\u001b[201~\r",
  ]);

  spawner.process.emitData("REPAIR_DONE\n");
  await waitForAsyncHandlers();

  const result = await runPromise;

  assert.deepEqual(validationStates, [true, true]);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Repair the artifact.\nKeep the provider session open.\u001b[201~\r",
    "/exit\n",
  ]);
  assert.deepEqual(result, {
    repairUsed: true,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: "REPAIR_DONE",
  });
});

test("PTY managed-session runner maps repair validation failures", async () => {
  const spawner = new FakePtySpawner();
  const initialFailure = new Error("initial artifact is invalid");
  const repairFailure = new Error("repaired artifact is still invalid");
  const mappedFailure = new Error("mapped repair failure");
  let validationCount = 0;

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      initialCompletionMarker: "INITIAL_DONE",
      async validate() {
        validationCount += 1;

        if (validationCount === 1) {
          throw initialFailure;
        }

        throw repairFailure;
      },
      repair: {
        completionMarker: "REPAIR_DONE",
        renderPrompt(error) {
          assert.equal(error, initialFailure);
          return "Repair the artifact.";
        },
        mapFailure(error) {
          assert.equal(error, repairFailure);
          return mappedFailure;
        },
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("INITIAL_DONE\n");
  await waitForAsyncHandlers();
  spawner.process.emitData("REPAIR_DONE\n");

  await assert.rejects(runPromise, mappedFailure);
  assert.equal(validationCount, 2);
  assert.deepEqual(spawner.process.writes, [
    "\u001b[200~Repair the artifact.\u001b[201~\r",
    "/exit\n",
  ]);
});

test("PTY managed-session runner propagates initial validation failures when repair is absent", async () => {
  const spawner = new FakePtySpawner();
  const validationFailure = new Error("artifact is invalid");

  const runPromise = runPtyManagedSession(
    {
      provider: getBuiltInProviderIdentity("codex"),
      executable: "codex",
      args: [],
      cleanupCommand: "/exit\n",
    },
    createInput({
      async validate() {
        throw validationFailure;
      },
    }),
    {
      ptySpawner: spawner,
      outputSink: { write() {} },
      terminal: {},
    },
  );

  spawner.process.emitData("DEVFLOW_DONE\n");

  await assert.rejects(runPromise, validationFailure);
  assert.deepEqual(spawner.process.writes, ["/exit\n"]);
});
