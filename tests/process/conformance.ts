import assert from "node:assert/strict";
import type {
  ChildFact,
  OwnedProcessOptions,
  ProcessAdapter,
  SpawnOptions,
  SpawnResult,
} from "../../src/process/process.js";

/** What a scenario's observer recorded. The real scenarios attach one and each
 *  case asserts its child facts; the fake attaches none, so its facts are proven
 *  where they are read, in the composition suite. */
interface ObservedFacts {
  readonly facts?: readonly ChildFact[];
}

interface ProcessConformanceCase<T> extends ObservedFacts {
  readonly process: ProcessAdapter;
  readonly options: T;
}

interface InterruptConformanceCase extends ProcessConformanceCase<OwnedProcessOptions> {
  readonly ready: string;
  readonly gracefulMs: number;
  readonly escalated: boolean;
}

export interface ProcessConformanceScenarios {
  readonly label: string;
  resolution(): ObservedFacts & {
    readonly process: ProcessAdapter;
    readonly foundName: string;
    readonly foundExecutable: string;
    readonly missingName: string;
  };
  commandExit(): ProcessConformanceCase<SpawnOptions> & {
    readonly status: number;
    readonly text: string;
  };
  commandCancellation(): ProcessConformanceCase<SpawnOptions> & {
    cancel(): void;
  };
  /** A Command that writes `stdout` and `stderr`, then outlives its time limit. */
  commandTimeoutTails(): ProcessConformanceCase<SpawnOptions> & {
    readonly stdout: { readonly text: string; readonly omitted: boolean };
    readonly stderr: { readonly text: string; readonly omitted: boolean };
  };
  /** A Command stopped by an outside termination once it runs: POSIX observes
   *  its signal, while Windows observes the native exit status it left. */
  commandSignal(): ProcessConformanceCase<SpawnOptions> & {
    terminate(): Promise<void>;
    readonly observed:
      | Extract<SpawnResult, { kind: "signal" }>
      | { readonly kind: "exited"; readonly status: number };
  };
  ownedExit(): ProcessConformanceCase<OwnedProcessOptions> & {
    readonly stdout: string;
    readonly stderr: string;
    readonly status: number;
  };
  ownedSignal(): ProcessConformanceCase<OwnedProcessOptions> & {
    readonly terminalKind: "exited" | "signal";
  };
  gracefulInterruption(): InterruptConformanceCase;
  forcedBoundInterruption(): InterruptConformanceCase;
  escalatingInterruption(): InterruptConformanceCase;
  treeCleanup(): ProcessConformanceCase<SpawnOptions>;
  failures(): ObservedFacts & {
    readonly process: ProcessAdapter;
    readonly missingName: string;
    readonly command: SpawnOptions;
    readonly owned: OwnedProcessOptions;
  };
}

type ProcessConformanceBody = () => void | Promise<void>;
export type RegisterProcessConformanceCase = (
  name: string,
  body: ProcessConformanceBody,
) => void;

