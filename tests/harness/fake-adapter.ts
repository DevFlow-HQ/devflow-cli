import { ownPreparations } from "./preparation-double.js";
import { createFakeProcess } from "../process/fake-adapter.js";
// The deterministic fake Harness Adapter. It lives in the `harness` test domain
// and implements the Harness Adapter Interface (src/harness/harness.ts) from a
// per-test script. It exists for what a recording of a real Harness cannot
// serve: it exercises Interface behaviours Claude Code never exhibits (native
// steer, structured clarifications, load-with-replay recovery, several
// concurrent requests, every `lost` variant), and it lets suites drive the
// Interface without spawning a process. It is never the only end-to-end double.
//
// Determinism without sleeps: a Turn awaits its scripted requests' answers and
// the caller's controls, never a timer. Terminal ordering is exact — remaining
// events publish, outstanding requests expire, the producer closes, then the
// one result settles, and nothing is emitted afterwards.
//
// Load-with-replay is performed, not just advertised (#127 A38): a resumed Turn
// on a profile declaring that mode first re-emits the Session's recorded
// transcript history, drops any scripted entry that repeats a replayed one, then
// emits `REPLAY_BARRIER` before any live progress — all inside the closed event
// vocabulary, so history is "visibly historical" by its position before the
// barrier rather than by a new field.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentCall,
  AgentCallAnswer,
  AgentCallDeclaration,
  CleanupReport,
  ControlReceipt,
  ControlRejection,
  HarnessPhaseFact,
  HarnessPhaseObserver,
  HarnessPhaseStep,
  HarnessProfile,
  HarnessRequest,
  HarnessDefaults,
  HarnessFailure,
  ModelChange,
  ModelChoice,
  ModelObservation,
  PrepareResult,
  PreparedHarness,
  RecordingReceipt,
  RequestAnswer,
  RequestShape,
  SteerInput,
  TurnEvent,
  TurnEventListener,
  TurnRequest,
  TurnResult,
  TurnSubscription,
} from "../../src/harness/harness.js";
import type {
  TestHarnessAdapter,
  TestHarnessAdapterFactory,
  TestPrepareOptions,
} from "./test-adapters.js";

/** One request the scripted Turn raises. `awaited` Turns settle only once it is
 *  answered; a non-awaited request is expired at terminal. */
export interface FakeRequestSpec {
  readonly id: string;
  readonly shape: RequestShape;
  readonly awaited: boolean;
}

/** One scripted Turn. `startTurn` consumes the next entry of `turns`. */
export interface FakeTurnScript {
  readonly agentCalls?: readonly AgentCall[];
  /** Events emitted in order before requests are awaited. Request lifecycle
   *  events are managed by the fake and must not appear here. */
  readonly events?: readonly TurnEvent[];
  /** When set, awaited before each scripted event is emitted, so a test can let an
   *  observer read between events instead of receiving them as one synchronous
   *  burst. Without it the events emit synchronously, in order. */
  readonly pace?: (index: number) => Promise<void>;
  readonly requests?: readonly FakeRequestSpec[];
  /** When set with no awaited requests, the Turn blocks after its events until it
   *  is interrupted or the Harness is closed — the request-free "blocks mid-Turn"
   *  shape the interrupt/recovery cases drive. */
  readonly block?: boolean;
  /** A natural native boundary, independent of Steer acceptance or delivery. */
  readonly finish?: Promise<void>;
  /** When supplied, model exposure waits for this boundary. The natural result
   *  cannot settle while an accepted Steer still waits here. */
  readonly steerBoundary?: Promise<void>;
  /** The result settled when the Turn ends naturally (all awaited requests
   *  answered, or no awaited requests). */
  readonly result: TurnResult;
  /** The result settled when the caller interrupts. Defaults to a plain
   *  `interrupted` result echoing the profile's interruption capability. */
  readonly interruptResult?: TurnResult;
  /** A recovery coordinate revealed only after acceptance; recorded through the
   *  recorder's checkpoint and echoed on a `completed` result. */
  readonly revealCoordinateAfterAcceptance?: { readonly opaque: string };
  /** How the Harness answers a live `changeModel` on a `live-turn` profile (#348),
   *  with the observation the answer leaves. `report` holds the answer until it
   *  resolves, so a caller sees the change pending; a Turn that ends first reports
   *  none. Unscripted, a change is answered `next-turn` with an unknown model. */
  readonly modelChange?: {
    readonly report?: Promise<void>;
    readonly answer: FakeModelChangeAnswer;
  };
}

