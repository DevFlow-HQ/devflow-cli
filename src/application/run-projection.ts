import { modelChoiceOffer } from "./model-choice.js";
import type { ApplicationHarnessQualification } from "./harness-registry.js";
import { deriveRun, type IterationMark } from "./run-progress.js";
import { z } from "zod";
import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import { inspectBundle, type Budgets } from "../bundle/bundle.js";
import { selectInstalledEntry } from "./entry-selection.js";
import {
  routingNeedsHarness,
  flattenSteps,
  humanReviewCheckpoint,
  inHumanRepeat,
  type AgentStep,
  type Platform,
  type RoutingNode,
} from "../workflow/workflow.js";
import type {
  AttemptLogEntry,
  GateAnswerRecord,
  HarnessSessionRecord,
  MaterializationConflict,
  RunGroup,
  RunListing,
  RunOwner,
  TranscriptEntryRecord,
  TurnEventRecord,
  TurnRecord,
} from "../run/store/store.js";
import {
  attemptIteration,
  attemptStepId,
  heldAgentCall,
  interactiveEndLegality,
  latestAgentCall,
  readAgentCallEvent,
  interactiveStepTarget,
} from "../run/execution/execution.js";
import type {
  ActionOffer,
  Problem,
  RunCheckpointView,
  RunConflictView,
  RunGateReference,
  RunOutputView,
  RunResult,
  RunSessionView,
  RunSnapshot,
  RunStateName,
  RunTimelineEvent,
  RunTimelineKind,
  RunTranscriptEntryView,
  RunTurnKind,
  RunView,
} from "./projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "./projection-port.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  runNotFound,
  runStoreDamaged,
} from "./problems.js";

/** The bound Artifact name a Human Gate answer publishes to (#85), so the answer
 *  reads back through `run show`/`run read` like any output. The latest answer
 *  wins the binding; every version stays retained in the Artifact store. */
export const GATE_ANSWER_ARTIFACT = "human-gate-answer";

// The `run` Projection join (#82), beside `bundle-catalog.ts`. It reads a Run's
// canonical record and outputs through the Run Store, re-derives the ordered
// Workflow (from the pinned Bundle's stored bytes, via the Bundle Module) to
// shape per-Step progress, and translates both into the normalized client
// contract. Application owns this join because it is the only place that imports
// the Run Store, the Bundle Module, and the Catalog together; nothing storage-,
// runtime-, or Git-shaped crosses — only semantic values leave here.

export interface RunProjectionDependencies {
  readonly runGroup: RunGroup;
  readonly catalog: Catalog;
  readonly budgets: Budgets;
  readonly hostPlatform?: Platform;
}

/** Facts a launched Run pins that are cheaper to carry from the launch use case
 *  than to re-derive: the routing (for progress), the Bundle's human name and
 *  identity, and the digest. For a Run launched in another process these are
 *  re-derived from the stored bytes instead. */