export function registerProcessConformanceCases(
  scenarios: ProcessConformanceScenarios,
  register: RegisterProcessConformanceCase,
): void {
  const name = (behaviour: string): string =>
    `[process-parity:${scenarios.label}] ${behaviour}`;

  register(
    name("resolves found and missing executables as typed values"),
    () => {
      const scenario = scenarios.resolution();
      assert.deepEqual(scenario.process.resolveExecutable(scenario.foundName), {
        kind: "found",
        executable: scenario.foundExecutable,
        prefixArgs: [],
      });
      assert.deepEqual(
        scenario.process.resolveExecutable(scenario.missingName),
        {
          kind: "not-found",
        },
      );
      // Only a Windows miss spawns: the `where.exe` fallback, reported in this
      // Module's own role, starting before it blocks.
      if (scenario.facts === undefined) return;
      if (windows) {
        const exit = assertChildFacts(scenario.facts, "executable-lookup", [
          "spawn",
          "exit",
        ]);
        assert.notEqual(exit.status, 0);
      } else {
        assert.deepEqual(scenario.facts, []);
      }
    },
  );

  register(
    name("captures stdout before stderr and preserves exit status"),
    async () => {
      const scenario = scenarios.commandExit();
      const result = await scenario.process.spawnCommand(scenario.options);
      assert.equal(result.kind, "exited");
      if (result.kind !== "exited") throw new Error("unreachable");
      assert.equal(result.status, scenario.status);
      assert.equal(new TextDecoder().decode(result.text), scenario.text);
      if (scenario.facts === undefined) return;
      const exit = assertChildFacts(scenario.facts, "command", [
        "spawn",
        "exit",
      ]);
      assert.equal(exit.status, scenario.status);
      assert.equal(exit.signal, undefined);
    },
  );

  register(
    name("cancellation settles to the typed cancelled result"),
    async () => {
      const scenario = scenarios.commandCancellation();
      const resultPromise = scenario.process.spawnCommand(scenario.options);
      scenario.cancel();
      assert.deepEqual(await resultPromise, { kind: "cancelled" });
      if (scenario.facts === undefined) return;
      const reap = assertChildFacts(scenario.facts, "command", [
        "spawn",
        "cancellation",
        ...forcedOnWindows,
        "reap",
      ]);
      if (!windows) assert.equal(reap.signal, "SIGTERM");
      assertTreeKill(scenario.facts);
    },
  );

  register(
    name("a timeout keeps each stream's bounded tail separately"),
    async () => {
      const scenario = scenarios.commandTimeoutTails();
      const result = await scenario.process.spawnCommand(scenario.options);
      assert.equal(result.kind, "timeout", JSON.stringify(result));
      if (result.kind !== "timeout") throw new Error("unreachable");
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
      assert.deepEqual(
        {
          stdout: {
            text: decode(result.stdout.bytes),
            omitted: result.stdout.omitted,
          },
          stderr: {
            text: decode(result.stderr.bytes),
            omitted: result.stderr.omitted,
          },
        },
        { stdout: scenario.stdout, stderr: scenario.stderr },
      );
      if (scenario.facts === undefined) return;
      assertChildFacts(scenario.facts, "command", [
        "spawn",
        "timeout",
        ...forcedOnWindows,
        "reap",
      ]);
    },
  );

  register(
    name("an outside termination keeps its native observation"),
    async () => {
      const scenario = scenarios.commandSignal();
      const pending = scenario.process.spawnCommand(scenario.options);
      await scenario.terminate();
      const result = await pending;
      assert.deepEqual(
        result.kind === "exited"
          ? { kind: result.kind, status: result.status }
          : result,
        scenario.observed,
      );
      if (scenario.facts === undefined) return;
      // Secant sent no kill, so the child's end is an exit fact either way.
      const exit = assertChildFacts(scenario.facts, "command", [
        "spawn",
        "exit",
      ]);
      if (windows) assert.equal(exit.status, 1);
      else assert.equal(exit.signal, "SIGTERM");
    },
  );

  register(
    name("delivers ordered stdout and stderr before one exit result"),
    async () => {
      const scenario = scenarios.ownedExit();
      const launched = await scenario.process.spawnOwnedProcess(
        scenario.options,
      );
      assert.equal(launched.ok, true);
      if (!launched.ok) throw new Error("unreachable");
      const [stdout, stderr, close] = await Promise.all([
        collect(launched.process.stdout),
        collect(launched.process.stderr),
        launched.process.closed(),
      ]);
      assert.equal(stdout, scenario.stdout);
      assert.equal(stderr, scenario.stderr);
      assert.deepEqual(close, { kind: "exited", status: scenario.status });
      assert.equal(await launched.process.closed(), close);
      if (scenario.facts === undefined) return;
      const exit = assertChildFacts(scenario.facts, "harness-runtime", [
        "spawn",
        "exit",
      ]);
      assert.equal(exit.status, scenario.status);
    },
  );

  register(
    name("reports an outside signal as a typed terminal result"),
    async () => {
      const scenario = scenarios.ownedSignal();
      const launched = await scenario.process.spawnOwnedProcess(
        scenario.options,
      );
      assert.equal(launched.ok, true);
      if (!launched.ok) throw new Error("unreachable");
      const close = await launched.process.closed();
      assert.equal(close.kind, scenario.terminalKind);
      if (scenario.facts === undefined) return;
      // An outside signal is an exit: Secant sent no kill.
      const exit = assertChildFacts(scenario.facts, "harness-runtime", [
        "spawn",
        "exit",
      ]);
      if (windows) assert.equal(exit.status, 1);
      else assert.equal(exit.signal, "SIGTERM");
    },
  );

  register(
    name("uses the supplied graceful bound before interrupt escalation"),
    async () => {
      const scenario = scenarios.gracefulInterruption();
      await assertInterruption(scenario);
      if (scenario.facts === undefined) return;
      // Off Windows the process exits on its own once SIGTERM reaches it, so the
      // kill is reaped with that status and never escalates.
      const reap = assertChildFacts(scenario.facts, "harness-runtime", [
        "spawn",
        "cancellation",
        ...forcedOnWindows,
        "reap",
      ]);
      if (!windows) assert.equal(reap.status, 0);
    },
  );

  register(
    name("force-kills an unresponsive process tree and reports escalation"),
    async () => {
      const scenario = scenarios.escalatingInterruption();
      await assertInterruption(scenario);
      assertEscalatedReap(scenario.facts);
    },
  );

  register(
    name("uses the supplied bound again after forced interruption"),
    async () => {
      const scenario = scenarios.forcedBoundInterruption();
      await assertInterruption(scenario);
      assertEscalatedReap(scenario.facts);
    },
  );

  register(
    name("reaps a tree whose descendant holds the output pipe"),
    async () => {
      const scenario = scenarios.treeCleanup();
      const result = await scenario.process.spawnCommand(scenario.options);
      assert.equal(result.kind, "timeout", JSON.stringify(result));
      if (scenario.facts === undefined) return;
      assertChildFacts(scenario.facts, "command", [
        "spawn",
        "timeout",
        ...forcedOnWindows,
        "reap",
      ]);
      assertTreeKill(scenario.facts);
    },
  );

  register(name("returns typed resolution and launch failures"), async () => {
    const scenario = scenarios.failures();
    assert.deepEqual(scenario.process.resolveExecutable(scenario.missingName), {
      kind: "not-found",
    });
    // A Command's spawn error keeps its errno name and the original cause.
    const command = await scenario.process.spawnCommand(scenario.command);
    assert.equal(command.kind, "spawn-error");
    if (command.kind !== "spawn-error") throw new Error("unreachable");
    assert.equal(command.errno, "ENOENT");
    assert.ok(command.cause instanceof Error, String(command.cause));
    const launched = await scenario.process.spawnOwnedProcess(scenario.owned);
    assert.equal(launched.ok, false);
    if (launched.ok) throw new Error("unreachable");
    assert.equal(launched.failure.kind, "spawn-error");
    if (scenario.facts === undefined) return;
    // The cause is the native code alone: the message, syscall, and stack all
    // carry the executable.
    for (const role of ["command", "harness-runtime"] as const) {
      const failed = assertChildFacts(scenario.facts, role, ["spawn-error"]);
      assert.equal(failed.code, "ENOENT");
    }
    assert.equal(
      JSON.stringify(scenario.facts).includes(scenario.missingName),
      false,
    );
  });
}

