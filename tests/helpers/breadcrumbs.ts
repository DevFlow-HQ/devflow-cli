import type { ChildFact } from "../../src/process/process.js";

// The standalone runner programs' breadcrumbs (#326, spec #313 stories 51–57):
// what a scenario process reports, synchronously, about where it is, and the
// last-active-stage summary built from them. The scenario side appends each one
// as a JSON line to the breadcrumb file before the work it names can block; the
// supervisor (supervisor.ts) folds the file while the scenario runs, and an
// unsupervised program folds the same breadcrumbs in-process. This module is
// process-free so the fold and summary have a semantic unit test.

/** One breadcrumb. `at` is the scenario process's wall clock in milliseconds,
 *  which the supervisor on the same host shares. */
export type Breadcrumb =
  | {
      readonly type: "program-start";
      readonly total?: number;
      readonly at: number;
    }
  | {
      readonly type: "scenario-start";
      readonly index: number;
      readonly scenario: string;
      readonly at: number;
    }
  | {
      readonly type: "scenario-end";
      readonly index: number;
      readonly scenario: string;
      readonly status: "passed" | "failed";
      readonly at: number;
    }
  | {
      readonly type: "stage-start";
      readonly stage: string;
      readonly at: number;
    }
  | {
      readonly type: "stage-end";
      readonly stage: string;
      readonly status: "passed" | "failed";
      readonly at: number;
    }
  | {
      readonly type: "program-ready";
      readonly total: number;
      readonly at: number;
    }
  | { readonly type: "program-end"; readonly at: number }
  | { readonly type: "child"; readonly fact: ChildFact; readonly at: number };

/** A child with a `spawn` fact and no settlement yet. A synchronous spawn names
 *  its role before it blocks and its PID only once it returns, so a child still
 *  blocking the scenario has no PID. */
export interface OpenChild {
  readonly role: ChildFact["role"];
  readonly pid?: number;
  readonly since: number;
  /** The kill Secant last started on it, if any. */
  readonly kill?: "timeout" | "cancellation" | "kill-escalation";
}

interface OpenStage {
  readonly stage: string;
  readonly since: number;
  readonly failed?: true;
}

export interface OpenScenario {
  readonly index: number;
  readonly scenario: string;
  readonly since: number;
  readonly status?: "failed";
  /** Open stages, outermost first. A stage that threw stays until the scenario
   *  moves on, so a failed scenario names where it stopped. */
  readonly stages: readonly OpenStage[];
  /** Children open in this scenario process that have not settled, including
   *  any an earlier, passing scenario left open. */
  readonly children: readonly OpenChild[];
}

/** The bounded work outside a scenario, including setup and finalization. */
interface ProgramGap {
  readonly phase: "program-start" | "between-scenarios" | "program-end";
  readonly since: number;
  readonly stages: readonly OpenStage[];
  readonly children: readonly OpenChild[];
}

/** The fold of a scenario process's breadcrumbs: its case count, active scenario
 *  or program gap, and every child not yet settled. */
export class BreadcrumbFold {
  total: number | undefined;
  completed = false;
  /** The last scenario that passed: where a supervisor resumes after the
   *  process ends outside any scenario. */
  lastPassed: number | undefined;
  private current: Mutable<OpenScenario> | undefined;
  private carried: OpenChild[] = [];
  private gapSince: number;
  private gapPhase: ProgramGap["phase"] = "program-start";
  private gapStages: OpenStage[] = [];

  constructor(startedAt = Date.now()) {
    this.gapSince = startedAt;
  }

  get since(): number {
    return this.current?.since ?? this.gapSince;
  }

  get gap(): ProgramGap | undefined {
    return this.current === undefined
      ? {
          phase: this.gapPhase,
          since: this.gapSince,
          stages: this.gapStages,
          children: this.carried,
        }
      : undefined;
  }

  get open(): OpenScenario | undefined {
    return this.current;
  }

