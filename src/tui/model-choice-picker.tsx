import { TextAttributes } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { HarnessFocus } from "../application/projection-port.js";
import {
  harnessFocusStatus,
  modelChoiceSourceLine,
  modelChoiceWords,
} from "./harness-format.js";
import { useTheme } from "./vendor/theme-context.js";
import { wrap } from "./wrap.js";

type Choice = NonNullable<HarnessFocus["preselection"]>["choice"];
export type ModelChoiceDraft =
  | { readonly kind: "chosen"; readonly choice: Choice }
  | { readonly kind: "model-needed"; readonly effort?: string };

type Stage = "model" | "effort" | "other";

/** The host routes navigation keys; unbound text editing stays with the native input. */
export interface ModelChoicePickerHandle {
  key(name: string): void;
  typing: Accessor<boolean>;
}

export function ModelChoicePicker(props: {
  focus: Accessor<HarnessFocus | undefined>;
  draft: Accessor<ModelChoiceDraft>;
  reset: Accessor<string | undefined>;
  enabled: Accessor<boolean>;
  width: number;
  height: number;
  initialStage: "model" | "effort";
  onChoice: (choice: Choice, reset?: string) => void;
  onDone: () => void;
  onBack: () => void;
  ref: (handle: ModelChoicePickerHandle) => void;
}) {
  const { theme } = useTheme();
  const [stage, setStage] = createSignal<Stage>(props.initialStage);
  const [highlight, setHighlight] = createSignal(0);
  const [typed, setTyped] = createSignal("");
  const [offset, setOffset] = createSignal(0);
  const currentChoice = () => {
    const draft = props.draft();
    return draft.kind === "chosen" ? draft.choice : undefined;
  };
  const currentEffort = () => {
    const draft = props.draft();
    return draft.kind === "chosen" ? draft.choice.effort : draft.effort;
  };
  const declaration = () => props.focus()?.modelDeclaration;
  const lock = () => {
    const focus = props.focus();
    const defaults = focus?.harnessDefaults;
    return (
      focus?.preselection?.effortLock ??
      (defaults?.kind === "reported" || defaults?.kind === "fallback"
        ? defaults.effortLock
        : undefined)
    );
  };
  const modelEntries = () => {
    const decl = declaration();
    return decl === undefined || decl.kind === "free-text" ? [] : decl.models;
  };
  const selectedEntry = () =>
    modelEntries().find((entry) => entry.model === currentChoice()?.model);
  const efforts = () => {
    const decl = declaration();
    if (decl === undefined)
      return currentChoice()?.effort === undefined
        ? []
        : [currentChoice()?.effort ?? ""];
    return (
      selectedEntry()?.efforts ?? (decl.kind === "list" ? [] : decl.efforts)
    );
  };
  const modelOptions = createMemo(() => {
    const entries = modelEntries().map((entry) => ({
      kind: "model" as const,
      model: entry.model,
      label: modelChoiceWords({ model: entry.model }, declaration()),
    }));
    const current = currentChoice()?.model;
    const decl = declaration();
    if (
      current !== undefined &&
      !entries.some((entry) => entry.model === current) &&
      decl?.kind !== "list"
    ) {
      entries.push({ kind: "model", model: current, label: current });
    }
    return decl !== undefined && decl.kind !== "list"
      ? [
          ...entries,
          { kind: "other" as const, label: "Other… exact model name" },
        ]
      : entries;
  });
  const disabledEffort = () => lock() !== undefined || efforts().length === 0;
  const count = () =>
    stage() === "model" ? modelOptions().length : efforts().length;
  const resetHighlight = () => {
    setOffset(0);
    setHighlight(
      Math.max(
        0,
        stage() === "model"
          ? modelOptions().findIndex(
              (entry) =>
                entry.kind === "model" &&
                entry.model === currentChoice()?.model,
            )
          : efforts().indexOf(currentEffort() ?? ""),
      ),
    );
  };
  // Qualification may settle after mount. Re-open on the current value rather than row zero.
  createEffect(() => {
    if (props.enabled()) resetHighlight();
  });
  const chooseModel = (model: string) => {
    const previous = currentEffort();
    const decl = declaration();
    const entry = modelEntries().find((entry) => entry.model === model);
    const offered =
      entry?.efforts ??
      (decl === undefined
        ? undefined
        : decl.kind === "list"
          ? []
          : decl.efforts);
    let effort = lock()?.effort ?? previous;
    let reset = props.reset();
    if (
      lock() === undefined &&
      offered !== undefined &&
      !offered.includes(effort ?? "")
    ) {
      effort = offered.length === 0 ? undefined : entry?.defaultEffort;
      if (previous !== undefined && effort !== undefined) {
        reset = `${model} does not offer ${previous} effort. Effort changed to ${effort}, its default.`;
      }
    }
    props.onChoice(
      { model, ...(effort === undefined ? {} : { effort }) },
      reset,
    );
    setStage("effort");
    resetHighlight();
  };
  const choose = () => {
    if (stage() === "other") {
      const model = typed().trim();
      if (model.length > 0) chooseModel(model);
    } else if (stage() === "model") {
      const candidate = modelOptions()[highlight()];
      if (candidate?.kind === "model") chooseModel(candidate.model);
      else if (candidate?.kind === "other") {
        setTyped("");
        setStage("other");
      }
    } else {
      const choice = currentChoice();
      if (choice === undefined) return;
      const effort =
        lock()?.effort ??
        (disabledEffort() ? undefined : efforts()[highlight()]);
      if (!disabledEffort() && effort === undefined) return;
      props.onChoice(
        { model: choice.model, ...(effort === undefined ? {} : { effort }) },
        props.reset(),
      );
      props.onDone();
    }
  };
  const headerLines = createMemo(() => {
    const focus = props.focus();
    const preselection = focus?.preselection;
    const lines = [
      stage() === "effort" ? "2. Choose effort" : "1. Choose a model",
      `Harness: ${focus?.name ?? "(not selected)"} (${focus?.id ?? "none"})`,
      harnessFocusStatus(focus),
    ];
    if (!props.enabled()) {
      lines.push(
        focus?.unavailable === undefined
          ? "Checking the Harness and loading model choices… Please wait."
          : `${focus.unavailable.explanation} ${focus.unavailable.remediation}`,
      );
    } else {
      if (focus?.preferenceNotice !== undefined)
        lines.push(focus.preferenceNotice);
      if (preselection !== undefined) {
        lines.push(
          `Starts from ${modelChoiceWords(preselection.choice, declaration())}`,
          modelChoiceSourceLine(
            focus?.name ?? "the Harness",
            preselection.source,
            preselection.choice,
            declaration(),
          ),
        );
      } else if (focus?.harnessDefaults?.kind === "unavailable")
        lines.push(`Nothing to start from. ${focus.harnessDefaults.reason}`);
      if (stage() === "effort" && currentChoice() !== undefined)
        lines.push(
          `Model: ${modelChoiceWords({ model: currentChoice()?.model ?? "" }, declaration())}`,
        );
      if (props.reset() !== undefined) lines.push(props.reset() ?? "");
      const locked = lock();
      if (locked !== undefined)
        lines.push(
          `Locked by ${locked.source}. Change that setting outside Secant.`,
        );
      else if (stage() === "effort" && efforts().length === 0)
        lines.push("This model has no effort setting.");
    }
    return lines.flatMap((line) => wrap(line, props.width));
  });
  const hint = () =>
    !props.enabled()
      ? "esc back · ctrl+c quit"
      : stage() === "other"
        ? "enter accept · esc cancel"
        : stage() === "effort" && disabledEffort()
          ? "enter acknowledge · esc back"
          : "↑/↓ move · enter choose · esc back · PgUp/PgDn scroll";
  const footerLines = () => wrap(hint(), props.width);
  const floatingHeader = () =>
    headerLines().length + footerLines().length >= props.height - 1;
  const pinnedHeader = () => (floatingHeader() ? [] : headerLines());
  const viewport = () =>
    Math.max(1, props.height - pinnedHeader().length - footerLines().length);
  const rows = createMemo(() => {
    if (!props.enabled() || stage() === "other") return [];
    if (stage() === "effort" && disabledEffort())
      return [
        {
          index: 0,
          lines: wrap(
            lock() === undefined
              ? "Not available."
              : `${lock()?.effort} [current] (locked)`,
            props.width,
          ),
        },
      ];
    const labels =
      stage() === "model"
        ? modelOptions().map(
            (entry) =>
              `${entry.label}${entry.kind === "model" && entry.model === currentChoice()?.model ? " [current]" : ""}`,
          )
        : efforts().map(
            (effort) =>
              `${effort}${effort === currentEffort() ? " [current]" : ""}${effort === selectedEntry()?.defaultEffort ? " (default)" : ""}`,
          );
    return labels.map((label, index) => ({
      index,
      lines: wrap(
        `${index === highlight() ? "›" : " "} ${label}`,
        props.width,
        2,
      ),
    }));
  });
  const rowStart = (index: number) =>
    rows()
      .slice(0, index)
      .reduce((sum, row) => sum + row.lines.length, 0);
  const visible = createMemo(() => {
    const all = [
      ...(floatingHeader()
        ? headerLines().map((text) => ({ text, selected: false }))
        : []),
      ...rows().flatMap((row) =>
        row.lines.map((text) => ({
          text,
          selected: row.index === highlight(),
        })),
      ),
    ];
    const start = rowStart(highlight());
    const height = rows()[highlight()]?.lines.length ?? 1;
    const end = start + height;
    const top = floatingHeader()
      ? Math.max(0, Math.min(offset(), all.length - viewport()))
      : height > viewport()
        ? Math.max(start, Math.min(offset(), end - viewport()))
        : Math.max(0, Math.min(start, Math.max(offset(), end - viewport())));
    return { top, lines: all.slice(top, top + viewport()) };
  });
  const move = (delta: number) => {
    if (stage() === "other" || (stage() === "effort" && disabledEffort()))
      return;
    const next = Math.max(0, Math.min(count() - 1, highlight() + delta));
    setOffset(
      floatingHeader() ? headerLines().length + rowStart(next) : visible().top,
    );
    setHighlight(next);
  };
  const page = (direction: -1 | 1) => {
    if (stage() === "other") return;
    const delta = direction * Math.max(1, viewport() - 1);
    const height = rows()[highlight()]?.lines.length ?? 1;
    if (floatingHeader() || height > viewport()) {
      setOffset(visible().top + delta);
    } else move(delta);
  };
  props.ref({
    typing: () => stage() === "other",
    key(name) {
      if (name === "escape") {
        if (stage() === "other") setStage("model");
        else if (stage() === "effort") setStage("model");
        else props.onBack();
        resetHighlight();
        return;
      }
      if (!props.enabled()) return;
      if (name === "return") choose();
      else if (name === "up") move(-1);
      else if (name === "down") move(1);
      else if (name === "pageup") page(-1);
      else if (name === "pagedown") page(1);
    },
  });
  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <For each={pinnedHeader()}>
        {(line) => (
          <text fg={theme.text} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
      <Show when={stage() === "other" && props.enabled()}>
        <input
          focused
          width={props.width}
          onInput={(value: string) => setTyped(value)}
        />
      </Show>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={visible().lines}>
          {(line) => (
            <text
              fg={line.selected ? theme.text : theme.textMuted}
              attributes={line.selected ? TextAttributes.BOLD : 0}
              flexShrink={0}
              wrapMode="none"
            >
              {line.text}
            </text>
          )}
        </For>
      </box>
      <For each={footerLines()}>
        {(line) => (
          <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  );
}
