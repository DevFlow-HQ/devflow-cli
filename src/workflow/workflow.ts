// The Workflow Module owns Secant's execution-free authored vocabulary: the
// closed sets and grammars a Bundle manifest is written against. It executes
// nothing and imports no Node mechanism (the boundary suite enforces both), so
// the Bundle validator and, next slice, the Composition check can consult one
// authority for what a manifest may legally say. Step *execution* is a private
// table added beside this in M2; only the static contract lives here.

/** Transport-independent restrictions declared by a Harness (ADR 0040). */
export type HarnessInputRule = {
  readonly kind: "reserved-leading-words";
  readonly words: readonly string[];
};

/** Returns the declared reserved word, or undefined when the text satisfies every
 *  rule. JavaScript's Unicode whitespace separates words and is skipped at start. */
export function matchHarnessInputRule({
  text,
  rules,
}: {
  readonly text: string;
  readonly rules: readonly HarnessInputRule[];
}): string | undefined {
  const firstWord = text.trimStart().split(/\s/, 1)[0]?.toLowerCase();
  for (const rule of rules) {
    switch (rule.kind) {
      case "reserved-leading-words": {
        const word = rule.words.find(
          (word) => word.toLowerCase() === firstWord,
        );
        if (word !== undefined) return word;
        break;
      }
      default: {
        const exhaustive: never = rule.kind;
        return exhaustive;
      }
    }
  }
  return undefined;
}

/** The five closed Run Artifact types. */
export type ArtifactType = "text" | "file" | "file-set" | "verdict" | "choice";
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "text",
  "file",
  "file-set",
  "verdict",
  "choice",
];

/** Where a produced artifact lives; `workspace` requests a materialization. */
export type ArtifactHome = "store" | "workspace";
export const ARTIFACT_HOMES: readonly ArtifactHome[] = ["store", "workspace"];

/** The four Crucible-owned Step kinds. Secant owns the set; a Bundle supplies
 *  only content, parameters, and optional Workspace prerequisites. */
export type StepKindName =
  "agent" | "interactive-agent" | "human-gate" | "command";
export const STEP_KIND_NAMES: readonly StepKindName[] = [
  "agent",
  "interactive-agent",
  "human-gate",
  "command",
];

/** The two shapes a Human Gate carries. */
export type HumanGateShape = "approve-reject" | "free-text";
export const HUMAN_GATE_SHAPES: readonly HumanGateShape[] = [
  "approve-reject",
  "free-text",
];

/** How a Step Attempt may end. */
export type AttemptOutcome =
  "succeeded" | "failed" | "indeterminate" | "cancelled";

/** How a Step kind relates to a Harness Session. */
type SessionNeed = "none" | "named";

/**
 * The one reserved Session name (ADR 0020, spec #107 story 8). An Agent Step
 * whose `session` is `fresh` opens an isolated Session per Attempt
 * (`fresh-<attempt>`) rather than joining a shared one; two Steps both naming
 * `fresh` do NOT continue one conversation. The word is authored vocabulary, so
 * it lives here — the executor keys `fresh-<attempt>` off this constant and the
 * Composition check names the non-sharing semantics from it, rather than either
 * re-typing the literal.
 */
export const FRESH_SESSION = "fresh";

/**
 * One Step kind's uniform contract, stated as the same seven facts for every
 * kind (#13). The orchestrator learns nothing per kind; adding a kind means
 * stating these facts, never branching on identity. `authored` marks a fact the
 * Bundle supplies per Step rather than one fixed by the kind.
 */
export interface StepKindContract {
  readonly kind: StepKindName;
  /** Artifacts required before the Step runs. */
  readonly requires: "authored";
  /** Artifacts produced. `authored` for agents; fixed for Command and Gates. */
  readonly produces: "authored" | readonly ArtifactType[] | "none";
  readonly session: SessionNeed;
  /** World facts checked at preflight beyond authored Workspace prerequisites. */
  readonly preconditions: "none" | "executable-on-path";
  readonly capabilityNeeds: readonly string[];
  readonly retryableOutcomes: readonly AttemptOutcome[];
  readonly reconciliation: "human-resume" | "reconciliation-probe";
}

