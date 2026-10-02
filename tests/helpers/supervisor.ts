import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BreadcrumbFold,
  formatSummary,
  parseBreadcrumbs,
  summarize,
  type FailureCause,
  type OpenChild,
  type ScenarioSummary,
} from "./breadcrumbs.js";
import {
  RUNNER_ENV,
  runScenarios,
  type RunnerCase,
} from "./scenario-runner.js";
import { removeTempDir, runMain, runnerLogFolder } from "./standalone.js";

// The runner supervisor (#326, spec #313 stories 51–57): a thin parent that runs
// a standalone program's scenarios in a child process and enforces the
// per-scenario bound from outside that child's event loop, so a scenario blocked
// in synchronous child work still times out. It reads the breadcrumb file the
// scenario side appends to (scenario-runner.ts), and when a scenario fails, times
// out, or ends its process, it prints the last-active-stage summary, kills the
// scenario's process tree, removes the run's temp folder, and restarts the
// program at the next scenario. The run exits non-zero if any scenario failed.
//
// Kill reach. Off Windows the scenario process leads its own group, so killing
// that group reaches every non-detached descendant, a blocked `spawnSync` child
// included; Command and owned children lead their own groups and are reached by
// their reported PIDs. On Windows every kill is `taskkill /T /F`, and the tree
// walk needs a live parent, so the scenario process is killed while it still
// waits. A grandchild a child detached itself and never reported is out of reach.

/** How often the supervisor reads new breadcrumbs. It bounds how late a timeout
 *  or failure is noticed, never how long a scenario may run. */
const POLL_MS = 50;
/** How long the clean-up waits for killed processes to be gone before removing
 *  the temp folder: a Windows process still exiting holds its files. */
const KILL_SETTLE_MS = 5_000;

export interface SuperviseOptions {
  /** The program's name in the summary and the operational log. */
  readonly program: string;
  /** The program file the scenario process runs. */
  readonly entry: string;
  readonly args?: readonly string[];
  /** The per-scenario bound. */
  readonly boundMs: number;
  /** Defaults to `runnerLogFolder()`. */
  readonly logFolder?: string;
  /** Where the run's temp folder is made; defaults to the OS temp folder. */
  readonly tempParent?: string;
  /** The scenario process's stdout and stderr. */
  readonly output?: "inherit" | "ignore";
  /** Where summaries go; defaults to stderr. */
  readonly report?: (text: string) => void;
}

export interface SupervisedFailure {
  readonly summary: ScenarioSummary;
  /** The case the next scenario process starts at, if any remain. */
  readonly resumeAt?: number;
  /** PIDs the clean-up killed that were still alive after it waited. */
  readonly survivors: readonly number[];
}

export interface SuperviseResult {
  readonly status: 0 | 1;
  readonly failures: readonly SupervisedFailure[];
}

/** Runs a program's scenarios under the supervisor: the program itself when the
 *  environment says it is the scenario process, otherwise its supervisor. */
export function runSupervised(
  options: Pick<SuperviseOptions, "program" | "entry" | "boundMs"> & {
    readonly cases: () => readonly RunnerCase[];
  },
): void {
  if (process.env[RUNNER_ENV.breadcrumbs] !== undefined) {
    runMain(() => runScenarios(options.program, options.cases));
    return;
  }
  runMain(async () => {
    const { status } = await superviseProgram({
      ...options,
      args: process.argv.slice(2),
    });
    if (status === 0) console.log(`${options.program}: every scenario passed.`);
    process.exit(status);
  });
}

export async function superviseProgram(
  options: SuperviseOptions,
): Promise<SuperviseResult> {
  const logFolder = options.logFolder ?? runnerLogFolder();
  const report =
    options.report ?? ((text: string) => void process.stderr.write(text));
  const failures: SupervisedFailure[] = [];
  for (let startIndex = 0; ;) {
    const failure = await superviseOnce(options, logFolder, startIndex);
    if (failure === undefined) break;
    failures.push(failure);
    report(
      formatSummary(failure.summary) +
        (failure.survivors.length === 0
          ? "  clean-up:       killed the scenario's process tree and removed its temp folder\n"
          : `  clean-up:       PIDs ${failure.survivors.join(", ")} survived the kill\n`),
    );
    if (failure.resumeAt === undefined) break;
    startIndex = failure.resumeAt;
  }
  if (failures.length > 0) {
    const names = failures.map(
      ({ summary }) => summary.scenario?.scenario ?? "(outside any scenario)",
    );
    report(
      `${options.program}: ${failures.length} failed: ${names.join(", ")}\n`,
    );
  }
  return { status: failures.length === 0 ? 0 : 1, failures };
}

/** One scenario process from case `startIndex`: undefined when it ran every
 *  remaining case and exited cleanly, else the failure it stopped at, after
 *  clean-up. */
