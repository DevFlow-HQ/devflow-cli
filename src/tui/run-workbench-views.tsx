import { latestFailure } from "./run-timeline-rows.js";
import { TextAttributes, type TextareaRenderable } from "@opentui/core";
import {
  batch,
  createEffect,
  createSignal,
  untrack,
  onCleanup,
  For,
  Match,
  Show,
  Switch,
  type Accessor,
} from "solid-js";
import type {
  AnswerHumanGateOffer,
  CancelRunOffer,
  ChangeModelChoiceOffer,
  DeleteRunOffer,
  Problem,
  ResumeRunOffer,
  RunCheckpointView,
  RunRestingCauseView,
  RunStateName,
  RunStepStatus,
  RunView,
  SessionHistoryValue,
  RunTimelineEvent,
} from "../application/projection-port.js";
import { clip } from "./clip.js";
import { wrap } from "./wrap.js";
import type { TranscriptTarget } from "./run-transcript.js";
import type { Openable } from "./run-inspection.js";
import type { Theme } from "./vendor/theme.js";
import { WorkingScanner } from "./working-scanner.js";

// Pure presentational leaves for the Run Workbench. State, effects, focus, the one
// resolved bottom interaction, and the key dispatcher stay in run-workbench.tsx;
// these views receive only Accessors, models, and callbacks from that owner.

/** What the prompt's hint rows show (ADR 0036): the working scanner beside its
 *  words while a Turn works, or plain lines the owner has already wrapped to the
 *  width — key hints or an armed confirmation. */
export type PromptHint =
  | {
      readonly kind: "working";
      readonly label: string;
      readonly detail: string;
    }
  | {
      readonly kind: "lines";
      readonly lines: readonly string[];
      readonly tone: "muted" | "warning";
    };

/** A completion's native token edit, in editor text offsets. */
export interface MentionReplacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Everything the ordinary prompt draws, resolved by the Workbench from its one
 *  bottom interaction. `promptHeight` counts exactly the rows `PromptControl` draws. */
export interface PromptModel {
  /** A note above the field, such as the Interrupt's "waiting on you". */
  readonly note?: string;
  /** Whose move it is, shown while the draft is empty. */
  readonly placeholder: string;
  readonly fieldRows: number;
  /** Step, Session, and Model choice at 120 columns or less. */
  readonly meta?: string;
  /** A refused send or Steer, wrapped; it sits above the hint, so the working
   *  state and its keys stay visible beside it. */
  readonly refusal: readonly string[];
  /** Saved old-target text and its explicit palette recovery route. */
  readonly recovery: readonly string[];
  readonly hint: PromptHint;
  readonly commands?: readonly {
    readonly kind: "candidate" | "status";
    readonly text: string;
  }[];
}

export function promptHeight(model: PromptModel): number {
  return (
    (model.note === undefined ? 0 : 1) +
    model.fieldRows +
    (model.meta === undefined ? 0 : 1) +
    model.refusal.length +
    model.recovery.length +
    (model.commands?.length ?? 0) +
    (model.hint.kind === "working" ? 1 : model.hint.lines.length)
  );
}

/** The always-editable prompt (ADR 0036): an optional note, a native OpenTUI
 *  textarea that owns text, cursor motion, word deletion, paste, and newlines
 *  (Shift+Enter, Ctrl+J), the narrow meta row, and the hint rows. The Workbench's
 *  Port dispatcher claims Enter and the command keys first; the field is blurred
 *  while a dialog, a confirmation, focused details holds the keys, so a confirming `y` never types. Every line is plain words, so whose move
 *  it is reads without colour. */
