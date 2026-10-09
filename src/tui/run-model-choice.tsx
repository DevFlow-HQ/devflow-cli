import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type {
  ChangeModelChoiceOffer,
  RunView,
} from "../application/projection-port.js";
import {
  ModelChoicePicker,
  type ModelChoiceDraft,
  type ModelChoicePickerHandle,
} from "./model-choice-picker.js";
import type { RunActionsView, RunActionOutcome } from "./run-actions-view.js";
import { useDialog } from "./vendor/dialog.js";
import { modelChoiceText } from "./run-workbench-views.js";

type AvailableOffer = Extract<ChangeModelChoiceOffer, { available: true }>;

/** Owns the Workbench picker lifecycle and its truthful Operation receipt. */
export function createModelChoiceControl(props: {
  run: Accessor<RunView | undefined>;
  offer: Accessor<ChangeModelChoiceOffer | undefined>;
  dims: Accessor<{ width: number; height: number }>;
  dialog: ReturnType<typeof useDialog>;
  submit: RunActionsView["changeModelChoice"];
}) {
  const [showing, setShowing] = createSignal(false);
  const [draft, setDraft] = createSignal<ModelChoiceDraft>({
    kind: "model-needed",
  });
  const [reset, setReset] = createSignal<string>();
  const [flight, setFlight] = createSignal<{
    offer: AvailableOffer;
    choice: NonNullable<AvailableOffer["currentChoice"]>;
    outcome: Accessor<RunActionOutcome>;
  }>();
  const pending = () => flight()?.outcome().kind === "pending";
  /** The requested choice in words while its Operation is still pending. */
  const requested = () => {
    const sent = flight();
    return sent !== undefined && pending()
      ? modelChoiceText(sent.choice)
      : undefined;
  };
  let picker: ModelChoicePickerHandle | undefined;
  const close = () => {
    if (showing()) props.dialog.clear();
  };
  createEffect(() => {
    if (showing() && props.offer()?.available !== true) close();
  });
  onCleanup(close);
  const reachWords = (reach: ChangeModelChoiceOffer["reach"]) =>
    reach === "next-turn"
      ? "applies from the next Turn"
      : "requested until the Harness reports it";
  const messages = (): readonly string[] => {
    const sent = flight();
    if (sent === undefined) return [];
    const outcome = sent.outcome();
    const choice = modelChoiceText(sent.choice);
    if (outcome.kind === "pending")
      return [
        `Model choice requested · ${choice} · ${reachWords(sent.offer.reach)}`,
      ];
    if (outcome.kind === "refused")
      return [
        `Model choice not changed · ${outcome.problem.explanation} ${outcome.problem.remediation}`,
      ];
    const change = outcome.modelChoiceChange;
    // Without a receipt there is no evidence for claiming a live change applied.
    if (change === undefined)
      return [
        "Model choice change accepted. Read the Run for its current choice.",
      ];
    const applied = modelChoiceText(change.choice);
    return [
      `Model choice ${change.reach === "live-turn" ? "applied to the live Turn" : "changed, applies from the next Turn"} · ${applied}`,
      ...(change.effortReset === undefined
        ? []
        : [change.effortReset.explanation]),
    ];
  };
  const open = (stage: "model" | "effort" = "model") => {
    const offer = props.offer();
    if (offer?.available !== true || pending()) return;
    setDraft(
      offer.currentChoice === undefined
        ? { kind: "model-needed" }
        : { kind: "chosen", choice: offer.currentChoice },
    );
    setReset(undefined);
    props.dialog.replace(
      () => (
        <box
          paddingLeft={2}
          paddingRight={2}
          height={Math.max(
            3,
            props.dims().height - Math.floor(props.dims().height / 4) - 2,
          )}
          overflow="hidden"
        >
          <ModelChoicePicker
            focus={() => {
              const current = props.run();
              const available = props.offer();
              if (available?.available !== true) return undefined;
              return {
                id: current?.selectedHarness,
                name:
                  current?.harness?.name ??
                  current?.selectedHarness ??
                  "Run Harness",
                modelDeclaration: available.modelDeclaration,
                effortLock: available.effortLock,
              };
            }}
            status={() => reachWords(props.offer()?.reach ?? offer.reach)}
            draft={draft}
            reset={reset}
            enabled={() => props.offer()?.available === true}
            width={Math.max(1, Math.min(60, props.dims().width - 2) - 4)}
            height={Math.max(
              3,
              props.dims().height - Math.floor(props.dims().height / 4) - 2,
            )}
            initialStage={stage}
            onChoice={(choice, reason) => {
              setDraft({ kind: "chosen", choice });
              setReset(reason);
            }}
            onBack={close}
            onDone={() => {
              const currentOffer = props.offer();
              const chosen = draft();
              if (
                currentOffer?.available !== true ||
                chosen.kind !== "chosen"
              ) {
                close();
                return;
              }
              setFlight({
                offer: currentOffer,
                choice: chosen.choice,
                outcome: props.submit(currentOffer, chosen.choice),
              });
              close();
            }}
            ref={(handle) => {
              picker = handle;
            }}
          />
        </box>
      ),
      () => {
        setShowing(false);
        picker = undefined;
      },
      (key) => {
        if (key.ctrl) {
          if (key.name === "c") close();
          return;
        }
        picker?.key(key.name ?? "");
      },
      props.dims,
    );
    setShowing(true);
  };
  return { open, close, pending, requested, messages };
}
