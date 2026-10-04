import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  createMemo,
  createSignal,
  For,
  Show,
  Switch,
  Match,
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
  ModelChoicePicker,
  type ModelChoicePickerHandle,
  type ModelChoiceDraft,
} from "./model-choice-picker.js";
import { wrap } from "./wrap.js";
import { CatalogRow } from "./catalog-navigation.js";
import {
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
            ? "enter continue · esc choose another · q quit"
            : "esc choose another · q quit"
          : "↑/↓ move · enter choose · esc back · q quit"}
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

export function ReviewStep(props: {
  bundle: Accessor<InstalledBundleFocus | undefined>;
  harness: Accessor<HarnessSummary | undefined>;
  harnessFocus: Accessor<HarnessFocus | undefined>;
  draft: Accessor<LaunchRunInput>;
  canAcknowledgeTrust: Accessor<boolean>;
  onAcknowledgeTrust: () => void;
  stepLabel: Accessor<string>;
  notice: Accessor<string | undefined>;
  onDismissNotice: () => void;
  reset: Accessor<string | undefined>;
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
  const canStart = () =>
    assessment().status === "ready" && launchOffer() !== undefined;
  // The Model choice the Offer launches, resolved by the assessment, and where it
  // came from; until it resolves, the line says so rather than guessing.
  const modelChoiceLines = (): readonly string[] => {
    const choice = assessment().draft.modelChoice;
    if (choice === undefined) {
      return [
        assessment().status === "assessing"
          ? "Model choice: checking…"
          : "Model choice: not resolved",
      ];
    }
    const declaration = props.harnessFocus()?.modelDeclaration;
    return [
      ...(assessment().draft.preferenceNotice === undefined
        ? []
        : [assessment().draft.preferenceNotice ?? ""]),
      `Model choice: ${modelChoiceWords(choice, declaration)}`,
      ...(props.reset() === undefined ? [] : [props.reset() ?? ""]),
      ...(choice.effort === undefined
        ? ["This model has no effort setting.", "Not available."]
        : []),
      modelChoiceSourceLine(
        props.harness()?.name ?? "the Harness",
        choice.source,
        choice,
        declaration,
      ),
      ...(choice.effortLock === undefined
        ? []
        : [
            `Locked by ${choice.effortLock.source}. Change that setting outside Secant.`,
          ]),
    ];
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

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "return",
        desc: "Start Run",
        group: "Review",
        cmd: () => {
          const offer = launchOffer();
          if (assessment().status === "ready" && offer !== undefined) {
            props.onStart(offer.draft);
          }
        },
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
      gap={dimensions().height < 24 ? 0 : 1}
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
      <Show when={assessment().status === "assessing"}>
        <text fg={theme.textMuted} flexShrink={0}>
          Checking launch
        </text>
        <Show when={props.harness() !== undefined}>
          <text fg={theme.textMuted} flexShrink={0}>
            Checking the Harness and loading model choices… Please wait.
          </text>
        </Show>
      </Show>
      <Show when={assessment().status === "ready"}>
        <text fg={theme.success} flexShrink={0}>
          Ready to start
        </text>
      </Show>
      <Show when={assessment().status === "not-ready"}>
        <text fg={theme.warning} flexShrink={0}>
          Not ready
        </text>
      </Show>
      <For each={assessment().findings}>
        {(finding) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.warning}>{finding.explanation}</text>
            <text fg={theme.textMuted}>{finding.remediation}</text>
          </box>
        )}
      </For>
      <Show
        when={props.bundle()}
        fallback={<text fg={theme.error}>No Bundle selected.</text>}
      >
        {(bundle) => (
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <text fg={theme.text} flexShrink={0}>
              {`Workflow: ${formatRouting(bundle().routing)}`}
            </text>
            <text fg={theme.text} flexShrink={0}>
              {`Bundle: ${assessment().draft.bundle.name ?? bundle().name} (${assessment().draft.bundle.id}@${assessment().draft.bundle.version ?? bundle().version})`}
            </text>
            <text fg={theme.textMuted} flexShrink={0}>
              {`Bundle digest: sha256:${assessment().draft.bundle.digest ?? bundle().digest}`}
            </text>
            <text fg={theme.text} flexShrink={0}>
              {`Workspace: ${workspaceName(workspace.snapshot().path)} · ${workspace.snapshot().path}`}
            </text>
            <Show when={routingNeedsHarness(bundle().routing)}>
              <text fg={theme.text} flexShrink={0}>
                {`Harness: ${props.harness()?.name ?? "(not selected)"} (${props.harness()?.id ?? "none"})`}
              </text>
              <For each={modelChoiceLines()}>
                {(line, index) => (
                  <text
                    fg={index() === 0 ? theme.text : theme.textMuted}
                    flexShrink={0}
                  >
                    {line}
                  </text>
                )}
              </For>
            </Show>
            <Show
              when={bundle().launchInputs.length > 0}
              fallback={<text fg={theme.textMuted}>No launch inputs.</text>}
            >
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme.textMuted}>Launch inputs:</text>
                <For each={bundle().launchInputs}>
                  {(input) => (
                    <text fg={theme.text}>
                      {`  ${input.name}: ${assessment().draft.launchInputs[input.name] ?? "(not set)"}`}
                    </text>
                  )}
                </For>
              </box>
            </Show>
            <text fg={theme.text} flexShrink={0}>
              {trustPosture()}
            </text>
          </box>
        )}
      </Show>
      <text fg={theme.textMuted} flexShrink={0}>
        {canStart()
          ? "enter start · esc back · q quit"
          : props.canAcknowledgeTrust()
            ? "a acknowledge trust · esc back · q quit"
            : "start unavailable · esc back · q quit"}
      </text>
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