/** The fake's answer to one live Model choice change and what it leaves observed. */
export type FakeModelChangeAnswer = {
  readonly observation: ModelObservation;
} & (
  | { readonly outcome: "applied" }
  | {
      readonly outcome: "refused";
      readonly reason: string;
      readonly kept?: ModelChoice;
    }
  | { readonly outcome: "next-turn"; readonly reason: string }
);

/** The whole scripted Adapter. */
export interface FakeScript {
  readonly preparationClock?: Parameters<typeof ownPreparations>[1];
  readonly profile: HarnessProfile;
  /** When set, `prepare` returns this failure instead of a prepared Harness. */
  readonly prepareFailure?: HarnessFailure;
  readonly turns: readonly FakeTurnScript[];
  /** The report `close` returns; the same value on every call. */
  readonly cleanup?: CleanupReport;
  /** Handshake sub-steps each `prepare` reports inside its handshake, in order;
   *  the last fails with a scripted `prepareFailure` (#325). */
  readonly handshakeSteps?: readonly HarnessPhaseStep[];
  /** What `readDefaults` reports: the Harness's own Model choice, a fallback with
   *  its reason, or none to fall back to (the default). */
  readonly defaults?: HarnessDefaults;
  /** When given, each `startTurn` appends what its request carried, in order:
   *  the fake's record of the Model choice every Turn asked for. */
  readonly turnRequests?: FakeTurnRequestRecord[];
  /** When given, each accepted live `changeModel` appends its choice, in order. */
  readonly modelChanges?: ModelChoice[];
}

/** One Turn request as the fake received it. */
export interface FakeTurnRequestRecord {
  readonly session: string;
  readonly modelChoice?: ModelChoice;
}

const NO_DEFAULTS: HarnessDefaults = {
  kind: "unavailable",
  reason: "The fake Harness scripts no defaults.",
};

const DEFAULT_CLEANUP: CleanupReport = {
  clean: true,
  detail: "fake harness closed",
};

/** The history/live barrier a load-with-replay resume emits once, after every
 *  replayed history event and before any live event. */
export const REPLAY_BARRIER: TurnEvent = {
  kind: "activity",
  description: "history/live barrier: replayed history ends here",
};

/** The event kinds that are transcript content, and so are replayed as history
 *  on a load-with-replay resume. Request lifecycle, previews, and Session
 *  availability are live facts of the Turn that produced them, not history. */
const HISTORY_KINDS = new Set<TurnEvent["kind"]>([
  "assistant-content",
  "tool-call",
  "thought",
]);

/** Build a factory for the fake Adapter from a script. It spawns nothing, so a
 *  prepare's Process is optional. Given a prepare's phase observer, the fake
 *  reports what a native Adapter would around its scripted outcomes: a launch and
 *  handshake on each `prepare` that passes validation (the handshake failing with
 *  a scripted `prepareFailure`), and a cleanup on that Prepared Harness's first
 *  `close` (failing with the report's failure). Elapsed time is always zero. */
export function createFake(script: FakeScript): TestHarnessAdapterFactory {
  return () => {
    const owned = ownPreparations(
      new FakeAdapter(script),
      script.preparationClock,
    );
    return {
      prepare: (options) =>
        owned.prepare({
          ...options,
          process: options.process ?? createFakeProcess({}),
        }),
      close: (options) => owned.close(options),
    };
  };
}

class FakeAdapter implements Pick<TestHarnessAdapter, "prepare"> {
  constructor(private readonly script: FakeScript) {}

