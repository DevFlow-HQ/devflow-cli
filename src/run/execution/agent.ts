import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  FRESH_SESSION,
  promptSlotPattern,
  WORKING_AREA_SLOT,
  type AgentStep,
  type ArtifactType,
  type AssetKind,
  type AttemptOutcome,
  type Reference,
  type StepKindName,
} from "../../workflow/workflow.js";
import { waitingAgentTurn } from "../store/store.js";
import type {
  AgentAttemptEvidence,
  CandidateOutput,
  HarnessIdentityRecord,
  OutputReceiptDirectoryResult,
  RunOwner,
  TurnKind,
  TurnRecord,
  WriteResult,
} from "../store/store.js";
import type {
  DurableTurnRecorder,
  HarnessFailure,
  HarnessProfile,
  ModelChoice,
  PreparedHarness,
  RecoveryCoordinate,
  RequestAnswer,
  TurnEvent,
  TurnOrigin,
  TurnResult,
} from "../../harness/harness.js";
import type {
  ExecutionObserver,
  HumanTurnPause,
  TurnFailureFacts,
} from "./execution.js";
import { observedWrite } from "./store-write.js";
import { guardedExecutionObserver } from "./observer.js";

// --- Live request-answer channel (#117) ------------------------------------
//
// The Seam an Agent Step's live approval Harness Requests reach a client through.
// Execution adapts the live Harness Turn (its `request-raised`/`answered`/`expired`
// events and its `answerRequest` control) into these normalized, Harness-agnostic
// notifications. The Application provides the channel per Run and turns the
// notifications into the `run` Projection's live overlay; a client answers through
// `answerRequest`, whose outcome is a value, never a throw (ADR 0022). Defined here
// (not in the Application) because execution owns the Step context and must not
// import above its Seam. Absent for a Command-only Run and whenever no client wired
// one in.

/** Who answered a request — carried down so the durable `request-answered` names
 *  the provenance the Harness Adapter cannot know (a client policy vs a human). */
type RequestAnswerBy = "human" | "client-policy";

/** One outstanding approval request, flattened to strings. */
export interface LiveRequestView {
  readonly requestId: string;
  readonly tool: string;
  readonly input: string;
  readonly decisions: readonly ("allow" | "deny")[];
}

/** The normalized outcome of answering one request. Never throws. */
type LiveAnswerOutcome =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "indeterminate" };

/** Answer one outstanding request on the live Turn. */
export type RequestAnswerFn = (
  requestId: string,
  decision: "allow" | "deny",
  by: RequestAnswerBy,
) => Promise<LiveAnswerOutcome>;

/** The outcome of steering the live Turn (#148): accepted, or a rejected native
 *  control race carrying its reason. Mirrors {@link LiveAnswerOutcome}. */
type LiveSteerOutcome =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly reason: string };

/** Send same-Turn guidance to the live Turn (#148). Bound only while a Turn whose
 *  Harness declares native steer is live; the Application reaches it for an
 *  available `steer-turn`. */
export type LiveSteerFn = (input: {
  readonly steerId: string;
  readonly text: string;
}) => Promise<LiveSteerOutcome>;

/** Interrupt one live Turn and report whether it ended interrupted or lost.
 *  Receipt rejection returns immediately; acceptance waits for this Turn's end. */
export type LiveInterruptFn = () => Promise<
  | { readonly outcome: "applied" }
  | { readonly outcome: "rejected"; readonly reason: string }
>;

/** Coalesced live observations for the overlay (never durable). */
export interface LiveObservation {
  readonly activity?: string;
  readonly preview?: string;
  readonly context?: {
    readonly usedTokens: number;
    readonly limitTokens: number;
  };
  readonly usage?: string;
}

export interface RequestChannel {
  /** An approval request was raised on the live Turn (now outstanding). */
  raised(request: LiveRequestView): void;
  /** The request was answered or expired; it is no longer outstanding. */
  settled(requestId: string): void;
  /** Bind (or, with `undefined`, unbind) the answer function for the active Turn.
   *  Bound before the first request can be raised, unbound when the Turn ends. */
  bindAnswer(answer: RequestAnswerFn | undefined): void;
  /** Bind (or, with `undefined`, unbind) the steer function for the active Turn
   *  (#148). Bound alongside the answer function and unbound when the Turn ends;
   *  the Application reaches it for an available `steer-turn`. */
  bindSteer(steer: LiveSteerFn | undefined): void;
  /** Bind (or unbind) interrupt for this Turn only, alongside answer and steer. */
  bindInterrupt(interrupt: LiveInterruptFn | undefined): void;
  /** The live Turn's Session commands (ADR 0040): the typed leading words the
   *  Harness runs as its own commands, replaced at each Session fact and cleared
   *  (`undefined`) when the Turn ends. Steer admission refuses them mid-Turn. */
  sessionCommands(commands: readonly string[] | undefined): void;
  /** Merge live overlay observations (activity / preview / context / usage). */
  observe(observation: LiveObservation): void;
}

/** What an Agent Step needs from composition (#116): the prepared Harness the Run
 *  owns (started once, reused across every Agent Step naming the same Session, and
 *  closed by composition when the Run rests), plus the manifest facts prompt
 *  rendering resolves against — the declared type of each Launch input (so a `file`
 *  slot renders as a path and a `file-set` as one path per line) and the kind of
 *  each declared asset (so only a `skill` in `uses` appends a `SKILL.md` line). */
export interface HarnessExecutionDeps {
  readonly prepared: PreparedHarness;
  readonly inputTypes: Readonly<Record<string, ArtifactType>>;
  readonly assetKinds: Readonly<Record<string, AssetKind>>;
}

/** Thrown by `executeRouting` when the caller's cancel signal aborts a Command
 *  mid-run: the child's process group is killed and the walk unwinds without
 *  publishing an Attempt or resting the Run, so `cancel-run` owns the `cancelled`
 *  rest. The Application drives that cancel signal in production (`wiring.ts`
 *  passes the signal; `application.ts` aborts with `RUN_CANCEL_ABORT`, #87/#98). */
export class RunCancelledError extends Error {
  constructor() {
    super("execution: the Run was cancelled mid-command.");
    this.name = "RunCancelledError";
  }
}

