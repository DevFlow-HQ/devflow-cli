import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  Switch,
  Match,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  FieldViolation,
  HarnessFocus,
  HarnessSummary,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchRunInput,
  Problem,
  RoutingNodeView,
} from "../application/projection-port.js";
import {
  effortControl,
  ModelChoicePicker,
  type ModelChoicePickerHandle,
  type ModelChoiceDraft,
} from "./model-choice-picker.js";
import { wrap } from "./wrap.js";
import { CatalogRow } from "./catalog-navigation.js";
import {
  effortLockSentence,
  harnessFocusStatus,
  harnessRowStatus,
  isCheckingModels,
  modelChoiceSourceLine,
  modelChoiceWords,
} from "./harness-format.js";
import { useBindings } from "./keymap.js";
import { LaunchTextBox, type LaunchTextBoxHandle } from "./launch-text-box.js";
import { useLaunchPreparationView } from "./launch-preparation-view.js";
import { useExit } from "./vendor/exit.js";
import { useDialog } from "./vendor/dialog.js";
import { useTheme } from "./vendor/theme-context.js";
import { useWorkspaceView } from "./workspace-view.js";
import { formatOrigin } from "./bundle-format.js";

// Presentational leaves and step components for the Start-a-Run flow. The draft
// signal, step transitions, and refusal routing stay in start-run.tsx; each step
// component owns its transient UI state (highlight, phase, focused field) and its
// own key bindings, and the review step opens the launch-preparation Projection
// directly.

const NARROW_BREAKPOINT = 60;

// --- shared layout ---------------------------------------------------------

function formatRouting(routing: readonly RoutingNodeView[]): string {
  if (routing.length === 0) return "(no steps)";
  return routing
    .map((node) =>
      node.node === "step"
        ? `${node.step.id} (${node.step.kind})`
        : "control" in node
          ? "repeat until a human ends the stage"
          : `repeat until ${node.until}`,
    )
    .join(" → ");
}

export function routingNeedsHarness(
  routing: readonly RoutingNodeView[],
): boolean {
  return routing.some((node) => {
    const steps = node.node === "step" ? [node.step] : node.steps;
    return steps.some((step) => {
      return step.kind === "agent" || step.kind === "interactive-agent";
    });
  });
}

function workspaceName(path: string): string {
  const withoutTrailingSeparator = path.replace(/[\\/]+$/, "");
  return withoutTrailingSeparator.split(/[\\/]/).at(-1) ?? path;
}

// A muted `Step N of M` line under a step title (blank while no Bundle is
// selected — the empty/errored Catalog has no sequence to count).
function StepCount(props: { label: Accessor<string> }) {
  const { theme } = useTheme();
  return (
    <Show when={props.label().length > 0}>
      <text fg={theme.textMuted} flexShrink={0}>
        {props.label()}
      </text>
    </Show>
  );
}

function RunNotStartedNotice(props: {
  notice: Accessor<string | undefined>;
  onDismiss: () => void;
  group: string;
}) {
  const { theme } = useTheme();
  const dialog = useDialog();
  useBindings(() => ({
    enabled: props.notice() !== undefined && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+d",
        desc: "Dismiss notice",
        group: props.group,
        cmd: props.onDismiss,
      },
    ],
  }));
  return (
    <Show when={props.notice()}>
      {(message) => (
        <text fg={theme.warning} flexShrink={0}>
          {`ⓘ ${message()} · ctrl+d dismiss`}
        </text>
      )}
    </Show>
  );
}

// --- choose ----------------------------------------------------------------