export interface RunFacts {
  readonly routing: readonly RoutingNode[];
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface RunSteerCapability {
  readonly available: boolean;
  readonly evidence: string;
}

/** How the join reaches a Run's canonical record and outputs. When the Run is
 *  live in this process the launch use case passes its held owner, so a snapshot
 *  read never fences the executing owner; otherwise the join acquires a
 *  short-lived owner and closes it. */
export interface RunReadContext {
  readonly windowsCleanupFallback?: boolean;
  readonly preferenceNotice?: string;
  readonly modelChoiceNotice?: string;
  readonly modelChoicePreparation?: boolean;
  readonly modelChoiceQualification?: ApplicationHarnessQualification;
  readonly facts?: RunFacts; // present for a Run launched in this process
  readonly liveOwner?: RunOwner; // present while live in this process
  readonly state?: string; // the in-memory latest state while tracked
  readonly steer?: RunSteerCapability; // current prepared profile evidence
  readonly problem?: Problem; // transient selected-Harness preparation refusal
}

/** Build the bounded `run` snapshot for one Run id. */
export function runSnapshot(
  deps: RunProjectionDependencies,
  runId: string,
  context: RunReadContext,
): RunSnapshot {
  return { family: "run", runId, result: runResult(deps, runId, context) };
}

function runResult(
  deps: RunProjectionDependencies,
  runId: string,
  context: RunReadContext,
): RunResult {
  const read = deps.runGroup.readRun(runId);
  if (!read.ok) {
    return {
      found: false,
      problem:
        read.problem.kind === "unknown-run"
          ? runNotFound(runId)
          : runStoreDamaged(runId),
    };
  }
  const record = read.run;
  const derived = context.facts
    ? { facts: context.facts }
    : deriveRunFacts(deps, record.bundleSnapshotDigest);
  if ("problem" in derived) return { found: false, problem: derived.problem };
  const facts = derived.facts;
  const trackedState = context.state ?? record.state;
  const selectedHarness = record.selectedHarness;
  const modelChoice = record.modelChoice;
  // Legality of cancel/delete is decided here, inside Secant (#87): an owned Run
  // can be cancelled; an unowned resting or terminal Run can be deleted. Read from the coordination record, which
  // is the same whether the Run is live in this process or another.
  const listing = runListing(deps.runGroup, runId);
  const isLive = listing?.live === true;
  const liveElsewhere = isLive && listing?.ownedByThisProcess === false;
  const view = (
    owner: RunOwner | undefined,
    log: readonly AttemptLogEntry[],
    outputs: readonly RunOutputView[],
    conflicts: readonly MaterializationConflict[],
    gateAnswers: readonly GateAnswerRecord[],
  ): RunResult => {
    // Progress, Iterations, and the interaction the Run waits on, by Step and
    // Iteration identity (#384) — the one derivation Application controls also
    // admit by. A persisted `halted` (#88) marks its current Step `blocked`.
    const derivedRun = deriveRun(facts.routing, trackedState, runId, owner);
    // The conflict resting the Run is the latest recorded one; earlier conflicts
    // stay on the timeline as history. It is surfaced only while `halted`.
    const active =
      derivedRun.state === "halted"
        ? conflicts[conflicts.length - 1]
        : undefined;
    // Harness Turn records (#116): the durable view of every Turn this Run ran —
    // its timeline entries, per-Session availability, effective model, and readable
    // transcript. Empty for a Command-only Run (and for a Run live elsewhere, read
    // without an owner), so the frozen `--json` stays unchanged for those.
    const turns = owner?.turns() ?? [];
    // The live Turn a Turn-scoped control targets (#118): the one admitted Turn with
    // no settled result, present only while the Run is live in this process (a Run
    // live elsewhere is read without an owner, so `turns` is empty and no control is
    // offered — resuming it is the only remote action).
    const liveTurn = !liveElsewhere
      ? turns.find((turn) => turn.resultKind === undefined)
      : undefined;
    // Why the Run holds its current Step for the human, the hold basis the
    // Application also admits and adopts by (#122, #354): an interactive-agent Step
    // at a Turn boundary, or an Agent Step's Attempt an Interrupt left waiting.
    // Neither needs a durable gate record.
    const current = derivedRun.statuses[derivedRun.position];
    const held =
      !liveElsewhere && owner !== undefined && liveTurn === undefined
        ? derivedRun.hold
        : undefined;
    const interactiveStep =
      held?.kind === "interactive" ? held.step : undefined;
    const followUp = held?.kind === "follow-up" ? held : undefined;
    const turnEvents = owner?.turnEvents() ?? [];
    const lastTurn = turns.at(-1);
    const pendingCall =
      owner !== undefined && lastTurn !== undefined
        ? latestAgentCall(owner, lastTurn.attemptId)
        : undefined;
    const pendingAgentCompletion =
      pendingCall !== undefined &&
      pendingCall.turn.resultKind === undefined &&
      !log.some((e) => e.attemptId === pendingCall.turn.attemptId)
        ? { call: pendingCall.call.id, reason: pendingCall.call.reason }
        : undefined;
    const deferredAgentCompletion =
      listing?.live !== true &&
      derivedRun.state === "blocked" &&
      current?.kind === "interactive-agent" &&
      pendingCall?.turn.resultKind === "completed" &&
      attemptStepId(pendingCall.turn.attemptId) === current.id &&
      interactiveEndLegality({
        routing: facts.routing,
        step: current,
        control: pendingCall.call.id,
        turnLive: true,
        attemptLog: log,
      }).kind === "legal";
    // The Review checkpoint held the agent's Continue (ADR 0032): the Iteration
    // waits at its Turn boundary for the person, whose controls stay offered.
    const heldForReview = ((): RunView["heldForReview"] => {
      if (
        owner === undefined ||
        interactiveStep === undefined ||
        lastTurn?.resultKind !== "completed" ||
        log.some((e) => e.attemptId === lastTurn.attemptId)
      )
        return undefined;
      const held = heldAgentCall(owner, lastTurn.attemptId);
      const checkpoint = humanReviewCheckpoint(
        facts.routing,
        interactiveStep.id,
      );
      return held !== undefined && checkpoint !== undefined
        ? { ...checkpoint, reason: held.call.reason }
        : undefined;
    })();
    const declarations = log.filter(
      (entry) =>
        entry.endsStage === true ||
        (entry.endedBy === "agent" &&
          !inHumanRepeat(facts.routing, attemptStepId(entry.attemptId) ?? "")),
    );
    const sessions = owner?.harnessSessions() ?? [];
    const names = sessionNames(facts.routing, turns);
    const harnessEvidence = owner?.harnessEvidence();
    const effectiveModel = harnessEvidence?.effectiveModel;
    // The normalized Harness identity of the latest Agent-step Attempt (#125): durable
    // profile facts read back through the owner, empty for a Command-only Run (and for a
    // Run live elsewhere, read without an owner), so the frozen `--json` stays unchanged
    // for those.
    const harnessIdentity = harnessEvidence?.identity;
    const steer = context.steer ?? harnessIdentity?.steer;
    // #194 stories 39/40: the evidence that shapes a resting resume offer. The
    // Attempt log carries no Step kind, so the resting Step's kind is read from the
    // derived progress at `position` (the Step the walk stalled at).
    // An interactive Step's Session is per Attempt inside a Repeat group, so an
    // earlier iteration's unusable Session must not refuse this one's resume (#216).
    const resumeEvidence = (): ResumeEvidence => {
      const currentInteractive = flattenSteps(facts.routing).find(
        (step): step is AgentStep =>
          step.id === current?.id && step.kind === "interactive-agent",
      );
      return resumeEvidenceOf({
        state: derivedRun.state,
        currentStepKind: current?.kind,
        lastAttemptOutcome: log[log.length - 1]?.outcome,
        hasConflict: active !== undefined,
        waitingForFollowUp:
          current?.kind === "agent" && derivedRun.waitingTurn !== undefined,
        sessions,
        ...(currentInteractive !== undefined
          ? {
              currentSession: interactiveStepTarget(
                facts.routing,
                currentInteractive,
                log,
              ).session,
            }
          : {}),
      });
    };
    return {
      found: true,
      run: {
        runId,
        bundle: {
          id: facts.id,
          version: facts.version,
          name: facts.name,
          digest: facts.digest,
        },
        workspacePath: record.workspacePath,
        launchedAt: record.createdAt,
        state: derivedRun.state,
        problem: context.problem,
        ...(context.preferenceNotice === undefined
          ? {}
          : { preferenceNotice: context.preferenceNotice }),
        ...(context.modelChoiceNotice === undefined
          ? {}
          : { modelChoiceNotice: context.modelChoiceNotice }),
        ...(context.windowsCleanupFallback
          ? {
              windowsCleanupNotice:
                "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.",
            }
          : {}),
        liveness: runLiveness(listing),
        progress: derivedRun.statuses,
        position: derivedRun.position,
        timeline: buildTimeline(
          deps,
          record.createdAt,
          log,
          facts.digest,
          derivedRun.iterationEvents,
          derivedRun.checkpoint,
          conflicts,
          gateAnswers,
          turns,
          turnEvents,
          facts.routing,
          names,
        ),
        outputs,
        ...(derivedRun.checkpoint !== undefined
          ? { checkpoint: derivedRun.checkpoint }
          : {}),
        ...(derivedRun.pendingGate !== undefined
          ? { pendingGate: derivedRun.pendingGate }
          : {}),
        // Typed Action Offers, legality decided inside Secant (#85, #86, #87, #98,
        // #108): the answer-human-gate offer appears only while blocked at a gate
        // (a derived Review checkpoint or an authored gate); resume-run only while
        // resting halted or failed; cancel is offered while the Run is live or
        // `blocked` (a blocked Run has resumable work, so it is cancelled rather than
        // deleted — A6), delete only otherwise (mutually exclusive).
        actionOffers: [
          ...(routingNeedsHarness(facts.routing) &&
          (context.modelChoicePreparation === true ||
            context.modelChoiceQualification !== undefined)
            ? [
                modelChoiceOffer({
                  runId,
                  currentChoice: modelChoice,
                  state: record.state,
                  foreignOwner: liveElsewhere ? listing : undefined,
                  qualification: context.modelChoiceQualification,
                  turnLive: isLive && liveTurn !== undefined,
                }),
              ]
            : []),
          ...(!liveElsewhere && derivedRun.checkpoint !== undefined
            ? [answerHumanGateOffer(derivedRun.checkpoint.gate, false)]
            : !liveElsewhere && derivedRun.pendingGate !== undefined
              ? [answerHumanGateOffer(derivedRun.pendingGate.gate, true)]
              : []),
          ...(liveElsewhere &&
          listing?.ownerPid !== undefined &&
          derivedRun.state !== "succeeded" &&
          derivedRun.state !== "cancelled"
            ? [
                resumeRunOffer(runId, derivedRun.state, {
                  takeoverOwnerPid: listing.ownerPid,
                }),
              ]
            : deferredAgentCompletion
              ? [
                  {
                    action: "resume-run" as const,
                    runId,
                    available: true as const,
                    consequence:
                      "Apply the agent's recorded Step completion and continue Routing.",
                  },
                ]
              : derivedRun.state === "halted" || derivedRun.state === "failed"
                ? [resumeRunOffer(runId, derivedRun.state, resumeEvidence())]
                : []),
          // Turn-scoped controls (#118, #148): while a Turn is live in this process, a
          // user can interrupt it without cancelling the Run (the Step returns to
          // `blocked` waiting for the person, #353, #354), and steer it when the
          // prepared profile declares native same-Turn guidance. The steer Offer is
          // discriminated on that profile
          // evidence (live first, then persisted with the Attempt) — a Harness with
          // steer offers it available, one without offers it unavailable with the
          // evidence, never Adapter-specific prose here.
          ...(isLive && liveTurn !== undefined
            ? [
                interruptTurnOffer(runId, liveTurn.turnId),
                ...(steer !== undefined
                  ? [steerTurnOffer(runId, liveTurn.turnId, steer)]
                  : []),
              ]
            : []),
          // Interactive-agent turn-taking (#122): while the Run rests `blocked` at an
          // interactive-agent Step at a Turn boundary (no gate, no live Turn), the
          // human can send the next Turn or end the Step. End Step is offered only at
          // a boundary — a live Turn suppresses both, exactly when interrupt is offered.
          // Inside a human-controlled Repeat, Continue and End Stage take End Step's
          // place (#217, #218).
          ...(interactiveStep !== undefined
            ? [
                sendInteractiveTurnOffer(runId, interactiveStep.id),
                ...(
                  [
                    ["end-interactive-step", endInteractiveStepOffer],
                    ["continue-repeat", continueRepeatOffer],
                    ["end-stage", endStageOffer],
                  ] as const
                ).flatMap(([control, offer]) =>
                  interactiveEndLegality({
                    routing: facts.routing,
                    step: interactiveStep,
                    control,
                    turnLive: liveTurn !== undefined,
                    attemptLog: log,
                  }).kind === "legal"
                    ? [offer(runId, interactiveStep.id)]
                    : [],
                ),
              ]
            : []),
          // An Agent Step's Attempt an Interrupt left waiting (#354): the person's
          // next message continues it as a follow-up Turn.
          ...(followUp !== undefined
            ? [sendFollowUpTurnOffer(runId, followUp.step.id, followUp.turn)]
            : []),
          isLive || derivedRun.state === "blocked"
            ? cancelRunOffer(runId)
            : deleteRunOffer(runId),
        ],
        ...(active !== undefined
          ? { conflict: conflictView(runId, active) }
          : {}),
        ...(sessions.length > 0
          ? {
              sessions: sessions.map((s) =>
                sessionView(
                  runId,
                  s,
                  names.get(s.session) ?? s.session,
                  (owner?.transcriptPage({ session: s.session, limit: 1 })
                    .entries.length ?? 0) > 0,
                ),
              ),
            }
          : {}),
        ...(effectiveModel !== undefined ? { effectiveModel } : {}),
        ...(modelChoice !== undefined
          ? {
              modelChoice: {
                model: modelChoice.model,
                ...(modelChoice.effort !== undefined
                  ? { effort: modelChoice.effort }
                  : {}),
              },
              requestedModel: modelChoice.model,
            }
          : {}),
        ...(selectedHarness !== undefined ? { selectedHarness } : {}),
        ...(harnessIdentity !== undefined
          ? {
              harness: {
                name: harnessIdentity.harness,
                executable: harnessIdentity.executable,
                executableVersion: harnessIdentity.executableVersion,
              },
            }
          : {}),
        ...(turns.length > 0 ? { turnPosition: turns.length } : {}),
        ...(pendingAgentCompletion !== undefined
          ? { pendingAgentCompletion }
          : {}),
        ...(heldForReview !== undefined ? { heldForReview } : {}),
        // A confirmed End Stage (#218) completed this Run by human declaration, not
        // automatic verification; the summary says so rather than imply a check.
        // An agent's Continue only opens the next Iteration, so it declares nothing.
        ...(derivedRun.state === "succeeded" && declarations.length > 0
          ? {
              completion: declarations.some(
                (entry) => entry.endedBy === "agent",
              )
                ? ("agent-declared" as const)
                : ("human-declared" as const),
            }
          : {}),
      },
    };
  };

  const live = context.liveOwner;
  // Never acquire a fresh owner for a Run that is live in another process: every
  // `acquireRun` bumps the fencing epoch, which would fence — and so abort — the
  // process actually executing the Run. A read must never break a running Run, so
  // show the record-level snapshot instead (no attempt log or outputs from here).
  if (live === undefined && liveElsewhere) {
    return view(undefined, [], [], [], []);
  }
  const owner = live ?? deps.runGroup.acquireRun(runId);
  if (owner === undefined) {
    return { found: false, problem: runStoreDamaged(runId) };
  }
  try {
    return view(
      owner,
      owner.attemptLog(),
      collectOutputs(owner, facts.routing, runId),
      owner.materializationConflicts(),
      owner.gateAnswers(),
    );
  } finally {
    if (live === undefined) owner.close();
  }
}

/** The client view of the conflict resting a Run `halted`: names the artifact and
 *  path, and references the diagnostic (read via `readResource`), never inlining
 *  its detail so the snapshot stays bounded (AC5). */
function conflictView(
  runId: string,
  conflict: MaterializationConflict,
): RunConflictView {
  return {
    artifactName: conflict.artifactName,
    path: conflict.path,
    reference: {
      runId,
      diagnosticId: conflict.diagnosticId,
      type: "diagnostic",
    },
  };
}

function runListing(runGroup: RunGroup, runId: string): RunListing | undefined {
  return runGroup.listRuns().find((run) => run.runId === runId);
}

function runLiveness(listing: RunListing | undefined): RunView["liveness"] {
  if (listing?.live !== true || listing.ownerPid === undefined) {
    return { state: "not-live" };
  }
  return listing.ownedByThisProcess
    ? { state: "live-here", ownerPid: listing.ownerPid }
    : { state: "live-elsewhere", ownerPid: listing.ownerPid };
}

/** Re-derive the routing and Bundle facts from the pinned Snapshot's stored
 *  bytes, translating a missing or corrupt managed store into a typed Problem. */
export function deriveRunFacts(
  deps: RunProjectionDependencies,
  digest: string,
): { facts: RunFacts } | { problem: Problem } {
  const bytes = deps.catalog.readManagedBytes(digest);
  if (bytes === undefined)
    return { problem: bundleBytesMissing({ digest: digest }) };
  const outcome = inspectBundle(bytes, deps.budgets, false);
  if (!outcome.ok) {
    return {
      problem: bundleBytesCorrupt({ digest: digest }, outcome.finding.code),
    };
  }
  const { manifest } = outcome.inspection;
  return {
    facts: {
      routing: manifest.routing,
      name: manifest.bundle.name,
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      digest,
    },
  };
}

// The outputs a Run produced, reached by reference. A Command binds only `text`
// and `verdict` (its Step-kind contract), so only those are surfaced in M2; the
// latest bound version per name wins when several Steps produce the same name.
function collectOutputs(
  owner: RunOwner,
  routing: readonly RoutingNode[],
  runId: string,
): RunOutputView[] {
  const declared = new Map<string, "text" | "verdict">();
  for (const step of flattenSteps(routing)) {
    for (const produced of step.produces ?? []) {
      if (produced.type === "text" || produced.type === "verdict") {
        declared.set(produced.name, produced.type);
      }
    }
  }
  // A durable Human Gate answer (#85) is a bound `text` Artifact not declared in
  // the Routing; surface it as an output so it reads back through run show/read.
  const answerVersion = owner.currentVersion(GATE_ANSWER_ARTIFACT);
  if (answerVersion !== undefined) declared.set(GATE_ANSWER_ARTIFACT, "text");
  const outputs: RunOutputView[] = [];
  for (const [name, type] of declared) {
    const versionId = owner.currentVersion(name);
    if (versionId === undefined) continue;
    outputs.push({
      name,
      type,
      reference: { runId, artifactName: name, versionId, type },
    });
  }
  return outputs;
}

/** The evidence that shapes a resting `resume-run` offer (#194 stories 39/40).
 *  At most one of these is set; an empty value is an ordinary available resume. */
interface ResumeEvidence {
  readonly takeoverOwnerPid?: number;
  readonly acknowledgement?: string;
  readonly unavailable?: string;
  readonly consequence?: string;
}

/** Derive the resting-resume evidence from the facts the Run view already exposes
 *  (#194 stories 39/40), pure so both branches are exercised in isolation:
 *   - An Agent/interactive Step whose Session is recorded `unusable` cannot resume —
 *     re-driving only fails the Attempt without ever opening a fresh Session
 *     (ADR 0022) — so resume is offered unavailable with the reason (story 40).
 *   - A `halted` Run whose current Step is a command and whose last Attempt settled
 *     `indeterminate` (an interrupted/lost command, not a Materialization conflict)
 *     may have already run side effects a re-run repeats, so resume arms an
 *     acknowledgement (story 39).
 *  Neither fires for an ordinary resumable rest, which resumes without ceremony. */
function resumeEvidenceOf(params: {
  readonly state: RunStateName;
  readonly currentStepKind: string | undefined;
  readonly lastAttemptOutcome: string | undefined;
  readonly hasConflict: boolean;
  readonly waitingForFollowUp: boolean;
  readonly sessions: readonly {
    readonly availability: string;
    readonly session: string;
  }[];
  /** The exact Session the current Step resumes into, when known. */
  readonly currentSession?: string;
}): ResumeEvidence {
  const unusable = params.sessions.find(
    (s) =>
      s.availability === "unusable" &&
      (params.currentSession === undefined ||
        s.session === params.currentSession),
  );
  if (
    unusable !== undefined &&
    (params.currentStepKind === "agent" ||
      params.currentStepKind === "interactive-agent")
  ) {
    // ponytail: an autonomous Agent Step still matches any unusable Session — its
    // next Attempt's `fresh` name is not minted yet; an interactive Step matches its
    // exact Session.
    return {
      unavailable: `resume needs the "${unusable.session}" Session, which is no longer usable — start a new Run instead.`,
    };
  }
  if (
    params.state === "halted" &&
    !params.hasConflict &&
    params.currentStepKind === "command" &&
    params.lastAttemptOutcome === "indeterminate"
  ) {
    return {
      acknowledgement:
        "the interrupted command may have already run — resuming re-runs this Step, so its effects may repeat.",
    };
  }
  if (params.state === "halted" && params.waitingForFollowUp) {
    return {
      consequence:
        "resume: wait again for your next message to the interrupted agent; nothing is re-sent.",
    };
  }
  return {};
}

/** The `resume-run` offer for a resting Run: names what resume does from the
 *  current state so a client presents it without re-deriving the model (#86), or
 *  is offered unavailable with the reason when the Port knows it cannot proceed
 *  (#194 story 40). */
function resumeRunOffer(
  runId: string,
  state: RunStateName,
  evidence: ResumeEvidence = {},
): ActionOffer {
  if (evidence.unavailable !== undefined) {
    return {
      action: "resume-run",
      runId,
      available: false,
      reason: evidence.unavailable,
    };
  }
  const consequence =
    evidence.takeoverOwnerPid !== undefined
      ? `take over from process ${evidence.takeoverOwnerPid} and continue the Run.`
      : state === "failed"
        ? "resume: reset this Step's attempt and iteration bounds and grant another try."
        : (evidence.consequence ??
          "resume: continue from the Step the Run stopped at.");
  return {
    action: "resume-run",
    runId,
    available: true,
    consequence,
    ...(evidence.takeoverOwnerPid !== undefined
      ? { takeover: { ownerPid: evidence.takeoverOwnerPid } }
      : {}),
    ...(evidence.acknowledgement !== undefined
      ? { acknowledgement: evidence.acknowledgement }
      : {}),
  };
}

/** The `answer-human-gate` offer for a blocked Run: names the consequence of each
 *  answer so a client presents them without re-deriving the model (#85). */
function answerHumanGateOffer(
  gate: RunGateReference,
  authored: boolean,
): ActionOffer {
  return {
    action: "answer-human-gate",
    gate,
    basis: "durable Human Gate",
    // An authored gate approves/advances a single pause; only a derived Review
    // checkpoint grants an interval of the Repeat cadence (#108).
    continueConsequence: authored
      ? "approve: advance the Run past the gate."
      : "continue: grant one more review interval and resume the Run.",
    stopConsequence: authored
      ? "reject: end the Run failed, keeping its history and Artifacts."
      : "stop: end the Run failed, keeping its history and Artifacts.",
    ...(gate.shape === "free-text"
      ? {
          textConsequence:
            "text: publish the answer as the gate's output and resume the Run.",
        }
      : {}),
  };
}

/** The `send-interactive-turn` offer for a Run blocked at an interactive-agent Step
 *  at a Turn boundary (#122). */
function sendInteractiveTurnOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "send-interactive-turn",
    runId,
    stepId,
    basis: "interactive Turn",
    consequence:
      "send the typed text as one human Turn in the Step's Session; the Run stays blocked for the next Turn.",
  };
}

