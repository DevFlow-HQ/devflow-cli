import type { ModelChange } from "../harness/harness.js";
import type {
  LiveInterruptFn,
  LiveModelChangeFn,
  LiveObservation,
  LiveRequestView,
  LiveSteerFn,
  RequestAnswerFn,
  RequestChannel,
} from "../run/execution/execution.js";
import type {
  AnswerHarnessRequestOffer,
  RunLiveOverlay,
  RunOutstandingRequest,
  TurnPhase,
} from "./projection-port.js";
import { UpdateStream } from "./update-stream.js";

export interface LiveOverlayState {
  generation: number;
  phase: TurnPhase;
  readonly outstanding: Map<string, RunOutstandingRequest>;
  answer?: RequestAnswerFn;
  /** The live Turn's steer function, bound while a Turn is live (#148). The
   *  Application reaches it for an available `steer-turn`. */
  steer?: LiveSteerFn;
  interrupt?: LiveInterruptFn;
  /** The live Turn's Model choice change (#348), bound while a Turn is live. */
  changeModel?: LiveModelChangeFn;
  /** The live Turn's Session commands (ADR 0040), which Steer admission refuses
   *  while the Turn works. */
  sessionCommands?: readonly string[];
  context?: RunLiveOverlay["context"];
  usage?: string;
  active: boolean;
}

interface LiveTrackedRun {
  readonly observers: Set<UpdateStream>;
  readonly live: LiveOverlayState;
}

export interface LiveOverlayChannel {
  fresh(): LiveOverlayState;
  push(runId: string, only?: UpdateStream): void;
  requestChannel(runId: string): RequestChannel;
}

/** Where the Harness's answers to Model choice changes go (#348): the
 *  Application owns the Run write they decide. `ended` follows the Turn's
 *  settlement, so a change still unanswered applies from the next Turn. */
interface ModelChangeListener {
  reported(runId: string, change: ModelChange): void;
  ended(runId: string): void;
  tool(runId: string, tool: NonNullable<LiveObservation["tool"]>): void;
  thought(
    runId: string,
    thought: NonNullable<LiveObservation["thought"]>,
  ): void;
  message(
    runId: string,
    message: NonNullable<LiveObservation["message"]>,
  ): void;
}

/** Own the Application's ephemeral Turn overlay behind one tracking accessor.
 *  Durable Run state stays with the Application; this private submodule owns the
 *  generation, request-answer binding, and coalesced live observations (#134 A31). */
export function createLiveOverlay(
  trackingFor: (runId: string) => LiveTrackedRun | undefined,
  modelChanges: ModelChangeListener,
): LiveOverlayChannel {
  function fresh(): LiveOverlayState {
    return {
      generation: 0,
      phase: "working",
      outstanding: new Map(),
      active: false,
    };
  }

  function build(runId: string): RunLiveOverlay | undefined {
    const tracking = trackingFor(runId);
    if (tracking === undefined || !tracking.live.active) return undefined;
    const live = tracking.live;
    const outstanding = [...live.outstanding.values()];
    const offers: AnswerHarnessRequestOffer[] = outstanding.map((request) => ({
      action: "answer-harness-request",
      runId,
      requestId: request.requestId,
      generation: live.generation,
      decisions: request.decisions,
      basis: "ephemeral Harness Request",
    }));
    return {
      runId,
      generation: live.generation,
      phase: outstanding.length > 0 ? "awaiting-approval" : live.phase,
      outstanding,
      offers,
      ...(live.context !== undefined ? { context: live.context } : {}),
      ...(live.usage !== undefined ? { usage: live.usage } : {}),
    };
  }

  function push(runId: string, only?: UpdateStream): void {
    const overlay = build(runId);
    if (overlay === undefined) return;
    const tracking = trackingFor(runId);
    if (tracking === undefined) return;
    const targets = only !== undefined ? [only] : tracking.observers;
    for (const observer of targets) observer.push({ kind: "live", overlay });
  }

  function requestChannel(runId: string): RequestChannel {
    return {
      raised(request: LiveRequestView): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.active = true;
        tracking.live.generation += 1;
        tracking.live.outstanding.set(request.requestId, {
          requestId: request.requestId,
          tool: request.tool,
          input: request.input,
          decisions: request.decisions,
        });
        push(runId);
      },
      settled(requestId: string): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        if (!tracking.live.outstanding.delete(requestId)) return;
        tracking.live.generation += 1;
        push(runId);
      },
      bindInterrupt(interrupt: LiveInterruptFn | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.interrupt = interrupt;
      },
      bindSteer(steer: LiveSteerFn | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.steer = steer;
      },
      bindModelChange(change: LiveModelChangeFn | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking !== undefined) tracking.live.changeModel = change;
        if (change === undefined) modelChanges.ended(runId);
      },
      modelChanged(change: ModelChange): void {
        modelChanges.reported(runId, change);
      },
      sessionCommands(commands: readonly string[] | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.sessionCommands = commands;
      },
      bindAnswer(answer: RequestAnswerFn | undefined): void {
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        tracking.live.answer = answer;
        if (answer !== undefined) {
          // Reports belong to this Turn, never to the preceding Turn or Session.
          tracking.live.context = undefined;
          tracking.live.usage = undefined;
          tracking.live.active = true;
          tracking.live.phase = "working";
        } else {
          tracking.live.phase = "settling";
          if (tracking.live.outstanding.size > 0) {
            tracking.live.outstanding.clear();
            tracking.live.generation += 1;
          }
        }
        push(runId);
      },
      observe(observation: LiveObservation): void {
        if (observation.tool !== undefined)
          modelChanges.tool(runId, observation.tool);
        const tracking = trackingFor(runId);
        if (tracking === undefined) return;
        const live = tracking.live;
        live.active = true;
        if (observation.message !== undefined)
          modelChanges.message(runId, observation.message);
        if (observation.thought !== undefined)
          modelChanges.thought(runId, observation.thought);
        if (observation.context !== undefined)
          live.context = observation.context;
        if (observation.usage !== undefined) live.usage = observation.usage;
        if (
          observation.context === undefined &&
          observation.usage === undefined
        )
          return;
        push(runId);
      },
    };
  }

  return { fresh, push, requestChannel };
}