  prepare(options: TestPrepareOptions): Promise<PrepareResult> {
    const phases = ignoringThrows(options.phases);
    if (this.script.prepareFailure) {
      this.reportOpen(phases, this.script.prepareFailure);
      return Promise.resolve({
        ok: false,
        failure: this.script.prepareFailure,
      });
    }
    // The additional writable directory is validated as every real Adapter does
    // (#214): anything but an existing absolute directory is a typed failure.
    const directory = options.writableDirectory;
    if (directory !== undefined && !isExistingAbsoluteDirectory(directory)) {
      return Promise.resolve({
        ok: false,
        failure: {
          phase: "prepare",
          category: "writable-directory-unavailable",
          possibleEffects: "none",
          diagnostics: `The fake Harness cannot grant '${directory}'.`,
        },
      });
    }
    this.reportOpen(phases);
    return Promise.resolve({
      ok: true,
      harness: new FakePreparedHarness(this.script, phases),
    });
  }

  /** The launch and handshake a native prepare reports, with any scripted
   *  handshake steps nested inside; the handshake and its last step fail with
   *  `failure` when one is given. */
  private reportOpen(
    phases: HarnessPhaseObserver | undefined,
    failure?: HarnessFailure,
  ): void {
    phases?.({ kind: "phase-start", phase: "launch" });
    phases?.({
      kind: "phase-end",
      phase: "launch",
      elapsedMs: 0,
      outcome: "ok",
    });
    phases?.({ kind: "phase-start", phase: "handshake" });
    const steps = this.script.handshakeSteps ?? [];
    steps.forEach((step, index) => {
      phases?.({ kind: "phase-start", phase: "handshake", step });
      phases?.(endFact(index === steps.length - 1 ? failure : undefined, step));
    });
    phases?.(endFact(failure));
  }
}

/** `observer`, ignoring a throw as every Adapter must, so observation never
 *  changes a Harness outcome. */
function ignoringThrows(
  observer: HarnessPhaseObserver | undefined,
): HarnessPhaseObserver | undefined {
  if (observer === undefined) return undefined;
  return (fact) => {
    try {
      observer(fact);
    } catch {
      // Observation never changes a Harness outcome.
    }
  };
}

/** A handshake (or handshake step) end: failed with `failure` when given. */
function endFact(
  failure: HarnessFailure | undefined,
  step?: HarnessPhaseStep,
): HarnessPhaseFact {
  const key = {
    kind: "phase-end",
    phase: "handshake",
    ...(step === undefined ? {} : { step }),
    elapsedMs: 0,
  } as const;
  return failure === undefined
    ? { ...key, outcome: "ok" }
    : { ...key, outcome: "failed", failure };
}

