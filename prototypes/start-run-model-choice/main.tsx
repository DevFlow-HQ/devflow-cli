// PROTOTYPE — throwaway. Can a human identify, edit, and confirm the initial Model choice,
// explain unavailable effort, and complete every scenario on narrow and wide terminals?
// Acceptance requires live human use. No Harness calls, Run creation, or saved preferences.
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import {
  render,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { DEFAULT_THEMES, resolveTheme } from "../../src/tui/vendor/theme.js";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  SCENARIOS,
  type Model,
} from "./scenarios.js";

const colors = resolveTheme(DEFAULT_THEMES.everforest!, "dark");
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const names = [
  "A · Lists together",
  "B · Form + pickers",
  "C · Guided choices",
];
type Field = "harness" | "model" | "effort" | "continue";

function Line(props: {
  text: string;
  tone?: "normal" | "muted" | "warning" | "success";
  bold?: boolean;
}) {
  const color = () =>
    props.tone === "muted"
      ? colors.textMuted
      : props.tone === "warning"
        ? colors.warning
        : props.tone === "success"
          ? colors.success
          : colors.text;
  return (
    <text flexShrink={0} fg={color()} attributes={props.bold ? 1 : 0}>
      {props.text}
    </text>
  );
}

export function App() {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [variant, setVariant] = createSignal(
    Math.max(0, ["A", "B", "C"].indexOf(arg("variant") ?? "A")),
  );
  const [sceneIx, setSceneIx] = createSignal(
    Math.max(
      0,
      SCENARIOS.findIndex((s) => s.key === arg("scene")),
    ),
  );
  const [harness, setHarness] = createSignal(SCENARIOS[sceneIx()]!.harness);
  const [modelId, setModelId] = createSignal(SCENARIOS[sceneIx()]!.model);
  const [effort, setEffort] = createSignal(SCENARIOS[sceneIx()]!.effort);
  const [source, setSource] = createSignal(SCENARIOS[sceneIx()]!.source);
  const [focus, setFocus] = createSignal<Field>("model");
  const [phase, setPhase] = createSignal<"choice" | "review" | "confirmed">(
    "choice",
  );
  const [guided, setGuided] = createSignal<"model" | "effort">("model");
  const [picker, setPicker] = createSignal<"model" | "effort">();
  const [cursor, setCursor] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [custom, setCustom] = createSignal(false);
  const [exact, setExact] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [checking, setChecking] = createSignal(true);
  let page: ScrollBoxRenderable | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const scene = () => SCENARIOS[sceneIx()]!;
  const locked = () =>
    harness() === "Claude Code" ? scene().locked : undefined;
  const noEffort = () =>
    harness() === "Claude Code" &&
    scene().noEffort &&
    modelId() === scene().model;
  const models = () => {
    const base = harness() === "Codex" ? CODEX_MODELS : CLAUDE_MODELS;
    if (base.some((m) => m.id === modelId())) return base;
    const entry: Model = {
      id: modelId(),
      label: modelId(),
      efforts: noEffort() ? [] : ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: noEffort() ? undefined : "medium",
    };
    return [...base.slice(0, -1), entry, base[base.length - 1]!];
  };
  const model = () => models().find((m) => m.id === modelId())!;
  setCursor(models().findIndex((m) => m.id === modelId()));
  createEffect(() => {
    const target = focus();
    phase();
    queueMicrotask(() => page?.scrollChildIntoView(`field-${target}`));
  });
  const effortEnabled = () => !locked() && !noEffort();
  const effortReason = () =>
    locked()
      ? `Locked by CLAUDE_CODE_EFFORT_LEVEL=${locked()}. Change that setting outside Secant.`
      : noEffort()
        ? "This model has no effort setting."
        : "";
  const effortLabel = () =>
    noEffort() ? "Not available" : (locked() ?? effort() ?? "medium");
  const qualify = () => {
    clearTimeout(timer);
    setChecking(true);
    timer = setTimeout(() => setChecking(false), 1000);
  };
  qualify();
  onCleanup(() => clearTimeout(timer));
  const reset = (n: number) => {
    const s = SCENARIOS[n]!;
    setSceneIx(n);
    setHarness(s.harness);
    setModelId(s.model);
    setEffort(s.locked ?? s.effort);
    setSource(s.source);
    setNotice("");
    setPhase("choice");
    setFocus("model");
    setGuided("model");
    setPicker(undefined);
    setCustom(false);
    setQuery("");
    setCursor(models().findIndex((m) => m.id === s.model));
    page?.scrollTo(0);
    qualify();
  };
  const chooseModel = (id: string) => {
    if (id === "other") {
      setExact("");
      setCustom(true);
      return false;
    }
    const next = models().find((m) => m.id === id);
    const previous = effort();
    setModelId(id);
    if (next && !next.efforts.length) setEffort(undefined);
    else if (
      !locked() &&
      (!previous || (next && !next.efforts.includes(previous)))
    ) {
      const fallback = next?.defaultEffort ?? "medium";
      setEffort(fallback);
      if (previous)
        setNotice(
          `${id} does not offer ${previous} effort. Effort changed to ${fallback}, its default.`,
        );
    }
    setSource("Your choice for this launch");
    return true;
  };
  const changeHarness = () => {
    const h = harness() === "Codex" ? "Claude Code" : "Codex";
    const s = SCENARIOS.find(
      (s) => s.harness === h && s.key.endsWith("-last"),
    )!;
    setHarness(h);
    setModelId(s.model);
    setEffort(s.effort);
    setSource(s.source);
    setNotice("");
    setPicker(undefined);
    setGuided("model");
    qualify();
  };
  const fields = (): Field[] => [
    "harness",
    "model",
    ...(effortEnabled() ? ["effort" as const] : []),
    "continue",
  ];
  const moveFocus = (direction: number) => {
    const all = fields();
    setFocus(
      all[
        (Math.max(0, all.indexOf(focus())) + direction + all.length) %
          all.length
      ]!,
    );
  };
  const openPicker = (kind: "model" | "effort") => {
    setPicker(kind);
    setQuery("");
    setCursor(
      kind === "model"
        ? models().findIndex((m) => m.id === modelId())
        : model().efforts.indexOf(effort()!),
    );
  };
  const options = () =>
    picker() === "effort" ||
    (!picker() && variant() === 2 && guided() === "effort")
      ? model().efforts.map((e) => ({ id: e, label: e }))
      : models().filter((m) =>
          m.label.toLowerCase().includes(query().toLowerCase()),
        );
  const selectedOption = () =>
    options()[Math.max(0, Math.min(cursor(), options().length - 1))];
  const advanceGuided = () => {
    if (guided() === "model") {
      setGuided("effort");
      setCursor(Math.max(0, model().efforts.indexOf(effort()!)));
    } else {
      qualify();
      setPhase("review");
      setFocus("continue");
    }
  };
  const commitPicker = () => {
    const option = selectedOption();
    if (!option) return;
    if (
      picker() === "effort" ||
      (!picker() && guided() === "effort" && variant() === 2)
    ) {
      setEffort(option.id);
      setSource("Your choice for this launch");
    } else if (!chooseModel(option.id)) return;
    setPicker(undefined);
    setQuery("");
    if (variant() === 2) advanceGuided();
  };
  const editFromReview = (field: "model" | "effort") => {
    setPhase("choice");
    setFocus(field);
    if (variant() === 1) openPicker(field);
    if (variant() === 2) {
      setGuided(field);
      setCursor(
        field === "model"
          ? models().findIndex((m) => m.id === modelId())
          : model().efforts.indexOf(effort()!),
      );
    }
  };

  useKeyboard((key) => {
    const alt = key.meta || key.option;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (custom()) setCustom(false);
      else if (picker()) {
        setPicker(undefined);
        setQuery("");
      } else renderer.destroy();
      return;
    }
    if (alt && ["1", "2", "3"].includes(key.name)) {
      key.preventDefault();
      setVariant(Number(key.name) - 1);
      setPicker(undefined);
      setCustom(false);
      setGuided("model");
      setCursor(models().findIndex((m) => m.id === modelId()));
      setQuery("");
      setPhase("choice");
      setFocus("model");
      return;
    }
    if (alt && ["n", "p", "r"].includes(key.name)) {
      key.preventDefault();
      reset(
        key.name === "r"
          ? sceneIx()
          : (sceneIx() + (key.name === "n" ? 1 : SCENARIOS.length - 1)) %
              SCENARIOS.length,
      );
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (custom()) setCustom(false);
      else if (picker()) {
        setPicker(undefined);
        setQuery("");
      } else if (phase() !== "choice") {
        setPhase("choice");
        setFocus("model");
      } else if (variant() === 2 && guided() === "effort") {
        setGuided("model");
        setCursor(models().findIndex((m) => m.id === modelId()));
      }
      return;
    }
    if (custom()) return; // native input owns typing, cursor, paste, and Enter
    if (key.name === "pageup" || key.name === "pagedown") {
      page?.scrollBy(key.name === "pageup" ? -6 : 6);
      return;
    }
    if (phase() !== "choice") {
      if (key.name === "tab") {
        key.preventDefault();
        moveFocus(key.shift ? -1 : 1);
      }
      if (key.name === "return" && phase() === "review" && !checking()) {
        if (focus() === "model") editFromReview("model");
        else if (focus() === "effort") editFromReview("effort");
        else if (focus() === "harness") {
          setPhase("choice");
          setFocus("harness");
        } else setPhase("confirmed");
      }
      return;
    }
    if (checking()) return;
    if (picker() || (variant() === 2 && focus() !== "harness")) {
      if ((key.name === "up" || key.name === "down") && options().length) {
        key.preventDefault();
        setCursor(
          (n) =>
            (n + (key.name === "up" ? -1 : 1) + options().length) %
            options().length,
        );
      }
      if (key.name === "return") {
        key.preventDefault();
        if (variant() === 2 && guided() === "effort" && !effortEnabled())
          advanceGuided();
        else commitPicker();
      }
      if (key.name === "tab" && !picker()) {
        key.preventDefault();
        setFocus(focus() === "harness" ? "model" : "harness");
      }
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      moveFocus(key.shift ? -1 : 1);
      return;
    }
    if (
      focus() === "harness" &&
      ["left", "right", "return"].includes(key.name)
    ) {
      key.preventDefault();
      changeHarness();
      return;
    }
    if (
      variant() === 0 &&
      ["up", "down", "left", "right"].includes(key.name) &&
      (focus() === "model" || focus() === "effort")
    ) {
      key.preventDefault();
      const delta = ["up", "left"].includes(key.name) ? -1 : 1;
      if (focus() === "model") {
        const all = models();
        const i = all.findIndex((m) => m.id === modelId());
        chooseModel(all[(i + delta + all.length) % all.length]!.id);
      } else {
        const all = model().efforts;
        setEffort(
          all[(all.indexOf(effort()!) + delta + all.length) % all.length],
        );
        setSource("Your choice for this launch");
      }
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      if (focus() === "continue") {
        setPhase("review");
        setFocus("continue");
        qualify();
      } else if (
        variant() === 1 &&
        (focus() === "model" || focus() === "effort")
      )
        openPicker(focus() as "model" | "effort");
      else moveFocus(1);
    }
  });

  const rowCount = () => Math.max(3, Math.min(8, dimensions().height - 20));
  function List(props: { kind: "model" | "effort"; interactive?: boolean }) {
    const all = () =>
      props.interactive
        ? options()
        : props.kind === "model"
          ? models()
          : model().efforts.map((e) => ({ id: e, label: e }));
    const active = () =>
      props.interactive
        ? Math.max(0, Math.min(cursor(), all().length - 1))
        : all().findIndex(
            (o) => o.id === (props.kind === "model" ? modelId() : effort()),
          );
    const start = () =>
      Math.max(
        0,
        Math.min(
          active() - Math.floor(rowCount() / 2),
          all().length - rowCount(),
        ),
      );
    return (
      <box flexDirection="column" flexShrink={0}>
        <Show when={start() > 0}>
          <Line text="↑ More choices" tone="muted" />
        </Show>
        <For each={all().slice(start(), start() + rowCount())}>
          {(item, index) => {
            const highlighted = () => index() + start() === active();
            const chosen = () =>
              item.id === (props.kind === "model" ? modelId() : effort());
            return (
              <box
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  highlighted() ? colors.primary : colors.backgroundPanel
                }
              >
                <text
                  flexShrink={0}
                  fg={highlighted() ? colors.background : colors.text}
                >{`${highlighted() ? "›" : " "} ${item.label}${chosen() ? "  ✓" : ""}`}</text>
              </box>
            );
          }}
        </For>
        <Show when={start() + rowCount() < all().length}>
          <Line text="↓ More choices" tone="muted" />
        </Show>
        <Show when={!all().length}>
          <Line text="No matching models" tone="muted" />
        </Show>
      </box>
    );
  }
  function FieldRow(props: {
    field: Field;
    label: string;
    value: string;
    disabled?: boolean;
  }) {
    return (
      <box
        id={`field-${props.field}`}
        flexShrink={0}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={
          focus() === props.field && !props.disabled
            ? colors.backgroundElement
            : colors.backgroundPanel
        }
      >
        <Line
          text={`${focus() === props.field && !props.disabled ? "›" : " "} ${props.label}${props.value ? ": " + props.value : ""}${props.disabled ? " · unavailable" : ""}`}
          bold={focus() === props.field}
        />
      </box>
    );
  }
  const summary = () =>
    `${harness()} · ${model().label} · Effort: ${effortLabel()}`;
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={colors.background}
      overflow="hidden"
    >
      <box
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="column"
      >
        <Line
          text={
            phase() === "choice"
              ? "Start a Run · Choose a Harness and model"
              : phase() === "review"
                ? "Start a Run · Review your launch"
                : "Launch choice confirmed · simulation"
          }
          bold
        />
        <Line
          text="Workflow: Test Repair · Workspace: /example/workspace"
          tone="muted"
        />
      </box>
      <scrollbox
        ref={(r) => {
          page = r;
        }}
        flexGrow={1}
        contentOptions={{
          flexDirection: "column",
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
        }}
      >
        <Show
          when={custom()}
          fallback={
            <Show
              when={phase() === "choice"}
              fallback={
                <box flexDirection="column" flexShrink={0} gap={1}>
                  <FieldRow field="harness" label="Harness" value={harness()} />
                  <FieldRow field="model" label="Model" value={model().label} />
                  <Line text={`Model name: ${modelId()}`} tone="muted" />
                  <FieldRow
                    field="effort"
                    label="Effort"
                    value={effortLabel()}
                    disabled={!effortEnabled()}
                  />
                  <Show when={effortReason()}>
                    <Line text={effortReason()} tone="warning" />
                  </Show>
                  <Show when={notice()}>
                    <Line text={notice()} tone="warning" />
                  </Show>
                  <Line
                    text="Input: Fix the failing authentication test"
                    tone="muted"
                  />
                  <Line
                    text={
                      checking()
                        ? "Checking your launch… Please wait."
                        : "Ready to start with the model and effort above."
                    }
                    tone={checking() ? "warning" : "success"}
                  />
                  <Show
                    when={phase() === "review"}
                    fallback={
                      <Line
                        text="Confirmed. No Run was created. Alt+R resets this scenario."
                        tone="success"
                      />
                    }
                  >
                    <FieldRow
                      field="continue"
                      label={
                        checking() ? "Start · waiting for checks" : "Start Run"
                      }
                      value=""
                    />
                    <Line
                      text="Tab to Model or Effort, then Enter to change; Esc goes back."
                      tone="muted"
                    />
                  </Show>
                </box>
              }
            >
              <box
                flexDirection="column"
                flexShrink={0}
                gap={variant() === 0 && dimensions().width < 100 ? 0 : 1}
              >
                <FieldRow
                  field="harness"
                  label="Harness"
                  value={`${harness()} · ${checking() ? "checking…" : "ready"}`}
                />
                <Show
                  when={!checking()}
                  fallback={
                    <Line
                      text="Checking the Harness and loading model choices… Please wait."
                      tone="warning"
                    />
                  }
                >
                  <Show when={variant() === 0}>
                    <box
                      flexDirection={
                        dimensions().width >= 100 ? "row" : "column"
                      }
                      gap={1}
                      flexShrink={0}
                    >
                      <box
                        flexDirection="column"
                        flexGrow={dimensions().width >= 100 ? 1 : 0}
                        flexBasis={dimensions().width >= 100 ? 0 : undefined}
                        flexShrink={0}
                      >
                        <Line
                          text={`${focus() === "model" ? "› " : ""}Model`}
                          bold
                        />
                        <List kind="model" />
                      </box>
                      <box
                        flexDirection="column"
                        flexGrow={dimensions().width >= 100 ? 1 : 0}
                        flexBasis={dimensions().width >= 100 ? 0 : undefined}
                        flexShrink={0}
                      >
                        <Line
                          text={`${focus() === "effort" ? "› " : ""}Effort${locked() ? " · locked" : ""}`}
                          bold
                        />
                        <Show
                          when={effortEnabled()}
                          fallback={<Line text={effortLabel()} />}
                        >
                          <List kind="effort" />
                        </Show>
                        <Show when={effortReason()}>
                          <Line text={effortReason()} tone="warning" />
                        </Show>
                      </box>
                    </box>
                  </Show>
                  <Show when={variant() === 1}>
                    <FieldRow
                      field="model"
                      label="Model"
                      value={model().label + " · Enter to change"}
                    />
                    <FieldRow
                      field="effort"
                      label="Effort"
                      value={
                        effortLabel() +
                        (effortEnabled() ? " · Enter to change" : "")
                      }
                      disabled={!effortEnabled()}
                    />
                    <Show when={effortReason()}>
                      <Line text={effortReason()} tone="warning" />
                    </Show>
                  </Show>
                  <Show when={variant() === 2 && !picker()}>
                    <Line
                      text={
                        guided() === "model"
                          ? "1. Choose a model"
                          : "2. Choose effort"
                      }
                      bold
                    />
                    <Show
                      when={guided() === "model" || effortEnabled()}
                      fallback={
                        <box flexDirection="column">
                          <Line text={`Effort: ${effortLabel()}`} />
                          <Line text={effortReason()} tone="warning" />
                          <Line text="Enter to continue to review" />
                        </box>
                      }
                    >
                      <List kind={guided()} interactive />
                    </Show>
                  </Show>
                  <Line text={source()} tone="muted" />
                  <Show when={notice()}>
                    <Line text={notice()} tone="warning" />
                  </Show>
                  <Show
                    when={
                      variant() === 2 && guided() === "model" && effortReason()
                    }
                  >
                    <Line text={effortReason()} tone="warning" />
                  </Show>
                  <Show when={variant() !== 2}>
                    <FieldRow
                      field="continue"
                      label="Continue to review"
                      value=""
                    />
                  </Show>
                </Show>
              </box>
            </Show>
          }
        >
          <box
            flexDirection="column"
            flexShrink={0}
            gap={1}
            padding={1}
            backgroundColor={colors.backgroundPanel}
          >
            <Line text="Other model · exact name" bold />
            <Line
              text="Enter a full model name. Secant does not validate Claude Code's suggested choices."
              tone="muted"
            />
            <input
              focused
              value={exact()}
              onInput={setExact}
              placeholder="Exact model name"
              textColor={colors.text}
              backgroundColor={colors.backgroundElement}
              focusedBackgroundColor={colors.backgroundElement}
              onSubmit={() => {
                if (!exact().trim()) return;
                setModelId(exact().trim());
                setEffort(locked() ?? effort() ?? "medium");
                setSource("Your choice for this launch");
                setCustom(false);
                setPicker(undefined);
                setQuery("");
                if (variant() === 2) advanceGuided();
              }}
            />
            <Line text="Enter uses this name · Esc cancels" tone="muted" />
          </box>
        </Show>
      </scrollbox>
      <Show when={picker() && !custom()}>
        <box
          position="absolute"
          top={3}
          left={2}
          width={Math.max(20, dimensions().width - 4)}
          height={Math.max(8, dimensions().height - 8)}
          flexDirection="column"
          padding={1}
          backgroundColor={colors.backgroundElement}
          overflow="hidden"
        >
          <Line
            text={
              picker() === "model"
                ? "Choose a model"
                : `Choose effort for ${model().label}`
            }
            bold
          />
          <Show when={picker() === "model"}>
            <input
              focused
              value={query()}
              onInput={(s) => {
                setQuery(s);
                setCursor(0);
              }}
              placeholder="Search models…"
              textColor={colors.text}
              backgroundColor={colors.backgroundPanel}
              focusedBackgroundColor={colors.backgroundPanel}
            />
          </Show>
          <List kind={picker()!} interactive />
          <Line text="↑↓ browse · Enter choose · Esc cancel" tone="muted" />
        </box>
      </Show>
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
      >
        <Line text={`Current choice: ${summary()}`} bold />
        <Line
          text={
            variant() === 2
              ? "↑↓ browse · Enter choose · Tab Harness · Esc back"
              : "Tab focus · ↑↓ change (A) · Enter choose / continue"
          }
          tone="muted"
        />
        <Line text="PgUp/PgDn scroll · Ctrl+C quit" tone="muted" />
        <text
          flexShrink={0}
          fg={colors.background}
          bg={colors.text}
        >{`PROTOTYPE · Alt+1/2/3 · ${names[variant()]}`}</text>
        <text
          flexShrink={0}
          fg={colors.background}
          bg={colors.text}
        >{`Alt+N/P case ${sceneIx() + 1}/${SCENARIOS.length} · ${scene().title} · Alt+R reset`}</text>
      </box>
    </box>
  );
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
  });
  await render(() => <App />, renderer);
}
