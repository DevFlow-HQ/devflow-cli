import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { CI_WORKFLOW } from "./check-release-workflow.js";
import {
  jobsToEdit,
  stepsToEdit,
  validWorkflow,
  type Jobs,
} from "./release-workflow-fixture.js";
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
 *  anchor resolves unless a test overrides the file it names, and a minimal valid
 *  CI workflow. */
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
    [CI_WORKFLOW]: JSON.stringify(validWorkflow()),
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

// A release-workflow finding has no native line, so each reports at 1:1.
const WORKFLOW = `${CI_WORKFLOW}:1:1`;
const VALIDATION = "see: docs/agents/release-workflow.md#candidate-validation";
const PROTECTION =
  "see: docs/agents/release-workflow.md#release-protection-policy";
const PROMOTION =
  "see: docs/agents/release-workflow.md#release-promotion-state-machine";

/** The report `rule` printed over a clean source tree and `workflow`. */
function workflowReport(rule: RuleId, workflow: string) {
  return reportOf(rule, {
    "src/tui/tui.ts": "export {};",
    [CI_WORKFLOW]: workflow,
  });
}

/** The report `rule` printed over the minimal valid workflow after `edit`. */
function releaseReport(
  rule: RuleId,
  edit: (workflow: Record<string, unknown>, jobs: Jobs) => void,
) {
  const workflow = validWorkflow();
  edit(workflow, jobsToEdit(workflow));
  return workflowReport(rule, JSON.stringify(workflow));
}

test("release/workflow-not-mapping", async () => {
  assert.equal(
    await workflowReport("release/workflow-not-mapping", "[]\n"),
    `${WORKFLOW}  release/workflow-not-mapping  the workflow is not a YAML mapping\n` +
      "fix: rewrite the workflow as a mapping with on: and jobs: keys\n" +
      VALIDATION,
  );
});

test("release/workflow-env-secret", async () => {
  assert.equal(
    await releaseReport("release/workflow-env-secret", (workflow) => {
      workflow.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
    }),
    `${WORKFLOW}  release/workflow-env-secret  the workflow-level env references secret NPM_READONLY_TOKEN, which reaches every job on every run\n` +
      "fix: remove secrets.NPM_READONLY_TOKEN from the workflow-level env; if a step needs it, stop and ask a human\n" +
      VALIDATION,
  );
});

test("release/dispatch-trigger", async () => {
  assert.equal(
    await releaseReport("release/dispatch-trigger", (workflow) => {
      workflow.on = { push: null, pull_request: null };
    }),
    `${WORKFLOW}  release/dispatch-trigger  the workflow has no workflow_dispatch trigger, so candidate validation has no manual entrypoint\n` +
      "fix: add workflow_dispatch under on:\n" +
      VALIDATION,
  );
});

test("release/validation-no-jobs", async () => {
  assert.equal(
    await releaseReport("release/validation-no-jobs", (workflow) => {
      delete workflow.jobs;
    }),
    `${WORKFLOW}  release/validation-no-jobs  the workflow declares no jobs, so no candidate is assembled or validated\n` +
      "fix: declare the gate's jobs as a mapping under jobs:\n" +
      VALIDATION,
  );
});

test("release/no-build-job", async () => {
  assert.equal(
    await releaseReport("release/no-build-job", (_, jobs) => {
      delete jobs.build;
    }),
    `${WORKFLOW}  release/no-build-job  the workflow has no build job to assemble the one candidate\n` +
      "fix: restore the build job that assembles the candidate once; if it was removed on purpose, stop and ask a human\n" +
      VALIDATION,
  );
});

test("release/missing-dry-run", async () => {
  assert.equal(
    await releaseReport("release/missing-dry-run", (_, jobs) => {
      jobs.build!.steps = stepsToEdit(jobs.build!).slice(0, 5);
    }),
    `${WORKFLOW}  release/missing-dry-run  the build job never runs scripts/npm-dry-run.ts, the candidate-validation dry-run\n` +
      "fix: add a step to the build job that runs scripts/npm-dry-run.ts, gated on github.event_name == 'workflow_dispatch'\n" +
      VALIDATION,
  );
});