// Run-wide cancellation and process signals stop live work through the cancel
// Seam. RUN_CANCEL_ABORT ends the Run cancelled; SIGNAL_ABORT leaves it halted
// and resumable (ADR 0019). A Port interrupt is bound to its Turn separately.
export const RUN_CANCEL_ABORT = "secant:cancel-run";
export const SIGNAL_ABORT = "secant:process-signal";

/** One Step Attempt's outcome and, when it ran, the outputs to publish. */
export interface StepAttempt {
  readonly outcome: AttemptOutcome;
  readonly outputs: readonly CandidateOutput[];
  /** The effective model an Agent Step's Turn ran under (#116), recorded on the
   *  Attempt. Absent for a Command/Gate Attempt. */
  readonly effectiveModel?: string;
  /** The normalized Harness identity an autonomous Agent Step's Turn qualified under,
   *  from the prepared profile (#125): Harness name, resolved executable, and observed
   *  executable version. Present for every autonomous Agent Step Attempt (whatever its
   *  outcome), so the identity is durable even for an interrupted, lost, or
   *  recovery-refused Turn. Absent for a Command/Gate Attempt, and for the
   *  interactive-agent Step's synthetic Attempt (#122), which records neither identity
   *  nor effective model — the same scope as `effectiveModel`. */
  readonly harnessIdentity?: HarnessIdentityRecord;
}

/** The human's message continuing an Agent Step's Attempt after an Interrupt
 *  (#354), keyed on the interrupted Turn it answers. */
export interface AgentFollowUp {
  readonly turnId: string;
  readonly text: string;
}

interface StepContext {
  readonly owner: RunOwner;
  readonly resolveAsset: (assetPath: string) => string | undefined;
  readonly cancelSignal?: AbortSignal;
  readonly harness?: HarnessExecutionDeps;
  readonly requestChannel?: RequestChannel;
  readonly observe: ExecutionObserver;
  readonly followUp?: AgentFollowUp;
}

/** An Agent Step's Attempt waits for the human's follow-up (#354). */
const AWAITS_FOLLOW_UP: HumanTurnPause = { pause: true, awaitsHumanTurn: true };

// --- Agent step (a Harness Turn dispatch entry, #116) ----------------------

/**
 * Run the Attempt's autonomous Turn in the Step's named Session and map its result
 * to an Attempt outcome (#116). An Attempt may already hold Turns — a walk resumed
 * after a crash mid-Turn re-mints the same Attempt id — so the Turn takes the next
 * id in order and, as the Attempt's last Turn, gives it its outcome (#352). The
 * rendered prompt is admitted as the Turn's transcript input before the stdin frame
 * is sent (the durable recorder the Adapter awaits: a write failure proves the Turn
 * `not-started`), events drain into the Store as they arrive, and the settled result
 * maps: `completed` → `succeeded`; `failed` and `not-started` → `failed` (retryable
 * within budget); `interrupted` by a process signal → `cancelled` (Run `halted`);
 * `lost` → `indeterminate` (Run `halted`). A Step declaring
 * `text` outputs succeeds only when each validated receipt file is present after a
 * completed Turn (#215); a Step declaring none publishes an empty output set.
 *
 * A Port Interrupt ends only the Turn (#354, ADR 0035): the Attempt stays open and
 * the Step pauses for the human. A later walk re-minting that Attempt sends the
 * human's follow-up verbatim as a human-origin Turn of it, keeping its receipts, and
 * the Attempt takes its outcome from that Turn; without the matching follow-up it
 * pauses again rather than re-send the prompt.
 */
export async function runAgent(
  step: AgentStep,
  context: StepContext,
  attemptId: string,
): Promise<StepAttempt | HumanTurnPause> {
  const harness = context.harness;
  if (harness === undefined) {
    // Preflight guarantees a prepared Harness for a Bundle carrying an Agent Step;
    // reaching here without one is a wiring fault composition owns.
    throw new Error("execution: an Agent Step ran without a prepared Harness.");
  }
  const owner = context.owner;
  // Waiting is decided here alone, so a stale or absent follow-up can never send a
  // Turn anywhere: it only pauses the Step again.
  const waiting = waitingAgentTurn(owner);
  const followUp =
    waiting?.attemptId === attemptId &&
    context.followUp?.turnId === waiting.turnId
      ? context.followUp
      : undefined;
  if (waiting?.attemptId === attemptId && followUp === undefined) {
    return AWAITS_FOLLOW_UP;
  }
  const rendered =
    followUp === undefined
      ? renderAgentPrompt(step, context, harness)
      : ({ ok: true, prompt: followUp.text } as const);
  if (!rendered.ok) {
    return mapTurnResult(rendered.result, harness.prepared.profile);
  }
  // `fresh` isolates a new Session per Attempt (per Iteration inside a Repeat
  // group, since the Attempt id encodes both); any other name is reused, so
  // successive Agent Steps naming it share one live process.
  const session =
    step.session === FRESH_SESSION
      ? `${FRESH_SESSION}-${attemptId}`
      : step.session;
  const turnId = nextAgentTurnId(owner, attemptId);

  const recovery = sessionRecovery(owner, session);
  // `unusable`: recovery already failed and ADR 0022 forbids fabricating a fresh
  // conversation, so the Attempt fails without starting a Turn — no retry ever
  // opens a fresh Session in its place. It still ran under a qualified Harness, so the
  // failed Attempt records the identity (#125), never the effective model (no Turn ran).
  if (recovery.unusable) {
    return {
      outcome: "failed",
      outputs: [],
      harnessIdentity: profileIdentity(harness.prepared.profile),
    };
  }

  // Each declared output is captured only from a receipt file at a fresh per-Attempt
  // path the prompt names (#215) — never parsed from assistant prose. Receipts live
  // in the working area (#220); preparing them is the one typed check (#305), so a
  // failure admits and sends no Turn. A follow-up keeps the Attempt's directory: the
  // receipt lines went into its first Turn, and the agent may have written there.
  const prepared = prepareReceipts(step, owner, attemptId, {
    keep: followUp !== undefined,
  });
  if (!prepared.ok) {
    return mapTurnResult(
      unusableDirectoryFailure(prepared.problem),
      harness.prepared.profile,
    );
  }
  const receipts = prepared.receipts;
  // The human's text is the Turn's input verbatim; only the prompt carries the
  // receipt lines.
  const input =
    followUp !== undefined || receipts.length === 0
      ? rendered.prompt
      : `${rendered.prompt}\n\n${receipts.map(receiptInstruction).join("\n")}`;

  const result = await driveHarnessTurn(owner, harness.prepared, {
    session,
    origin: followUp !== undefined ? "human" : "managed",
    kind: "agent",
    attemptId,
    turnId,
    input,
    observe: context.observe,
    ...(recovery.resume !== undefined ? { resume: recovery.resume } : {}),
    ...(context.requestChannel !== undefined
      ? { requestChannel: context.requestChannel }
      : {}),
    ...(context.cancelSignal !== undefined
      ? { cancelSignal: context.cancelSignal }
      : {}),
  });
  if (interruptWaits(result.kind, context.cancelSignal)) {
    return AWAITS_FOLLOW_UP;
  }
  const attempt = mapTurnResult(result, harness.prepared.profile);
  if (attempt.outcome !== "succeeded" || receipts.length === 0) return attempt;
  // A completed Turn is only a Harness boundary: the Step succeeds only when every
  // required receipt validates. A missing or invalid one fails the Attempt, which
  // moves no binding (retryable within budget, like any failed Agent Attempt).
  // ponytail: which receipt failed and why is not recorded — a failed Attempt has
  // no diagnostic channel yet (the Command-step spawn cause shares this gap).
  const outputs: CandidateOutput[] = [];
  for (const receipt of receipts) {
    const content = readReceipt(receipt.path);
    if (content === undefined) return { ...attempt, outcome: "failed" };
    outputs.push({ name: receipt.name, type: "text", content });
  }
  return { ...attempt, outputs };
}