const windows = process.platform === "win32";
// Windows has no graceful stage: its first kill is already `taskkill /T /F`.
const forcedOnWindows: readonly ChildFact["kind"][] = windows
  ? ["kill-escalation"]
  : [];
// The only fields a fact may carry: never an argument, environment value, or
// output.
const FACT_FIELDS = new Set([
  "kind",
  "role",
  "pid",
  "code",
  "status",
  "signal",
  "elapsedMs",
  "containment",
]);

/** The settlement fields a case checks on the last fact it asserts. */
interface LastFact {
  readonly status?: number;
  readonly signal?: string;
  readonly code?: string;
}

/** Asserts the kinds `role`'s facts arrived in, that every fact naming a PID
 *  names the same child's, that a settlement carries monotonic elapsed time, and
 *  that no fact holds a field outside the allowlist. Returns the last fact. */
function assertChildFacts(
  facts: readonly ChildFact[],
  role: ChildFact["role"],
  kinds: readonly ChildFact["kind"][],
): LastFact {
  for (const fact of facts) {
    for (const key of Object.keys(fact)) assert.ok(FACT_FIELDS.has(key), key);
  }
  const mine = facts.filter((fact) => fact.role === role);
  assert.deepEqual(
    mine.map((fact) => fact.kind),
    kinds,
    JSON.stringify(facts),
  );
  const pids = new Set<number | undefined>();
  for (const fact of mine) {
    if ("elapsedMs" in fact) assert.ok(fact.elapsedMs >= 0);
    if (fact.kind === "spawn-error") {
      assert.equal("pid" in fact, false);
      continue;
    }
    // A synchronous spawn names its PID only once it returns.
    if (fact.kind === "spawn" && fact.pid === undefined) continue;
    assert.ok(
      Number.isInteger(fact.pid) && fact.pid! > 0,
      JSON.stringify(fact),
    );
    pids.add(fact.pid);
  }
  assert.ok(pids.size <= 1, JSON.stringify(mine));
  const last = mine.at(-1)!;
  return {
    status: "status" in last ? last.status : undefined,
    signal: "signal" in last ? last.signal : undefined,
    code: "code" in last ? last.code : undefined,
  };
}