/** The `send-follow-up-turn` offer for an Agent Step's Attempt waiting after an
 *  Interrupt (#354), keyed on the interrupted Turn. */
function sendFollowUpTurnOffer(
  runId: string,
  stepId: string,
  turn: TurnRecord,
): ActionOffer {
  return {
    action: "send-follow-up-turn",
    runId,
    stepId,
    attemptId: turn.attemptId,
    turnId: turn.turnId,
    basis: "interrupted Agent Turn",
    consequence:
      "send the typed text to the agent as your next message in the same Session; the Step continues from that Turn.",
  };
}

/** The `end-interactive-step` offer for a Run blocked at an interactive-agent Step
 *  at a Turn boundary (#122): offered only when it can be taken (no live Turn). */
function endInteractiveStepOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "end-interactive-step",
    runId,
    stepId,
    consequence:
      "end the interactive Step succeeded and advance the Run; the following Step reuses the same Session.",
  };
}

/** The `continue-repeat` offer for a Run blocked at a human-controlled Repeat's
 *  interactive-agent Step at a Turn boundary (#217). */
function continueRepeatOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "continue-repeat",
    runId,
    stepId,
    consequence:
      "this does not close the ticket; a fresh Session reads the tracker again and may choose it while it is still open.",
  };
}

/** The `end-stage` offer beside Continue (#218). Its consequence is what the
 *  client's confirmation shows: the human declares the stage done, unverified. */
function endStageOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "end-stage",
    runId,
    stepId,
    consequence:
      "Secant has not checked the tracker. This ends the stage as complete; use it only after you and the agent verified the tickets are done.",
  };
}

/** The `cancel-run` offer for a live Run (#87). */
function cancelRunOffer(runId: string): ActionOffer {
  return {
    action: "cancel-run",
    runId,
    consequence:
      "end the live Run cancelled, stopping execution and keeping its history and Artifacts.",
  };
}

/** The `interrupt-turn` offer for a Run with a live Turn (#118): it carries the
 *  live Turn's id so a control targets exactly that generation. */
function interruptTurnOffer(runId: string, turnId: string): ActionOffer {
  return {
    action: "interrupt-turn",
    runId,
    turnId,
    consequence:
      "stop the live Turn; the agent then waits for your next message in the same Session.",
  };
}

/** The `steer-turn` offer for a live Turn (#118, #148), discriminated on the
 *  prepared Harness profile's steer evidence: `available` carries the live turnId a
 *  client submits against; unavailable carries the evidence as its reason. */
function steerTurnOffer(
  runId: string,
  turnId: string,
  steer: RunSteerCapability,
): ActionOffer {
  return steer.available
    ? {
        action: "steer-turn",
        runId,
        turnId,
        available: true,
        consequence:
          "send same-Turn guidance to the running agent without ending the Turn.",
      }
    : {
        action: "steer-turn",
        runId,
        turnId,
        available: false,
        reason: steer.evidence,
      };
}

