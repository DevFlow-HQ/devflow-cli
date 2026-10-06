import type {
  HarnessFailure,
  PreparationCleanupReport,
  PreparationCloseOptions,
  PrepareOptions,
  PrepareResult,
} from "./harness.js";
import type {
  OwnedProcess,
  OwnedProcessClose,
  ProcessAdapter,
} from "../process/process.js";
import { redactSecrets } from "./secrets.js";
import { translateCause, type SafeCause } from "./safe-cause.js";

export interface InitialPreparation {
  failed(failure: HarnessFailure): void;
  cleanupFailed(failure: HarnessFailure): void;
  remainingMs(): number;
}

export interface PreparationClock {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

interface Resource {
  readonly id: number;
  process:
    | { readonly kind: "owned"; readonly value: OwnedProcess }
    | { readonly kind: "closed" };
  cleanup:
    | { readonly kind: "none" }
    | { readonly kind: "pending"; readonly promise: Promise<OwnedProcessClose> }
    | { readonly kind: "settled"; readonly receipt: OwnedProcessClose };
}

interface Preparation {
  readonly id: number;
  readonly abort: AbortController;
  readonly resources: Resource[];
  readonly cleanupFailures: HarnessFailure[];
  readonly changed: () => void;
  pending: boolean;
  handedOff: boolean;
  reporting: boolean;
  startupFailure?: HarnessFailure;
}

/** Invocation owner before the exclusive successful handoff. Process wrapping
 * applies only to initial acquisition; after handoff every call passes through. */
export class PreparationOwner {
  private readonly preparations = new Set<Preparation>();
  private nextId = 0;
  private deadline: number | undefined;
  private closing: Promise<PreparationCleanupReport> | undefined;
  private notify: () => void = () => {};
  private captureDeadline: (() => void) | undefined;

  constructor(
    private readonly clock: PreparationClock = {
      now: () => performance.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      },
    },
  ) {}