function isExistingAbsoluteDirectory(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

class FakePreparedHarness implements PreparedHarness {
  readonly profile: HarnessProfile;
  private turnIndex = 0;
  private readonly declarations = new Map<
    string,
    readonly AgentCallDeclaration[]
  >();
  private active: FakeTurn | undefined;
  private closed = false;
  private readonly cleanup: CleanupReport;
  /** Per named Session, the transcript content every Turn so far emitted — what
   *  a load-with-replay resume replays. */
  private readonly history = new Map<string, TurnEvent[]>();

  constructor(
    private readonly script: FakeScript,
    private readonly phases: HarnessPhaseObserver | undefined,
  ) {
    this.profile = script.profile;
    this.cleanup = script.cleanup ?? DEFAULT_CLEANUP;
  }

  readDefaults(): Promise<HarnessDefaults> {
    if (this.closed) {
      return Promise.reject(
        new Error("readDefaults after close: the prepared Harness is closed"),
      );
    }
    return Promise.resolve(this.script.defaults ?? NO_DEFAULTS);
  }

  startTurn(request: TurnRequest): FakeTurn {
    if (this.closed) {
      throw new Error("startTurn after close: the prepared Harness is closed");
    }
    if (this.active && !this.active.settled) {
      throw new Error("startTurn while a Turn is active: one active Turn only");
    }
    const declarations = [...(request.agentCalls ?? [])]
      .map((call) => ({ ...call }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set<string>();
    for (const call of declarations) {
      if (
        !call.id ||
        ids.has(call.id) ||
        !Number.isInteger(call.maxReasonLength) ||
        call.maxReasonLength < 1 ||
        call.maxReasonLength > 400
      )
        throw new Error("invalid agent-call declaration");
      ids.add(call.id);
    }
    const bound = this.declarations.get(request.session);
    if (bound !== undefined && !isDeepStrictEqual(bound, declarations)) {
      throw new Error("agent-call declarations changed after Session open");
    }
    if (declarations.length > 0 && !this.profile.agentCalls.available) {
      throw new Error("agent calls are unsupported by this Harness");
    }
    this.declarations.set(request.session, declarations);
    const scripted = this.script.turns[this.turnIndex++];
    if (!scripted) {
      throw new Error("startTurn beyond the scripted Turns");
    }
    this.script.turnRequests?.push({
      session: request.session,
      ...(request.modelChoice !== undefined
        ? { modelChoice: request.modelChoice }
        : {}),
    });
    const history = this.history.get(request.session) ?? [];
    this.history.set(request.session, history);
    const turn = new FakeTurn(
      scripted,
      this.profile,
      { ...request, agentCalls: declarations },
      history,
      this.script.modelChanges,
    );
    this.active = turn;
    turn.begin();
    return turn;
  }

  close(): Promise<CleanupReport> {
    if (!this.closed) {
      this.phases?.({ kind: "phase-start", phase: "cleanup" });
      const failure = this.cleanup.failure;
      this.phases?.(
        failure === undefined
          ? { kind: "phase-end", phase: "cleanup", elapsedMs: 0, outcome: "ok" }
          : {
              kind: "phase-end",
              phase: "cleanup",
              elapsedMs: 0,
              outcome: "failed",
              failure,
            },
      );
    }
    this.closed = true;
    // Graceful stop of a still-live Turn, so `close` mid-Turn does not leave it
    // hanging; the settled result cannot be rewritten by cleanup.
    if (this.active && !this.active.settled) this.active.closeSettle();
    // Idempotent: the same report every time.
    return Promise.resolve(this.cleanup);
  }
}

interface RequestState {
  readonly request: HarnessRequest;
  status: "outstanding" | "answered";
  /** Resolves the driver's wait once an awaited request is answered. */
  release?: () => void;
}

class FakeTurn {
  settled = false;
  private terminal = false;
  private interrupting = false;
  private resolveResult!: (result: TurnResult) => void;
  private readonly resultPromise: Promise<TurnResult>;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly buffer: TurnEvent[] = [];
  private readonly requests = new Map<string, RequestState>();
  private readonly calls = new Map<string, "outstanding" | "answered">();
  private interruptSignal?: () => void;
  private readonly steers = new Map<
    string,
    SteerInput & { readonly sentAt: string }
  >();
  private readonly steerIds = new Set<string>();
  private steerBoundaryReached = false;

  constructor(
    private readonly script: FakeTurnScript,
    private readonly profile: HarnessProfile,
    private readonly request: TurnRequest,
    private readonly history: TurnEvent[],
    private readonly modelChanges: ModelChoice[] | undefined,
  ) {
    this.resultPromise = new Promise<TurnResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  begin(): void {
    // The handle is already returned; drive on a microtask so a caller can
    // subscribe first.
    queueMicrotask(() => {
      void this.drive();
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    // Replay history so a late subscriber sees the ordered stream from its
    // start. This is replay to a new consumer, not a new event, so it does not
    // breach terminal ordering even after the result has settled.
    for (const event of this.buffer) listener(event);
    if (!this.settled) this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  async steer(input: SteerInput): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    if (!this.profile.steer.available) return reject("unsupported");
    if (this.steerIds.has(input.steerId)) return reject("already-settled");
    this.steerIds.add(input.steerId);
    this.steers.set(input.steerId, {
      ...input,
      sentAt: new Date().toISOString(),
    });
    if (this.script.steerBoundary !== undefined) {
      void this.script.steerBoundary.then(() => {
        this.steerBoundaryReached = true;
        if (!this.terminal) this.deliverSteers("after-boundary");
      });
    }
    return accept();
  }

  async changeModel(choice: ModelChoice): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    if (this.profile.modelChange.reach !== "live-turn")
      return reject("unsupported");
    this.modelChanges?.push(choice);
    const scripted = this.script.modelChange;
    void (scripted?.report ?? Promise.resolve()).then(() => {
      // A Turn that ended first reports no outcome.
      if (this.terminal) return;
      const answer: FakeModelChangeAnswer = scripted?.answer ?? {
        outcome: "next-turn",
        reason: "The fake Harness scripts no live change.",
        observation: { known: false },
      };
      this.emit({
        kind: "model",
        observation: answer.observation,
        change: modelChange(choice, answer),
      });
    });
    return accept();
  }

  private deliverSteers(delivery: "within-turn" | "after-boundary"): void {
    for (const steer of this.steers.values()) {
      this.steers.delete(steer.steerId);
      this.emit({
        kind: "steer",
        ...steer,
        settlement: { kind: "delivered", delivery },
      });
    }
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    if (this.interrupting) return reject("already-settled");
    this.interrupting = true;
    // Reject new inputs immediately; the driver drains to the interrupt result.
    this.terminal = true;
    this.interruptSignal?.();
    return accept();
  }

  async answerAgentCall(answer: AgentCallAnswer): Promise<ControlReceipt> {
    if (!this.profile.agentCalls.available) return reject("unsupported");
    if (this.terminal) return reject("expired");
    const status = this.calls.get(answer.callId.opaque);
    if (status === undefined) return reject("expired");
    if (status === "answered") return reject("already-settled");
    this.calls.set(answer.callId.opaque, "answered");
    return accept();
  }

  async answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    const state = this.requests.get(answer.requestId.opaque);
    if (!state) return reject("expired");
    if (state.status === "answered") return reject("already-settled");
    if (answer.kind !== state.request.shape.kind)
      return reject("shape-mismatch");
    state.status = "answered";
    this.emit({
      kind: "request-answered",
      requestId: answer.requestId,
      by: "human",
      answer,
    });
    state.release?.();
    return accept();
  }

  private async drive(): Promise<void> {
    // A model the profile's declared list does not admit refuses the Turn before
    // admission, never a substitution (ADR 0034). A suggested or free-text
    // declaration admits any value; a selection-unavailable profile ignores it.
    const selection = this.profile.modelSelection;
    const model = this.request.modelChoice?.model;
    if (
      model !== undefined &&
      selection.at !== "unavailable" &&
      selection.declaration.kind === "list" &&
      !selection.declaration.models.some((entry) => entry.model === model)
    ) {
      this.settle({
        kind: "not-started",
        detail: {
          failure: {
            phase: "turn",
            category: "model-unavailable",
            possibleEffects: "none",
            diagnostics: `The fake Harness does not offer the requested model '${model}'.`,
          },
        },
      });
      return;
    }
    const admission = await this.admit();
    if (!admission.recorded) {
      this.settle(
        notStarted(
          admission.reason,
          "cause" in admission ? admission.cause : admission.reason,
        ),
      );
      return;
    }
    let checkpoint: RecordingReceipt | undefined;
    const coordinate = this.script.revealCoordinateAfterAcceptance;
    if (coordinate) {
      checkpoint = await this.request.recorder.checkpoint(coordinate);
    }

    if (!this.terminal) {
      const pace = this.script.pace;
      if (pace === undefined) {
        for (const event of this.liveEvents()) {
          if (this.script.steerBoundary === undefined)
            this.deliverSteers("within-turn");
          this.emit(event);
        }
      } else {
        await this.emitPaced(pace);
      }
      for (const call of this.script.agentCalls ?? []) {
        if (this.terminal) break;
        const declaration = this.request.agentCalls?.find(
          (item) => item.id === call.id,
        );
        if (
          declaration === undefined ||
          !call.reason.trim() ||
          call.reason.length > Math.min(400, declaration.maxReasonLength)
        )
          continue;
        this.calls.set(call.callId.opaque, "outstanding");
        this.emit({ kind: "agent-call", phase: "raised", call });
      }
      if (this.script.requests?.length) {
        await this.raiseAndAwaitRequests();
      } else if (this.script.block) {
        await this.awaitInterrupt();
      }
    }

    if (this.settled) return;
    if (this.interrupting) {
      this.settle(this.script.interruptResult ?? this.defaultInterrupt());
      return;
    }
    if (this.script.result.kind === "completed" && this.steers.size > 0) {
      if (
        this.script.steerBoundary !== undefined &&
        !this.steerBoundaryReached
      ) {
        await Promise.race([
          this.script.steerBoundary,
          this.awaitInterrupt(false),
        ]);
        if (this.settled) return;
        if (this.interrupting) {
          this.settle(this.script.interruptResult ?? this.defaultInterrupt());
          return;
        }
      }
      this.deliverSteers(
        this.script.steerBoundary === undefined
          ? "within-turn"
          : "after-boundary",
      );
    }
    this.settle(withCheckpoint(this.script.result, checkpoint));
  }

  private async emitPaced(
    pace: (index: number) => Promise<void>,
  ): Promise<void> {
    for (const [index, event] of this.liveEvents().entries()) {
      await pace(index);
      if (this.terminal) return;
      if (this.script.steerBoundary === undefined)
        this.deliverSteers("within-turn");
      this.emit(event);
    }
  }

  /** The scripted events to emit live. On a load-with-replay resume the recorded
   *  history is replayed first, a scripted entry that repeats a replayed one is
   *  reconciled away (it appears once, as history), and the barrier follows the
   *  history so every live event lands after it. */
  private liveEvents(): readonly TurnEvent[] {
    const scripted = this.script.events ?? [];
    if (
      this.request.resume === undefined ||
      this.profile.recovery.mode !== "load-with-replay"
    ) {
      return scripted;
    }
    const replayed = [...this.history];
    for (const event of replayed) this.emit(event, { record: false });
    this.emit(REPLAY_BARRIER, { record: false });
    return scripted.filter(
      (event) => !replayed.some((past) => isDeepStrictEqual(past, event)),
    );
  }

  private awaitInterrupt(natural = true): Promise<void> {
    if (this.interrupting || this.terminal) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.interruptSignal = resolve;
      if (natural) void this.script.finish?.then(resolve);
    });
  }

  /** Settle a live Turn on `close`: lost, since no authoritative result arrived,
   *  and release the blocked driver. */
  closeSettle(): void {
    if (this.settled) return;
    this.settle({
      kind: "lost",
      detail: {
        unknown: "completion",
        lastObservation: "the Harness closed during a live Turn",
        session: {
          state: "detached",
          coordinate: { opaque: this.request.session },
        },
      },
    });
    this.interruptSignal?.();
  }

  private async admit(): Promise<
    | RecordingReceipt
    | {
        readonly recorded: false;
        readonly reason: string;
        readonly cause: unknown;
      }
  > {
    try {
      return await this.request.recorder.admit({
        correlationKey: this.request.correlationKey,
        session: this.request.session,
        origin: this.request.origin,
        input: this.request.input,
        recoveryCoordinate:
          this.request.resume ?? ({ opaque: this.request.session } as const),
        resume: this.request.resume,
      });
    } catch (error) {
      return { recorded: false, reason: describe(error), cause: error };
    }
  }

  private async raiseAndAwaitRequests(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const spec of this.script.requests ?? []) {
      const request: HarnessRequest = {
        requestId: { opaque: spec.id },
        shape: spec.shape,
      };
      const state: RequestState = { request, status: "outstanding" };
      this.requests.set(spec.id, state);
      this.emit({ kind: "request-raised", request });
      if (spec.awaited) {
        waits.push(
          new Promise<void>((resolve) => {
            state.release = resolve;
          }),
        );
      }
    }
    if (waits.length === 0) return;
    const interrupted = new Promise<void>((resolve) => {
      this.interruptSignal = resolve;
    });
    await Promise.race([Promise.all(waits), interrupted]);
  }

  /** Terminal ordering: expire outstanding requests, close the producer, then
   *  settle the one result. No event is emitted after this. */
  private settle(result: TurnResult): void {
    if (this.settled) return;
    this.terminal = true;
    const previews = this.buffer.filter(
      (event) =>
        event.kind === "message-preview" || event.kind === "thought-preview",
    );
    this.removePreviews();
    for (const event of previews)
      if (event.kind === "thought-preview")
        this.emit({
          kind: "thought",
          summaryId: event.summaryId,
          content: event.content,
          incomplete: true,
        });
      else if (event.kind === "message-preview")
        this.emit({
          kind: "assistant-content",
          messageId: event.messageId,
          content: event.content,
          incomplete: true,
        });
    for (const steer of this.steers.values()) {
      this.emit({
        kind: "steer",
        ...steer,
        settlement: {
          kind: "dropped",
          reason: result.kind === "interrupted" ? "interrupt" : "loss",
        },
      });
    }
    this.steers.clear();
    for (const [opaque, status] of this.calls) {
      if (status === "outstanding")
        this.emit({ kind: "agent-call", phase: "expired", callId: { opaque } });
    }
    for (const [, state] of this.requests) {
      if (state.status === "outstanding") {
        this.emit({
          kind: "request-expired",
          requestId: state.request.requestId,
        });
      }
    }
    this.settled = true;
    this.listeners.clear();
    this.resolveResult(result);
  }

  private emit(
    event: TurnEvent,
    options: { readonly record: boolean } = { record: true },
  ): void {
    if (this.settled) throw new Error("emit after result: terminal ordering");
    if (event.kind === "thought") this.removeThoughtPreviews(event.summaryId);
    if (event.kind === "thought-preview" && !event.content.trim()) return;
    if (event.kind === "assistant-content")
      this.removePreviews(event.messageId);
    if (event.kind === "tool-call" && event.call.outcome.kind !== "running") {
      for (let index = this.buffer.length - 1; index >= 0; index--) {
        const retained = this.buffer[index];
        if (
          retained?.kind === "tool-preview" &&
          retained.call.callId === event.call.callId
        )
          this.buffer.splice(index, 1);
      }
    }
    const preview =
      event.kind === "tool-preview"
        ? this.buffer.findIndex(
            (retained) =>
              retained.kind === "tool-preview" &&
              retained.call.callId === event.call.callId,
          )
        : event.kind === "message-preview"
          ? this.buffer.findIndex(
              (retained) =>
                retained.kind === "message-preview" &&
                retained.messageId === event.messageId,
            )
          : -1;
    const thoughtPreview =
      event.kind === "thought-preview"
        ? this.buffer.findIndex(
            (retained) =>
              retained.kind === "thought-preview" &&
              retained.summaryId === event.summaryId,
          )
        : -1;
    if (thoughtPreview >= 0) this.buffer[thoughtPreview] = event;
    else if (preview < 0) this.buffer.push(event);
    else this.buffer[preview] = event;
    if (options.record && HISTORY_KINDS.has(event.kind)) {
      this.history.push(event);
    }
    for (const listener of this.listeners) listener(event);
  }

  private removeThoughtPreviews(summaryId?: string): void {
    for (let index = this.buffer.length - 1; index >= 0; index--) {
      const event = this.buffer[index];
      if (
        event?.kind === "thought-preview" &&
        (summaryId === undefined || event.summaryId === summaryId)
      )
        this.buffer.splice(index, 1);
    }
  }
  private removePreviews(messageId?: string): void {
    if (messageId === undefined) this.removeThoughtPreviews();
    for (let index = this.buffer.length - 1; index >= 0; index -= 1) {
      const event = this.buffer[index];
      if (
        event.kind === "message-preview" &&
        (messageId === undefined || event.messageId === messageId)
      )
        this.buffer.splice(index, 1);
    }
  }

  private defaultInterrupt(): TurnResult {
    return {
      kind: "interrupted",
      detail: {
        interruption: this.profile.interruption,
        session: {
          state: "detached",
          coordinate: { opaque: this.request.session },
        },
      },
    };
  }
}

function modelChange(
  requested: ModelChoice,
  answer: FakeModelChangeAnswer,
): ModelChange {
  switch (answer.outcome) {
    case "applied":
      return { requested, outcome: "applied" };
    case "refused":
      return {
        requested,
        outcome: "refused",
        reason: answer.reason,
        ...(answer.kept === undefined ? {} : { kept: answer.kept }),
      };
    case "next-turn":
      return { requested, outcome: "next-turn", reason: answer.reason };
  }
}

function accept(): ControlReceipt {
  return { outcome: "accepted" };
}

function reject(reason: ControlRejection): ControlReceipt {
  return { outcome: "rejected", reason };
}

function notStarted(reason: string, cause: unknown): TurnResult {
  const failure: HarnessFailure = {
    phase: "turn",
    category: "durable-admission",
    possibleEffects: "none",
    cause,
    diagnostics: reason,
  };
  return { kind: "not-started", detail: { failure } };
}

function withCheckpoint(
  result: TurnResult,
  checkpoint: RecordingReceipt | undefined,
): TurnResult {
  if (!checkpoint || result.kind !== "completed") return result;
  return {
    kind: "completed",
    detail: { ...result.detail, recoveryCheckpoint: checkpoint },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