/** The `delete-run` offer for a resting or terminal Run (#87). */
function deleteRunOffer(runId: string): ActionOffer {
  return {
    action: "delete-run",
    runId,
    consequence:
      "remove the Run and its stored history and Artifacts from disk.",
  };
}

/** Narrow a stored Session availability to the client union, defaulting an
 *  unrecognized value to `unusable` (the safe read at the ingress, D7). A Session
 *  with a recorded transcript advertises its typed `page`/`export` References
 *  (#124), reached through `readResource`; the bytes are never inlined here. */
function sessionView(
  runId: string,
  record: HarnessSessionRecord,
  name: string,
  hasTranscript: boolean,
): RunSessionView {
  const availability =
    record.availability === "open" ||
    record.availability === "detached" ||
    record.availability === "unusable"
      ? record.availability
      : "unusable";
  return {
    session: record.session,
    name,
    availability,
    ...(hasTranscript
      ? {
          transcriptPage: {
            runId,
            session: record.session,
            type: "transcript-page",
          },
          transcriptExport: {
            runId,
            session: record.session,
            type: "transcript-export",
          },
        }
      : {}),
  };
}

/** Narrow a stored Turn kind to the client union, or undefined when it is absent
 *  (a legacy row) or unrecognized — the safe truthful read at the ingress (D7): an
 *  unknown kind is omitted, never coerced to a guess. */