export const STEP_KINDS: Readonly<Record<StepKindName, StepKindContract>> = {
  agent: {
    kind: "agent",
    requires: "authored",
    produces: "authored",
    session: "named",
    preconditions: "none",
    capabilityNeeds: ["agent-turn"],
    retryableOutcomes: ["failed"],
    reconciliation: "reconciliation-probe",
  },
  "interactive-agent": {
    kind: "interactive-agent",
    requires: "authored",
    produces: "authored",
    session: "named",
    preconditions: "none",
    capabilityNeeds: ["interactive-turns"],
    retryableOutcomes: ["failed"],
    reconciliation: "human-resume",
  },
  "human-gate": {
    kind: "human-gate",
    requires: "authored",
    // approve-reject produces nothing; free-text produces a text answer.
    produces: "authored",
    session: "none",
    preconditions: "none",
    capabilityNeeds: [],
    retryableOutcomes: [],
    reconciliation: "human-resume",
  },
  command: {
    kind: "command",
    requires: "authored",
    // A Command step always yields a verdict from its exit status and a text of
    // its captured output.
    produces: ["verdict", "text"],
    session: "none",
    preconditions: "executable-on-path",
    capabilityNeeds: [],
    retryableOutcomes: ["failed"],
    reconciliation: "reconciliation-probe",
  },
};

/** The closed set of Workspace prerequisites an authored Step may require. */
export type WorkspacePrerequisite = "git-worktree-root";
export const WORKSPACE_PREREQUISITES: readonly WorkspacePrerequisite[] = [
  "git-worktree-root",
];

/** The two reference forms a Step uses: static asset vs dynamic artifact. */
export type Reference =
  { readonly asset: string } | { readonly artifact: string };

/**
 * The Prompt slot grammar `{{artifact:name}}` as a fresh global RegExp. It is
 * substitution only: no conditionals, loops, includes, or expressions. This is
 * the single owner of the grammar — Composition validates prompts with it and
 * the executor substitutes with it, so the two can never diverge by a character
 * (a divergence used to pass Composition and fail at render). A fresh instance
 * per call keeps `lastIndex` state from leaking between `matchAll` and `replace`.
 */
export function promptSlotPattern(): RegExp {
  return /\{\{artifact:([a-zA-Z0-9._-]+)\}\}/g;
}

/**
 * Parse the Prompt slot grammar `{{artifact:name}}` out of prompt text. Returns
 * the referenced artifact names in order of appearance (with duplicates).
 */
export function promptSlotReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(promptSlotPattern())) {
    names.push(match[1]);
  }
  return names;
}

/**
 * The one generic Run-owned reference slot (#214): the executor substitutes the
 * Run's editable working area as an exact absolute directory, the only place an
 * agent is granted extra write access. It names no artifact, so it adds no
 * required binding.
 */
export const WORKING_AREA_SLOT = "{{run:working-area}}";

/**
 * A `{{...}}` sequence is a valid Prompt slot only if it is exactly
 * `{{artifact:name}}` or {@link WORKING_AREA_SLOT}. Any other `{{...}}` (an
 * expression, an unknown scheme, a malformed name) is rejected so authored
 * prompts cannot smuggle in logic.
 */
