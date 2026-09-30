import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { headingSlug, rules, type RuleId } from "./rule-catalogue.js";
import { runStructuralStep } from "./structural-step.js";

// The structural step's printed report is the seam these tests pin: each catalogued
// rule's full three-line report over a synthetic source tree, as exact strings.

const guidanceFiles = [
  ...new Set(Object.values(rules).map((rule) => rule.see.split("#")[0]!)),
];

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A synthetic tree carrying the repository's real guidance files, so every `see:`
 *  anchor resolves unless a test overrides the file it names. */
async function tree(files: Record<string, string>) {
  const root = makeTempDir("secant-structural-");
  const guidance: Record<string, string> = {};
  for (const file of guidanceFiles)
    guidance[file] = await readFile(join(process.cwd(), file), "utf8");
  await writeTree(root, {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
      include: ["src", "tests"],
    }),
    ...guidance,
    ...files,
  });
  return root;
}

function run(root: string) {
  let output = "";
  const exitCode = runStructuralStep(root, (text) => {
    output += text;
  });
  return { exitCode, output };
}

/** The report blocks one rule printed, joined; the step exits non-zero. */
async function reportOf(rule: RuleId, files: Record<string, string>) {
  const { exitCode, output } = run(await tree(files));
  assert.equal(exitCode, 1, output);
  return blocks(output)
    .filter((block) => block.split("\n")[0]!.includes(`  ${rule}  `))
    .join("\n");
}

// A fix names only a change to the violating code, never a lever on the gate.
const forbiddenLever =
  /polic|allow-?list|checker|catalogue|\.test\.|eslint-disable|@ts-|@internal|suppress/i;

/** Splits the output into its three-line reports, asserting each keeps the
 *  contract, so every pinned fixture also proves its fix names no lever. */
function blocks(output: string) {
  const lines = output.split("\n");
  assert.equal(lines.pop(), "", "the report ends with a newline");
  assert.equal(lines.length % 3, 0, output);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 3) {
    const [where, fix, see] = lines.slice(index, index + 3) as [
      string,
      string,
      string,
    ];
    assert.match(where, /^[^\s:]+:\d+:\d+ {2}[a-z]+\/[a-z-]+ {2}\S.*$/);
    assert.match(fix, /^fix: \S.*$/);
    assert.doesNotMatch(fix, forbiddenLever);
    assert.match(see, /^see: docs\/agents\/[a-z-]+\.md#[a-z0-9-]+$/);
    result.push([where, fix, see].join("\n"));
  }
  return result;
}

test("a clean tree prints nothing and passes", async () => {
  const root = await tree({
    "src/cli/main.ts": 'import { start } from "../composition/main.js";',
    "src/composition/main.ts": "export function start() {}",
    "tests/cli/main.test.ts": 'import { start } from "../../src/cli/main.js";',
  });
  assert.deepEqual(run(root), { exitCode: 0, output: "" });
});

test("the step exits non-zero and prints nothing outside the report contract", async () => {
  const root = await tree({
    "src/adapters/stray.ts": "export {};",
    "src/tui/tui.ts":
      'import "bun:sqlite"; import "../run/store/private.js"; export * from "./view.js"; require("x");',
    "src/tui/view.ts": "export {};",
    "src/run/store/private.ts": "export {};",
    "tests/headless/misfiled.test.ts": 'import "../../src/tui/tui.js";',
    "docs/agents/dependencies.md": "# Renamed\n",
  });
  const { exitCode, output } = run(root);
  assert.equal(exitCode, 1);
  assert.ok(blocks(output).length >= 7, output);
});

test("guidance/unresolved-see-anchor", async () => {
  const root = await tree({
    "src/tui/tui.ts": "export {};",
    "docs/agents/dependencies.md": "# Dependencies\n\n## Growth\n",
  });
  assert.deepEqual(run(root), {
    exitCode: 1,
    output:
      "docs/agents/dependencies.md:1:1  guidance/unresolved-see-anchor  no heading here resolves #dependency-discipline, the see: anchor of module/composition-invocation\n" +
      "fix: restore a heading whose slug is dependency-discipline in docs/agents/dependencies.md; if it was retired on purpose, stop and ask a human\n" +
      "see: docs/agents/engineering-baseline.md#minimum-verification\n",
  });
});

test("anchors use GitHub's heading slugs", () => {
  assert.equal(headingSlug("Interfaces And Imports"), "interfaces-and-imports");
  assert.equal(
    headingSlug("Module-local `AGENTS.md`"),
    "module-local-agentsmd",
  );
  assert.equal(
    headingSlug("Invariants (interrupt, recovery, cleanup)"),
    "invariants-interrupt-recovery-cleanup",
  );
});