export function ChooseStep(props: {
  rows: Accessor<readonly InstalledBundleSummary[]>;
  listProblem: Accessor<Problem | undefined>;
  selected: Accessor<number>;
  setSelected: (index: number) => void;
  focus: Accessor<InstalledBundleFocus | undefined>;
  untrusted: Accessor<boolean>;
  acknowledged: Accessor<boolean>;
  acknowledge: () => void;
  canContinue: Accessor<boolean>;
  stepLabel: Accessor<string>;
  onContinue: () => void;
  onViewDetails: () => void;
  onBack: () => void;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const stacked = () => dimensions().width < NARROW_BREAKPOINT;

  const move = (delta: number) => {
    const count = props.rows().length;
    if (count === 0) return;
    props.setSelected(
      Math.max(0, Math.min(props.selected() + delta, count - 1)),
    );
  };

  // The acknowledge hint appears only when an untrusted Bundle is selected and
  // still needs it — never on an empty or errored Catalog where `a` does nothing.
  const chooserFooter = () => {
    if (props.canContinue()) {
      return "↑/↓ move · v view details · enter continue · esc back · q quit";
    }
    if (props.untrusted() && !props.acknowledged()) {
      return "↑/↓ move · v view details · acknowledge trust (a) to continue · esc back · q quit";
    }
    return "↑/↓ move · v view details · esc back · q quit";
  };

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: "Previous",
        group: "Start a Run",
        cmd: () => move(-1),
      },
      { key: "down", desc: "Next", group: "Start a Run", cmd: () => move(1) },
      {
        key: "a",
        desc: "Acknowledge trust",
        group: "Start a Run",
        cmd: () => props.acknowledge(),
      },
      {
        key: "v",
        desc: "View Bundle Details",
        group: "Start a Run",
        cmd: () => props.onViewDetails(),
      },
      {
        key: "return",
        desc: "Continue",
        group: "Start a Run",
        cmd: () => props.onContinue(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Start a Run",
        cmd: () => props.onBack(),
      },
      { key: "q", desc: "Quit", group: "Start a Run", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Start a Run", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Start a Run
      </text>
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Start a Run"
      />
      <Show when={props.problem()}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              Correction needed
            </text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <Show
        when={props.listProblem()}
        fallback={
          <Show
            when={props.rows().length > 0}
            fallback={
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted}>The Catalog is empty.</text>
                <text fg={theme.textMuted}>
                  {"Install one with `secant bundle build <folder>` or"}
                </text>
                <text fg={theme.textMuted}>
                  {"`secant bundle install <file.wfb>`."}
                </text>
              </box>
            }
          >
            <box
              flexDirection={stacked() ? "column" : "row"}
              gap={1}
              flexGrow={1}
              overflow="hidden"
            >
              <box
                flexDirection="column"
                flexShrink={0}
                width={stacked() ? undefined : 28}
                overflow="hidden"
              >
                <For each={props.rows()}>
                  {(bundle, index) => (
                    <CatalogRow
                      title={bundle.name}
                      details={[`${bundle.id}@${bundle.version}`]}
                      selected={index() === props.selected()}
                      focused
                      onSelect={() => props.setSelected(index())}
                    />
                  )}
                </For>
              </box>
              <box
                flexDirection="column"
                flexShrink={0}
                flexGrow={1}
                overflow="hidden"
              >
                <SidePanel
                  focus={props.focus}
                  untrusted={props.untrusted}
                  acknowledged={props.acknowledged}
                />
              </box>
            </box>
          </Show>
        }
      >
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.error}>
              {`Catalog error: ${problem().code}`}
            </text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <text
        fg={props.canContinue() ? theme.text : theme.textMuted}
        flexShrink={0}
      >
        {chooserFooter()}
      </text>
    </box>
  );
}

function SidePanel(props: {
  focus: Accessor<InstalledBundleFocus | undefined>;
  untrusted: Accessor<boolean>;
  acknowledged: Accessor<boolean>;
}) {
  const { theme } = useTheme();
  return (
    <Show
      when={props.focus()}
      fallback={<text fg={theme.textMuted}>Select a Bundle.</text>}
    >
      {(bundle) => (
        <box flexDirection="column" flexShrink={0} gap={1} overflow="hidden">
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Name</text>
            <text fg={theme.text}>{bundle().name}</text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Description</text>
            <text fg={theme.text}>{bundle().description}</text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Source</text>
            <text fg={theme.text}>
              {formatOrigin(bundle().origin, bundle().shippedWithRunningSecant)}
            </text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.textMuted}>Workflow</text>
            <text fg={theme.text}>{formatRouting(bundle().routing)}</text>
          </box>
          {/* A calm navigation pointer — full commands and the Execution summary
              live in Workflow Bundles, so this panel never duplicates them. */}
          <text fg={theme.textMuted} flexShrink={0}>
            Press v to View Bundle Details.
          </text>
          <Show when={props.untrusted()}>
            <box flexDirection="column" flexShrink={0}>
              <text
                attributes={TextAttributes.BOLD}
                fg={props.acknowledged() ? theme.text : theme.warning}
              >
                {props.acknowledged()
                  ? "Trust acknowledged ✓"
                  : "Untrusted Bundle — press a to acknowledge trust"}
              </text>
              <text fg={theme.textMuted}>
                {`Digest sha256:${bundle().digest}`}
              </text>
              <text fg={theme.textMuted}>
                {bundle().executionSummary.warning}
              </text>
            </box>
          </Show>
        </box>
      )}
    </Show>
  );
}

