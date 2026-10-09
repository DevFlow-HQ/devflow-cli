import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  RunView,
  SendFollowUpTurnOffer,
} from "../application/projection-port.js";
import type { AnswerOutcome, SteerOutcome } from "./run-view.js";

/** The semantic input target a draft belongs to: the current Step, and the
 *  Attempt once a follow-up names it. */
interface TPromptTarget {
  /** Survives first Attempt naming; changes only when the semantic target departs. */
  readonly epoch: number;
  readonly step: string;
  readonly attempt?: string;
}

/** Owns draft text, captures and ordered recovery for one Workbench lifetime. */
export function createDraftControl(props: {
  run: Accessor<RunView | undefined>;
  prompt: Accessor<boolean>;
  finished: Accessor<boolean>;
  working: Accessor<boolean>;
  endingPending: Accessor<boolean>;
  refocus(): void;
  refused(
    outcome: Extract<AnswerOutcome, { kind: "refused" }> | undefined,
  ): void;
}) {
  const run = props.run;
  const [draft, setDraft] = createSignal("");
  type CapturedText = {
    readonly order: number;
    readonly target: TPromptTarget;
    readonly text: string;
  };
  type Submission =
    | { readonly kind: "send"; readonly outcome: Accessor<AnswerOutcome> }
    | { readonly kind: "steer"; readonly outcome: Accessor<SteerOutcome> };
  type Capture = CapturedText & Submission;
  const [captures, setCaptures] = createSignal<readonly Capture[]>([]);
  const [recoverable, setRecoverable] = createSignal<readonly CapturedText[]>(
    [],
  );
  const [draftNotice, setDraftNotice] = createSignal<string>();
  const [recoveryNotice, setRecoveryNotice] = createSignal<string>();
  let captureOrder = 0;
  const sendPending = () =>
    captures().some(
      (capture) =>
        capture.kind === "send" && capture.outcome().kind === "pending",
    ) || props.endingPending();
  const steerPending = () =>
    captures().some(
      (capture) =>
        capture.kind === "steer" && capture.outcome().kind === "pending",
    );
  const clear = () =>
    batch(() => {
      setDraft("");
      setDraftNotice(undefined);
      restoredPrefix = [];
    });
  const capture = (submit: (text: string) => Submission) => {
    const text = draft();
    if (text.trim() === "") return;
    const target = promptTarget();
    batch(() => {
      props.refused(undefined);
      clear();
      const submitted = submit(text);
      setCaptures((previous) => [
        ...previous,
        { ...submitted, text, target, order: captureOrder++ },
      ]);
    });
  };
  // The draft belongs to its semantic input target. A different Step, or a
  // follow-up for a different Attempt of the same Step, is fresh and resets only
  // the old target's draft; a follow-up first naming the Attempt of the Step being
  // steered keeps it. Unrelated updates, resize, catch-ups, and the request or
  // gate that briefly holds the bottom region keep the draft and focus.
  const promptTarget = createMemo<TPromptTarget>((previous) => {
    const current = run();
    const followUp = followUpOfferOf(current);
    const step =
      followUp?.stepId ?? current?.progress[current.position]?.id ?? "";
    const attempt = followUp?.attemptId;
    const fresh =
      previous !== undefined &&
      (previous.step !== step ||
        (previous.attempt !== undefined &&
          attempt !== undefined &&
          previous.attempt !== attempt));
    const knownAttempt = attempt ?? (fresh ? undefined : previous?.attempt);
    return {
      step,
      epoch: (previous?.epoch ?? 0) + (fresh ? 1 : 0),
      ...(knownAttempt === undefined ? {} : { attempt: knownAttempt }),
    };
  });
  const targetKey = (target: TPromptTarget) => String(target.epoch);
  const sameTarget = (a: TPromptTarget, b: TPromptTarget) =>
    a.epoch === b.epoch;
  let lastTarget: TPromptTarget | undefined;
  let lastFollowUpTurn = "";
  // The target a restore last filled: the two effects run in no fixed order, so a
  // fresh target never clears a draft restored into it on the same snapshot.
  let restoredTargetKey = "";
  createEffect(() => {
    if (run() === undefined) return;
    const target = promptTarget();
    const previous = lastTarget;
    const fresh = previous !== undefined && previous.epoch !== target.epoch;
    if (props.finished() && untrack(draft) !== "") {
      const text = untrack(draft);
      setRecoverable((saved) =>
        [
          ...saved,
          {
            text,
            target: previous ?? target,
            order: captureOrder++,
          },
        ].sort((a, b) => a.order - b.order),
      );
      clear();
    }
    if (fresh) {
      if (restoredTargetKey !== targetKey(target)) {
        clear();
      }
      props.refused(undefined);
      props.refocus();
    }
    lastTarget = target;
    // Each newly interrupted Turn hands the person its reply (#354).
    const followUp = followUpOfferOf(run());
    if (followUp !== undefined && followUp.turnId !== lastFollowUpTurn)
      props.refocus();
    if (followUp !== undefined) lastFollowUpTurn = followUp.turnId;
  });

  // Restored captures remain an ordered prefix while native edits preserve it.
  // Editing that prefix makes it ordinary draft text; consumed captures never replay.
  let restoredPrefix: readonly CapturedText[] = [];
  const restore = (texts: readonly CapturedText[]) => {
    const prefix = restoredPrefix.map((text) => text.text).join("\n");
    const current = untrack(draft);
    const intact =
      prefix !== "" &&
      (current === prefix || current.startsWith(`${prefix}\n`));
    const unsent = intact
      ? current.slice(prefix.length).replace(/^\n/, "")
      : current;
    restoredPrefix = [...(intact ? restoredPrefix : []), ...texts].sort(
      (a, b) => a.order - b.order,
    );
    restoredTargetKey = targetKey(promptTarget());
    setDraft(
      [...restoredPrefix.map((text) => text.text), unsent]
        .filter((text) => text !== "")
        .join("\n"),
    );
  };
  const handledReceipts = new Set<number>();
  const restoredCaptures = new Set<number>();
  const seenSteers = new Set<string>();
  const matchedSteers = new Set<number>();
  let steerHistoryOpened = false;
  type Restoration = CapturedText & {
    readonly reason: "refused" | "interrupt";
  };
  let restoreQueue: Restoration[] = [];
  const enqueue = (text: CapturedText, reason: Restoration["reason"]) => {
    if (restoredCaptures.has(text.order)) return;
    restoredCaptures.add(text.order);
    restoreQueue.push({ ...text, reason });
  };
  createEffect(() => {
    const current = run();
    if (current === undefined) return;
    const target = promptTarget();
    const flights = captures();
    for (const flight of flights) {
      const outcome = flight.outcome();
      if (outcome.kind === "pending" || handledReceipts.has(flight.order))
        continue;
      handledReceipts.add(flight.order);
      if (outcome.kind === "refused") {
        enqueue(flight, "refused");
        if (sameTarget(flight.target, target)) {
          props.refused(outcome);
          if (
            flight.kind === "steer" &&
            outcome.problem.code === "turn-control-rejected"
          )
            setDraftNotice("Late Steer · text restored to draft");
        }
      }
    }
    const entries = current.timeline.flatMap((event) =>
      event.steer === undefined || event.steer.settlement.kind === "waiting"
        ? []
        : [{ event, steer: event.steer }],
    );
    if (!steerHistoryOpened) {
      for (const { steer } of entries) seenSteers.add(steer.steerId);
      steerHistoryOpened = true;
    }
    const readyForDrops =
      !steerPending() &&
      !sendPending() &&
      !props.working() &&
      (interactiveStep(current) ||
        followUpOfferOf(current) !== undefined ||
        current.state !== "running");
    if (readyForDrops) {
      for (const { event, steer } of entries) {
        if (seenSteers.has(steer.steerId)) continue;
        seenSteers.add(steer.steerId);
        const flight = flights.find((capture) => {
          if (capture.kind !== "steer" || matchedSteers.has(capture.order))
            return false;
          const outcome = capture.outcome();
          return outcome.steerId === steer.steerId;
        });
        if (flight !== undefined) matchedSteers.add(flight.order);
        if (
          steer.settlement.kind !== "dropped" ||
          steer.settlement.reason !== "interrupt"
        )
          continue;
        if (
          flight === undefined &&
          event.step !== current.progress[current.position]?.id
        )
          continue;
        if (
          !interactiveStep(current) &&
          followUpOfferOf(current) === undefined &&
          sameTarget(flight?.target ?? target, target)
        )
          continue;
        enqueue(
          flight ?? { text: steer.text, target, order: captureOrder++ },
          "interrupt",
        );
      }
    }
    // Queued recovery owns settled sends and definite refusals. Only admitted or
    // uncertain-effect Steers still need their durable delivery evidence.
    const outstanding = flights.filter((capture) => {
      const outcome = capture.outcome();
      if (outcome.kind === "pending") return true;
      if (capture.kind !== "steer" || matchedSteers.has(capture.order))
        return false;
      return (
        outcome.kind === "applied" || outcome.problem.possibleEffects !== "none"
      );
    });
    if (outstanding.length !== flights.length) setCaptures(outstanding);
    if (restoreQueue.length === 0) return;
    const waiting: Restoration[] = [];
    const ready: Restoration[] = [];
    const old: CapturedText[] = [];
    for (const text of restoreQueue) {
      if (!sameTarget(text.target, target) || props.finished()) old.push(text);
      else if (
        !props.prompt() ||
        flights.some(
          (capture) =>
            capture.order < text.order &&
            capture.outcome().kind === "pending" &&
            sameTarget(capture.target, text.target),
        )
      )
        waiting.push(text);
      else ready.push(text);
    }
    restoreQueue = waiting;
    untrack(() =>
      batch(() => {
        if (old.length > 0)
          setRecoverable((previous) =>
            [...previous, ...old].sort((a, b) => a.order - b.order),
          );
        if (ready.length > 0) {
          restore(ready);
          if (ready.some((text) => text.reason === "interrupt"))
            setDraftNotice(
              (previous) =>
                previous ?? "◇ Steer dropped by interrupt · draft restored",
            );
        }
      }),
    );
  });

  return {
    draft,
    input: (text: string) => (text === "" ? clear() : setDraft(text)),
    clear,
    sendPending,
    steerPending,
    send: (submit: (text: string) => Accessor<AnswerOutcome>) =>
      capture((text) => ({ kind: "send", outcome: submit(text) })),
    steer: (submit: (text: string) => Accessor<SteerOutcome>) =>
      capture((text) => ({ kind: "steer", outcome: submit(text) })),
    note: draftNotice,
    savedCount: () => recoverable().length,
    savedText: () =>
      recoverable()
        .map((text) => text.text)
        .join("\n"),
    recoveryNotice,
    copied: (copied: boolean) =>
      setRecoveryNotice(
        copied
          ? "Saved unsent text copied to terminal clipboard"
          : "Clipboard unavailable · unsent text remains saved",
      ),
    recover: () =>
      batch(() => {
        restore(recoverable());
        setRecoverable([]);
        setRecoveryNotice(undefined);
        setDraftNotice("Earlier-input text recovered into this draft");
      }),
  };
}

/** Whether the Run's current Step is an Interactive agent step. */
export function interactiveStep(run: RunView | undefined): boolean {
  return run?.progress[run.position]?.kind === "interactive-agent";
}

/** The follow-up Offer of an Agent Step waiting after an Interrupt (#354). */
export function followUpOfferOf(
  run: RunView | undefined,
): SendFollowUpTurnOffer | undefined {
  return run?.actionOffers.find(
    (offer): offer is SendFollowUpTurnOffer =>
      offer.action === "send-follow-up-turn",
  );
}