  get children(): readonly OpenChild[] {
    return this.current?.children ?? this.carried;
  }

  apply(crumb: Breadcrumb): void {
    switch (crumb.type) {
      case "program-start":
        this.total = crumb.total;
        // Include process startup before its first breadcrumb in this bound.
        this.gapSince = Math.min(this.gapSince, crumb.at);
        return;
      case "program-ready":
        this.total = crumb.total;
        if (crumb.total === 0) {
          this.gapPhase = "program-end";
          this.gapSince = crumb.at;
          this.gapStages = [];
        }
        return;
      case "scenario-start":
        this.current = {
          index: crumb.index,
          scenario: crumb.scenario,
          since: crumb.at,
          stages: [],
          children: this.carried,
        };
        this.carried = [];
        this.gapStages = [];
        return;
      case "scenario-end":
        if (crumb.status === "failed" && this.current !== undefined) {
          // A failed scenario stays open: its stages and children are what the
          // summary reports and the clean-up kills.
          this.current.status = "failed";
          return;
        }
        this.lastPassed = crumb.index;
        // A child a passing scenario left open is still this process's to kill.
        this.carried = this.current?.children ?? [];
        this.current = undefined;
        this.gapSince = crumb.at;
        this.gapPhase =
          this.total !== undefined && crumb.index + 1 >= this.total
            ? "program-end"
            : "between-scenarios";
        this.gapStages = [];
        return;
      case "stage-start": {
        const stages = this.current?.stages ?? this.gapStages;
        dropCaughtFailures(stages);
        stages.push({ stage: crumb.stage, since: crumb.at });
        return;
      }
      case "stage-end": {
        const stages = this.current?.stages ?? this.gapStages;
        // A throw unwinding several stages marks each; they stay open as the
        // place the scenario stopped until it starts or ends another stage.
        if (crumb.status === "passed") dropCaughtFailures(stages);
        const at = lastIndex(stages, (open) => open.stage === crumb.stage);
        if (at < 0) return;
        if (crumb.status === "failed")
          stages[at] = { ...stages[at]!, failed: true };
        else stages.splice(at, 1);
        return;
      }
      case "program-end":
        this.completed = true;
        return;
      case "child":
        applyChild(
          this.current?.children ?? this.carried,
          crumb.fact,
          crumb.at,
        );
        return;
    }
  }
}

/** A scenario that goes on after a stage threw caught that failure. */
function dropCaughtFailures(stages: OpenStage[]): void {
  while (stages.at(-1)?.failed) stages.pop();
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K];
};

function applyChild(children: OpenChild[], fact: ChildFact, at: number): void {
  const pid = "pid" in fact ? fact.pid : undefined;
  switch (fact.kind) {
    case "spawn":
      children.push({ role: fact.role, pid, since: at });
      return;
    case "timeout":
    case "cancellation":
    case "kill-escalation": {
      const index = children.findIndex((child) => child.pid === fact.pid);
      if (index >= 0)
        children[index] = { ...children[index]!, kill: fact.kind };
      return;
    }
    case "spawn-error":
    case "exit":
    case "reap": {
      // An asynchronous child settles by its PID. A synchronous one started with
      // no PID, and synchronous spawns nest, so it is the latest PID-less child of
      // its role; an asynchronous spawn error had no start at all.
      let index =
        pid === undefined
          ? -1
          : children.findIndex((child) => child.pid === pid);
      if (index < 0) {
        index = lastIndex(
          children,
          (child) => child.pid === undefined && child.role === fact.role,
        );
      }
      if (index >= 0) children.splice(index, 1);
      return;
    }
  }
}

function lastIndex<T>(
  items: readonly T[],
  match: (item: T) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (match(items[index]!)) return index;
  }
  return -1;
}

/** Why a supervised scenario ended the run. */
export type FailureCause =
  | { readonly kind: "failed" }
  | { readonly kind: "timed-out"; readonly boundMs: number }
  | {
      readonly kind: "exited";
      readonly status: number | null;
      readonly signal: string | null;
    };

