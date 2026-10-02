import {
  createProcessAdapter,
  type ChildFact,
  type ExecutableResolution,
  type OwnedProcess,
  type OwnedProcessClose,
  type ProcessAdapter,
  type ProcessInterruption,
  type ResolveExecutableOptions,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncResult,
  type SpawnOwnedProcessResult,
  type SpawnResult,
  type OwnedProcessOptions,
  type ProcessAdapterOptions,
} from "../../src/process/process.js";

/** A Process Interface that resolves and probes through the real Module, but
 *  launches owned processes through a scripted spawn. The Adapter conformance
 *  suites use it to hand a Session process behaviours a real child cannot be made
 *  to produce on demand, now that the Adapters take a Process Interface rather
 *  than a private spawn override. */
export function processWithSpawn(
  spawnOwnedProcess: ProcessAdapter["spawnOwnedProcess"],
): ProcessAdapter {
  const real = createProcessAdapter();
  return {
    resolveExecutable: (name, options) => real.resolveExecutable(name, options),
    spawnCommand: (options) => real.spawnCommand(options),
    spawnCommandSync: (options) => real.spawnCommandSync(options),
    spawnOwnedProcess,
  };
}

interface FakeResolutionScript {
  readonly name: string;
  readonly result: ExecutableResolution;
}

type FakeCommandScript =
  | { readonly trigger: "immediate"; readonly result: SpawnResult }
  | { readonly trigger: "cancellation"; readonly result: SpawnResult };

interface FakeSyncCommandScript {
  readonly result:
    SpawnSyncResult | ((options: SpawnSyncOptions) => SpawnSyncResult);
}

export type FakeOwnedProcessEmission =
  | { readonly kind: "stdout"; readonly bytes: Uint8Array }
  | { readonly kind: "stderr"; readonly bytes: Uint8Array }
  | {
      readonly kind: "terminal";
      readonly trigger: "automatic" | "close-stdin";
      readonly close: OwnedProcessClose;
    }
  | {
      readonly kind: "terminal";
      readonly trigger: "interrupt";
      readonly interruption: ProcessInterruption;
      readonly expectedGracefulMs?: number;
    };

type FakeOwnedProcessScript =
  | {
      readonly kind: "launch-failure";
      readonly failure: Extract<
        SpawnOwnedProcessResult,
        { readonly ok: false }
      >;
    }
  | {
      readonly kind: "launched";
      readonly emissions: readonly FakeOwnedProcessEmission[];
    };

export interface FakeProcessScript {
  readonly resolutions?: readonly FakeResolutionScript[];
  readonly resolutionHandler?: (name: string) => ExecutableResolution;
  readonly commands?: readonly FakeCommandScript[];
  readonly commandHandler?: (
    options: SpawnOptions,
  ) => SpawnResult | Promise<SpawnResult>;
  readonly syncCommands?: readonly FakeSyncCommandScript[];
  readonly syncCommandHandler?: (options: SpawnSyncOptions) => SpawnSyncResult;
  readonly ownedProcesses?: readonly FakeOwnedProcessScript[];
}

/** The scripted Process. Given the factory's options, it reports each scripted
 *  child's facts the way the real Adapter would: a start (before the call for a
 *  synchronous spawn), then the scripted outcome's settlement, with a fake PID
 *  and a fixed elapsed time. It never spawns `where.exe` or `taskkill`, so it
 *  reports no Windows-only fact. */
export function createFakeProcess(
  script: FakeProcessScript,
  options: ProcessAdapterOptions = {},
): ProcessAdapter {
  return new FakeProcessAdapter(script, options.observeChild ?? (() => {}));
}

type Observe = (fact: ChildFact) => void;

// A scripted settlement's signal, which no SpawnResult names, and the fixed
// elapsed time every settlement reports (fractional, so rounding shows).
const FAKE_SIGNAL: NodeJS.Signals = "SIGTERM";
const FAKE_ELAPSED_MS = 12.6;

/** The facts the real Adapter reports after a running child settles to
 *  `result`. */