test("release/job-not-mapping", async () => {
  assert.equal(
    await releaseReport("release/job-not-mapping", (_, jobs) => {
      (jobs as Record<string, unknown>).lint = "bun run lint";
    }),
    `${WORKFLOW}  release/job-not-mapping  job lint is not a mapping\n` +
      "fix: rewrite job lint as a mapping with runs-on: and steps:\n" +
      VALIDATION,
  );
});

test("release/needs-build", async () => {
  assert.equal(
    await releaseReport("release/needs-build", (_, jobs) => {
      delete jobs.smoke!.needs;
    }),
    `${WORKFLOW}  release/needs-build  job smoke does not need build, so it cannot consume the one candidate\n` +
      "fix: add build to the needs: of job smoke\n" +
      VALIDATION,
  );
});

test("release/candidate-download", async () => {
  assert.equal(
    await releaseReport("release/candidate-download", (_, jobs) => {
      jobs.smoke!.steps = [{ run: "bun scripts/package-smoke.ts dist" }];
    }),
    `${WORKFLOW}  release/candidate-download  job smoke never downloads the candidate artifact\n` +
      "fix: add an actions/download-artifact step to job smoke and use the candidate it downloads instead of rebuilding it\n" +
      VALIDATION,
  );
});

test("release/reassembly", async () => {
  assert.equal(
    await releaseReport("release/reassembly", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({ run: "bun run scripts/assemble.ts" });
    }),
    `${WORKFLOW}  release/reassembly  job smoke runs scripts/assemble.ts, but the candidate is assembled once on build\n` +
      "fix: remove scripts/assemble.ts from job smoke and download the candidate artifact instead\n" +
      VALIDATION,
  );
});

test("release/job-env-secret", async () => {
  assert.equal(
    await releaseReport("release/job-env-secret", (_, jobs) => {
      jobs.build!.env = {
        NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}",
      };
    }),
    `${WORKFLOW}  release/job-env-secret  job build's env references secret NPM_READONLY_TOKEN, which reaches every step on every run\n` +
      "fix: move secrets.NPM_READONLY_TOKEN from job build's env to the env of the dispatch-gated step that needs it\n" +
      VALIDATION,
  );
  assert.equal(
    await releaseReport("release/job-env-secret", (_, jobs) => {
      jobs.smoke!.env = { TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
    }),
    `${WORKFLOW}  release/job-env-secret  job smoke's env references secret NPM_READONLY_TOKEN, which reaches every step on every run\n` +
      "fix: remove secrets.NPM_READONLY_TOKEN from job smoke's env; if the job needs it, stop and ask a human\n" +
      VALIDATION,
  );
});

test("release/secret-outside-build", async () => {
  assert.equal(
    await releaseReport("release/secret-outside-build", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({
        if: "github.event_name == 'workflow_dispatch'",
        env: { TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" },
        run: "echo hi",
      });
    }),
    `${WORKFLOW}  release/secret-outside-build  job smoke references a secret, but before approval only the build dry-run step may hold one\n` +
      "fix: remove the secret from job smoke; if the job needs a credential, stop and ask a human\n" +
      VALIDATION,
  );
});

test("release/ungated-credential", async () => {
  assert.equal(
    await releaseReport("release/ungated-credential", (_, jobs) => {
      stepsToEdit(jobs.build!)[5]!.if =
        "github.event_name != 'workflow_dispatch'";
    }),
    `${WORKFLOW}  release/ungated-credential  the credentialed step in job build is not gated on a workflow_dispatch run, so it runs on every push\n` +
      "fix: gate the credentialed step in job build with if: github.event_name == 'workflow_dispatch'\n" +
      VALIDATION,
  );
});

test("release/secret-not-read-only", async () => {
  assert.equal(
    await releaseReport("release/secret-not-read-only", (_, jobs) => {
      stepsToEdit(jobs.build!)[5]!.env = {
        NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}",
      };
    }),
    `${WORKFLOW}  release/secret-not-read-only  secret NPM_PUBLISH_TOKEN does not read as a read-only identity, so it may carry publication authority\n` +
      "fix: remove secrets.NPM_PUBLISH_TOKEN from the step in job build; the dry-run authenticates only with the read-only npm identity, so if the step needs NPM_PUBLISH_TOKEN, stop and ask a human\n" +
      VALIDATION,
  );
});