// --- An Attempt's Turns (#352) ---------------------------------------------

/** Every admitted Turn of one Attempt, in admission order. */
function attemptTurns(
  owner: Pick<RunOwner, "turns">,
  attemptId: string,
): readonly TurnRecord[] {
  return owner.turns().filter((turn) => turn.attemptId === attemptId);
}

/** The id keying an Agent Step Attempt's next durable Turn record: one past the
 *  Attempt's admitted Turns, whatever their origin or id, so a later Turn joining the
 *  Attempt never collides with an earlier one — including a row admitted before this
 *  scheme as `#turn`. */
function nextAgentTurnId(
  owner: Pick<RunOwner, "turns">,
  attemptId: string,
): string {
  return `${attemptId}#turn-${attemptTurns(owner, attemptId).length + 1}`;
}

// --- Required text output receipts (#215) ----------------------------------

/** The byte cap on one receipt: a reference, not a document. */
const MAX_RECEIPT_BYTES = 64 * 1024;

interface Receipt {
  readonly name: string;
  readonly path: string;
}

/** One receipt path per declared output, in a fresh per-Attempt directory the Run
 *  Store owns. Composition admits only `text` outputs on an Agent Step. */
function prepareReceipts(
  step: AgentStep,
  owner: RunOwner,
  attemptId: string,
  options: { readonly keep: boolean },
):
  | { readonly ok: true; readonly receipts: readonly Receipt[] }
  | Extract<OutputReceiptDirectoryResult, { ok: false }> {
  const produces = step.produces ?? [];
  if (produces.length === 0) return { ok: true, receipts: [] };
  const dir = owner.outputReceiptDirectory(attemptId, options);
  if (!dir.ok) return dir;
  return {
    ok: true,
    receipts: produces.map((produced) => ({
      name: produced.name,
      path: join(dir.path, produced.name),
    })),
  };
}

function receiptInstruction(receipt: Receipt): string {
  return `Write the required output "${receipt.name}" as UTF-8 text to ${receipt.path} before you finish; Secant completes this Step only from that file.`;
}

/** Validate one receipt at this ingress: a regular file (not a link or directory)
 *  within the byte cap, valid UTF-8, and non-empty once trimmed. Returns the trimmed
 *  text's bytes, or undefined when the receipt is missing or invalid. The value is
 *  kept opaque — a remote reference is the agent's observation, never checked
 *  against the tracker it names. */
function readReceipt(path: string): Uint8Array | undefined {
  let bytes: Uint8Array;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return undefined;
    bytes = readFileSync(path);
  } catch {
    return undefined;
  }
  if (bytes.byteLength > MAX_RECEIPT_BYTES) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return undefined;
  }
  return text === "" ? undefined : new TextEncoder().encode(text);
}

/** What the named Session's last recorded availability says about how the next Turn
 *  opens (#118): `unusable` forbids another Turn (recovery failed, ADR 0022);
 *  `detached` resumes the same Claude Code Session from the stored coordinate;
 *  absent or `open` opens a fresh Turn (a first launch or a healthy same-Session
 *  Turn). Shared by the autonomous Agent Step and the interactive human Turn. */
function sessionRecovery(
  owner: RunOwner,
  session: string,
):
  | { readonly unusable: true }
  | { readonly unusable: false; readonly resume?: RecoveryCoordinate } {
  const record = owner
    .harnessSessions()
    .find((candidate) => candidate.session === session);
  if (record?.availability === "unusable") return { unusable: true };
  const resume: RecoveryCoordinate | undefined =
    record?.availability === "detached" &&
    record.availabilityDetail !== undefined
      ? { opaque: record.availabilityDetail }
      : undefined;
  return { unusable: false, ...(resume !== undefined ? { resume } : {}) };
}

/** The Run's current Model choice (ADR 0034), read fresh from the owner's record
 *  each Turn, or undefined for a legacy Run that holds none. An empty stored model
 *  is no choice, as it was at prepare. */
function currentModelChoice(owner: RunOwner): ModelChoice | undefined {
  const choice = owner.record.modelChoice;
  return choice === undefined || choice.model.length === 0 ? undefined : choice;
}

/** The mechanical driving of one Harness Turn shared by the autonomous Agent Step
 *  and the interactive human Turn (#116, #122): admit the input as the Turn's
 *  transcript before the stdin frame (the durable admission the Adapter awaits),
 *  drain events into the Store, relay approval requests to the live channel, wire the
 *  cancel Seam to `interrupt`, settle the durable Turn, and return the raw result.
 *  A full cancel-run (RUN_CANCEL_ABORT) throws `RunCancelledError` so the cancel path
 *  owns the `cancelled` rest; every other result is returned for the caller to map. */