  prepare(
    options: PrepareOptions,
    acquire: (
      options: PrepareOptions,
      initial: InitialPreparation,
    ) => Promise<PrepareResult>,
  ): Promise<PrepareResult> {
    if (this.closing !== undefined)
      return Promise.resolve(refused("preparation-closed"));
    const preparation: Preparation = {
      id: ++this.nextId,
      abort: new AbortController(),
      resources: [],
      cleanupFailures: [],
      changed: () => this.notify(),
      pending: true,
      handedOff: false,
      reporting: true,
    };
    // Registration precedes even discovery and an already-aborted caller signal.
    this.preparations.add(preparation);
    const cancel = () => {
      preparation.abort.abort();
      this.cleanup(preparation);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const scoped: PrepareOptions = {
      ...options,
      signal: preparation.abort.signal,
      process: this.scopedProcess(options.process, preparation),
      phases:
        options.phases === undefined
          ? undefined
          : (fact) => {
              if (preparation.reporting) options.phases?.(fact);
            },
      containment:
        options.containment === undefined
          ? undefined
          : (fact) => {
              if (preparation.reporting) options.containment?.(fact);
            },
    };
    return this.acquire(preparation, scoped, acquire).finally(() => {
      options.signal?.removeEventListener("abort", cancel);
    });
  }

  private async acquire(
    preparation: Preparation,
    options: PrepareOptions,
    acquire: (
      options: PrepareOptions,
      initial: InitialPreparation,
    ) => Promise<PrepareResult>,
  ): Promise<PrepareResult> {
    try {
      if (preparation.abort.signal.aborted)
        return refused("preparation-cancelled");
      const result = await acquire(options, {
        failed: (failure) => {
          this.beforeObservation();
          if (!preparation.abort.signal.aborted)
            preparation.startupFailure ??= failure;
        },
        cleanupFailed: (failure) => {
          this.beforeObservation();
          preparation.cleanupFailures.push(failure);
          preparation.changed();
        },
        remainingMs: () => this.remaining(),
      });
      this.beforeObservation();
      // No await between the cancellation check and exclusive transfer.
      if (result.ok && !preparation.abort.signal.aborted) {
        preparation.handedOff = true;
        this.preparations.delete(preparation);
        return result;
      }
      if (
        !result.ok &&
        preparation.startupFailure === undefined &&
        !preparation.abort.signal.aborted
      ) {
        preparation.startupFailure = result.failure;
      }
      if (
        !result.ok &&
        preparation.startupFailure?.category === result.failure.category
      ) {
        preparation.startupFailure = result.failure;
      }
      this.cleanup(preparation);
      return preparation.startupFailure === undefined
        ? refused("preparation-cancelled")
        : { ok: false, failure: preparation.startupFailure };
    } catch (cause) {
      this.beforeObservation();
      preparation.startupFailure ??= {
        phase: "prepare",
        category: "prepare-exception",
        possibleEffects: "none",
        cause: redactSecrets(cause),
      };
      this.cleanup(preparation);
      // Unexpected construction failures still retain acquired resources.
      throw cause;
    } finally {
      this.beforeObservation();
      preparation.pending = false;
      preparation.changed();
      this.release(preparation);
    }
  }

  close(
    options: PreparationCloseOptions = {},
  ): Promise<PreparationCleanupReport> {
    if (this.closing !== undefined) return this.closing;
    this.deadline = options.deadline ?? this.clock.now() + 5000;
    const result = Promise.withResolvers<PreparationCleanupReport>();
    // Close admission before cancelling anything; abort listeners may re-enter.
    this.closing = result.promise;
    for (const preparation of this.preparations) {
      preparation.abort.abort();
      this.cleanup(preparation);
    }
    void this.reportAtDeadline().then(result.resolve, result.reject);
    return this.closing;
  }

  private reportAtDeadline(): Promise<PreparationCleanupReport> {
    const result = Promise.withResolvers<PreparationCleanupReport>();
    let captured = false;
    let cancelTimer: (() => void) | undefined;
    const capture = () => {
      if (captured) return;
      captured = true;
      cancelTimer?.();
      this.notify = () => {};
      this.captureDeadline = undefined;
      // Snapshot in the deadline callback itself, before later exit or
      // acquisition microtasks can change the deadline's observations.
      result.resolve(this.captureReport());
    };
    this.captureDeadline = capture;
    this.notify = () => {
      if (!this.unresolved()) capture();
    };
    if (this.remaining() === 0 || !this.unresolved()) capture();
    else {
      cancelTimer = this.clock.schedule(capture, this.remaining());
      if (captured) cancelTimer();
    }
    return result.promise;
  }

  /** Event-loop delays cannot let an observation made after the nominal bound
   * enter the report, even when it runs before the scheduled timer callback. */
  private beforeObservation(): void {
    if (this.deadline !== undefined && this.clock.now() >= this.deadline)
      this.captureDeadline?.();
  }

  private captureReport(): PreparationCleanupReport {
    const preparations = Array.from(this.preparations, (preparation) => {
      // Late results remain owned but cannot call the invocation's closed sinks.
      preparation.reporting = false;
      const unresolved: PreparationCleanupReport["preparations"][number]["unresolved"][number][] =
        [];
      if (preparation.pending)
        unresolved.push(Object.freeze({ kind: "preparation-pending" }));
      for (const resource of preparation.resources) {
        if (resource.process.kind === "owned")
          unresolved.push(
            Object.freeze({
              kind: "closure-unconfirmed",
              resource: resource.id,
            }),
          );
      }
      return Object.freeze({
        preparation: preparation.id,
        ...(preparation.startupFailure === undefined
          ? {}
          : { startupFailure: snapshotFailure(preparation.startupFailure) }),
        cleanupFailures: Object.freeze(
          preparation.cleanupFailures.map(snapshotFailure),
        ),
        unresolved: Object.freeze(unresolved),
      });
    });
    const report: PreparationCleanupReport = Object.freeze({
      status: preparations.some((entry) => entry.unresolved.length > 0)
        ? "unresolved"
        : "closed",
      preparations: Object.freeze(preparations),
    });
    // Confirmed failed preparations need no private resource retention. Keep
    // pending/unconfirmed ones until their independent final lifetime settles.
    for (const preparation of this.preparations) this.release(preparation);
    return report;
  }

  private unresolved(): boolean {
    return Array.from(this.preparations).some(
      (preparation) =>
        preparation.pending ||
        preparation.resources.some(
          (resource) => resource.process.kind === "owned",
        ),
    );
  }

  private remaining(): number {
    return Math.max(
      0,
      (this.deadline ?? this.clock.now() + 5000) - this.clock.now(),
    );
  }

  private cleanup(preparation: Preparation): void {
    if (preparation.handedOff) return;
    for (const resource of preparation.resources) {
      if (resource.process.kind === "owned")
        void this.stop(
          preparation,
          resource,
          resource.process.value,
          this.remaining(),
        );
    }
  }

  private stop(
    preparation: Preparation,
    resource: Resource,
    process: OwnedProcess,
    timeoutMs: number,
  ): Promise<OwnedProcessClose> {
    if (resource.cleanup.kind === "pending") return resource.cleanup.promise;
    if (resource.cleanup.kind === "settled")
      return Promise.resolve(resource.cleanup.receipt);
    const cleanup = Promise.resolve()
      .then(() => process.closeStdin(Math.min(timeoutMs, this.remaining())))
      .then(
        (close) => {
          this.beforeObservation();
          if (
            close.kind === "cleanup-error" ||
            close.kind === "cleanup-timeout"
          ) {
            preparation.cleanupFailures.push({
              phase: "cleanup",
              category: close.kind,
              possibleEffects: "none",
              diagnostics:
                "Initial Harness resource closure was not confirmed.",
              ...(close.kind === "cleanup-error"
                ? { cause: redactSecrets(close.cause) }
                : {}),
            });
          }
          resource.cleanup = { kind: "settled", receipt: close };
          preparation.changed();
          return close;
        },
        (cause): OwnedProcessClose => {
          this.beforeObservation();
          const safe = redactSecrets(cause);
          preparation.cleanupFailures.push({
            phase: "cleanup",
            category: "cleanup-error",
            possibleEffects: "none",
            cause: safe,
          });
          const receipt = {
            kind: "cleanup-error",
            cause: safe,
          } satisfies OwnedProcessClose;
          resource.cleanup = { kind: "settled", receipt };
          preparation.changed();
          return receipt;
        },
      );
    resource.cleanup = { kind: "pending", promise: cleanup };
    return cleanup;
  }

  private release(preparation: Preparation): void {
    if (
      !preparation.reporting &&
      !preparation.pending &&
      preparation.resources.every(
        (resource) => resource.process.kind === "closed",
      )
    ) {
      this.preparations.delete(preparation);
    }
  }

  private scopedProcess(
    process: ProcessAdapter,
    preparation: Preparation,
  ): ProcessAdapter {
    return {
      resolveExecutable: (name, options) =>
        process.resolveExecutable(name, options),
      spawnCommandSync: (options) => process.spawnCommandSync(options),
      spawnCommand: (options) =>
        preparation.abort.signal.aborted && !preparation.handedOff
          ? Promise.resolve({ kind: "cancelled" })
          : process.spawnCommand({
              ...options,
              cancelSignal: preparation.handedOff
                ? options.cancelSignal
                : options.cancelSignal === undefined
                  ? preparation.abort.signal
                  : AbortSignal.any([
                      options.cancelSignal,
                      preparation.abort.signal,
                    ]),
            }),
      spawnOwnedProcess: async (options) => {
        if (preparation.abort.signal.aborted && !preparation.handedOff) {
          return {
            ok: false,
            failure: {
              kind: "spawn-error",
              cause: new Error("Initial preparation was cancelled."),
            },
          };
        }
        const spawned = await process.spawnOwnedProcess(options);
        if (!spawned.ok || preparation.handedOff) return spawned;
        this.beforeObservation();
        const resource: Resource = {
          id: preparation.resources.length + 1,
          process: { kind: "owned", value: spawned.process },
          cleanup: { kind: "none" },
        };
        preparation.resources.push(resource);
        const owned = spawned.process;
        void owned.closed().then(
          (close) => {
            this.beforeObservation();
            if (
              close.kind === "exited" ||
              close.kind === "signal" ||
              close.kind === "spawn-error"
            ) {
              // Keep failure/id metadata for the final report, never the
              // confirmed child's native handle.
              resource.process = { kind: "closed" };
            }
            preparation.changed();
            this.release(preparation);
          },
          () => {
            preparation.changed();
          },
        );
        if (preparation.abort.signal.aborted) this.cleanup(preparation);
        return {
          ...spawned,
          process: {
            stdout: owned.stdout,
            stderr: owned.stderr,
            writeStdin: (bytes) => owned.writeStdin(bytes),
            closed: () => owned.closed(),
            interrupt: (gracefulMs) => owned.interrupt(gracefulMs),
            closeStdin: (timeoutMs) =>
              preparation.handedOff
                ? owned.closeStdin(timeoutMs)
                : this.stop(preparation, resource, owned, timeoutMs),
          },
        };
      },
    };
  }
}

function refused(
  category: "preparation-closed" | "preparation-cancelled",
): PrepareResult {
  return {
    ok: false,
    failure: {
      phase: "prepare",
      category,
      possibleEffects: "none",
      diagnostics:
        category === "preparation-closed"
          ? "Harness preparation admission is closed."
          : "Harness preparation was cancelled before handoff.",
    },
  };
}

function snapshotFailure(
  failure: HarnessFailure,
): NonNullable<
  PreparationCleanupReport["preparations"][number]["startupFailure"]
> {
  const { cause, ...fields } = failure;
  return Object.freeze({
    ...fields,
    ...(cause === undefined
      ? {}
      : { cause: freezeCause(translateCause(cause)) }),
  });
}

function freezeCause(cause: SafeCause): SafeCause {
  if (cause.cause !== undefined) freezeCause(cause.cause);
  return Object.freeze(cause);
}