test("release/stray-environment", async () => {
  assert.equal(
    await releaseReport("release/stray-environment", (_, jobs) => {
      jobs.build!.environment = "release";
    }),
    `${WORKFLOW}  release/stray-environment  job build declares an environment, but only the protected promote job may\n` +
      "fix: remove environment: from job build\n" +
      VALIDATION,
  );
});

test("release/real-publish", async () => {
  assert.equal(
    await releaseReport("release/real-publish", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({ run: "npm publish dist/secant.tgz" });
    }),
    `${WORKFLOW}  release/real-publish  job smoke runs a real npm publish, but validation publishes only with --dry-run\n` +
      "fix: add --dry-run to the npm publish in job smoke\n" +
      VALIDATION,
  );
});

test("release/gh-release", async () => {
  assert.equal(
    await releaseReport("release/gh-release", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({ run: "gh release create v1.0.0" });
    }),
    `${WORKFLOW}  release/gh-release  job smoke runs gh release, but validation exposes no public release\n` +
      "fix: remove the gh release command from job smoke\n" +
      VALIDATION,
  );
});

test("release/release-action", async () => {
  assert.equal(
    await releaseReport("release/release-action", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({ uses: "softprops/action-gh-release@v2" });
    }),
    `${WORKFLOW}  release/release-action  job smoke uses release action softprops/action-gh-release@v2, but validation exposes no public release\n` +
      "fix: remove the softprops/action-gh-release@v2 step from job smoke\n" +
      VALIDATION,
  );
});

test("release/retry-action", async () => {
  assert.equal(
    await releaseReport("release/retry-action", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({ uses: "nick-fields/retry@v3" });
    }),
    `${WORKFLOW}  release/retry-action  job smoke uses retry action nick-fields/retry@v3, which re-runs a flaky release step instead of fixing it\n` +
      "fix: remove the nick-fields/retry@v3 wrapper from job smoke and run its step directly\n" +
      VALIDATION,
  );
});

test("release/protection-no-jobs", async () => {
  assert.equal(
    await workflowReport("release/protection-no-jobs", "[]\n"),
    `${WORKFLOW}  release/protection-no-jobs  the workflow declares no jobs, so no protected boundary guards promotion\n` +
      "fix: declare the gate's jobs as a mapping under jobs:\n" +
      PROTECTION,
  );
});

test("release/protection-no-promote-job", async () => {
  assert.equal(
    await releaseReport("release/protection-no-promote-job", (_, jobs) => {
      delete jobs.promote;
    }),
    `${WORKFLOW}  release/protection-no-promote-job  the workflow has no promote job to hold publication behind the protected release environment\n` +
      "fix: restore the promote job with environment: release; if it was removed on purpose, stop and ask a human\n" +
      PROTECTION,
  );
});

test("release/no-approval-job", async () => {
  assert.equal(
    await releaseReport("release/no-approval-job", (_, jobs) => {
      delete jobs["release-approval"];
    }),
    `${WORKFLOW}  release/no-approval-job  the workflow has no release-approval job to run the tag and version gate and write the approval summary\n` +
      "fix: restore the release-approval job that runs scripts/release-gate.ts; if it was removed on purpose, stop and ask a human\n" +
      PROTECTION,
  );
});

test("release/protection-environment", async () => {
  assert.equal(
    await releaseReport("release/protection-environment", (_, jobs) => {
      jobs.promote!.environment = "staging";
    }),
    `${WORKFLOW}  release/protection-environment  job promote does not target the protected release environment\n` +
      "fix: set environment: release on job promote\n" +
      PROTECTION,
  );
});

test("release/promote-needs", async () => {
  assert.equal(
    await releaseReport("release/promote-needs", (_, jobs) => {
      jobs["release-approval"]!.needs = ["check", "build"];
    }),
    `${WORKFLOW}  release/promote-needs  job smoke does not gate job promote: it is outside promote's transitive needs\n` +
      "fix: add smoke to the needs: of job release-approval\n" +
      PROTECTION,
  );
  assert.equal(
    await releaseReport("release/promote-needs", (_, jobs) => {
      jobs.promote!.needs = ["check", "build", "smoke"];
    }),
    `${WORKFLOW}  release/promote-needs  job release-approval does not gate job promote: it is outside promote's transitive needs\n` +
      "fix: add release-approval to the needs: of job promote\n" +
      PROTECTION,
  );
});

