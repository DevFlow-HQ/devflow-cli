import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChildFact,
  ProcessAdapterOptions,
} from "../../src/process/process.js";

// Shared helpers for the framework-free runner programs (the terminal-lifecycle
// suite and the runtime-conformance suite). These are ordinary Bun programs, not
// `node:test` suites, so they own their own timeouts, process exit, and temp-dir
// cleanup. This module registers no `node:test` hook, so it is safe to
// import from a standalone program. It also stays free of composition, so the
// test-runner suites that reach it through tempDir.ts load nothing more: the
// scenario runner (scenario-runner.ts) installs the breadcrumb recorder that
// `stage` and `withRunnerObserver` report to, and outside one they do nothing.

/** Where a runner program's stage breadcrumbs and child facts go. */
export interface BreadcrumbRecorder {
  stageStart(stage: string): void;
  stageEnd(stage: string, status: "passed" | "failed", elapsedMs: number): void;
  child(fact: ChildFact): void;
}

let recorder: BreadcrumbRecorder | undefined;

/** Installs the running program's recorder; only the scenario runner calls it. */
export function installBreadcrumbRecorder(next: BreadcrumbRecorder): void {
  recorder = next;
}

/** Runs `body` as one named stage of the current scenario, recording its start
 *  before `body` runs (so a block inside it still names the stage) and its end
 *  when `body` returns or its promise settles. A stage that throws stays the
 *  scenario's open stage in the summary. */
export function stage<T>(name: string, body: () => T): T {
  const current = recorder;
  if (current === undefined) return body();
  const started = performance.now();
  const end = (status: "passed" | "failed") =>
    current.stageEnd(name, status, performance.now() - started);
  current.stageStart(name);
  let result: T;
  try {
    result = body();
  } catch (error) {
    end("failed");
    throw error;
  }
  if (!(result instanceof Promise)) {
    end("passed");
    return result;
  }
  return result.then(
    (value: unknown) => {
      end("passed");
      return value;
    },
    (error: unknown) => {
      end("failed");
      throw error;
    },
  ) as T;
}

/** Process factory options that report every child fact to the running
 *  program's recorder, and then to the case's own observer if it has one. Every
 *  real Process a runner program builds takes these, so the supervisor sees the
 *  child's role and PID before a synchronous spawn blocks. */
export function withRunnerObserver(
  options: ProcessAdapterOptions = {},
): ProcessAdapterOptions {
  const own = options.observeChild;
  return {
    ...options,
    observeChild: (fact) => {
      recorder?.child(fact);
      own?.(fact);
    },
  };
}

/** The operational-log folder a runner program writes to and its summary names:
 *  the inherited `SECANT_LOG_DIR`, which CI sets for every gated job and uploads
 *  on failure, or else one shared folder under the OS temp folder, which the log
 *  sink prunes and no runner clean-up removes. */
export function runnerLogFolder(): string {
  return (
    process.env.SECANT_LOG_DIR?.trim() || join(tmpdir(), "secant-runner-logs")
  );
}

/** Race a promise against a timeout that rejects with `message`: an inner bound,
 *  such as terminal lifecycle's exit wait. It cannot fire while a synchronous
 *  spawn blocks the event loop, so the runtime-conformance scenario bound is the
 *  supervisor's (supervisor.ts), not this. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Run a standalone program's `main` and exit non-zero on any rejection, printing
 *  the stack. A runner owns its process exit; a test-runner suite never calls this. */
export function runMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}

/** Best-effort recursive removal that retries the transient Windows lock codes: a
 *  just-closed bun:sqlite catalog can briefly report EBUSY/EPERM/ENOTEMPTY (#64).
 *  Cleanup stays best-effort; the OS eventually reclaims a leftover temp dir. */
export async function removeTempDir(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt >= 20) {
        process.stderr.write(
          `warning: could not remove temp dir ${directory}: ${String(error)}\n`,
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