async function superviseOnce(
  options: SuperviseOptions,
  logFolder: string,
  startIndex: number,
): Promise<SupervisedFailure | undefined> {
  const root = mkdtempSync(
    join(options.tempParent ?? tmpdir(), "secant-runner-"),
  );
  try {
    // Every temp folder the scenario or its children make lands under `temp`.
    const temp = join(root, "tmp");
    mkdirSync(temp);
    const file = join(root, "breadcrumbs.jsonl");
    writeFileSync(file, "");
    const output = options.output ?? "inherit";
    const child = spawn(
      process.execPath,
      [options.entry, ...(options.args ?? [])],
      {
        env: {
          ...process.env,
          TMPDIR: temp,
          TEMP: temp,
          TMP: temp,
          [RUNNER_ENV.breadcrumbs]: file,
          [RUNNER_ENV.logFolder]: logFolder,
          [RUNNER_ENV.startIndex]: String(startIndex),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", output, output],
        windowsHide: true,
      },
    );
    let ended:
      | { readonly status: number | null; readonly signal: string | null }
      | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once("exit", (status, signal) => {
        ended = { status, signal };
        resolve();
      });
      child.once("error", () => {
        ended ??= { status: null, signal: null };
        resolve();
      });
    });

    const fold = new BreadcrumbFold();
    const reader = breadcrumbReader(file);
    let cause: FailureCause;
    for (;;) {
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, POLL_MS)),
      ]);
      for (const crumb of reader()) fold.apply(crumb);
      const open = fold.open;
      if (open?.status === "failed") {
        cause = { kind: "failed" };
        break;
      }
      if (ended !== undefined) {
        if (ended.status === 0 && open === undefined) return undefined;
        cause = { kind: "exited", ...ended };
        break;
      }
      if (open !== undefined && Date.now() - open.since >= options.boundMs) {
        cause = { kind: "timed-out", boundMs: options.boundMs };
        break;
      }
    }

    const summary = summarize(
      options.program,
      fold,
      cause,
      logFolder,
      Date.now(),
    );
    const children = summary.scenario?.children ?? [];
    const survivors = await killScenarioTree(
      child.pid,
      ended === undefined,
      children,
      exited,
    );
    // After a scenario, the next one; after a crash between scenarios, the one
    // after the last that passed. A crash before any scenario ends the run.
    const next = summary.scenario?.index ?? fold.lastPassed;
    const resumeAt =
      next === undefined || fold.total === undefined || next + 1 >= fold.total
        ? undefined
        : next + 1;
    return {
      summary,
      survivors,
      ...(resumeAt === undefined ? {} : { resumeAt }),
    };
  } finally {
    await removeTempDir(root);
  }
}

/** Reads the breadcrumbs appended since the last call. */
function breadcrumbReader(
  file: string,
): () => ReturnType<typeof parseBreadcrumbs>["crumbs"] {
  let offset = 0;
  return () => {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return [];
      const bytes = new Uint8Array(size - offset);
      const read = readSync(fd, bytes, 0, bytes.length, offset);
      const { crumbs, consumed } = parseBreadcrumbs(bytes.subarray(0, read));
      offset += consumed;
      return crumbs;
    } finally {
      closeSync(fd);
    }
  };
}

/** Kills each open child's own group or tree by its reported PID, then the
 *  scenario process's tree, and waits for them to be gone. Returns the PIDs still
 *  alive after that wait. The reported PIDs go first: while the scenario process
 *  lives it holds its children unreaped (and on Windows their handles open), so
 *  none of those PIDs can yet name an unrelated, reused process. */
async function killScenarioTree(
  scenarioPid: number | undefined,
  scenarioAlive: boolean,
  children: readonly OpenChild[],
  exited: Promise<void>,
): Promise<number[]> {
  const pids = children.flatMap((child) =>
    child.pid === undefined ? [] : [child.pid],
  );
  for (const pid of pids) {
    if (process.platform === "win32") taskkill(pid);
    else {
      killPosixGroup(pid);
      killPosix(pid);
    }
  }
  if (scenarioPid !== undefined) {
    // Off Windows the group outlives its leader, so it is killed even after the
    // scenario process ended; Windows needs the live parent.
    if (process.platform !== "win32") killPosixGroup(scenarioPid);
    else if (scenarioAlive) taskkill(scenarioPid);
  }
  const deadline = Date.now() + KILL_SETTLE_MS;
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, KILL_SETTLE_MS)),
  ]);
  const survivors: number[] = [];
  for (const pid of pids) {
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    if (isAlive(pid)) survivors.push(pid);
  }
  return survivors;
}

function killPosixGroup(pid: number): void {
  killPosix(-pid);
}

function killPosix(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // Already gone, a PID that leads no group, or a reused PID this user does
    // not own: none is this run's to kill.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

function taskkill(pid: number): void {
  // A not-found exit means the process had already ended.
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

/** Whether `pid` names a live process; a process this user cannot signal is
 *  still alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