function assertEscalatedReap(facts: readonly ChildFact[] | undefined): void {
  if (facts === undefined) return;
  const reap = assertChildFacts(facts, "harness-runtime", [
    "spawn",
    "cancellation",
    "kill-escalation",
    "reap",
  ]);
  if (!windows) assert.equal(reap.signal, "SIGKILL");
}

/** On Windows every kill spawns `taskkill`, reported in its own role. Its exit
 *  can land after the killed child's result, so only its start is asserted. */
function assertTreeKill(facts: readonly ChildFact[]): void {
  const treeKill = facts.filter((fact) => fact.role === "tree-kill");
  if (!windows) {
    assert.deepEqual(treeKill, []);
    return;
  }
  assert.equal(treeKill[0]?.kind, "spawn");
  assert.equal(
    treeKill.some((fact) => fact.kind === "spawn-error"),
    false,
  );
}

async function assertInterruption(
  scenario: InterruptConformanceCase,
): Promise<void> {
  const launched = await scenario.process.spawnOwnedProcess(scenario.options);
  assert.equal(launched.ok, true);
  if (!launched.ok) throw new Error("unreachable");
  const stdout = await readUntil(launched.process.stdout, scenario.ready);
  assert.notEqual(stdout, undefined);
  if (stdout === undefined) throw new Error("unreachable");
  const end = stdout.next();
  let endedBeforeTerminal = false;
  void end.then(() => {
    endedBeforeTerminal = true;
  });
  await Promise.resolve();
  assert.equal(endedBeforeTerminal, false);
  const interruption = await launched.process.interrupt(scenario.gracefulMs);
  assert.equal(interruption.escalated, scenario.escalated);
  assert.notEqual(interruption.close.kind, "cleanup-timeout");
  assert.equal(
    await launched.process.interrupt(scenario.gracefulMs),
    interruption,
  );
  assert.equal(await launched.process.closed(), interruption.close);
  assert.equal((await end).done, true);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

async function readUntil(
  stream: AsyncIterable<Uint8Array>,
  expected: string,
): Promise<AsyncIterator<Uint8Array> | undefined> {
  const decoder = new TextDecoder();
  const iterator = stream[Symbol.asyncIterator]();
  let text = "";
  for (;;) {
    const next = await iterator.next();
    if (next.done) return undefined;
    text += decoder.decode(next.value, { stream: true });
    if (text.includes(expected)) return iterator;
  }
}