function toTurnKind(kind: string | undefined): RunTurnKind | undefined {
  return kind === "agent" || kind === "interactive-agent" ? kind : undefined;
}

/** A `turn-started` entry's requested model and effort (ADR 0034): free text, so
 *  copied as stored, and omitted when the Turn recorded no request. */
function requestFields(
  turn: TurnRecord,
): Pick<RunTimelineEvent, "requestedModel" | "requestedEffort"> {
  const choice = turn.modelChoice;
  if (choice === undefined) return {};
  return {
    requestedModel: choice.model,
    ...(choice.effort !== undefined ? { requestedEffort: choice.effort } : {}),
  };
}

/** Each Turn's Step, decoded from its stored Attempt id (#289), keyed by Turn id. */
export function turnSteps(
  turns: readonly TurnRecord[],
): ReadonlyMap<string, string> {
  const steps = new Map<string, string>();
  for (const turn of turns) {
    const step = attemptStepId(turn.attemptId);
    if (step !== undefined) steps.set(turn.turnId, step);
  }
  return steps;
}

/** Narrow a stored transcript entry to the client view, naming the Step whose Turn
 *  wrote it (`turnSteps`). Shared with the transcript-resource resolver so
 *  page/export output matches the inline view. */
export function transcriptView(
  record: TranscriptEntryRecord,
  steps: ReadonlyMap<string, string>,
): RunTranscriptEntryView {
  const step = steps.get(record.turnId);
  return {
    session: record.session,
    role: record.role === "assistant" ? "assistant" : "user",
    content: record.content,
    ...(step !== undefined ? { step } : {}),
  };
}

/** A one-line, capped detail for a timeline entry drawn from possibly-multiline
 *  content, so `run show`'s per-line timeline stays legible. */
const TIMELINE_DETAIL_LIMIT = 160;

function timelineDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TIMELINE_DETAIL_LIMIT) return flat;
  const contentLimit =
    TIMELINE_DETAIL_LIMIT - RUN_TIMELINE_TRUNCATION_MARKER.length - 1;
  return `${flat.slice(0, contentLimit)} ${RUN_TIMELINE_TRUNCATION_MARKER}`;
}

const steerEventSchema = z.object({
  steerId: z.string(),
  text: z.string(),
  sentAt: z.iso.datetime(),
  settlement: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("delivered"),
      delivery: z.enum(["within-turn", "after-boundary", "re-delivered"]),
    }),
    z.object({
      kind: z.literal("dropped"),
      reason: z.enum(["interrupt", "loss"]),
    }),
  ]),
});

const effectiveModelEventSchema = z.object({
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});

const declinedElicitationSchema = z.object({
  harness: z.enum(["codex", "claude-code"]),
  server: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

/** The turn-event timeline entries for one Turn's normalized durable events. */
function turnEventEntry(event: TurnEventRecord): RunTimelineEvent | undefined {
  if (event.kind === "elicitation-declined") {
    let payload: unknown;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      return undefined;
    }
    const parsed = declinedElicitationSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const { harness, server, message, url } = parsed.data;
    const name = harness === "codex" ? "Codex" : "Claude Code";
    return {
      at: event.at,
      event: "elicitation-declined",
      elicitation: parsed.data,
      detail: timelineDetail(
        `Secant cannot show this elicitation. Finish setup in ${name} directly before continuing. Declined from ${server}: ${message}${url === undefined ? "" : ` · ${url}`}`,
      ),
    };
  }

  // The effective model and effort a Turn's Harness reported (#345), copied as
  // stored; a malformed payload projects nothing rather than a guess.
  if (event.kind === "model") {
    let payload: unknown;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      return undefined;
    }
    const parsed = effectiveModelEventSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const { model, effort } = parsed.data;
    return {
      at: event.at,
      event: "effective-model",
      detail: effort !== undefined ? `${model} · ${effort}` : model,
      effectiveModel: model,
      ...(effort !== undefined ? { effectiveEffort: effort } : {}),
    };
  }
  if (event.kind === "steer") {
    let payload: unknown;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      return undefined;
    }
    const parsed = steerEventSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    const steer = parsed.data;
    const settlement =
      steer.settlement.kind === "dropped"
        ? `dropped by ${steer.settlement.reason}`
        : {
            "within-turn": "delivered within Turn",
            "after-boundary": "delivered after boundary",
            "re-delivered": "re-delivered",
          }[steer.settlement.delivery];
    return {
      at: event.at,
      event: "steer",
      detail: timelineDetail(`${settlement} · ${steer.text}`),
      steer,
    };
  }
  if (event.kind === "assistant-content") {
    const content = safeField(event.payload, "content");
    return {
      at: event.at,
      event: "assistant-content",
      detail: timelineDetail(content ?? ""),
    };
  }
  if (event.kind === "tool-activity") {
    const tool = safeField(event.payload, "tool") ?? "tool";
    const phase = safeField(event.payload, "phase") ?? "";
    return {
      at: event.at,
      event: "tool-activity",
      detail: `${tool} ${phase}`.trim(),
    };
  }
  // Approval Harness Request lifecycle (#117): the raised request names its tool
  // and serialized input; the answer names who answered and the decision; the
  // expiry names the request. Durable history — the request itself is never stored.
  if (event.kind === "request-raised") {
    const tool = safeField(event.payload, "tool") ?? "tool";
    const input = safeField(event.payload, "input") ?? "";
    return {
      at: event.at,
      event: "request-raised",
      detail: timelineDetail(`${tool} ${input}`),
    };
  }
  if (event.kind === "request-answered") {
    const by = safeField(event.payload, "by");
    const decision = safeField(event.payload, "decision");
    const who =
      by === "client-policy"
        ? "answered by client policy"
        : by === "human"
          ? "answered by human"
          : "answered";
    return {
      at: event.at,
      event: "request-answered",
      detail: decision !== undefined ? `${who} (${decision})` : who,
    };
  }
  if (event.kind === "request-expired") {
    const requestId = safeField(event.payload, "requestId");
    return {
      at: event.at,
      event: "request-expired",
      ...(requestId !== undefined ? { detail: requestId } : {}),
    };
  }
  return undefined;
}