async function driveHarnessTurn(
  owner: RunOwner,
  prepared: PreparedHarness,
  params: {
    readonly session: string;
    readonly origin: TurnOrigin;
    /** The Crucible Step kind that produced this Turn (#126). This is the Step-kind
     *  dispatch seam: the kind is known from the executing Step — the Agent executor
     *  passes `agent`, the interactive human Turn passes `interactive-agent` — and is
     *  recorded durably at admission, never derived from a Harness-native type. */
    readonly kind: TurnKind;
    readonly attemptId: string;
    readonly turnId: string;
    readonly input: string;
    readonly resume?: RecoveryCoordinate;
    readonly requestChannel?: RequestChannel;
    readonly cancelSignal?: AbortSignal;
    /** True for an interactive human Turn: record its Session detached so a later
     *  reopen or following Agent Step can resume it. The Harness is held for the
     *  interactive Step and closed once when that Step is released. */
    readonly detachAfterTurn?: boolean;
    /** Reports the Turn's durable admission and its settlement (#320); nothing
     *  per streamed event. */
    readonly observe: ExecutionObserver;
  },
): Promise<TurnResult> {
  const { session, attemptId, turnId, observe } = params;
  const ids = { runId: owner.runId, attemptId, turnId, session };
  const harnessName = prepared.profile.harness;
  // The one read of the Model choice current at Turn start (ADR 0034): the same
  // value is sent on the Turn request and recorded on the admitted Turn, so the
  // Turn's record is what it asked for. Every Agent, Entry, and human Turn passes
  // here.
  const modelChoice = currentModelChoice(owner);
  // The recovery coordinate the Adapter reveals at admission (Claude Code reveals it
  // before submission), captured so an interactive Turn can settle `detached` by it.
  let recoveryCoordinate: string | undefined;
  const recorder: DurableTurnRecorder = {
    admit(admission) {
      const result = observedWrite(
        observe,
        owner.runId,
        { write: "turn-admission", attemptId, turnId },
        () =>
          owner.admitTurn({
            turnId,
            attemptId,
            session,
            origin: admission.origin,
            kind: params.kind,
            input: admission.input.text,
            ...(modelChoice !== undefined ? { modelChoice } : {}),
            recoveryCoordinate: admission.recoveryCoordinate.opaque,
            harness: harnessName,
            at: new Date(),
          }),
      );
      // Only a durable admission makes the coordinate meaningful; a fenced (rejected)
      // admission drives the Turn `not-started`, whose availability is never detached.
      if (result.ok) {
        recoveryCoordinate = admission.recoveryCoordinate.opaque;
        observe({ kind: "turn-start", ...ids });
      }
      return Promise.resolve(
        result.ok
          ? { recorded: true }
          : { recorded: false, reason: result.reason },
      );
    },
    // M3 records the recovery coordinate at admission (Claude Code reveals it before
    // submission), so a later checkpoint is a no-op success.
    checkpoint() {
      return Promise.resolve({ recorded: true });
    },
  };

  const turn = prepared.startTurn({
    session,
    origin: params.origin,
    correlationKey: { opaque: turnId },
    recorder,
    input: { text: params.input },
    ...(params.resume !== undefined ? { resume: params.resume } : {}),
    ...(modelChoice !== undefined ? { modelChoice } : {}),
  });
  // The live request-answer channel (#117): each approval request reaches an
  // observing client through the channel, which the client answers by policy
  // (headless) or a human decision (TUI). The Harness Adapter always emits
  // `request-answered` with `by:"human"` (it cannot know a client policy exists),
  // so the client-declared provenance is stashed here and wins in the durable
  // record.
  const channel = params.requestChannel;
  const answerSources = new Map<string, RequestAnswerBy>();
  const signal = params.cancelSignal;
  const onAbort = (): void => {
    void turn.interrupt();
  };
  try {
    const resultPromise = turn.result();
    turn.subscribe((event) => {
      recordTurnEvent(owner, turnId, event, answerSources);
      if (channel !== undefined) notifyChannel(channel, event);
    });
    if (channel !== undefined) {
      channel.bindInterrupt(async () => {
        const receipt = await turn.interrupt();
        if (receipt.outcome === "rejected") {
          return { outcome: "rejected", reason: receipt.reason };
        }
        const result = await resultPromise;
        return result.kind === "interrupted" || result.kind === "lost"
          ? { outcome: "applied" }
          : { outcome: "rejected", reason: result.kind };
      });
      channel.bindAnswer(async (requestId, decision, by) => {
        answerSources.set(requestId, by);
        const answer: RequestAnswer = {
          requestId: { opaque: requestId },
          kind: "approval",
          decision,
        };
        const receipt = await turn.answerRequest(answer);
        return receipt.outcome === "accepted"
          ? { outcome: "accepted" }
          : { outcome: "rejected", reason: receipt.reason };
      });
      // Same-Turn guidance (#148): a Harness declaring native steer accepts it while
      // the Turn is live and keeps working. Bound for every Turn — the Application
      // only reaches it when the prepared profile declares steer available, so a
      // Harness without it is never asked here.
      channel.bindSteer(async (input) => {
        const receipt = await turn.steer(input);
        return receipt.outcome === "accepted"
          ? { outcome: "accepted" }
          : { outcome: "rejected", reason: receipt.reason };
      });
    }
    // Cancel and shutdown remain Run-wide; a Port interrupt uses the Turn binding.
    if (signal !== undefined) {
      if (signal.aborted) void turn.interrupt();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const result = await resultPromise;
    observedWrite(
      observe,
      owner.runId,
      { write: "turn-settlement", attemptId, turnId },
      () =>
        settleTurnResult(
          owner,
          turnId,
          session,
          result,
          params.detachAfterTurn === true ? recoveryCoordinate : undefined,
        ),
    );
    const failure = turnFailure(result);
    observe({
      kind: "turn-end",
      ...ids,
      result: result.kind,
      ...(failure !== undefined ? { failure } : {}),
    });
    // A full cancel-run of a live Turn stops the Turn but ends the Run `cancelled`
    // (#87/#98): unwind without settling this Attempt, so the Application's cancel
    // path owns the `cancelled` rest — the same RunCancelledError a cancelled
    // Command throws. An interrupt-turn or an OS signal instead returns the result,
    // which the caller maps to its rest (`interactiveTurnRest` for an Interactive Step).
    if (signal?.aborted === true && signal.reason === RUN_CANCEL_ABORT) {
      throw new RunCancelledError();
    }
    return result;
  } finally {
    // The Turn is over: drop the abort listener so a completed Turn leaks none, and
    // unbind so a late `answer-harness-request` finds no live answer function and
    // the Application refuses it (the request has expired).
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    channel?.bindAnswer(undefined);
    channel?.bindSteer(undefined);
    channel?.bindInterrupt(undefined);
    channel?.sessionCommands(undefined);
  }
}

/** Whether a Turn's result is an Interrupt that leaves its Step waiting for the
 *  person (#353, #354, ADR 0035). A process signal also settles a live Turn
 *  `interrupted` without throwing (a cancel throws first), so under an aborted
 *  signal it does not wait (ADR 0019). */
function interruptWaits(
  kind: TurnResult["kind"],
  cancelSignal: AbortSignal | undefined,
): boolean {
  return kind === "interrupted" && cancelSignal?.aborted !== true;
}

/** The rest an Interactive Step's Turn leaves the Run at (#353, ADR 0035). An
 *  Interrupt ends only the Turn, so every result but `lost` and a signal-stopped
 *  Turn waits for the person. */
export function interactiveTurnRest(
  kind: TurnResult["kind"],
  cancelSignal: AbortSignal | undefined,
): "blocked" | "halted" {
  if (kind === "lost") return "halted";
  return kind !== "interrupted" || interruptWaits(kind, cancelSignal)
    ? "blocked"
    : "halted";
}

/** What driving one human interactive Turn needs (#122). */
export interface InteractiveTurnRequest {
  readonly owner: RunOwner;
  readonly prepared: PreparedHarness;
  /** The Step's named Session, reused across the Step's human Turns and the
   *  following Agent Steps that name it. */
  readonly session: string;
  /** The interactive Step's pending Attempt id, so every human Turn links to it. */
  readonly attemptId: string;
  /** A unique id per human Turn (the durable Turn record's key). */
  readonly turnId: string;
  /** The human's verbatim text — Secant authors nothing; recorded as the Turn's
   *  `user` transcript entry before any stdin frame is sent. */
  readonly text: string;
  readonly requestChannel?: RequestChannel;
  readonly cancelSignal?: AbortSignal;
  /** Reports the human Turn's admission and settlement (#320). Absent, they are
   *  reported nowhere. */
  readonly observe?: ExecutionObserver;
}

/** Drive one human Turn of an interactive-agent Step (#122): admit the human's
 *  verbatim text (origin `human`), resume the named Session when detached, record
 *  the Turn durably, and return the raw result. The Application maps the result to
 *  the Run's next resting state; between Turns the Run stays `blocked`. */
export async function driveInteractiveTurn(
  request: InteractiveTurnRequest,
): Promise<TurnResult> {
  const recovery = sessionRecovery(request.owner, request.session);
  // A Session whose recovery already failed cannot take another Turn (ADR 0022);
  // surface it as a failed result without opening a fresh conversation.
  if (recovery.unusable) return unusableTurnResult(request.session);
  return driveHarnessTurn(request.owner, request.prepared, {
    session: request.session,
    origin: "human",
    kind: "interactive-agent",
    attemptId: request.attemptId,
    turnId: request.turnId,
    input: request.text,
    observe: guardedExecutionObserver(request.observe),
    // The Harness stays held for the interactive Step. Record detached after each
    // Turn so a later reopen or following Agent Step can resume the Session (#122).
    detachAfterTurn: true,
    ...(recovery.resume !== undefined ? { resume: recovery.resume } : {}),
    ...(request.requestChannel !== undefined
      ? { requestChannel: request.requestChannel }
      : {}),
    ...(request.cancelSignal !== undefined
      ? { cancelSignal: request.cancelSignal }
      : {}),
  });
}

/** Drive an interactive-agent Step's authored entry Turn (#212) when it opts in with
 *  `entryTurn` and no Turn of this Attempt was admitted yet: the rendered prompt —
 *  slots filled, bundled skill paths appended, exactly as an Agent Step renders it —
 *  is the Session's first Turn (origin `managed`), so the human never re-types what a
 *  Launch input already carries. Sent at most once: a resume after any admitted entry
 *  Turn (even an interrupted one) finds it in history and waits for the human rather
 *  than silently re-sending it. Returns undefined when no entry Turn is due. */
export async function runInteractiveEntryTurn(
  step: AgentStep,
  context: StepContext,
  attemptId: string,
  /** The Attempt's Session — scoped per iteration inside a Repeat group (#216). */
  session: string,
): Promise<TurnResult | undefined> {
  if (step.entryTurn !== true) return undefined;
  const owner = context.owner;
  if (attemptTurns(owner, attemptId).length > 0) return undefined;
  const harness = context.harness;
  if (harness === undefined) {
    throw new Error(
      "execution: an interactive entry Turn ran without a prepared Harness.",
    );
  }
  const rendered = renderAgentPrompt(step, context, harness);
  if (!rendered.ok) return rendered.result;
  const recovery = sessionRecovery(owner, session);
  if (recovery.unusable) return unusableTurnResult(session);
  return driveHarnessTurn(owner, harness.prepared, {
    session,
    origin: "managed",
    kind: "interactive-agent",
    attemptId,
    turnId: `${attemptId}#entry`,
    input: rendered.prompt,
    observe: context.observe,
    // Settle `detached` like a human Turn, so the next Turn resumes this Session.
    detachAfterTurn: true,
    ...(recovery.resume !== undefined ? { resume: recovery.resume } : {}),
    ...(context.requestChannel !== undefined
      ? { requestChannel: context.requestChannel }
      : {}),
    ...(context.cancelSignal !== undefined
      ? { cancelSignal: context.cancelSignal }
      : {}),
  });
}

/** A settled Turn's typed failure facts, copied field by field so its diagnostics,
 *  partial output, and retry evidence never reach the observer. */
function turnFailure(result: TurnResult): TurnFailureFacts | undefined {
  const failure =
    result.kind === "not-started" ||
    result.kind === "failed" ||
    result.kind === "lost"
      ? result.detail.failure
      : undefined;
  if (failure === undefined) return undefined;
  return {
    phase: failure.phase,
    category: failure.category,
    possibleEffects: failure.possibleEffects,
    ...(failure.nativeCode !== undefined
      ? { nativeCode: failure.nativeCode }
      : {}),
    ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
  };
}

/** The failed result an interactive Turn returns for an unusable Session (#122). */
function unusableTurnResult(session: string): TurnResult {
  return {
    kind: "failed",
    detail: {
      failure: {
        phase: "recovery",
        category: "session-unusable",
        possibleEffects: "none",
        cause: undefined,
        diagnostics: `Session "${session}" is unusable and cannot take another Turn.`,
      },
      effectiveModel: { known: false },
      session: { state: "unusable", reason: "recovery previously failed" },
    },
  };
}

/** Relay one Turn event to the live request-answer channel (#117): approval
 *  requests toggle the outstanding set; preview, context, usage, and activity are
 *  coalesced observations. Durable recording is separate (`recordTurnEvent`). */
function notifyChannel(channel: RequestChannel, event: TurnEvent): void {
  switch (event.kind) {
    case "session":
      if (event.facts !== undefined)
        channel.sessionCommands(event.facts.commands);
      return;
    case "request-raised":
      if (event.request.shape.kind === "approval") {
        channel.raised({
          requestId: event.request.requestId.opaque,
          tool: event.request.shape.tool,
          input: event.request.shape.input,
          decisions: [...event.request.shape.decisions],
        });
      }
      return;
    case "request-answered":
      channel.settled(event.requestId.opaque);
      return;
    case "request-expired":
      channel.settled(event.requestId.opaque);
      return;
    case "preview":
      channel.observe({ preview: event.text });
      return;
    case "context":
      channel.observe({ context: event.observation });
      return;
    case "usage":
      channel.observe({ usage: event.observation.summary });
      return;
    case "activity":
      channel.observe({ activity: event.description });
      return;
    case "tool-activity":
      channel.observe({
        activity: `${event.activity.tool} ${event.activity.phase}`,
      });
      return;
    default:
      return;
  }
}

/** Render the Agent prompt (#116): substitute the Run working area (#214), fill each `{{artifact:name}}` slot from the
 *  Run's bindings and Launch inputs, then append one line per `skill` in `uses`
 *  telling the agent to read its `SKILL.md`. No `@` or other Harness syntax is
 *  baked in — the file path is a plain absolute path. */
function renderAgentPrompt(
  step: AgentStep,
  context: StepContext,
  harness: HarnessExecutionDeps,
):
  | { readonly ok: true; readonly prompt: string }
  | { readonly ok: false; readonly result: TurnResult } {
  const deliveryFailure = unsupportedDeliveryFailure(harness.prepared.profile);
  if (deliveryFailure !== undefined) {
    return { ok: false, result: deliveryFailure };
  }
  let base = readPromptText(step.prompt, context);
  if (base.includes(WORKING_AREA_SLOT)) {
    // The exact directory composition granted the Harness at prepare (#214).
    const area = context.owner.workingArea();
    if (!area.ok) {
      return { ok: false, result: unusableDirectoryFailure(area.problem) };
    }
    base = base.replaceAll(WORKING_AREA_SLOT, area.path);
  }
  const filled = base.replace(promptSlotPattern(), (_match, name: string) =>
    resolvePromptSlot(name, context, harness),
  );
  const skillLines: string[] = [];
  for (const use of step.uses ?? []) {
    if (!("asset" in use)) continue;
    if (harness.assetKinds[use.asset] !== "skill") continue;
    const dir = context.resolveAsset(use.asset);
    if (dir === undefined) {
      throw new Error(
        `execution: skill asset "${use.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    skillLines.push(
      `Read the skill instructions at ${join(dir, "SKILL.md")} before you begin.`,
    );
  }
  return {
    ok: true,
    prompt:
      skillLines.length === 0
        ? filled
        : `${filled}\n\n${skillLines.join("\n")}`,
  };
}

/** The not-started result for an unusable Run working area (#214) or receipt
 *  directory (#305): no Turn ran, and the Problem's kind is the category. */
function unusableDirectoryFailure(
  problem: Extract<OutputReceiptDirectoryResult, { ok: false }>["problem"],
): TurnResult {
  const what =
    problem.kind === "working-area-unavailable"
      ? "Run working area"
      : "output receipt directory";
  return {
    kind: "not-started",
    detail: {
      failure: {
        phase: "launch",
        category: problem.kind,
        possibleEffects: "none",
        diagnostics: `The ${what} '${problem.path}' is not a usable directory.`,
        cause: problem.cause,
      },
    },
  };
}

/** Refuse a profile whose declared delivery cannot be honoured by the plain-path
 *  prompt renderer. This is an operational value, not a throw: no Turn has started
 *  and the profile itself proves retrying cannot change the mismatch. */
function unsupportedDeliveryFailure(
  profile: HarnessProfile,
): TurnResult | undefined {
  const unsupported: string[] = [];
  if (profile.skillDelivery.mode !== "plain-path") {
    unsupported.push(`skill:${profile.skillDelivery.mode}`);
  }
  if (profile.fileDelivery.mode !== "plain-path") {
    unsupported.push(`file:${profile.fileDelivery.mode}`);
  }
  if (unsupported.length === 0) return undefined;
  return {
    kind: "not-started",
    detail: {
      failure: {
        phase: "launch",
        category: "unsupported-delivery-mode",
        possibleEffects: "none",
        retryEvidence: "the prepared Harness profile is immutable",
        diagnostics: `Prompt rendering supports plain-path delivery only; profile declared ${unsupported.join(", ")}.`,
      },
    },
  };
}

/** The prompt asset's or bound artifact's text. */
function readPromptText(prompt: Reference, context: StepContext): string {
  if ("asset" in prompt) {
    const path = context.resolveAsset(prompt.asset);
    if (path === undefined) {
      throw new Error(
        `execution: agent prompt asset "${prompt.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    return readFileSync(path, "utf8");
  }
  const versionId = context.owner.currentVersion(prompt.artifact);
  if (versionId === undefined) {
    throw new Error(
      `execution: agent prompt artifact "${prompt.artifact}" is not bound at this Step.`,
    );
  }
  const bytes = context.owner.readArtifact(versionId, prompt.artifact);
  if (bytes === undefined) {
    throw new Error(
      `execution: agent prompt artifact "${prompt.artifact}" has no bytes at its bound version.`,
    );
  }
  return new TextDecoder().decode(bytes);
}

/** Resolve one `{{artifact:name}}` slot: a bound store artifact substitutes as its
 *  canonical text; a Launch input substitutes by its declared type — `file` as an
 *  absolute path (Workspace-relative resolved against the Workspace), `file-set` as
 *  one absolute path per line, everything else as its text. */
function resolvePromptSlot(
  name: string,
  context: StepContext,
  harness: HarnessExecutionDeps,
): string {
  const versionId = context.owner.currentVersion(name);
  if (versionId !== undefined) {
    const bytes = context.owner.readArtifact(versionId, name);
    if (bytes === undefined) {
      throw new Error(
        `execution: agent prompt slot "${name}" has no bytes at its bound version.`,
      );
    }
    return new TextDecoder().decode(bytes);
  }
  const launch = launchInputs(context.owner);
  const value = launch[name];
  if (value === undefined) {
    // The Composition check already proved every slot names a required, bound
    // artifact; reaching here is a broken invariant.
    throw new Error(
      `execution: agent prompt slot "${name}" names an artifact that is neither bound nor a Launch input.`,
    );
  }
  const type = harness.inputTypes[name];
  const workspacePath = context.owner.record.workspacePath;
  if (type === "file") {
    return absoluteWorkspacePath(workspacePath, value);
  }
  if (type === "file-set") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => absoluteWorkspacePath(workspacePath, line))
      .join("\n");
  }
  return value;
}

/** A file input's absolute path: an absolute value passes through, a
 *  Workspace-relative one resolves against the Workspace root (#116). Host
 *  `node:path.isAbsolute` is correct here (unlike a portable Bundle path, which
 *  needs `bundle/relative-path`): a `file` Launch input is validated to exist on
 *  the executing host at Preflight, so it is always a host-native path. */
function absoluteWorkspacePath(workspacePath: string, value: string): string {
  return isAbsolute(value) ? value : resolvePath(workspacePath, value);
}

/** The Run's Launch inputs, read back from the canonical record as a string map
 *  (validated to that shape at launch and resume). */
export function launchInputs(
  owner: RunOwner,
): Readonly<Record<string, string>> {
  const launch = owner.record.launch;
  if (launch === null || typeof launch !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    launch as Record<string, unknown>,
  )) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Drain the meaningful Turn events into the Store as durable timeline entries
 *  (#116): authoritative assistant content, tool activity, Steer settlements, and
 *  each known effective model and effort the Harness observed (#345, ADR 0034), so
 *  the settlement stays immutable while a reroute adds a second. Session facts and
 *  the Attempt's effective model reach the durable view through the settled
 *  result; previews, usage, and context are live-only. Best-effort: `appendTurnEvent` (and
 *  `settleTurn` below) no-op on a fenced owner rather than throw — a fenced owner
 *  means another process took over the Run, and that is surfaced authoritatively
 *  when this Attempt's `publishAttempt` is refused and the walk unwinds. */
function recordTurnEvent(
  owner: RunOwner,
  turnId: string,
  event: TurnEvent,
  answerSources: ReadonlyMap<string, RequestAnswerBy>,
): void {
  if (event.kind === "steer") {
    owner.appendTurnEvent({
      turnId,
      kind: "steer",
      payload: JSON.stringify({
        steerId: event.steerId,
        text: event.text,
        sentAt: event.sentAt,
        settlement: event.settlement,
      }),
      at: new Date(),
    });
  } else if (event.kind === "model") {
    // An unknown observation says nothing durable.
    if (!event.observation.known) return;
    owner.appendTurnEvent({
      turnId,
      kind: "model",
      payload: JSON.stringify({
        model: event.observation.model,
        ...(event.observation.effort !== undefined
          ? { effort: event.observation.effort }
          : {}),
      }),
      at: new Date(),
    });
  } else if (event.kind === "assistant-content") {
    owner.appendTurnEvent({
      turnId,
      kind: "assistant-content",
      payload: JSON.stringify({ content: event.content }),
      at: new Date(),
    });
  } else if (event.kind === "tool-activity") {
    owner.appendTurnEvent({
      turnId,
      kind: "tool-activity",
      payload: JSON.stringify({
        tool: event.activity.tool,
        phase: event.activity.phase,
        summary: event.activity.summary,
      }),
      at: new Date(),
    });
  } else if (event.kind === "request-raised") {
    // The request's tool and serialized input, so `run show` prints the exact
    // approval a Turn paused on (#117 AC1). Durable history only; the request is
    // never stored as live state, so a resumed Run re-raises nothing.
    if (event.request.shape.kind === "approval") {
      owner.appendTurnEvent({
        turnId,
        kind: "request-raised",
        payload: JSON.stringify({
          requestId: event.request.requestId.opaque,
          tool: event.request.shape.tool,
          input: event.request.shape.input,
          decisions: event.request.shape.decisions,
        }),
        at: new Date(),
      });
    }
  } else if (event.kind === "request-answered") {
    // The client-declared provenance wins over the Adapter's `by:"human"`, so a
    // headless policy answer records "answered by client policy" (#117 AC1).
    const by = answerSources.get(event.requestId.opaque) ?? event.by;
    const decision =
      event.answer.kind === "approval" ? event.answer.decision : undefined;
    owner.appendTurnEvent({
      turnId,
      kind: "request-answered",
      payload: JSON.stringify({
        requestId: event.requestId.opaque,
        by,
        ...(decision !== undefined ? { decision } : {}),
      }),
      at: new Date(),
    });
  } else if (event.kind === "request-expired") {
    owner.appendTurnEvent({
      turnId,
      kind: "request-expired",
      payload: JSON.stringify({ requestId: event.requestId.opaque }),
      at: new Date(),
    });
  }
}

/** Settle the durable Turn record from the authoritative result (#116): the result
 *  kind, the post-Turn Session availability, and any authoritative assistant
 *  content. Immutable in the Store; a fenced write is ignored (the walk unwinds).
 *
 *  `detachCoordinate` records an interactive human Turn's Session as `detached`
 *  even when the Adapter reports it `open`. The Harness is held across Turns for
 *  the interactive Step and closed once on release; the persisted coordinate lets
 *  a later reopen or the following Agent Step resume the same Session (#122).
 *  Claude Code can resume by id from persisted native state, so the coordinate is
 *  valid at Turn end while the Step still holds the prepared Harness. */
function settleTurnResult(
  owner: RunOwner,
  turnId: string,
  session: string,
  result: TurnResult,
  detachCoordinate?: string,
): WriteResult {
  const reported = resultAvailability(owner, session, result);
  const availability =
    detachCoordinate !== undefined && reported.state === "open"
      ? { state: "detached", detail: detachCoordinate }
      : reported;
  return owner.settleTurn({
    turnId,
    session,
    resultKind: result.kind,
    resultDetail: turnResultDetail(result),
    availability: availability.state,
    ...(availability.detail !== undefined
      ? { availabilityDetail: availability.detail }
      : {}),
    ...(result.kind === "completed" && result.detail.finalContent !== undefined
      ? { assistantContent: result.detail.finalContent }
      : {}),
    at: new Date(),
  });
}

/** The settled result's detail, flattened to JSON for the durable Turn row. A
 *  failure-bearing kind carries its category, phase, and native exit code (spec
 *  #107 asks `lost`/`failed` to carry them, not just the bare kind); the crash
 *  reconciler writes its own `{kind, unknown}` for an abandoned Turn. */
function turnResultDetail(result: TurnResult): string {
  switch (result.kind) {
    case "completed":
      return JSON.stringify({ kind: "completed" });
    case "not-started":
      return JSON.stringify({
        kind: "not-started",
        failure: flattenFailure(result.detail.failure),
      });
    case "failed":
      return JSON.stringify({
        kind: "failed",
        failure: flattenFailure(result.detail.failure),
      });
    case "interrupted":
      return JSON.stringify({
        kind: "interrupted",
        mode: result.detail.interruption.mode,
      });
    case "lost":
      return JSON.stringify({
        kind: "lost",
        unknown: result.detail.unknown,
        ...(result.detail.failure !== undefined
          ? { failure: flattenFailure(result.detail.failure) }
          : {}),
      });
  }
}

/** The failure fields the durable row keeps: the stable category, the phase, and
 *  the native exit/error code when one exists. Never a raw frame or cause. */
function flattenFailure(failure: HarnessFailure): {
  category: string;
  phase: string;
  nativeCode?: string;
} {
  return {
    category: failure.category,
    phase: failure.phase,
    ...(failure.nativeCode !== undefined
      ? { nativeCode: failure.nativeCode }
      : {}),
  };
}

/** The post-Turn Session availability a result carries, flattened for the Store. */
function resultAvailability(
  owner: RunOwner,
  sessionName: string,
  result: TurnResult,
): {
  state: string;
  detail?: string;
} {
  if (result.kind === "not-started") {
    const recorded = owner
      .harnessSessions()
      .find((session) => session.session === sessionName);
    return recorded === undefined
      ? { state: "open" }
      : {
          state: recorded.availability,
          ...(recorded.availabilityDetail !== undefined
            ? { detail: recorded.availabilityDetail }
            : {}),
        };
  }
  const session = result.detail.session;
  if (session.state === "detached") {
    return { state: "detached", detail: session.coordinate.opaque };
  }
  if (session.state === "unusable") {
    return { state: "unusable", detail: session.reason };
  }
  return { state: "open" };
}

/** The co-sourced Harness evidence to record on an autonomous Agent Attempt.
 *  `runAgentStep` calls this only for Agent results, whose qualified profile must
 *  always supply identity; a missing one is an internal invariant failure. */
export function attemptEvidence(
  stepKind: StepKindName,
  result: StepAttempt,
): { readonly agentEvidence?: AgentAttemptEvidence } {
  if (stepKind !== "agent") {
    if (
      result.harnessIdentity !== undefined ||
      result.effectiveModel !== undefined
    ) {
      throw new Error(
        `run execution: a ${stepKind} Attempt carried Agent evidence.`,
      );
    }
    return {};
  }
  if (result.harnessIdentity === undefined) {
    throw new Error("run execution: an Agent Attempt has no Harness identity.");
  }
  return {
    agentEvidence: {
      kind: "agent",
      identity: result.harnessIdentity,
      ...(result.effectiveModel !== undefined
        ? { effectiveModel: result.effectiveModel }
        : {}),
    },
  };
}

/** The normalized Harness identity for an autonomous Agent Step Attempt (#125), read
 *  from the prepared profile. Stamped on the Attempt whatever its outcome, so an
 *  interrupted, lost, or recovery-refused Turn still records the Harness it ran under. */
function profileIdentity(profile: HarnessProfile): HarnessIdentityRecord {
  return {
    harness: profile.harness,
    executable: profile.executable,
    executableVersion: profile.executableVersion,
    steer: profile.steer,
  };
}

/** Map a Turn result to an Attempt outcome, its effective model (#116), and the
 *  normalized Harness identity it qualified under (#125). The identity comes from the
 *  prepared profile, so it is present for every autonomous Agent Step Attempt whatever
 *  its outcome — an interrupted or lost Turn still ran under a known Harness — while the
 *  effective model is present only when the Turn authoritatively observed one. */
function mapTurnResult(
  result: TurnResult,
  profile: HarnessProfile,
): StepAttempt {
  const model = resultEffectiveModel(result);
  const base = {
    outputs: [] as readonly CandidateOutput[],
    harnessIdentity: profileIdentity(profile),
  };
  switch (result.kind) {
    case "completed":
      return {
        outcome: "succeeded",
        ...base,
        ...(model !== undefined ? { effectiveModel: model } : {}),
      };
    case "failed":
    case "not-started":
      return {
        outcome: "failed",
        ...base,
        ...(model !== undefined ? { effectiveModel: model } : {}),
      };
    case "interrupted":
      return { outcome: "cancelled", ...base };
    case "lost":
      return { outcome: "indeterminate", ...base };
  }
}

/** The effective model a settled result reports, or undefined when unknown or when
 *  the result never reached a model observation. */
function resultEffectiveModel(result: TurnResult): string | undefined {
  if (result.kind === "completed" || result.kind === "failed") {
    const model = result.detail.effectiveModel;
    return model.known ? model.model : undefined;
  }
  return undefined;
}