function commandSettlement(
  role: ChildFact["role"],
  pid: number,
  result: SpawnResult,
): ChildFact[] {
  switch (result.kind) {
    case "exited":
      return [
        {
          kind: "exit",
          role,
          pid,
          status: result.status,
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ];
    case "signal":
      return [
        {
          kind: "exit",
          role,
          pid,
          signal: FAKE_SIGNAL,
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ];
    case "timeout":
    case "cancelled":
      return [
        {
          kind: result.kind === "timeout" ? "timeout" : "cancellation",
          role,
          pid,
        },
        {
          kind: "reap",
          role,
          pid,
          signal: FAKE_SIGNAL,
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ];
    case "spawn-error":
      return [{ kind: "spawn-error", role, elapsedMs: FAKE_ELAPSED_MS }];
  }
}

function closeSettlement(
  role: ChildFact["role"],
  pid: number,
  kind: "exit" | "reap",
  close: OwnedProcessClose,
): ChildFact[] {
  if (close.kind === "exited") {
    return [
      { kind, role, pid, status: close.status, elapsedMs: FAKE_ELAPSED_MS },
    ];
  }
  if (close.kind === "signal") {
    return [
      {
        kind,
        role,
        pid,
        signal: close.signal ?? FAKE_SIGNAL,
        elapsedMs: FAKE_ELAPSED_MS,
      },
    ];
  }
  // A cleanup error or timeout observed no close: the child was never reaped.
  return [];
}

function errorCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

class FakeProcessAdapter implements ProcessAdapter {
  private resolutionIndex = 0;
  private commandIndex = 0;
  private syncCommandIndex = 0;
  private ownedProcessIndex = 0;
  private nextPid = 40_000;

  constructor(
    private readonly script: FakeProcessScript,
    private readonly observe: Observe,
  ) {}

  private report(facts: readonly ChildFact[]): void {
    for (const fact of facts) this.observe(fact);
  }

  resolveExecutable(
    name: string,
    _options: ResolveExecutableOptions = {},
  ): ExecutableResolution {
    const entry = this.script.resolutions?.[this.resolutionIndex++];
    if (entry === undefined && this.script.resolutionHandler !== undefined) {
      return this.script.resolutionHandler(name);
    }
    if (entry === undefined) {
      throw new Error(
        `resolveExecutable beyond the scripted resolutions: ${name}`,
      );
    }
    if (entry.name !== name) {
      throw new Error(
        `resolveExecutable expected ${entry.name}, received ${name}`,
      );
    }
    return entry.result;
  }

  spawnCommand(options: SpawnOptions): Promise<SpawnResult> {
    const pid = this.nextPid++;
    const { role } = options;
    const scripted = this.scriptedCommand(options);
    // A child that never ran reports no spawn; one that did reports it before
    // it settles, so a scripted child that never settles still names itself.
    const neverRan =
      !(scripted instanceof Promise) && scripted.kind === "spawn-error";
    if (!neverRan) this.report([{ kind: "spawn", role, pid }]);
    return Promise.resolve(scripted).then((result) => {
      this.report(commandSettlement(role, pid, result));
      return result;
    });
  }

  private scriptedCommand(
    options: SpawnOptions,
  ): SpawnResult | Promise<SpawnResult> {
    const entry = this.script.commands?.[this.commandIndex++];
    if (entry === undefined && this.script.commandHandler !== undefined) {
      return this.script.commandHandler(options);
    }
    if (entry === undefined) {
      throw new Error(
        `spawnCommand beyond the scripted commands: ${options.executable}`,
      );
    }
    if (entry.trigger === "immediate") return entry.result;
    if (options.cancelSignal === undefined) {
      throw new Error("scripted cancellation requires a cancelSignal");
    }
    if (options.cancelSignal.aborted) return entry.result;
    return new Promise((resolve) => {
      options.cancelSignal!.addEventListener(
        "abort",
        () => resolve(entry.result),
        { once: true },
      );
    });
  }

  spawnCommandSync(options: SpawnSyncOptions): SpawnSyncResult {
    const { role } = options;
    this.report([{ kind: "spawn", role }]);
    const result = this.scriptedSyncCommand(options);
    const pid = this.nextPid++;
    if (result.kind === "spawn-error") {
      const code = errorCode(result.cause);
      this.report([
        {
          kind: "spawn-error",
          role,
          ...(code !== undefined ? { code } : {}),
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ]);
    } else if (result.kind === "signal") {
      this.report([
        {
          kind: "exit",
          role,
          pid,
          signal: FAKE_SIGNAL,
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ]);
    } else {
      this.report([
        {
          kind: "exit",
          role,
          pid,
          status: result.status,
          elapsedMs: FAKE_ELAPSED_MS,
        },
      ]);
    }
    return result;
  }

  private scriptedSyncCommand(options: SpawnSyncOptions): SpawnSyncResult {
    const entry = this.script.syncCommands?.[this.syncCommandIndex++];
    if (entry === undefined && this.script.syncCommandHandler !== undefined) {
      return this.script.syncCommandHandler(options);
    }
    if (entry === undefined) {
      throw new Error(
        `spawnCommandSync beyond the scripted commands: ${options.executable}`,
      );
    }
    return typeof entry.result === "function"
      ? entry.result(options)
      : entry.result;
  }

  spawnOwnedProcess(
    options: OwnedProcessOptions,
  ): Promise<SpawnOwnedProcessResult> {
    const entry = this.script.ownedProcesses?.[this.ownedProcessIndex++];
    if (entry === undefined) {
      throw new Error(
        `spawnOwnedProcess beyond the scripted processes: ${options.executable}`,
      );
    }
    const { role } = options;
    const pid = this.nextPid++;
    if (entry.kind === "launch-failure") {
      const { failure } = entry.failure;
      if (failure.kind === "spawn-error") {
        const code = errorCode(failure.cause);
        this.report([
          {
            kind: "spawn-error",
            role,
            ...(code !== undefined ? { code } : {}),
            elapsedMs: FAKE_ELAPSED_MS,
          },
        ]);
      } else {
        // The real Adapter reaps a launch that timed out before it reports.
        this.report([
          { kind: "spawn", role, pid },
          { kind: "timeout", role, pid },
          {
            kind: "reap",
            role,
            pid,
            signal: FAKE_SIGNAL,
            elapsedMs: FAKE_ELAPSED_MS,
          },
        ]);
      }
      return Promise.resolve(entry.failure);
    }
    const owned = new FakeOwnedProcess(entry.emissions, (settled) =>
      this.report(
        settled.interruption === undefined
          ? closeSettlement(role, pid, "exit", settled.close)
          : [
              { kind: "cancellation", role, pid },
              ...(settled.interruption.escalated
                ? [{ kind: "kill-escalation" as const, role, pid }]
                : []),
              ...closeSettlement(role, pid, "reap", settled.close),
            ],
      ),
    );
    this.report([{ kind: "spawn", role, pid }]);
    owned.start();
    return Promise.resolve({ ok: true, process: owned });
  }
}

class FakeOwnedProcess implements OwnedProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  private readonly stdoutStream = new FakeChunkStream();
  private readonly stderrStream = new FakeChunkStream();
  private readonly closePromise: Promise<OwnedProcessClose>;
  private readonly resolveClose: (close: OwnedProcessClose) => void;
  private readonly terminal: Extract<
    FakeOwnedProcessEmission,
    { readonly kind: "terminal" }
  >;
  private interruptPromise: Promise<ProcessInterruption> | undefined;

  constructor(
    emissions: readonly FakeOwnedProcessEmission[],
    private readonly onSettle: (settled: {
      readonly close: OwnedProcessClose;
      readonly interruption?: ProcessInterruption;
    }) => void,
  ) {
    let terminal:
      | Extract<FakeOwnedProcessEmission, { readonly kind: "terminal" }>
      | undefined;
    for (const emission of emissions) {
      if (terminal !== undefined) {
        throw new Error(
          `fake process emitted ${emission.kind} after its terminal result`,
        );
      }
      if (emission.kind === "stdout") this.stdoutStream.emit(emission.bytes);
      else if (emission.kind === "stderr")
        this.stderrStream.emit(emission.bytes);
      else terminal = emission;
    }
    if (terminal === undefined) {
      throw new Error("fake process script has no terminal result");
    }
    this.terminal = terminal;
    this.stdout = this.stdoutStream;
    this.stderr = this.stderrStream;
    let resolveClose!: (close: OwnedProcessClose) => void;
    this.closePromise = new Promise((resolve) => {
      resolveClose = resolve;
    });
    this.resolveClose = resolveClose;
  }

  /** Settles an automatic terminal once the spawn has been reported. */
  start(): void {
    if (this.terminal.trigger === "automatic") this.settle(this.terminal.close);
  }

  writeStdin(_bytes: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  closeStdin(_timeoutMs: number): Promise<OwnedProcessClose> {
    if (this.terminal.trigger !== "close-stdin") {
      throw new Error(
        `closeStdin cannot settle a ${this.terminal.trigger} fake process`,
      );
    }
    this.settle(this.terminal.close);
    return this.closePromise;
  }

  interrupt(gracefulMs: number): Promise<ProcessInterruption> {
    if (this.interruptPromise !== undefined) return this.interruptPromise;
    if (this.terminal.trigger !== "interrupt") {
      throw new Error(
        `interrupt cannot settle a ${this.terminal.trigger} fake process`,
      );
    }
    if (
      this.terminal.expectedGracefulMs !== undefined &&
      this.terminal.expectedGracefulMs !== gracefulMs
    ) {
      throw new Error(
        `interrupt expected gracefulMs ${this.terminal.expectedGracefulMs}, received ${gracefulMs}`,
      );
    }
    this.settle(this.terminal.interruption.close, this.terminal.interruption);
    this.interruptPromise = Promise.resolve(this.terminal.interruption);
    return this.interruptPromise;
  }

  closed(): Promise<OwnedProcessClose> {
    return this.closePromise;
  }

  private settled = false;

  private settle(
    close: OwnedProcessClose,
    interruption?: ProcessInterruption,
  ): void {
    this.stdoutStream.close();
    this.stderrStream.close();
    this.resolveClose(close);
    if (this.settled) return;
    this.settled = true;
    this.onSettle({
      close,
      ...(interruption !== undefined ? { interruption } : {}),
    });
  }
}

class FakeChunkStream implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private readonly readers: Array<
    (result: IteratorResult<Uint8Array>) => void
  > = [];
  private closed = false;

  emit(bytes: Uint8Array): void {
    if (this.closed)
      throw new Error("fake process emitted after terminal result");
    const reader = this.readers.shift();
    if (reader === undefined) this.buffered.push(bytes);
    else reader({ done: false, value: bytes });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.buffered.shift();
        if (value !== undefined) {
          return Promise.resolve({ done: false, value });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}