/** Read one string field from a JSON payload, or undefined on any parse fault. */
function safeField(payload: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string") return value;
    }
  } catch {
    // A malformed payload contributes no detail rather than throwing the read.
  }
  return undefined;
}

function buildTimeline(
  deps: RunProjectionDependencies,
  createdAt: string,
  log: readonly AttemptLogEntry[],
  digest: string,
  iterationEvents: readonly IterationMark[],
  checkpoint: RunCheckpointView | undefined,
  conflicts: readonly MaterializationConflict[],
  gateAnswers: readonly GateAnswerRecord[],
  turns: readonly TurnRecord[],
  turnEvents: readonly TurnEventRecord[],
  routing: readonly RoutingNode[],
  names: ReadonlyMap<string, string>,
): RunTimelineEvent[] {
  // Each event is keyed by the Step instance it belongs to (#289): the log index of
  // its Attempt, so at an equal instant one Step's events stay together instead of
  // interleaving by category with the next Step's. An Attempt still running (or
  // never settled) has Turns but no log entry yet, so it ranks after every settled
  // Attempt, in admission order. Run-scoped events rank first.
  const attemptOrder = new Map<string, number>();
  log.forEach((attempt, index) => attemptOrder.set(attempt.attemptId, index));
  for (const turn of turns) {
    if (!attemptOrder.has(turn.attemptId)) {
      attemptOrder.set(turn.attemptId, attemptOrder.size);
    }
  }
  // An event with no Attempt of its own ranks after every Attempt that settled at or
  // before its instant.
  const afterSettled = (at: string): number =>
    log.filter((attempt) => attempt.at <= at).length - 0.5;
  const events: { readonly event: RunTimelineEvent; readonly order: number }[] =
    [{ event: { at: createdAt, event: "run-created" }, order: -1 }];
  const entry = deps.catalog.listEntries().find((e) => e.digest === digest);
  if (entry !== undefined) {
    const grant = deps.catalog.getTrustGrant(
      digest,
      entry.installationGeneration,
    );
    if (grant !== undefined) {
      events.push({
        event: {
          at: grant.grantedAt,
          event: "trust-granted",
          detail: grant.operationId,
        },
        order: -1,
      });
    }
  }
  // Only End Step publishes an interactive-agent Attempt, in any iteration (#216);
  // inside a human-controlled Repeat only Continue (#217) or End Stage (#218) does,
  // told apart by the End Stage mark on the log entry.
  const interactiveSteps = new Set(
    flattenSteps(routing)
      .filter((step) => step.kind === "interactive-agent")
      .map((step) => step.id),
  );
  log.forEach((attempt, index) => {
    const stepId = attemptStepId(attempt.attemptId);
    events.push({
      event: {
        at: attempt.at,
        event:
          stepId === undefined || !interactiveSteps.has(stepId)
            ? "attempt-settled"
            : attempt.endsStage === true
              ? "stage-ended"
              : inHumanRepeat(routing, stepId)
                ? "repeat-continued"
                : "interactive-step-ended",
        detail: attempt.outcome,
        ...(attempt.endedBy === "agent"
          ? {
              endedBy: "agent" as const,
              reason: latestAgentCall(
                { turns: () => turns, turnEvents: () => turnEvents },
                attempt.attemptId,
              )?.call.reason,
            }
          : {}),
        ...(stepId !== undefined ? { step: stepId } : {}),
      },
      order: index,
    });
  });
  // Each completed Repeat-group iteration, then the block when the Run rests at a
  // Review checkpoint (#84). ponytail: per-Attempt Verdict *values* still are not
  // tied to their Attempt through the Store Interface (no attempt→version link),
  // so the Verdict is reached as an output; add Verdict values here when it lands.
  // Both belong to the group, not one Step, so they name none.
  for (const iteration of iterationEvents) {
    events.push({ event: iteration.event, order: iteration.logIndex });
  }
  if (checkpoint !== undefined) {
    events.push({
      event: {
        at: log[log.length - 1]?.at ?? createdAt,
        event: "checkpoint-blocked",
        detail: String(checkpoint.completedIterations),
      },
      order: log.length - 1,
    });
  }
  // Each durable Human Gate answer, in the order it was recorded (#85), so the
  // grant/stop history stays readable after the Run resumes or ends.
  for (const answer of gateAnswers) {
    events.push({
      event: { at: answer.at, event: "gate-answered", detail: answer.answer },
      order: attemptOrder.get(answer.gateAttemptId) ?? afterSettled(answer.at),
    });
  }
  // Each conflict names its declared Workspace path (AC5). It is recorded before
  // the Step it stops runs, so it has no Attempt and names no Step.
  for (const conflict of conflicts) {
    events.push({
      event: {
        at: conflict.at,
        event: "materialization-conflict",
        detail: conflict.path,
      },
      order: afterSettled(conflict.at),
    });
  }
  // Each Harness Turn (#116): admitted (naming its Session and the Model choice it
  // requested, ADR 0034), then — once settled — its result kind. Each carries its
  // Crucible Turn kind (#126), narrowed at this read ingress (D7) so a client labels reopened Agent and Interactive Turns
  // without inferring from `progress[position]`; a legacy row with no kind omits it.
  // The authoritative assistant content and tool activity in between come from the
  // normalized durable events. Every Turn-scoped event names its Step and its
  // Session, with the Session's plain name (#289).
  const scope = (turn: TurnRecord) => {
    const step = attemptStepId(turn.attemptId);
    return {
      ...(step !== undefined ? { step } : {}),
      session: turn.session,
      sessionName: names.get(turn.session) ?? turn.session,
    };
  };
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  for (const turn of turns) {
    const turnKind = toTurnKind(turn.kind);
    const kindField = turnKind !== undefined ? { turnKind } : {};
    const order = attemptOrder.get(turn.attemptId)!;
    events.push({
      event: {
        at: turn.admittedAt,
        event: "turn-started",
        detail: turn.session,
        ...kindField,
        ...requestFields(turn),
        ...scope(turn),
      },
      order,
    });
    if (turn.settledAt !== undefined && turn.resultKind !== undefined) {
      events.push({
        event: {
          at: turn.settledAt,
          event: "turn-settled",
          detail: turn.resultKind,
          ...kindField,
          ...scope(turn),
        },
        order,
      });
    }
  }
  for (const turnEvent of turnEvents) {
    const call = readAgentCallEvent(turnEvent);
    const callTurn = turnsById.get(turnEvent.turnId);
    const entry: RunTimelineEvent | undefined =
      call !== undefined
        ? {
            at: turnEvent.at,
            event: "agent-call",
            agentCall: {
              id: call.id,
              reason: call.reason,
              answer: call.answer,
              disposition:
                callTurn?.resultKind === undefined
                  ? "pending"
                  : callTurn.resultKind === "completed"
                    ? "completed"
                    : "dropped",
            },
          }
        : turnEventEntry(turnEvent);
    if (entry === undefined) continue;
    const turn = turnsById.get(turnEvent.turnId);
    events.push(
      turn === undefined
        ? { event: entry, order: afterSettled(entry.at) }
        : {
            event: { ...entry, ...scope(turn) },
            order: attemptOrder.get(turn.attemptId)!,
          },
    );
  }
  // Order the timeline by `at` (ISO 8601 sorts lexicographically), then by Step
  // instance, then by category, so events at the same instant keep a stable,
  // meaningful order (#98 A2, #289). Sorting by time — rather than emitting category
  // by category — means a later Attempt never reorders the events that preceded it.
  return events
    .sort((a, b) =>
      a.event.at < b.event.at
        ? -1
        : a.event.at > b.event.at
          ? 1
          : a.order !== b.order
            ? a.order - b.order
            : TIMELINE_CATEGORY_RANK[a.event.event] -
              TIMELINE_CATEGORY_RANK[b.event.event],
    )
    .map((keyed) => keyed.event);
}