export function PromptControl(props: {
  model: Accessor<PromptModel>;
  draft: Accessor<string>;
  onInput: (value: string) => void;
  onCaret: (caret: number) => void;
  replacement: Accessor<MentionReplacement | undefined>;
  onReplacement: () => void;
  focused: Accessor<boolean>;
  listOpen: Accessor<boolean>;
  width: Accessor<number>;
  reducedMotion: boolean;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const hint = () => props.model().hint;
  const working = () => {
    const current = hint();
    return current.kind === "working" ? current : undefined;
  };
  const lines = () => {
    const current = hint();
    return current.kind === "lines" ? current : undefined;
  };
  const tone = (which: "muted" | "warning") =>
    which === "warning" ? theme.warning : theme.textMuted;
  return (
    <box
      flexDirection="column"
      height={promptHeight(props.model())}
      flexShrink={0}
      overflow="hidden"
    >
      <Show when={props.model().note}>
        {(note) => (
          <text fg={theme.warning} flexShrink={0} wrapMode="none">
            {clip(note(), w())}
          </text>
        )}
      </Show>
      <box
        flexDirection="row"
        height={props.model().fieldRows}
        flexShrink={0}
        overflow="hidden"
      >
        <text fg={theme.accent} attributes={TextAttributes.BOLD} flexShrink={0}>
          {"> "}
        </text>
        <PromptField
          draft={props.draft}
          onInput={props.onInput}
          onCaret={props.onCaret}
          replacement={props.replacement}
          onReplacement={props.onReplacement}
          focused={props.focused}
          listOpen={props.listOpen}
          placeholder={() => clip(props.model().placeholder, w() - 2)}
          placeholderColor={theme.textMuted}
          width={() => Math.max(1, w() - 2)}
          rows={() => props.model().fieldRows}
        />
      </box>
      <For each={props.model().commands}>
        {(line) => (
          <text
            fg={line.kind === "status" ? theme.textMuted : theme.text}
            flexShrink={0}
            wrapMode="none"
          >
            {line.text}
          </text>
        )}
      </For>
      <Show when={props.model().meta}>
        {(meta) => (
          <text fg={theme.textMuted} flexShrink={0} wrapMode="none">
            {clip(meta(), w())}
          </text>
        )}
      </Show>
      <For each={props.model().recovery}>
        {(line) => (
          <text fg={theme.warning} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
      <For each={props.model().refusal}>
        {(line) => (
          <text fg={theme.error} flexShrink={0} wrapMode="none">
            {line}
          </text>
        )}
      </For>
      <Switch>
        <Match when={working()}>
          {(current) => (
            <WorkingScanner
              label={current().label}
              detail={current().detail}
              labelColor={theme.text}
              reducedMotion={props.reducedMotion}
              width={w()}
              accent={theme.accent}
              muted={theme.textMuted}
            />
          )}
        </Match>
        <Match when={lines()}>
          {(current) => (
            <For each={current().lines}>
              {(line) => (
                <text fg={tone(current().tone)} flexShrink={0} wrapMode="none">
                  {line}
                </text>
              )}
            </For>
          )}
        </Match>
      </Switch>
    </box>
  );
}

/** The Run states whose resting view replaces the prompt (ADR 0036, ADR 0041). */
export type RestingState = "succeeded" | "failed" | "cancelled" | "halted";

const RESTING_GLYPH: Record<RestingState, string> = {
  succeeded: "✓",
  failed: "✗",
  cancelled: "■",
  halted: "⏸",
};

/** One drawn row of the resting view. */
export interface RestingLine {
  readonly text: string;
  readonly tone: DetailsTone;
  readonly bold: boolean;
}

/** The resting view's rows at `width`, wrapped in full so a long explanation is
 *  never cut (#528): the state and why the Run rests, the next step its Resting
 *  cause names, the Run id now that the Run has left an active state, and its
 *  keys. The Workbench reserves exactly these rows. */
export function restingLines(
  run: RunView,
  state: RestingState,
  width: number,
): readonly RestingLine[] {
  const prose = restingProse(run);
  const lines = (text: string, tone: DetailsTone, bold = false) =>
    wrap(text, width, 2).map((line) => ({ text: line, tone, bold }));
  const next = run.restingCause?.nextStep;
  return [
    ...lines(
      `${RESTING_GLYPH[state]} Run ${state}${prose === undefined ? "" : ` — ${prose}`}`,
      restingTone(state),
      true,
    ),
    ...(next === undefined ? [] : lines(`  Next: ${next}`, "text")),
    ...lines(`  Run ${run.runId}`, "text"),
    ...lines(
      next === undefined
        ? "  ctrl+g details · esc back · ctrl+c quit"
        : "  ctrl+g details to resume or delete · esc back · ctrl+c quit",
      "muted",
    ),
  ];
}

/** A resting Run's view (ADR 0036): it replaces the prompt and captures no typed
 *  text, so the details panel's resume and delete stay the only routes. It reads by
 *  glyph and words, never colour alone. */
export function RestingView(props: {
  lines: Accessor<readonly RestingLine[]>;
  theme: Theme;
}) {
  const { theme } = props;
  return (
    <box
      flexDirection="column"
      height={props.lines().length}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <For each={props.lines()}>
        {(line) => (
          <text
            fg={toneColour(theme, line.tone)}
            attributes={line.bold ? TextAttributes.BOLD : 0}
            flexShrink={0}
            wrapMode="none"
          >
            {line.text}
          </text>
        )}
      </For>
    </box>
  );
}

/** The Review checkpoint interaction (#92): the authored message and cadence, the
 *  completed-iteration count, the latest `fail` Verdict, the openable evidence,
 *  and two consequence-stating controls. It holds the bottom region while blocked;
 *  every line is plain text so both consequences read with colour removed. */
export function CheckpointInteraction(props: {
  checkpoint: Accessor<RunCheckpointView>;
  height: number;
  offer: Accessor<AnswerHumanGateOffer | undefined>;
  evidence: Accessor<readonly string[]>;
  control: Accessor<"continue" | "stop">;
  focused: Accessor<boolean>;
  pending: Accessor<boolean>;
  refusal: Accessor<Problem | undefined>;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const cp = () => props.checkpoint();
  const continueLabel = () => `Continue ${cp().interval} More Iterations`;
  const marker = (which: "continue" | "stop") =>
    props.focused() && props.control() === which ? "› " : "  ";
  const evidence = () => {
    const labels = props.evidence();
    return labels.length > 0 ? labels.join(" · ") : "(none)";
  };
  const status = () => {
    if (props.pending()) return "… submitting your answer";
    const refusal = props.refusal();
    if (refusal !== undefined)
      return `refused: ${refusal.explanation} ${refusal.remediation}`;
    return "←/→ choose · enter confirm · ctrl+g details · esc back · ctrl+c quit";
  };
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <text
        fg={props.focused() ? theme.warning : theme.textMuted}
        attributes={props.focused() ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${props.focused() ? "› " : "  "}Review checkpoint · ${cp().message}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(
          `  every ${cp().interval} iteration(s) · ${cp().completedIterations} completed · latest: ${cp().latestVerdict.name} = ${cp().latestVerdict.value} · evidence: ${evidence()}`,
          w(),
        )}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "continue" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("continue")}[ ${continueLabel()} ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.continueConsequence ?? ""}`, w())}
      </text>
      <text
        fg={theme.text}
        attributes={props.control() === "stop" ? TextAttributes.BOLD : 0}
        flexShrink={0}
      >
        {clip(
          `${marker("stop")}[ Stop Run ]${props.pending() ? "  (unavailable)" : ""}`,
          w(),
        )}
      </text>
      <text fg={theme.textMuted} flexShrink={0}>
        {clip(`    ${props.offer()?.stopConsequence ?? ""}`, w())}
      </text>
      <text
        fg={props.refusal() !== undefined ? theme.error : theme.textMuted}
        flexShrink={0}
      >
        {clip(status(), w())}
      </text>
    </box>
  );
}

/** Short prose stating why a resting Run rests (#194 story 38). A `halted` or
 *  `failed` Run reads its Resting cause's explanation, which the Projection
 *  derives (ADR 0041), except that a Materialization conflict keeps its own reason
 *  until its cause is recorded; the other states are worded here from the Run
 *  view's facts. Exhaustive over `RunStateName` so a new state must be given prose
 *  here to compile. `running` is not a resting state. The resting view (beside the
 *  state word, so colour is never the only signal, AC4) and the panel's recovery
 *  evidence (AC2) render this one string. */
function restingProse(run: RunView): string | undefined {
  switch (run.state) {
    case "running":
      return undefined;
    case "succeeded":
      // A confirmed End Stage (#218) is the human's declaration, never a check.
      return run.completion === "agent-declared"
        ? "The agent declared this Run complete."
        : run.completion === "human-declared"
          ? "You declared the stage complete; Secant did not check the tracker."
          : "Workflow completed.";
    case "failed":
      return run.restingCause?.explanation;
    case "cancelled":
      return "You cancelled this Run.";
    case "halted":
      return run.conflict !== undefined
        ? "A required file changed, so execution stopped outside the Workflow."
        : run.restingCause?.explanation;
    case "blocked":
      return run.checkpoint !== undefined
        ? "You stopped at the Review checkpoint."
        : run.pendingGate !== undefined
          ? "Paused at a Human Gate — waiting for your answer."
          : "It's your Turn — waiting for you to continue.";
  }
}

export type DetailsTone = "text" | "muted" | "warning" | "error" | "success";

export interface DetailsRow {
  readonly text: string;
  readonly tone: DetailsTone;
  readonly bold: boolean;
}

/** Possible effects in plain phrases, so the stored `partial` is never misread
 *  as a half-finished Step (#527 decision 28). */
const EFFECTS: Record<
  NonNullable<RunRestingCauseView["possibleEffects"]>,
  string
> = {
  none: "No changes made",
  unknown: "May have changed files",
  partial: "Changed files before it stopped",
};

function restingTone(state: RunStateName): DetailsTone {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "halted":
    case "blocked":
      return "warning";
    case "cancelled":
    case "running":
      return "muted";
  }
}

/** The details panel's rows, built once so the render and the container's exact
 *  row reservation (the panel's height) share one source of truth (tui/AGENTS.md).
 *  Every recovery-evidence line appears only when the Run view exposes its fact —
 *  nothing is invented when a fact is absent (#194 story 36, AC2). */
export function buildDetailsRows(params: {
  readonly run: RunView;
  readonly position: string;
  readonly compact: boolean;
  readonly focused: boolean;
  readonly openables: readonly (Openable | TranscriptTarget)[];
  /** The Resting cause's diagnostic was pruned (ADR 0041). */
  readonly diagnosticExpired: boolean;
  readonly failureDiagnosticExpired: boolean;
  readonly selected: number;
  /** Set when the resting resume offer arms an indeterminate-Command-Attempt
   *  acknowledgement (#194 story 39); surfaced as recovery evidence too. */
  readonly resumeAcknowledgement: string | undefined;
  readonly modelChoice: ChangeModelChoiceOffer | undefined;
  readonly resume: ResumeRunOffer | undefined;
  readonly cancel: CancelRunOffer | undefined;
  readonly remove: DeleteRunOffer | undefined;
  readonly armed: "takeover" | "acknowledge" | "cancel" | "delete" | undefined;
}): DetailsRow[] {
  const { run } = params;
  const rows: DetailsRow[] = [];
  const push = (text: string, tone: DetailsTone = "muted", bold = false) =>
    rows.push({ text, tone, bold });

  push(
    `${params.focused ? "› " : "  "}Details${params.focused ? " · ↑/↓ select · enter open · esc back · ctrl+g close" : " · ctrl+g focus"}`,
    "text",
    params.focused,
  );
  // The Run id and owner process the everyday screen leaves out (#293); the
  // owner shows only while the Run is live, worded as headless `run show` words it.
  push(`  Run ${run.runId}`, "text");
  if (run.liveness.state !== "not-live")
    push(
      `  Live · ${run.liveness.state === "live-here" ? "in this instance" : "in another instance"} (process ${run.liveness.ownerPid})`,
    );
  push(
    `  ${run.bundle.id}@${run.bundle.version} · sha256:${run.bundle.digest}`,
    "text",
  );
  push(`  Workspace: ${run.workspacePath}`);
  push(`  Launched: ${run.launchedAt} · ${params.position}`);

  // Harness/model facts, kept off the everyday screen (#194 story 35): durable
  // selection, then the latest Attempt's observation, then the requested model
  // kept visibly apart from the observed effective model (AC1). The compact form
  // drops the long executable path to stay readable at small widths.
  if (run.selectedHarness !== undefined)
    push(`  Selected Harness · ${run.selectedHarness}`);
  if (run.harness !== undefined) {
    const model = run.effectiveModel ?? "not reported";
    push(
      params.compact
        ? `  Observed Harness · ${run.harness.name} · ${run.harness.executableVersion} · model ${model}`
        : `  Observed Harness · ${run.harness.name} · ${run.harness.executable} · ${run.harness.executableVersion} · model ${model}`,
    );
  }
  if (run.modelChoice !== undefined)
    push(`  Model choice · ${modelChoiceText(run.modelChoice)}`);

  // Recovery evidence (#194 story 36): each line only when its fact is present.
  const recovery: DetailsRow[] = [];
  const prose = restingProse(run);
  if (prose !== undefined)
    recovery.push({
      text: `  Resting reason · ${prose}`,
      tone: restingTone(run.state),
      bold: false,
    });
  const last = run.timeline[run.timeline.length - 1];
  if (last !== undefined)
    recovery.push({
      text: `  Latest activity · ${last.event}${last.detail !== undefined ? ` ${last.detail}` : ""} · ${last.at}`,
      tone: "muted",
      bold: false,
    });
  if (run.conflict !== undefined)
    recovery.push({
      text: `  Materialization conflict · restore ${run.conflict.path}`,
      tone: "warning",
      bold: false,
    });
  if (params.resumeAcknowledgement !== undefined)
    recovery.push({
      text: `  Indeterminate Attempt · ${params.resumeAcknowledgement}`,
      tone: "warning",
      bold: false,
    });
  for (const session of run.sessions ?? [])
    recovery.push({
      text: `  Session ${session.name} · ${session.availability}`,
      tone: session.availability === "unusable" ? "warning" : "muted",
      bold: false,
    });
  if (recovery.length > 0) {
    push("  Recovery:", "muted");
    rows.push(...recovery);
  }

  // The technical cause the everyday screen leaves out (ADR 0041): the Resting
  // cause's code and possible effects in plain phrases, its diagnostic among the
  // Resources, and a transient Problem's code.
  const cause = run.restingCause;
  const failure = latestFailure(run);
  if (
    cause !== undefined ||
    failure !== undefined ||
    run.problem !== undefined
  ) {
    push("  Failure:", "muted");
    if (cause !== undefined) {
      push(`  Resting cause · ${cause.code}`, restingTone(run.state));
      if (cause.possibleEffects !== undefined)
        push(`  Possible effects · ${EFFECTS[cause.possibleEffects]}`);
      if (cause.diagnostic !== undefined)
        push(
          params.diagnosticExpired
            ? "  Diagnostic · Expired after 90 days"
            : "  Diagnostic · open the failure diagnostic under Resources",
        );
    }
    if (failure !== undefined) {
      push(`  Source · ${failure.source}`);
      push(`  Code · ${failure.code}`, "error");
      if (failure.phase !== undefined) push(`  Phase · ${failure.phase}`);
      if (failure.category !== undefined)
        push(`  Category · ${failure.category}`);
      push(`  Possible effects · ${EFFECTS[failure.possibleEffects]}`);
      if (failure.nativeCode !== undefined)
        push(`  Native code · ${failure.nativeCode}`);
      push(
        failure.diagnostic === undefined
          ? "  Diagnostic · None recorded"
          : params.failureDiagnosticExpired
            ? "  Diagnostic · Expired after 90 days"
            : "  Diagnostic · open the failure diagnostic under Resources",
      );
    }
    if (run.problem !== undefined)
      push(`  Problem · ${run.problem.code}`, "error");
  }

  push("  Resources:", "muted");
  if (params.openables.length === 0) push("    (none)");
  else
    params.openables.forEach((openable, index) => {
      const active = params.focused && index === params.selected;
      push(`    ${active ? "› " : "  "}${openable.label}`, "text", active);
    });

  // Run lifecycle actions (ADR 0036): resume, cancel, and delete keep their letter
  // keys here, where the focused panel owns them, with the consequence each Offer
  // names; an armed confirm (AC3) shows in place. Model choice is an App command.
  if (
    params.modelChoice !== undefined ||
    params.resume !== undefined ||
    params.cancel !== undefined ||
    params.remove !== undefined
  ) {
    push("  Actions:", "muted");
    if (params.resume !== undefined)
      push(
        params.resume.available
          ? `    r resume — ${params.resume.consequence}`
          : `    resume — unavailable · ${params.resume.reason}`,
        params.resume.available ? "text" : "muted",
      );
    if (params.modelChoice !== undefined)
      push(
        params.modelChoice.available
          ? `    ctrl+p Model choice · ${params.modelChoice.reach === "next-turn" ? "applies from the next Turn" : "requested until the Harness reports it"}`
          : `    Model choice unavailable · ${params.modelChoice.problem.explanation}`,
        "text",
      );
    if (params.cancel !== undefined)
      push(`    c cancel — ${params.cancel.consequence}`, "text");
    if (params.remove !== undefined)
      push(`    x delete — ${params.remove.consequence}`, "text");
    if (params.armed === "takeover")
      push(
        `    ⚠ Take over from process ${params.resume?.available === true ? (params.resume.takeover?.ownerPid ?? "unknown") : "unknown"}? Press y to confirm · esc to keep`,
        "warning",
      );
    else if (params.armed === "acknowledge")
      push(
        "    ⚠ Resuming may repeat this Step's effects. Press y to acknowledge and resume · esc to keep",
        "warning",
      );
    else if (params.armed === "cancel")
      push(
        "    ⚠ Cancel ends the Run (history is kept). Press y to confirm · esc to keep",
        "warning",
      );
    else if (params.armed === "delete")
      push(
        "    ⚠ Delete is permanent (Workspace files are kept). Press y to confirm · esc to keep",
        "warning",
      );
  }

  return rows;
}

function toneColour(theme: Theme, tone: DetailsTone) {
  return tone === "text"
    ? theme.text
    : tone === "warning"
      ? theme.warning
      : tone === "error"
        ? theme.error
        : tone === "success"
          ? theme.success
          : theme.textMuted;
}

export function DetailsPanel(props: {
  rows: Accessor<readonly DetailsRow[]>;
  height: number;
  width: Accessor<number>;
  theme: Theme;
}) {
  const { theme } = props;
  const w = () => props.width();
  const colour = (tone: DetailsTone) => toneColour(theme, tone);
  return (
    <box
      flexDirection="column"
      height={props.height}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <For each={props.rows()}>
        {(row) => (
          <text
            fg={colour(row.tone)}
            attributes={row.bold ? TextAttributes.BOLD : 0}
            flexShrink={0}
          >
            {clip(row.text, w())}
          </text>
        )}
      </For>
    </box>
  );
}

/** A Model choice in words: the model, then any effort. */
export function modelChoiceText(choice: {
  readonly model: string;
  readonly effort?: string;
}): string {
  return `${choice.model}${choice.effort === undefined ? "" : ` · ${choice.effort} effort`}`;
}

const STEP_GLYPH: Record<RunStepStatus, string> = {
  pending: "·",
  running: "…",
  succeeded: "✓",
  failed: "✗",
  blocked: "⏸",
};

/** Columns the sidebar holds above 120 terminal columns (ADR 0036). */
export const SIDEBAR_WIDTH = 42;

/** The sidebar's rows: the Bundle and the Run's state in words, the Steps by
 *  glyph with the current one's Session (its plain name carries any Iteration),
 *  the Harness and Model choice beside any differing observed model, and the
 *  Harness's reported context. Ids, processes, and timestamps stay out. */
export function buildSidebarRows(params: {
  readonly run: RunView;
  readonly session: string | undefined;
  /** A requested Model choice not yet applied or reported. */
  readonly pendingChoice: string | undefined;
  readonly metadata: readonly string[];
}): DetailsRow[] {
  const { run } = params;
  const rows: DetailsRow[] = [];
  const push = (text: string, tone: DetailsTone = "muted", bold = false) =>
    rows.push({ text, tone, bold });
  push(run.bundle.name, "text", true);
  push(
    run.state[0]!.toUpperCase() + run.state.slice(1),
    restingTone(run.state),
  );
  push("");
  push("Steps", "text", true);
  if (run.progress.length === 0) push("  (no steps)");
  run.progress.forEach((step, index) => {
    const current = index === run.position;
    push(
      `${current ? "▸" : " "} ${STEP_GLYPH[step.status]} ${step.id}`,
      current ? "text" : "muted",
      current,
    );
    if (current && params.session !== undefined) push(`    ${params.session}`);
  });
  if (
    run.selectedHarness !== undefined ||
    run.harness !== undefined ||
    run.modelChoice !== undefined ||
    params.pendingChoice !== undefined
  ) {
    push("");
    push("Agent", "text", true);
    const harness = run.harness?.name ?? run.selectedHarness;
    if (harness !== undefined) push(`  ${harness}`);
    if (run.modelChoice !== undefined)
      push(`  ${modelChoiceText(run.modelChoice)}`, "text");
    if (
      run.effectiveModel !== undefined &&
      run.effectiveModel !== run.modelChoice?.model
    )
      push(`  observed ${run.effectiveModel}`);
    if (params.pendingChoice !== undefined)
      push(`  → requested ${params.pendingChoice}`, "warning");
  }
  const reported = params.metadata.filter((line) => line !== "");
  if (reported.length > 0) {
    push("");
    push("Context", "text", true);
    for (const line of reported) push(`  ${line}`);
  }
  push("");
  push("ctrl+g details · ctrl+p commands");
  return rows;
}

export function Sidebar(props: {
  rows: Accessor<readonly DetailsRow[]>;
  theme: Theme;
}) {
  const { theme } = props;
  return (
    <box
      width={SIDEBAR_WIDTH}
      flexDirection="column"
      flexShrink={0}
      paddingLeft={2}
      paddingRight={1}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
    >
      <For each={props.rows()}>
        {(row) => (
          <text
            fg={toneColour(theme, row.tone)}
            attributes={row.bold ? TextAttributes.BOLD : 0}
            flexShrink={0}
            wrapMode="none"
          >
            {clip(row.text, SIDEBAR_WIDTH - 3)}
          </text>
        )}
      </For>
    </box>
  );
}

/** The prompt's native editor. A textarea keeps verbatim line breaks (an
 *  `<input>` strips them), so restored Steers and Shift+Enter/Ctrl+J newlines
 *  survive. It owns its text after mount; the Workbench writes only a changed
 *  draft back (a clear, a restore), never echoing what the field reported. Enter
 *  submits rather than inserting a line, since the Port dispatcher sends it. */
function PromptField(props: {
  draft: Accessor<string>;
  onInput: (value: string) => void;
  onCaret: (caret: number) => void;
  replacement: Accessor<MentionReplacement | undefined>;
  onReplacement: () => void;
  focused: Accessor<boolean>;
  listOpen: Accessor<boolean>;
  placeholder: Accessor<string>;
  placeholderColor: Theme["textMuted"];
  width: Accessor<number>;
  rows: Accessor<number>;
}) {
  const initial = untrack(props.draft);
  let reported = initial;
  const [box, setBox] = createSignal<TextareaRenderable>();
  onCleanup(() => box()?.blur());
  const report = () => {
    const editor = box();
    if (editor === undefined) return;
    const value = editor.plainText;
    const offset = editor.getTextRange(0, editor.cursorOffset).length;
    batch(() => {
      if (value !== reported) {
        reported = value;
        props.onInput(value);
      }
      props.onCaret(offset);
    });
  };
  createEffect(() => {
    const editor = box();
    const replacement = props.replacement();
    if (editor === undefined || replacement === undefined) return;
    untrack(() => {
      // Tokens never cross a logical line. Find their native positions using
      // the editor's ranges, including its tab and grapheme boundaries.
      const nativeOffset = (offset: number) => {
        let start = editor.editBuffer.getLineStartOffset(
          editor.logicalCursor.row,
        );
        let end = editor.editBuffer.getEOL().offset;
        while (start < end) {
          const middle = Math.ceil((start + end) / 2);
          if (editor.getTextRange(0, middle).length <= offset) start = middle;
          else end = middle - 1;
        }
        return start;
      };
      editor.setSelection(
        nativeOffset(replacement.start),
        nativeOffset(replacement.end),
      );
      editor.insertText(replacement.text);
      editor.clearSelection();
      report();
      props.onReplacement();
    });
  });
  createEffect(() => {
    const editor = box();
    const value = props.draft();
    if (editor === undefined || editor.plainText === value) return;
    reported = value;
    editor.setText(value);
    editor.gotoBufferEnd();
  });
  return (
    <textarea
      ref={setBox}
      initialValue={initial}
      placeholder={props.placeholder()}
      placeholderColor={props.placeholderColor}
      height={props.rows()}
      width={props.width()}
      wrapMode="none"
      focused={props.focused()}
      keyBindings={[
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
        // The Port owns list navigation. Submit has no handler and keeps the
        // native cursor still when the same arrow reaches the focused field.
        { name: "up", action: props.listOpen() ? "submit" : "move-up" },
        { name: "down", action: props.listOpen() ? "submit" : "move-down" },
      ]}
      onContentChange={report}
      onCursorChange={report}
    />
  );
}

/** One counted history line, with semantics supplied by the row owner. */
export function HistoryLine(props: {
  theme: Theme;
  text: string;
  value?: SessionHistoryValue;
  event?: RunTimelineEvent["event"];
  humanPanel: boolean;
  failurePanel: boolean;
  width: number;
  onMouseDown: () => void;
}) {
  const tone = () => {
    if (props.failurePanel) return props.theme.textMuted;
    const value = props.value;
    if (value === undefined)
      return props.event === "agent-call"
        ? props.theme.success
        : props.event === "turn-started" || props.event === "turn-settled"
          ? props.theme.accent
          : props.event === "materialization-conflict"
            ? props.theme.error
            : props.event === "request-raised"
              ? props.theme.warning
              : props.theme.text;
    switch (value.kind) {
      case "tool":
        return value.outcome.kind === "failed"
          ? props.theme.error
          : value.outcome.kind === "running"
            ? props.theme.text
            : props.theme.textMuted;
      case "entry-prompt":
        return props.theme.textMuted;
      case "thought":
      case "request":
        return props.theme.warning;
      case "agent-call":
        return props.theme.success;
      case "turn-result":
        return props.theme.accent;
      case "message":
      case "steer":
      case "turn-diff":
      case "activity":
        return props.theme.text;
      default: {
        const exhaustive: never = value;
        return exhaustive;
      }
    }
  };
  return (
    <box
      flexDirection="row"
      height={1}
      flexShrink={0}
      backgroundColor={
        props.humanPanel ? props.theme.backgroundPanel : undefined
      }
      onMouseDown={props.onMouseDown}
    >
      <Show when={props.humanPanel || props.failurePanel}>
        <text
          fg={props.failurePanel ? props.theme.error : props.theme.accent}
          width={1}
          flexShrink={0}
          wrapMode="none"
        >
          {"┃"}
        </text>
      </Show>
      <text
        fg={tone()}
        bg={props.humanPanel ? props.theme.backgroundPanel : undefined}
        width={
          props.humanPanel || props.failurePanel
            ? Math.max(1, props.width - 1)
            : props.width
        }
        flexShrink={0}
        wrapMode="none"
      >
        {props.text}
      </text>
    </box>
  );
}