test("release/tag-ref-gate", async () => {
  assert.equal(
    await releaseReport("release/tag-ref-gate", (_, jobs) => {
      jobs.promote!.if = "startsWith(github.ref, 'refs/tags/')";
    }),
    `${WORKFLOW}  release/tag-ref-gate  job promote is not gated on a refs/tags/v* tag ref, so it can run on a branch\n` +
      "fix: add startsWith(github.ref, 'refs/tags/v') to the if: of job promote\n" +
      PROTECTION,
  );
});

test("release/missing-tag-gate", async () => {
  assert.equal(
    await releaseReport("release/missing-tag-gate", (_, jobs) => {
      jobs["release-approval"]!.steps = [
        { uses: "actions/download-artifact@v4" },
      ];
    }),
    `${WORKFLOW}  release/missing-tag-gate  job release-approval never runs scripts/release-gate.ts, so a tag is admitted without matching the package version\n` +
      "fix: add a step to job release-approval that runs scripts/release-gate.ts\n" +
      PROTECTION,
  );
});

test("release/approval-secret", async () => {
  assert.equal(
    await releaseReport("release/approval-secret", (_, jobs) => {
      stepsToEdit(jobs["release-approval"]!).push({
        env: {
          NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}",
          GH_TOKEN: "${{ secrets.GH_PAT }}",
        },
        run: "echo x",
      });
    }),
    `${WORKFLOW}  release/approval-secret  job release-approval references secrets NPM_PUBLISH_TOKEN and GH_PAT, but no credential may exist before the protected boundary\n` +
      "fix: remove secrets.NPM_PUBLISH_TOKEN and secrets.GH_PAT from job release-approval; if the job needs a credential, stop and ask a human\n" +
      PROTECTION,
  );
  // One secret named twice reads as one secret.
  assert.equal(
    await releaseReport("release/approval-secret", (_, jobs) => {
      stepsToEdit(jobs["release-approval"]!).push({
        env: {
          NODE_AUTH_TOKEN: "${{ secrets.GH_PAT }}",
          GH_TOKEN: "${{ secrets.GH_PAT }}",
        },
        run: "echo x",
      });
    }),
    `${WORKFLOW}  release/approval-secret  job release-approval references secret GH_PAT, but no credential may exist before the protected boundary\n` +
      "fix: remove secrets.GH_PAT from job release-approval; if the job needs a credential, stop and ask a human\n" +
      PROTECTION,
  );
});

test("release/promotion-no-jobs", async () => {
  assert.equal(
    await workflowReport("release/promotion-no-jobs", "[]\n"),
    `${WORKFLOW}  release/promotion-no-jobs  the workflow declares no jobs, so no protected job promotes the release\n` +
      "fix: declare the gate's jobs as a mapping under jobs:\n" +
      PROMOTION,
  );
});

test("release/promotion-no-promote-job", async () => {
  assert.equal(
    await releaseReport("release/promotion-no-promote-job", (_, jobs) => {
      delete jobs.promote;
    }),
    `${WORKFLOW}  release/promotion-no-promote-job  the workflow has no promote job to run release promotion\n` +
      "fix: restore the promote job; if it was removed on purpose, stop and ask a human\n" +
      PROMOTION,
  );
});

test("release/promotion-environment", async () => {
  assert.equal(
    await releaseReport("release/promotion-environment", (_, jobs) => {
      delete jobs.promote!.environment;
    }),
    `${WORKFLOW}  release/promotion-environment  job promote does not target the protected release environment, so publication waits for no approval\n` +
      "fix: set environment: release on job promote\n" +
      PROMOTION,
  );
});

test("release/missing-promotion-script", async () => {
  assert.equal(
    await releaseReport("release/missing-promotion-script", (_, jobs) => {
      stepsToEdit(jobs.promote!)[3]!.run = "echo approved";
    }),
    `${WORKFLOW}  release/missing-promotion-script  job promote never runs scripts/release-promote.ts, the one publication state machine\n` +
      "fix: add a step to job promote that runs scripts/release-promote.ts\n" +
      PROMOTION,
  );
});