/** Each recorded Session's plain name (#289), read from the Turns that ran in it:
 *  the authored name when the Session is shared, and the authored name with its
 *  one-based Iteration when the Run scoped it to one Attempt (a per-Iteration or
 *  `fresh` Session). A Session no Turn names, or whose Step the Snapshot lacks, keeps
 *  its recorded name. */
function sessionNames(
  routing: readonly RoutingNode[],
  turns: readonly TurnRecord[],
): ReadonlyMap<string, string> {
  const authored = new Map<string, string>();
  for (const step of flattenSteps(routing)) {
    if (step.kind === "agent" || step.kind === "interactive-agent") {
      authored.set(step.id, step.session);
    }
  }
  const names = new Map<string, string>();
  for (const turn of turns) {
    if (names.has(turn.session)) continue;
    const stepId = attemptStepId(turn.attemptId);
    const name = stepId !== undefined ? authored.get(stepId) : undefined;
    const iteration = attemptIteration(turn.attemptId);
    if (name === undefined || iteration === undefined) continue;
    names.set(
      turn.session,
      turn.session === name ? name : `${name}, iteration ${iteration + 1}`,
    );
  }
  return names;
}

/** The tiebreak order for timeline events sharing an `at` (#98 A2): the same
 *  category order `buildTimeline` emits in, so equal-instant events read run-created
 *  → trust → attempt → iteration → checkpoint → gate-answer → conflict. */
const TIMELINE_CATEGORY_RANK: Record<RunTimelineKind, number> = {
  "run-created": 0,
  "trust-granted": 1,
  // A Turn's own events sort before the Attempt that settles after it, so an
  // equal-instant ordering reads start → content → tool → settled → attempt.
  "turn-started": 2,
  "effective-model": 3,
  "assistant-content": 3,
  "tool-activity": 4,
  // An approval request's lifecycle sorts between tool activity and the Turn's
  // settle, in raise → answer → expire order for an equal instant (#117).
  "request-raised": 5,
  "request-answered": 6,
  "request-expired": 7,
  "elicitation-declined": 7,
  steer: 7,
  "turn-settled": 8,
  "interactive-step-ended": 9,
  "repeat-continued": 9,
  "stage-ended": 9,
  "agent-call": 8,
  "attempt-settled": 10,
  iteration: 11,
  "checkpoint-blocked": 12,
  "gate-answered": 13,
  "materialization-conflict": 14,
};

// --- entry selection -------------------------------------------------------

/** Select the installed Entry a launch names, through the one selector shared with
 *  the Bundle-catalog focus join (#98 A18): an omitted version is the highest stable
 *  installed version; a prerelease must be named (#9, #49). */
export function selectRunEntry(
  catalog: Catalog,
  id: string,
  version: string | undefined,
): { entry: CatalogEntry } | { problem: Problem } {
  return selectInstalledEntry(catalog.listEntries(), id, version);
}