// --- Harness selection --------------------------------------------

export function HarnessStep(props: {
  rows: Accessor<readonly HarnessSummary[]>;
  chosenId: Accessor<string | undefined>;
  findingHarnessId: Accessor<string | undefined>;
  choose: (id: string) => void;
  focus: Accessor<HarnessFocus | undefined>;
  stepLabel: Accessor<string>;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  canContinue: Accessor<boolean>;
  onContinue: () => void;
  /** Whether this visit came from Review or the guided model stage, so Tab
   *  (like Esc from the list) returns there. */
  canReturn: Accessor<boolean>;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const [highlight, setHighlight] = createSignal(
    Math.max(
      0,
      props
        .rows()
        .findIndex(
          (row) => row.id === (props.chosenId() ?? props.findingHarnessId()),
        ),
    ),
  );
  const [selected, setSelected] = createSignal(false);
  const statusLines = () =>
    wrap(
      isCheckingModels(props.focus())
        ? "Checking the Harness and loading model choices… Please wait."
        : props.focus()?.unavailable === undefined
          ? "Model choices loaded. Enter to continue."
          : `Unavailable · ${props.focus()?.unavailable?.explanation} ${props.focus()?.unavailable?.remediation}`,
      Math.max(1, dimensions().width - 2),
    );
  const move = (delta: number) =>
    setHighlight(
      Math.max(0, Math.min(props.rows().length - 1, highlight() + delta)),
    );
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: "Previous Harness",
        group: "Harness",
        cmd: () => {
          if (!selected()) move(-1);
        },
      },
      {
        key: "down",
        desc: "Next Harness",
        group: "Harness",
        cmd: () => {
          if (!selected()) move(1);
        },
      },
      {
        key: "return",
        desc: "Choose Harness",
        group: "Harness",
        cmd: () => {
          if (selected()) {
            props.onContinue();
            return;
          }
          const harness = props.rows()[highlight()];
          if (harness === undefined) return;
          setSelected(true);
          props.choose(harness.id);
        },
      },
      {
        key: "escape",
        desc: "Back",
        group: "Harness",
        cmd: () => {
          if (selected()) setSelected(false);
          else props.onBack();
        },
      },
      { key: "q", desc: "Quit", group: "Harness", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Harness", cmd: () => exit() },
    ],
  }));
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && props.canReturn(),
    bindings: [
      { key: "tab", desc: "Return", group: "Harness", cmd: props.onBack },
    ],
  }));
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Choose a Harness
      </text>
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Harness"
      />
      <Show when={props.problem()}>
        {(problem) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.error}>Correction needed</text>
            <text fg={theme.textMuted}>{problem().explanation}</text>
            <text fg={theme.textMuted}>{problem().remediation}</text>
          </box>
        )}
      </Show>
      <Show
        when={selected()}
        fallback={
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <For each={props.rows()}>
              {(harness, index) => (
                <CatalogRow
                  title={`${harness.name} (${harness.id}) — ${harness.id === props.chosenId() ? harnessFocusStatus(props.focus()) : harnessRowStatus(harness)}`}
                  details={[]}
                  selected={index() === highlight()}
                  focused
                  onSelect={() => setHighlight(index())}
                />
              )}
            </For>
          </box>
        }
      >
        <box flexDirection="column" flexGrow={1} overflow="hidden">
          <text
            fg={theme.text}
            flexShrink={0}
          >{`Harness: ${props.focus()?.name ?? props.chosenId()}`}</text>
          <text fg={theme.textMuted} flexShrink={0}>
            {harnessFocusStatus(props.focus())}
          </text>
          <For each={statusLines()}>
            {(line) => (
              <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        {selected()
          ? props.canContinue()
            ? `enter continue · esc choose another · ${props.canReturn() ? "tab return · " : ""}q quit`
            : `esc choose another · ${props.canReturn() ? "tab return · " : ""}q quit`
          : `↑/↓ move · enter choose · ${props.canReturn() ? "tab/esc return" : "esc back"} · q quit`}
      </text>
    </box>
  );
}