/** The last-active-stage summary of one failed or timed-out scenario. */
export interface ScenarioSummary {
  readonly program: string;
  /** Undefined when the program stopped outside every scenario. */
  readonly scenario?: OpenScenario;
  readonly gap?: ProgramGap;
  readonly total?: number;
  readonly cause: FailureCause;
  readonly elapsedMs: number;
  readonly logFolder: string;
  /** When the failure was seen; open times are measured to it. */
  readonly at: number;
}

export function summarize(
  program: string,
  fold: BreadcrumbFold,
  cause: FailureCause,
  logFolder: string,
  now: number,
): ScenarioSummary {
  const scenario = fold.open;
  return {
    program,
    ...(scenario === undefined ? { gap: fold.gap } : { scenario }),
    ...(fold.total === undefined ? {} : { total: fold.total }),
    cause,
    elapsedMs: now - fold.since,
    logFolder,
    at: now,
  };
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function describeCause(cause: FailureCause): string {
  switch (cause.kind) {
    case "failed":
      return "threw (its stack is above)";
    case "timed-out":
      return `did not settle within ${cause.boundMs / 1000} seconds`;
    case "exited":
      return cause.signal === null
        ? `ended its process with status ${cause.status}`
        : `ended its process by ${cause.signal}`;
  }
}

function describeChild(child: OpenChild, now: number): string {
  const pid =
    child.pid === undefined
      ? "PID unknown (synchronous spawn still blocking)"
      : `PID ${child.pid}`;
  const kill = child.kill === undefined ? "" : `, ${child.kill} started`;
  return `${child.role} ${pid}, open ${seconds(now - child.since)}${kill}`;
}

/** The summary as the supervisor prints it: scenario, open stage, open child
 *  roles and PIDs, elapsed time, and the log folder to open. */
export function formatSummary(summary: ScenarioSummary): string {
  const { scenario, at: now } = summary;
  const lines: string[] = [];
  if (scenario === undefined) {
    lines.push(
      `FAILED ${summary.program}: the program ${describeCause(summary.cause)} outside any scenario`,
    );
  } else {
    const position =
      summary.total === undefined
        ? `#${scenario.index + 1}`
        : `#${scenario.index + 1} of ${summary.total}`;
    lines.push(
      `FAILED ${scenario.scenario} (${summary.program} ${position}): ${describeCause(summary.cause)}`,
    );
  }
  const activity = scenario ?? summary.gap;
  if (scenario === undefined && summary.gap !== undefined) {
    lines.push(`  program phase:  ${summary.gap.phase}`);
  }
  const stage = activity?.stages.at(-1);
  lines.push(
    `  open stage:     ${stage === undefined ? "none" : `${activity!.stages.map((open) => open.stage).join(" > ")}, open ${seconds(now - stage.since)}`}`,
  );
  const children = activity?.children ?? [];
  lines.push(
    `  open children:  ${children.length === 0 ? "none reported" : describeChild(children[0]!, now)}`,
  );
  for (const child of children.slice(1)) {
    lines.push(`                  ${describeChild(child, now)}`);
  }
  lines.push(`  elapsed:        ${seconds(summary.elapsedMs)}`);
  lines.push(`  log folder:     ${summary.logFolder}`);
  return `${lines.join("\n")}\n`;
}

/** Parses the complete lines of breadcrumb-file bytes, returning the breadcrumbs
 *  and how many bytes they spanned; a final line still being written is left for
 *  the next read. */
export function parseBreadcrumbs(bytes: Uint8Array): {
  readonly crumbs: Breadcrumb[];
  readonly consumed: number;
} {
  const end = bytes.lastIndexOf(0x0a) + 1;
  const crumbs = new TextDecoder()
    .decode(bytes.subarray(0, end))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Breadcrumb);
  return { crumbs, consumed: end };
}