test("release/promote-download", async () => {
  assert.equal(
    await releaseReport("release/promote-download", (_, jobs) => {
      jobs.promote!.steps = stepsToEdit(jobs.promote!).filter(
        (step) =>
          (step.with as { name?: string } | undefined)?.name !==
          "platform-packages",
      );
    }),
    `${WORKFLOW}  release/promote-download  job promote does not download the approved platform-packages artifact\n` +
      "fix: add an actions/download-artifact step with name: platform-packages to job promote\n" +
      PROMOTION,
  );
});

test("release/promote-permissions", async () => {
  assert.equal(
    await releaseReport("release/promote-permissions", (_, jobs) => {
      jobs.promote!.permissions = { contents: "read" };
    }),
    `${WORKFLOW}  release/promote-permissions  job promote lacks permissions: contents: write, so it cannot expose the approved GitHub release assets\n` +
      "fix: set permissions: contents: write on job promote\n" +
      PROMOTION,
  );
});

test("release/promote-unexpected-secret", async () => {
  assert.equal(
    await releaseReport("release/promote-unexpected-secret", (_, jobs) => {
      const step = stepsToEdit(jobs.promote!)[3]!;
      step.env = {
        ...(step.env as object),
        EXTRA_TOKEN: "${{ secrets.EXTRA_TOKEN }}",
      };
    }),
    `${WORKFLOW}  release/promote-unexpected-secret  job promote references secret EXTRA_TOKEN, but only NPM_PUBLISH_TOKEN belongs on its state-machine step\n` +
      "fix: remove secrets.EXTRA_TOKEN from job promote; if promotion needs it, stop and ask a human\n" +
      PROMOTION,
  );
});

test("release/credential-placement", async () => {
  assert.equal(
    await releaseReport("release/credential-placement", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({
        env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
        run: "echo leaked",
      });
    }),
    `${WORKFLOW}  release/credential-placement  job smoke references NPM_PUBLISH_TOKEN outside the promote step that runs scripts/release-promote.ts\n` +
      "fix: remove secrets.NPM_PUBLISH_TOKEN from job smoke\n" +
      PROMOTION,
  );
  assert.equal(
    await releaseReport("release/credential-placement", (_, jobs) => {
      stepsToEdit(jobs.promote!).unshift({
        env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
        run: "echo early",
      });
    }),
    `${WORKFLOW}  release/credential-placement  job promote references NPM_PUBLISH_TOKEN outside the promote step that runs scripts/release-promote.ts\n` +
      "fix: move secrets.NPM_PUBLISH_TOKEN to the promote step that runs scripts/release-promote.ts\n" +
      PROMOTION,
  );
});

test("release/credential-count", async () => {
  assert.equal(
    await releaseReport("release/credential-count", (_, jobs) => {
      stepsToEdit(jobs.promote!)[3]!.env = { GH_TOKEN: "${{ github.token }}" };
    }),
    `${WORKFLOW}  release/credential-count  no promote step that runs scripts/release-promote.ts references NPM_PUBLISH_TOKEN\n` +
      "fix: add secrets.NPM_PUBLISH_TOKEN to the env of the promote step that runs scripts/release-promote.ts\n" +
      PROMOTION,
  );
  assert.equal(
    await releaseReport("release/credential-count", (_, jobs) => {
      stepsToEdit(jobs.promote!).push({
        env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
        run: "bun scripts/release-promote.ts again",
      });
    }),
    `${WORKFLOW}  release/credential-count  the promote steps that run scripts/release-promote.ts reference NPM_PUBLISH_TOKEN 2 times, not once\n` +
      "fix: keep one secrets.NPM_PUBLISH_TOKEN reference, on the one promote step that runs scripts/release-promote.ts\n" +
      PROMOTION,
  );
});

test("release/promotion-script-placement", async () => {
  assert.equal(
    await releaseReport("release/promotion-script-placement", (_, jobs) => {
      stepsToEdit(jobs.smoke!).push({
        run: "bun scripts/release-promote.ts dist",
      });
    }),
    `${WORKFLOW}  release/promotion-script-placement  job smoke runs scripts/release-promote.ts, which may run only in the protected promote job\n` +
      "fix: remove scripts/release-promote.ts from job smoke\n" +
      PROMOTION,
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