export function ModelChoiceStep(props: {
  focus: Accessor<HarnessFocus | undefined>;
  draft: Accessor<ModelChoiceDraft>;
  reset: Accessor<string | undefined>;
  enabled: Accessor<boolean>;
  initialStage: "model" | "effort";
  onChoice: (
    choice: NonNullable<HarnessFocus["preselection"]>["choice"],
    reset?: string,
  ) => void;
  onDone: () => void;
  onHarness: () => void;
  onBack: () => void;
  stepLabel: Accessor<string>;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
}) {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const dialog = useDialog();
  const exit = useExit();
  let picker: ModelChoicePickerHandle | undefined;
  const width = () => Math.max(1, dimensions().width - 2);
  const findingLines = () =>
    props.problem() === undefined
      ? []
      : wrap(
          `${props.problem()?.explanation} ${props.problem()?.remediation}`,
          width(),
        );
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: ["up", "down", "return", "escape", "pageup", "pagedown"].map(
      (key) => ({
        key,
        desc: key,
        group: "Model choice",
        cmd: () => picker?.key(key),
      }),
    ),
  }));
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !picker?.typing(),
    bindings: [
      { key: "q", desc: "Quit", group: "Model choice", cmd: () => exit() },
      {
        key: "tab",
        desc: "Harness",
        group: "Model choice",
        cmd: () => props.onHarness(),
      },
    ],
  }));
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "ctrl+c", desc: "Quit", group: "Model choice", cmd: () => exit() },
    ],
  }));
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Model choice"
      />
      <For each={findingLines()}>
        {(line) => (
          <text fg={theme.error} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
      <ModelChoicePicker
        focus={props.focus}
        draft={props.draft}
        reset={props.reset}
        enabled={props.enabled}
        width={width()}
        height={Math.max(
          1,
          dimensions().height -
            3 -
            findingLines().length -
            (props.notice() === undefined ? 0 : 1),
        )}
        initialStage={props.initialStage}
        harnessKey
        onChoice={props.onChoice}
        onDone={props.onDone}
        onBack={props.onBack}
        ref={(handle) => {
          picker = handle;
        }}
      />
    </box>
  );
}

// --- inputs ----------------------------------------------------------------

// Only `text` takes the multi-line box (#287). A `file-set` value is
// newline-separated paths, but it keeps the single-line field the spec leaves.
function isPathLike(type: string): boolean {
  return type === "file" || type === "file-set";
}