test("topology/test-mirror", async () => {
  assert.equal(
    await reportOf("topology/test-mirror", {
      "src/application/application.ts": "export {};",
      "tests/headless/misfiled.test.ts":
        'import "../../src/application/application.js";',
    }),
    "tests/headless/misfiled.test.ts:1:1  topology/test-mirror  this test sits under tests/headless/ but crosses only src/application/\n" +
      "fix: move it to tests/application/, the folder mirroring the Module it crosses\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("topology/unowned-source", async () => {
  assert.equal(
    await reportOf("topology/unowned-source", {
      "src/adapters/stray.ts": "export {};",
    }),
    "src/adapters/stray.ts:1:1  topology/unowned-source  no Module owns this source file\n" +
      "fix: move it under the src/ Module that owns its behaviour; if no Module fits, stop and ask a human\n" +
      "see: docs/agents/topology.md#ownership",
  );
});

test("topology/source-symlink", async () => {
  const root = await tree({ "src/tui/tui.ts": "export {};" });
  await symlink("tui.ts", join(root, "src/tui/link.ts"));
  const { exitCode, output } = run(root);
  assert.deepEqual(
    { exitCode, output },
    {
      exitCode: 1,
      output:
        "src/tui/link.ts:1:1  topology/source-symlink  this source file is a symlink, which bypasses ownership\n" +
        "fix: replace the symlink with an ordinary source file\n" +
        "see: docs/agents/topology.md#enforcement-and-tests\n",
    },
  );
});

test("module/private-import", async () => {
  assert.equal(
    await reportOf("module/private-import", {
      "src/application/application.ts":
        'import { row } from "../run/store/private.js";',
      "src/run/store/private.ts": "export const row = 1;",
    }),
    "src/application/application.ts:1:1  module/private-import  imports src/run/store/private.ts, which is private to store\n" +
      "fix: import it from src/run/store/store.ts, store's front door\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  // A client reaching into Application is sent to the client contracts only.
  assert.equal(
    await reportOf("module/private-import", {
      "src/tui/tui.ts": '\n  import "../application/internal.js";',
      "src/application/internal.ts": "export {};",
    }),
    "src/tui/tui.ts:2:3  module/private-import  imports src/application/internal.ts, which is private to application\n" +
      "fix: import it from src/application/projection-port.ts or src/application/bundle-management.ts, application's front doors\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  // A Module the importer may not import has no usable front door.
  assert.equal(
    await reportOf("module/private-import", {
      "src/tui/tui.ts": 'import "../run/store/private.js";',
      "src/run/store/private.ts": "export {};",
    }),
    "src/tui/tui.ts:1:1  module/private-import  imports src/run/store/private.ts, which is private to store\n" +
      "fix: remove this import and use store through application's Interface; tui may import only application and renderer\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/import-direction", async () => {
  assert.equal(
    await reportOf("module/import-direction", {
      "src/headless/headless.ts":
        'import type { Store } from "../run/store/store.js";',
      "src/run/store/store.ts": "export interface Store {}",
    }),
    "src/headless/headless.ts:1:1  module/import-direction  headless imports store, which headless may not import\n" +
      "fix: remove this import and use store through application's Interface; headless may import only application\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  assert.equal(
    await reportOf("module/import-direction", {
      "src/tui/tui.ts": 'import "../run/store/artifacts/artifacts.js";',
      "src/run/store/artifacts/artifacts.ts": "export {};",
    }),
    "src/tui/tui.ts:1:1  module/import-direction  tui imports artifacts, which tui may not import\n" +
      "fix: remove this import and use artifacts through application's Interface; tui may import only application and renderer\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  // No allowed Module reaches the target: the fix stops at a human.
  assert.equal(
    await reportOf("module/import-direction", {
      "src/harness/harness.ts": 'import "../run/store/store.js";',
      "src/run/store/store.ts": "export {};",
    }),
    "src/harness/harness.ts:1:1  module/import-direction  harness imports store, which harness may not import\n" +
      "fix: remove this import; harness may import only process, which does not reach store, so stop and ask a human\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  assert.equal(
    await reportOf("module/import-direction", {
      "src/workflow/workflow.ts": 'import "../process/process.js";',
      "src/process/process.ts": "export {};",
    }),
    "src/workflow/workflow.ts:1:1  module/import-direction  workflow imports process, which workflow may not import\n" +
      "fix: remove this import; workflow may import no other Module, so stop and ask a human\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/composition-invocation", async () => {
  assert.equal(
    await reportOf("module/composition-invocation", {
      "src/application/application.ts": 'import "../composition/main.js";',
      "src/composition/main.ts": "export {};",
    }),
    "src/application/application.ts:1:1  module/composition-invocation  application invokes the outer composition root, which only the CLI host invokes\n" +
      "fix: remove this import and receive what composition builds from your caller\n" +
      "see: docs/agents/dependencies.md#dependency-discipline",
  );
});

test("module/foreign-reexport", async () => {
  assert.equal(
    await reportOf("module/foreign-reexport", {
      "src/application/application.ts":
        'export { row } from "../run/store/store.js";',
      "src/run/store/store.ts": "export const row = 1;",
    }),
    "src/application/application.ts:1:1  module/foreign-reexport  re-exports src/run/store/store.ts, which is store's surface\n" +
      "fix: remove this re-export and export a value or type application declares itself\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/client-construction", async () => {
  assert.equal(
    await reportOf("module/client-construction", {
      "src/headless/headless.ts":
        'import { create } from "../application/application.js";',
      "src/application/application.ts": "export function create() {}",
    }),
    "src/headless/headless.ts:1:1  module/client-construction  headless imports src/application/application.ts, the construction surface only composition uses\n" +
      "fix: import the Interface from src/application/projection-port.ts or src/application/bundle-management.ts and receive the Application from composition\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/client-contract-implementation", async () => {
  assert.equal(
    await reportOf("module/client-contract-implementation", {
      "src/application/projection-port.ts":
        'export type { Row } from "./internal.js";',
      "src/application/internal.ts": "export type Row = number;",
    }),
    "src/application/projection-port.ts:1:1  module/client-contract-implementation  this client contract imports src/application/internal.ts, which is not a client contract\n" +
      "fix: declare it in src/application/projection-port.ts, src/application/bundle-management.ts, or src/application/contracts/ instead of importing it\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/client-contract-external", async () => {
  assert.equal(
    await reportOf("module/client-contract-external", {
      "src/application/contracts/port.ts":
        'import type { Stats } from "node:fs";',
    }),
    "src/application/contracts/port.ts:1:1  module/client-contract-external  this client contract imports node:fs, an external package or native type\n" +
      "fix: declare a normalized type in the contract instead of importing node:fs\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/unowned-import", async () => {
  assert.equal(
    await reportOf("module/unowned-import", {
      "src/run/execution/execution.ts": 'import "../../stray.js";',
      "src/stray.ts": "export {};",
    }),
    "src/run/execution/execution.ts:1:1  module/unowned-import  imports src/stray.ts, which no Module owns\n" +
      "fix: move src/stray.ts under the src/ Module that owns its behaviour and import it from there; if no Module fits, stop and ask a human\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/unresolved-import", async () => {
  assert.equal(
    await reportOf("module/unresolved-import", {
      "src/tui/tui.ts": 'import "./missing.js";',
    }),
    'src/tui/tui.ts:1:1  module/unresolved-import  "./missing.js" resolves to neither owned source nor an installed dependency\n' +
      "fix: correct the specifier so it names a file under src/ or an installed dependency\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/dependency-owner", async () => {
  // The importer may reach an owner: the fix names the owners' front doors.
  assert.equal(
    await reportOf("module/dependency-owner", {
      "src/application/application.ts": 'import "bun:sqlite";',
    }),
    "src/application/application.ts:1:1  module/dependency-owner  application imports bun:sqlite, which only store and catalog may import\n" +
      "fix: remove this import and use bun:sqlite through src/run/store/store.ts or src/catalog/catalog.ts, the front doors of store and catalog\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  // No owner is reachable: the code moves to an owner or a human decides.
  assert.equal(
    await reportOf("module/dependency-owner", {
      "src/bundle/bundle.ts": 'import "@anthropic-ai/sdk";',
    }),
    "src/bundle/bundle.ts:1:1  module/dependency-owner  bundle imports @anthropic-ai/sdk, which only harness may import\n" +
      "fix: move the code that needs @anthropic-ai/sdk into harness; if it does not belong there, stop and ask a human\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/excluded-dependency", async () => {
  assert.equal(
    await reportOf("module/excluded-dependency", {
      "src/tui/tui.ts": 'import "@opencode-ai/sdk";',
    }),
    "src/tui/tui.ts:1:1  module/excluded-dependency  imports @opencode-ai/sdk, but target code excludes OpenCode domain packages and PTY transport\n" +
      "fix: remove this import; if the change needs an OpenCode domain package or PTY transport, stop and ask a human\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/sqlite-driver", async () => {
  assert.equal(
    await reportOf("module/sqlite-driver", {
      "src/catalog/catalog.ts": 'import { DatabaseSync } from "node:sqlite";',
    }),
    "src/catalog/catalog.ts:1:1  module/sqlite-driver  imports node:sqlite, but SQLite is admitted only as bun:sqlite\n" +
      "fix: import SQLite from bun:sqlite instead of node:sqlite\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
  assert.equal(
    await reportOf("module/sqlite-driver", {
      "src/tui/tui.ts": 'import "better-sqlite3";',
    }),
    "src/tui/tui.ts:1:1  module/sqlite-driver  imports better-sqlite3, but SQLite is admitted only as bun:sqlite\n" +
      "fix: move the code that needs SQLite into store or catalog and import bun:sqlite there; if it does not belong there, stop and ask a human\n" +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/custom-loader", async () => {
  assert.equal(
    await reportOf("module/custom-loader", {
      "src/application/application.ts": 'import "node:vm";',
    }),
    "src/application/application.ts:1:1  module/custom-loader  imports node:vm, a custom loader or evaluated module graph mechanism\n" +
      "fix: remove this import; if the change needs a custom loader or an evaluated module graph, stop and ask a human\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/workflow-builtin", async () => {
  assert.equal(
    await reportOf("module/workflow-builtin", {
      "src/workflow/workflow.ts": 'import "node:fs";',
    }),
    "src/workflow/workflow.ts:1:1  module/workflow-builtin  workflow imports node:fs, but workflow is execution-free\n" +
      "fix: remove this import and move the behaviour that needs node:fs to the Module that executes it\n" +
      "see: docs/agents/topology.md#ownership",
  );
});

test("module/triple-slash-reference", async () => {
  assert.equal(
    await reportOf("module/triple-slash-reference", {
      "src/tui/tui.ts": '\n/// <reference types="node" />\nexport {};',
    }),
    "src/tui/tui.ts:2:1  module/triple-slash-reference  uses a triple-slash reference directive\n" +
      "fix: replace the triple-slash reference with an explicit import\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/wildcard-export", async () => {
  assert.equal(
    await reportOf("module/wildcard-export", {
      "src/tui/tui.ts": 'export * from "./view.js";',
      "src/tui/view.ts": "export {};",
    }),
    'src/tui/tui.ts:1:1  module/wildcard-export  export * from "./view.js" is a wildcard barrel\n' +
      'fix: name each export instead: export { … } from "./view.js"\n' +
      "see: docs/agents/topology.md#interfaces-and-imports",
  );
});

test("module/require-assignment", async () => {
  assert.equal(
    await reportOf("module/require-assignment", {
      "src/tui/tui.ts": 'import view = require("./view.js");\nvoid view;',
      "src/tui/view.ts": "export {};",
    }),
    'src/tui/tui.ts:1:1  module/require-assignment  import … = require("./view.js") is a require-style import assignment\n' +
      'fix: replace it with an ESM import: import … from "./view.js"\n' +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/computed-import", async () => {
  assert.equal(
    await reportOf("module/computed-import", {
      "src/tui/tui.ts": 'const path = "./view.js";\nvoid import(path);',
    }),
    "src/tui/tui.ts:2:6  module/computed-import  imports a computed specifier, which cannot be checked\n" +
      'fix: replace it with a table of literal import("…") calls\n' +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("module/require-or-eval", async () => {
  assert.equal(
    await reportOf("module/require-or-eval", {
      "src/tui/tui.ts": 'require("./view.js");\neval("1");',
      "src/tui/view.ts": "export {};",
    }),
    "src/tui/tui.ts:1:1  module/require-or-eval  calls require, which bypasses the declared ESM graph\n" +
      "fix: replace require(…) with a static ESM import\n" +
      "see: docs/agents/topology.md#enforcement-and-tests\n" +
      "src/tui/tui.ts:2:1  module/require-or-eval  calls eval, which bypasses the declared ESM graph\n" +
      "fix: remove eval and import the code it runs as an ESM module\n" +
      "see: docs/agents/topology.md#enforcement-and-tests",
  );
});

test("every catalogued rule has a pinned fixture above", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  const pinned = new Set(
    [...source.matchAll(/^test\("([a-z]+\/[a-z-]+)"/gm)].map(
      (match) => match[1],
    ),
  );
  const unpinned = (Object.keys(rules) as RuleId[]).filter(
    (rule) => !pinned.has(rule),
  );
  assert.deepEqual(unpinned, []);
});
