import { openSync, writeSync } from "node:fs";
import { runRunnerInvocation } from "../../src/composition/main.js";
import {
  BreadcrumbFold,
  formatSummary,
  summarize,
  type Breadcrumb,
} from "./breadcrumbs.js";
import { installBreadcrumbRecorder, runnerLogFolder } from "./standalone.js";

// The scenario side of a standalone runner program (#326, spec #313 stories
// 51–57). It runs the program's cases in order and records each scenario and
// stage start and end, and each child fact, three ways: synchronously to the
// breadcrumb file the supervisor reads (only when supervised), to the operational
// log as one `runner` Secant invocation, and to an in-process fold. Every write
// lands before the work it names starts, so a synchronous spawn that then blocks
// the event loop is already on record.

/** The environment a supervisor hands its scenario process. */
export const RUNNER_ENV = {
  breadcrumbs: "SECANT_RUNNER_BREADCRUMBS",
  logFolder: "SECANT_RUNNER_LOG_DIR",
  startIndex: "SECANT_RUNNER_START_INDEX",
} as const;

export interface RunnerCase {
  readonly name: string;
  readonly body: () => unknown;
}

/** Runs `program`'s cases and exits with its status. Supervised, it starts at the
 *  supervisor's index, and a failed scenario waits for the supervisor to kill
 *  its tree: on Windows a tree kill walks down from a live parent, so the
 *  scenario must not exit first. Unsupervised, as terminal lifecycle runs, a
 *  failure prints the summary and ends the program. `cases` is called only here,
 *  so a supervisor that imports the same program never builds its fixtures. */
export async function runScenarios(
  program: string,
  cases: () => readonly RunnerCase[],
): Promise<never> {
  const file = process.env[RUNNER_ENV.breadcrumbs];
  const logFolder = process.env[RUNNER_ENV.logFolder] ?? runnerLogFolder();
  const startIndex = Number(process.env[RUNNER_ENV.startIndex] ?? "0");
  const fd = file === undefined ? undefined : openSync(file, "a");
  const fold = new BreadcrumbFold();
  const write = (crumb: Breadcrumb) => {
    fold.apply(crumb);
    if (fd !== undefined) writeSync(fd, `${JSON.stringify(crumb)}\n`);
  };

  const status = await runRunnerInvocation(
    program,
    { folder: logFolder },
    async (log) => {
      let scenario = "";
      installBreadcrumbRecorder({
        stageStart(stage) {
          write({ type: "stage-start", stage, at: Date.now() });
          log.breadcrumb({ kind: "stage-start", scenario, stage });
        },
        stageEnd(stage, stageStatus, elapsedMs) {
          write({
            type: "stage-end",
            stage,
            status: stageStatus,
            at: Date.now(),
          });
          log.breadcrumb({
            kind: "stage-end",
            scenario,
            stage,
            status: stageStatus,
            elapsedMs,
          });
        },
        child(fact) {
          write({ type: "child", fact, at: Date.now() });
          log.processOptions.observeChild?.(fact);
        },
      });

      const list = cases();
      write({ type: "program-start", total: list.length, at: Date.now() });
      for (let index = startIndex; index < list.length; index++) {
        const { name, body } = list[index]!;
        scenario = name;
        write({ type: "scenario-start", index, scenario, at: Date.now() });
        log.breadcrumb({ kind: "scenario-start", scenario });
        const started = performance.now();
        try {
          await body();
        } catch (error) {
          write({
            type: "scenario-end",
            index,
            scenario,
            status: "failed",
            at: Date.now(),
          });
          log.breadcrumb({
            kind: "scenario-end",
            scenario,
            status: "failed",
            elapsedMs: performance.now() - started,
          });
          process.stderr.write(
            `${name} threw:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
          );
          if (fd !== undefined) return awaitSupervisorKill();
          const now = Date.now();
          process.stderr.write(
            formatSummary(
              summarize(program, fold, { kind: "failed" }, logFolder, now),
            ),
          );
          return 1;
        }
        write({
          type: "scenario-end",
          index,
          scenario,
          status: "passed",
          at: Date.now(),
        });
        log.breadcrumb({
          kind: "scenario-end",
          scenario,
          status: "passed",
          elapsedMs: performance.now() - started,
        });
        console.log(`  ok  ${name}`);
      }
      return 0;
    },
  );
  // A supervised program's supervisor reports the run's outcome.
  if (status === 0 && fd === undefined) {
    console.log(`${program}: every scenario passed.`);
  }
  // Explicit, so a handle a passing scenario left open cannot hold the run.
  process.exit(status);
}

/** Never settles: the supervisor that saw the failed scenario kills this tree.
 *  Should the supervisor itself die first, the orphaned scenario notices its
 *  parent change and exits rather than linger (POSIX; Windows keeps the PID). */
function awaitSupervisorKill(): Promise<number> {
  const parent = process.ppid;
  return new Promise((resolve) => {
    const watch = setInterval(() => {
      if (process.ppid === parent) return;
      clearInterval(watch);
      resolve(1);
    }, 1_000);
  });
}
