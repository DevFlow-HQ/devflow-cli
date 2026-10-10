import type { RunOwner, TurnRecord } from "./store.js";

/** The latest Turn of the open Agent Step Attempt — one with admitted Turns and no
 *  published outcome — whose `attemptId` names that Attempt (#352). Read from the
 *  Turns and the attempt log already stored, so it adds no durable record. Only a
 *  Turn admitted with kind `agent` counts: a resting Interactive Attempt also has
 *  Turns and no outcome, and a legacy row's unknown kind is never guessed to be an
 *  Agent one. Should more than one be open, the Run's latest such Turn wins. Open is
 *  not waiting: a crash-abandoned Attempt stays open behind its `lost` Turn until a
 *  resume re-runs it, so the waiting basis also needs the Run `blocked` and this
 *  Turn `interrupted`. */
export function openAgentAttemptTurn(
  run: Pick<RunOwner, "turns" | "attemptLog">,
): TurnRecord | undefined {
  const published = new Set(run.attemptLog().map((entry) => entry.attemptId));
  return run
    .turns()
    .filter((turn) => turn.kind === "agent" && !published.has(turn.attemptId))
    .at(-1);
}

/** The Attempt-level waiting basis (#354): the open Agent Attempt's latest Turn
 *  when an Interrupt ended it, or a process signal stopped a human follow-up (#537).
 *  A signal cancels the autonomous Turn's Attempt instead, and a crash leaves the
 *  Turn `lost`, so neither waits. The Run-level rest — `blocked`,
 *  with no gate or checkpoint — is the caller's to add. */
export function waitingAgentTurn(
  run: Pick<RunOwner, "turns" | "attemptLog">,
): TurnRecord | undefined {
  const open = openAgentAttemptTurn(run);
  return open?.resultKind === "interrupted" ? open : undefined;
}