export function hasOnlyValidPromptSlots(text: string): boolean {
  const anySlot = /\{\{([^}]*)\}\}/g;
  for (const match of text.matchAll(anySlot)) {
    if (match[0] === WORKING_AREA_SLOT) continue;
    if (!/^artifact:[a-zA-Z0-9._-]+$/.test(match[1])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Authored manifest vocabulary
//
// The validated shape a Bundle manifest is written against. The Bundle Module's
// validator (bundle/manifest.ts) parses untrusted JSON into these trusted values
// at the archive ingress; the Composition check below runs over the result and
// never touches JSON, bytes, or the filesystem. The vocabulary lives here rather
// than in Bundle because it is authored value vocabulary the check must consult
// and Bundle imports Workflow, not the reverse.
// ---------------------------------------------------------------------------

/** The three supported operating systems, in canonical order. */
export type Platform = "windows" | "macos" | "linux";
export const PLATFORMS: readonly Platform[] = ["windows", "macos", "linux"];

/** The five Bundle Asset kinds. */
export type AssetKind = "prompt" | "skill" | "schema" | "script" | "resource";
export const ASSET_KINDS: readonly AssetKind[] = [
  "prompt",
  "skill",
  "schema",
  "script",
  "resource",
];

interface BundleMeta {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly authors?: readonly string[];
  readonly license?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly keywords?: readonly string[];
  readonly notices?: readonly string[];
}

export interface LaunchInput {
  readonly type: ArtifactType;
  readonly description: string;
  readonly schema?: string;
  readonly choices?: readonly string[];
}

export interface AssetDecl {
  readonly path: string;
  readonly kind: AssetKind;
}

export interface ProducedArtifact {
  readonly name: string;
  readonly type: ArtifactType;
  readonly home?: ArtifactHome;
  readonly path?: string;
}

export interface CommandInvocation {
  readonly executable: string;
  readonly arguments: readonly (string | Reference)[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string | Reference>>;
}

export interface CommandParams extends CommandInvocation {
  readonly platforms?: Readonly<Partial<Record<Platform, PlatformOverride>>>;
}
export type PlatformOverride = Partial<CommandInvocation>;

/** Select each authored field as a whole; empty arguments and env replace the base. */
export function resolveCommandInvocation({
  command,
  platform,
}: {
  readonly command: CommandParams;
  readonly platform: Platform;
}): CommandInvocation {
  const override = command.platforms?.[platform];
  return {
    executable: override?.executable ?? command.executable,
    arguments: override?.arguments ?? command.arguments,
    workingDirectory: override?.workingDirectory ?? command.workingDirectory,
    env: override?.env ?? command.env,
  };
}

interface StepCommon {
  readonly id: string;
  readonly kind: StepKindName;
  readonly requires?: readonly string[];
  readonly produces?: readonly ProducedArtifact[];
  readonly prerequisites?: readonly WorkspacePrerequisite[];
  readonly retry?: number;
  /** Composition rejects enabled Agent calls on non-interactive Steps. */
  readonly agentCompletion?: boolean | readonly ("step" | "stage")[];
  readonly stepDoneWhen?: string;
  readonly stageDoneWhen?: string;
}
export interface AgentStep extends StepCommon {
  readonly kind: "agent" | "interactive-agent";
  readonly prompt: Reference;
  readonly session: string;
  readonly uses?: readonly Reference[];
  /** interactive-agent only: send the rendered `prompt` as the Step's first Turn
   *  on entry, instead of waiting for the human to write it (#212). */
  readonly entryTurn?: boolean;
}
export interface CommandStep extends StepCommon {
  readonly kind: "command";
  readonly command: CommandParams;
}
export interface HumanGateStep extends StepCommon {
  readonly kind: "human-gate";
  readonly shape: HumanGateShape;
  readonly prompt?: Reference;
  readonly message?: string;
  /** free-text only: quick-choice answers a client offers beside an Other entry
   *  (#213). A suggestion is only a pre-filled answer — any text is still admitted. */
  readonly suggestions?: readonly string[];
}
export type Step = AgentStep | CommandStep | HumanGateStep;

interface ReviewCheckpoint {
  readonly interval: number;
  readonly message: string;
}
/** Repeats until the named Verdict reads `pass`, with a periodic Review checkpoint
 *  (ADR 0020). */
interface VerdictRepeat {
  readonly until: string;
  readonly reviewCheckpoint: ReviewCheckpoint;
  readonly steps: readonly Step[];
}
/** Repeats until a human ends the stage (#217, #218): each iteration pauses at its one
 *  interactive-agent Step, and the human's Continue is that iteration's review
 *  decision. Opted-in agent Continues pause at a periodic Review checkpoint. */
interface HumanRepeat {
  readonly control: "human";
  readonly reviewCheckpoint?: {
    readonly interval?: number;
    readonly message?: string;
  };
  readonly steps: readonly Step[];
}
export interface RepeatGroup {
  readonly repeat: VerdictRepeat | HumanRepeat;
}
export type RoutingNode = Step | RepeatGroup;

/** Whether the named Step sits inside a human-controlled Repeat group (#217): its
 *  iteration advances only by the human's Continue, never by End Step. */
export function inHumanRepeat(
  routing: readonly RoutingNode[],
  stepId: string,
): boolean {
  return humanRepeatOf(routing, stepId) !== undefined;
}

function humanRepeatOf(
  routing: readonly RoutingNode[],
  stepId: string,
): HumanRepeat | undefined {
  for (const node of routing)
    if (
      "repeat" in node &&
      "control" in node.repeat &&
      node.repeat.steps.some((step) => step.id === stepId)
    )
      return node.repeat;
  return undefined;
}

/** Resolve authored opt-in at the Step's position. Composition rejects explicit
 *  calls that are invalid there before execution or Preflight consumes them. */
export function agentCompletionCalls(
  routing: readonly RoutingNode[],
  step: Step,
): readonly ("step" | "stage")[] {
  if (step.kind !== "interactive-agent") return [];
  if (step.agentCompletion === true)
    return inHumanRepeat(routing, step.id) ? ["step", "stage"] : ["step"];
  return step.agentCompletion === false || step.agentCompletion === undefined
    ? []
    : step.agentCompletion;
}

/** The human-controlled group's resolved Review checkpoint (ADR 0032): the
 *  authored cadence of consecutive agent Continues, or 100 with no ceiling, and the
 *  authored message or Secant's. Undefined outside a human-controlled group. */
export function humanReviewCheckpoint(
  routing: readonly RoutingNode[],
  stepId: string,
): { readonly interval: number; readonly message: string } | undefined {
  const repeat = humanRepeatOf(routing, stepId);
  if (repeat === undefined) return undefined;
  const interval =
    repeat.reviewCheckpoint?.interval ?? DEFAULT_HUMAN_REVIEW_INTERVAL;
  return {
    interval,
    message:
      repeat.reviewCheckpoint?.message ??
      `The agent has continued ${interval} Iterations in a row on its own. Review the work, then Continue or End Stage.`,
  };
}

/** Unlike the Verdict form's ceiling, an author may set any larger interval. */
const DEFAULT_HUMAN_REVIEW_INTERVAL = 100;

export interface AuthoredManifest {
  readonly formatVersion: 1;
  readonly bundle: BundleMeta;
  readonly platforms?: readonly Platform[];
  readonly inputs: Readonly<Record<string, LaunchInput>>;
  readonly assets: readonly AssetDecl[];
  readonly routing: readonly RoutingNode[];
}

// ---------------------------------------------------------------------------
// Composition check (#13, #9, spec #49)
//
// Proves a validated manifest composes; it lives in the private `composition`
// submodule so the static authored vocabulary above and the check stay two
// nameable concerns. Re-exported here so callers still consult one Workflow
// entry. `flattenSteps` is the shared Step-order rule the check, the Bundle
// Execution summary, and the `bundle-catalog` focus all use.
// ---------------------------------------------------------------------------

export {
  checkComposition,
  flattenSteps,
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  routingNeedsHarness,
  type CompositionFinding,
  type TextAssets,
} from "./composition.js";