export function InputsStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  values: Record<string, string>;
  setValue: (name: string, value: string) => void;
  findings: Accessor<readonly FieldViolation[] | undefined>;
  problem: Accessor<Problem | undefined>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  stepLabel: Accessor<string>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const inputs = () => props.bundle()?.launchInputs ?? [];
  const firstInvalidated = () => {
    const finding = props.findings()?.[0];
    if (finding === undefined) return 0;
    return Math.max(
      0,
      inputs().findIndex((input) => input.name === finding.field),
    );
  };
  const [field, setField] = createSignal(firstInvalidated());
  const inputWidth = () => Math.max(10, dimensions().width - 4);

  const current = () => inputs()[field()];
  const choiceLike = () => {
    const input = current();
    return (
      input !== undefined &&
      (input.type === "choice" || input.type === "verdict")
    );
  };
  const options = (name: string, type: string): readonly string[] => {
    if (type === "verdict") return ["pass", "fail"];
    const input = inputs().find((candidate) => candidate.name === name);
    return input?.choices ?? [];
  };
  const cycle = (delta: number) => {
    const input = current();
    if (input === undefined) return;
    const choices = options(input.name, input.type);
    if (choices.length === 0) return;
    const index = choices.indexOf(props.values[input.name] ?? "");
    // From an unset value, right lands on the first choice and left on the last;
    // otherwise wrap either way.
    const next =
      index === -1
        ? delta > 0
          ? 0
          : choices.length - 1
        : (index + delta + choices.length) % choices.length;
    props.setValue(input.name, choices[next] ?? "");
  };
  const move = (delta: number) => {
    const count = inputs().length;
    if (count === 0) return;
    setField(Math.max(0, Math.min(field() + delta, count - 1)));
  };
  // The keymap's Up/Down pre-empt a focused box, so they first offer the move to
  // the focused text box; only from its first or last line do they change input.
  const boxes = new Map<string, LaunchTextBoxHandle>();
  const moveLineOrInput = (delta: -1 | 1) => {
    const input = current();
    if (input?.type === "text" && boxes.get(input.name)?.moveLine(delta))
      return;
    move(delta);
  };
  const findingFor = (name: string): string | undefined =>
    props.findings()?.find((violation) => violation.field === name)
      ?.explanation;

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "up",
        desc: "Previous input",
        group: "Launch inputs",
        cmd: () => moveLineOrInput(-1),
      },
      {
        key: "down",
        desc: "Next input",
        group: "Launch inputs",
        cmd: () => moveLineOrInput(1),
      },
      {
        key: "return",
        desc: "Continue",
        group: "Launch inputs",
        cmd: () => props.onContinue(),
      },
      {
        key: "escape",
        desc: "Back",
        group: "Launch inputs",
        cmd: () => props.onBack(),
      },
      {
        key: "ctrl+c",
        desc: "Quit",
        group: "Launch inputs",
        cmd: () => exit(),
      },
    ],
  }));
  // Only when a choice/verdict input is focused do left/right cycle it; on a
  // text or path input they stay unbound so they reach the focused field's cursor.
  useBindings(() => ({
    enabled: choiceLike() && dialog.stack.length === 0,
    bindings: [
      {
        key: "left",
        desc: "Previous choice",
        group: "Launch inputs",
        cmd: () => cycle(-1),
      },
      {
        key: "right",
        desc: "Next choice",
        group: "Launch inputs",
        cmd: () => cycle(1),
      },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      gap={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Launch inputs
      </text>
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Launch inputs"
      />
      <Show when={props.findings() !== undefined}>
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.error}>
            One or more inputs are missing or invalid.
          </text>
          <Show when={props.problem()}>
            {(problem) => (
              <text fg={theme.textMuted}>{problem().remediation}</text>
            )}
          </Show>
        </box>
      </Show>
      <box flexDirection="column" gap={1} flexGrow={1} overflow="hidden">
        <For each={inputs()}>
          {(input, index) => (
            <box flexDirection="column" flexShrink={0}>
              <text
                fg={theme.text}
                attributes={index() === field() ? TextAttributes.BOLD : 0}
              >
                {`${index() === field() ? "› " : "  "}${input.name} (${input.type})`}
              </text>
              <text fg={theme.textMuted}>{`  ${input.description}`}</text>
              <Switch
                fallback={
                  <text fg={theme.text}>
                    {`  ‹ ${props.values[input.name] ?? "(not set)"} › — ←/→ to choose from: ${options(
                      input.name,
                      input.type,
                    ).join(", ")}`}
                  </text>
                }
              >
                <Match when={input.type === "text"}>
                  <LaunchTextBox
                    ref={(handle) => boxes.set(input.name, handle)}
                    initialValue={props.values[input.name] ?? ""}
                    focused={index() === field()}
                    width={inputWidth()}
                    onValue={(value) => props.setValue(input.name, value)}
                    onSubmit={() => props.onContinue()}
                  />
                </Match>
                <Match when={isPathLike(input.type)}>
                  <input
                    focused={index() === field()}
                    width={inputWidth()}
                    value={props.values[input.name] ?? ""}
                    onInput={(value) => props.setValue(input.name, value)}
                  />
                </Match>
              </Switch>
              <Show when={findingFor(input.name)}>
                {(explanation) => (
                  <text fg={theme.error}>{`  ${explanation()}`}</text>
                )}
              </Show>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.textMuted} flexShrink={0}>
        {`↑/↓ input · ${current()?.type === "text" ? "ctrl+j newline" : "type to edit"} · enter continue · esc back`}
      </text>
    </box>
  );
}

// --- review ----------------------------------------------------------------

/** Review's focus stops, in Tab order. Start is always a stop; Harness and Model
 *  are stops for an Agent Bundle, and Effort only while it can be edited. */
export type ReviewField = "harness" | "model" | "effort" | "start";
const REVIEW_FIELDS: readonly ReviewField[] = [
  "harness",
  "model",
  "effort",
  "start",
];

type Tone = "text" | "muted" | "warning" | "error" | "success";

// Rows outside the paged body: the box's top and bottom padding, plus the
// "Review" title and the assessment status line.
const REVIEW_FRAME_ROWS = 2;
const REVIEW_HEADER_ROWS = 2;
// Below this height the sections share rows; at or above it a blank line
// separates them, as the pre-#350 Review's gap did on a tall terminal.
const REVIEW_SECTION_GAP_HEIGHT = 30;

/** One logical Review line before wrapping. `owner` is the field whose row it
 *  belongs to (its title or a reason under it), so revealing a field reveals
 *  its reasons too. */
interface ReviewEntry {
  readonly text: string;
  readonly tone: Tone;
  readonly owner?: ReviewField;
  readonly title?: boolean;
  readonly hang: number;
}

export function ReviewStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  harness: Accessor<HarnessSummary | undefined>;
  harnessFocus: Accessor<HarnessFocus | undefined>;
  modelDraft: Accessor<ModelChoiceDraft>;
  draft: Accessor<LaunchRunInput>;
  canAcknowledgeTrust: Accessor<boolean>;
  onAcknowledgeTrust: () => void;
  stepLabel: Accessor<string>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  reset: Accessor<string | undefined>;
  initialFocus: ReviewField;
  onEdit: (field: Exclude<ReviewField, "start">) => void;
  onStart: (draft: LaunchRunInput) => void;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const exit = useExit();
  const dialog = useDialog();
  const dimensions = useTerminalDimensions();
  const preparation = useLaunchPreparationView();
  const workspace = useWorkspaceView();
  const openedAssessment = createMemo(() => preparation.open(props.draft()));
  const assessment = () => openedAssessment()();
  const launchOffer = () =>
    assessment().actionOffers.find((offer) => offer.action === "launch-run");
  const needsHarness = () => {
    const bundle = props.bundle();
    return bundle !== undefined && routingNeedsHarness(bundle.routing);
  };
  const checking = () =>
    assessment().status === "assessing" ||
    (needsHarness() && isCheckingModels(props.harnessFocus()));
  // Start holds through every fresh assessment and Harness check; it submits only
  // the current ready Offer's exact draft.
  const canStart = () =>
    assessment().status === "ready" &&
    launchOffer() !== undefined &&
    !checking();
  const effortEditable = () =>
    effortControl(props.harnessFocus(), props.modelDraft()).editable &&
    assessment().draft.modelChoice?.effortLock === undefined;
  const available = (field: ReviewField) =>
    field === "start" ||
    (needsHarness() && (field !== "effort" || effortEditable()));
  const [focus, setFocus] = createSignal<ReviewField>(props.initialFocus);
  const focused = (): ReviewField => (available(focus()) ? focus() : "start");
  const moveFocus = (delta: 1 | -1) => {
    let index = REVIEW_FIELDS.indexOf(focused());
    for (let step = 0; step < REVIEW_FIELDS.length; step++) {
      index = (index + delta + REVIEW_FIELDS.length) % REVIEW_FIELDS.length;
      const field = REVIEW_FIELDS[index];
      if (field !== undefined && available(field)) {
        setFocus(field);
        return;
      }
    }
  };

  const width = () => Math.max(1, dimensions().width - 2);
  const row = (
    owner: Exclude<ReviewField, "start">,
    text: string,
  ): ReviewEntry => ({ text, tone: "text", owner, title: true, hang: 2 });
  const reason = (
    owner: Exclude<ReviewField, "start">,
    text: string,
  ): ReviewEntry => ({ text: `    ${text}`, tone: "muted", owner, hang: 4 });
  const plain = (text: string, tone: Tone = "text", hang = 0): ReviewEntry => ({
    text,
    tone,
    hang,
  });
  // The Model choice the Offer launches, resolved by the assessment, with every
  // reason that applies; until it resolves, the rows say so rather than guessing.
  const modelChoiceEntries = (): ReviewEntry[] => {
    const harness = props.harness();
    const entries = [
      row(
        "harness",
        `Harness: ${harness?.name ?? "(not selected)"} (${harness?.id ?? "none"})`,
      ),
    ];
    if (checking() && harness !== undefined)
      entries.push(
        reason(
          "harness",
          "Checking the Harness and loading model choices… Please wait.",
        ),
      );
    const choice = assessment().draft.modelChoice;
    if (choice === undefined) {
      const unresolved =
        assessment().status === "assessing" ? "checking…" : "not resolved";
      entries.push(
        row("model", `Model: ${unresolved}`),
        row("effort", `Effort: ${unresolved}`),
      );
      return entries;
    }
    const declaration = props.harnessFocus()?.modelDeclaration;
    const notice = assessment().draft.preferenceNotice;
    entries.push(
      row(
        "model",
        `Model: ${modelChoiceWords({ model: choice.model }, declaration)}`,
      ),
      ...(notice === undefined ? [] : [reason("model", notice)]),
      reason(
        "model",
        modelChoiceSourceLine(
          harness?.name ?? "the Harness",
          choice.source,
          choice,
          declaration,
        ),
      ),
      row(
        "effort",
        choice.effort === undefined
          ? "Effort: Not available."
          : `Effort: ${choice.effort}${choice.effortLock === undefined ? "" : " (locked)"}`,
      ),
    );
    const reset = props.reset();
    if (reset !== undefined) entries.push(reason("effort", reset));
    if (choice.effort === undefined)
      entries.push(reason("effort", "This model has no effort setting."));
    if (choice.effortLock !== undefined)
      entries.push(
        reason("effort", effortLockSentence(choice.effortLock.source)),
      );
    return entries;
  };
  const trustPosture = () => {
    if (
      assessment().findings.some((finding) => finding.correction === "trust")
    ) {
      return "Trust: Acknowledgement required";
    }
    if (assessment().draft.trustDigest !== undefined) {
      return "Trust: Exact digest acknowledged for this launch";
    }
    return assessment().status === "assessing"
      ? "Trust: Checking"
      : "Trust: Already trusted";
  };
  // A tall terminal separates the sections with a blank line; a short one
  // keeps every row for content.
  const gap = (): ReviewEntry[] =>
    dimensions().height >= REVIEW_SECTION_GAP_HEIGHT ? [plain("")] : [];
  const bodyEntries = (): ReviewEntry[] => {
    const entries = assessment().findings.flatMap((finding) => [
      plain(finding.explanation, "warning"),
      plain(finding.remediation, "muted"),
    ]);
    const bundle = props.bundle();
    if (bundle === undefined)
      return [...entries, plain("No Bundle selected.", "error")];
    const draft = assessment().draft;
    if (entries.length > 0) entries.push(...gap());
    entries.push(
      plain(`Workflow: ${formatRouting(bundle.routing)}`),
      plain(
        `Bundle: ${draft.bundle.name ?? bundle.name} (${draft.bundle.id}@${draft.bundle.version ?? bundle.version})`,
      ),
      plain(
        `Bundle digest: sha256:${draft.bundle.digest ?? bundle.digest}`,
        "muted",
      ),
      plain(
        `Workspace: ${workspaceName(workspace.snapshot().path)} · ${workspace.snapshot().path}`,
      ),
    );
    if (needsHarness()) entries.push(...gap(), ...modelChoiceEntries());
    entries.push(...gap());
    if (bundle.launchInputs.length === 0)
      entries.push(plain("No launch inputs.", "muted"));
    else {
      entries.push(plain("Launch inputs:", "muted"));
      for (const input of bundle.launchInputs) {
        const value = draft.launchInputs[input.name] ?? "(not set)";
        const [first = "", ...rest] = value.split(/\r?\n/);
        entries.push(
          plain(`  ${input.name}: ${first}`, "text", 4),
          ...rest.map((line) => plain(`    ${line}`, "text", 4)),
        );
      }
    }
    entries.push(plain(trustPosture()));
    return entries;
  };
  const bodyLines = createMemo(() =>
    bodyEntries().flatMap((entry) => {
      const marked =
        entry.title === true
          ? `${entry.owner === focused() ? "›" : " "} ${entry.text}`
          : entry.text;
      return wrap(marked, width(), entry.hang).map((text) => ({
        text,
        tone: entry.tone,
        owner: entry.owner,
        selected: entry.title === true && entry.owner === focused(),
      }));
    }),
  );
  const status = (): { text: string; tone: Tone } =>
    assessment().status === "ready"
      ? { text: "Ready to start", tone: "success" }
      : assessment().status === "not-ready"
        ? { text: "Not ready", tone: "warning" }
        : { text: "Checking launch", tone: "muted" };
  // Start is a focus stop of its own only beside the Model choice's fields; a
  // Command-only Review keeps Start in its hint alone.
  const startLines = () =>
    needsHarness()
      ? wrap(
          `${focused() === "start" ? "›" : " "} Start Run${
            canStart()
              ? ""
              : checking()
                ? " · unavailable while checks run"
                : " · unavailable"
          }`,
          width(),
          2,
        )
      : [];
  const hintLines = (scroll: boolean) =>
    wrap(
      [
        ...(needsHarness() ? ["tab/shift+tab move"] : []),
        ...(focused() !== "start"
          ? ["enter edit"]
          : canStart()
            ? ["enter start"]
            : []),
        ...(props.canAcknowledgeTrust() ? ["a acknowledge trust"] : []),
        ...(scroll ? ["PgUp/PgDn scroll"] : []),
        "esc back",
        "q quit",
      ].join(" · "),
      width(),
    );
  const viewportWith = (hint: readonly string[]) =>
    Math.max(
      1,
      dimensions().height -
        REVIEW_FRAME_ROWS -
        REVIEW_HEADER_ROWS -
        (props.stepLabel().length > 0 ? 1 : 0) -
        (props.notice() === undefined ? 0 : 1) -
        startLines().length -
        hint.length,
    );
  // The scroll hint appears only when the body overflows the viewport that
  // leaves room for it; content that fits there fits without it too.
  const hint = () => {
    const scrolling = hintLines(true);
    return bodyLines().length > viewportWith(scrolling)
      ? scrolling
      : hintLines(false);
  };
  const viewport = () => viewportWith(hint());
  const [offset, setOffset] = createSignal(0);
  const top = () =>
    Math.max(
      0,
      Math.min(offset(), Math.max(0, bodyLines().length - viewport())),
    );
  // Keep the focused row and its reasons in view as focus moves, content
  // settles, or the terminal resizes; paging between those moves is free.
  createEffect(() => {
    const field = focused();
    const lines = bodyLines();
    const height = viewport();
    untrack(() => {
      const start = lines.findIndex((line) => line.owner === field);
      if (start === -1) return;
      let end = start;
      while (lines[end]?.owner === field) end++;
      if (start < top()) setOffset(start);
      else if (end > top() + height) setOffset(Math.min(start, end - height));
    });
  });
  const page = (direction: -1 | 1) =>
    setOffset(top() + direction * Math.max(1, viewport() - 1));
  const colour = (tone: Tone) =>
    ({
      text: theme.text,
      muted: theme.textMuted,
      warning: theme.warning,
      error: theme.error,
      success: theme.success,
    })[tone];

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "tab",
        desc: "Next field",
        group: "Review",
        cmd: () => moveFocus(1),
      },
      {
        key: "shift+tab",
        desc: "Previous field",
        group: "Review",
        cmd: () => moveFocus(-1),
      },
      {
        key: "return",
        desc: "Edit or start",
        group: "Review",
        cmd: () => {
          const field = focused();
          if (field !== "start") {
            props.onEdit(field);
            return;
          }
          const offer = launchOffer();
          if (canStart() && offer !== undefined) props.onStart(offer.draft);
        },
      },
      {
        key: "pageup",
        desc: "Scroll up",
        group: "Review",
        cmd: () => page(-1),
      },
      {
        key: "pagedown",
        desc: "Scroll down",
        group: "Review",
        cmd: () => page(1),
      },
      {
        key: "a",
        desc: "Acknowledge trust",
        group: "Review",
        cmd: () => {
          if (props.canAcknowledgeTrust()) props.onAcknowledgeTrust();
        },
      },
      {
        key: "escape",
        desc: "Back",
        group: "Review",
        cmd: () => props.onBack(),
      },
      { key: "q", desc: "Quit", group: "Review", cmd: () => exit() },
      { key: "ctrl+c", desc: "Quit", group: "Review", cmd: () => exit() },
    ],
  }));

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} flexShrink={0}>
        Review
      </text>
      <StepCount label={props.stepLabel} />
      <RunNotStartedNotice
        notice={props.notice}
        onDismiss={props.onDismissNotice}
        group="Review"
      />
      <text fg={colour(status().tone)} flexShrink={0} wrapMode="none">
        {status().text}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        <For each={bodyLines().slice(top(), top() + viewport())}>
          {(line) => (
            <text
              fg={colour(line.tone)}
              attributes={line.selected ? TextAttributes.BOLD : 0}
              flexShrink={0}
              wrapMode="none"
            >
              {line.text}
            </text>
          )}
        </For>
      </box>
      <For each={startLines()}>
        {(line) => (
          <text
            fg={canStart() ? theme.text : theme.textMuted}
            attributes={focused() === "start" ? TextAttributes.BOLD : 0}
            flexShrink={0}
            wrapMode="none"
          >
            {line}
          </text>
        )}
      </For>
      <For each={hint()}>
        {(line) => (
          <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
    </box>
  );
}

// --- pending ---------------------------------------------------------------

export function PendingStep() {
  const { theme } = useTheme();
  const dimensions = useTerminalDimensions();
  const exit = useExit();
  const dialog = useDialog();
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "q", desc: "Quit", group: "Checking launch", cmd: () => exit() },
      {
        key: "ctrl+c",
        desc: "Quit",
        group: "Checking launch",
        cmd: () => exit(),
      },
    ],
  }));
  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      padding={1}
      overflow="hidden"
      backgroundColor={theme.background}
    >
      <text fg={theme.text} flexShrink={0}>
        Checking launch
      </text>
    </box>
  );
}
