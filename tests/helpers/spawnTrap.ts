// The semantic suite's spawn trap (#317, spec #313 stories 58–60). bunfig.toml
// preloads it into every `bun test` file before the file loads, so no test can
// reach a real child: the semantic suite proves behavior without one, and real
// children belong to standalone runtime conformance or compiled-binary acceptance
// (ADR 0027, docs/agents/testing.md).
//
// Every spawn function of the child-process module is replaced on its CommonJS
// object, which a CommonJS `require` returns and an ESM import linked afterwards
// copies, and through a module mock, which also rebinds an ESM import linked
// before the trap ran (Bun 1.4.2 copies the functions at link time). Bun's spawn,
// spawnSync, and shell are replaced too; Bun builds its child-process module on
// them, so they also catch `ChildProcess#spawn`. Each trap
// records the route and the test that reached it, then throws. The global hook
// below fails that test afterwards, so a caller that turns the throw into a value,
// as the Process Adapter does with `spawn-error`, cannot hide the spawn. There is
// no allowlist and no exemption.
//
// Bun's `getTestContext()` names the test. It follows the test's async context
// through timers, where a stack trace has lost the test, so a spawn behind a timer
// is still charged to the test that started it. A spawn outside every test, at a
// module's top level, is charged to its file.

import { afterAll, afterEach, mock } from "bun:test";
import { createRequire } from "node:module";
import { relative, sep } from "node:path";
import * as nodeTest from "node:test";
import { fileURLToPath } from "node:url";

const SPAWN_FUNCTIONS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

const FIX =
  "fix: inject a fake Process (createFakeProcess from tests/process/fake-adapter.ts); " +
  "a real child belongs in standalone runtime conformance or compiled-binary acceptance " +
  "(docs/agents/testing.md)";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** The running test as Bun's `node:test` reports it; `@types/node` does not
 *  declare Bun's `getTestContext`. */
interface RunningTest {
  readonly fullName: string;
  readonly filePath: string;
}

const { getTestContext } = nodeTest as typeof nodeTest & {
  getTestContext(): RunningTest | undefined;
};

/** Each spawn reached since the global hook last ran, as `<route> in <where>`. */
const reached: string[] = [];
let hookRuns = 0;

function repositoryPath(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function spawnSite(): string {
  const running = getTestContext();
  return running === undefined
    ? `${repositoryPath(Bun.main)}, outside any test`
    : `${repositoryPath(running.filePath)} > ${running.fullName}`;
}

function trap(route: string): () => never {
  return () => {
    const reachedAt = `${route} in ${spawnSite()}`;
    reached.push(reachedAt);
    throw new Error(
      `spawn trap: ${reachedAt} reached a real child under bun test\n${FIX}`,
    );
  };
}

/** The global hook: fail the test that reached a trap, listing every spawn it
 *  reached, and empty the record for the next test. The trap's own test runs it in
 *  place of the runner. */
export function failOnTrappedSpawn(): void {
  hookRuns += 1;
  if (reached.length === 0) return;
  const spawns = reached.splice(0).map((spawn) => `  ${spawn}`);
  throw new Error(
    [
      "spawn trap: a real child was reached under bun test, even if the caller turned the throw into a value:",
      ...spawns,
      FIX,
    ].join("\n"),
  );
}

/** How many times the global hook has run in this file. The trap's own test reads
 *  it on both sides of a test boundary to prove the runner runs the hook. */
export function globalHookRuns(): number {
  return hookRuns;
}

const childProcess: Record<string, unknown> = createRequire(import.meta.url)(
  "node:child_process",
);
for (const name of SPAWN_FUNCTIONS) {
  childProcess[name] = trap(`child_process.${name}`);
}
mock.module("node:child_process", () => ({
  ...childProcess,
  default: childProcess,
}));
Object.assign(Bun, {
  spawn: trap("Bun.spawn"),
  spawnSync: trap("Bun.spawnSync"),
  $: trap("Bun.$"),
});

afterEach(failOnTrappedSpawn);
// A spawn after a file's last test has no later test to fail.
afterAll(failOnTrappedSpawn);
