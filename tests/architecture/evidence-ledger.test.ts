import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const testsRoot = join(root, "tests");
const ledgerPath = join(root, "docs", "subprocess-test-migration-ledger.md");

// A suite born over doubles has no real-child assertion to migrate. Keep its
// rationale here, not as a second classification in the historical ledger.
const PROCESS_FREE_TEST_FILES = new Set([
  // Born process-free (#436): real temporary Store/Catalog and injected Process,
  // fake Git, held qualification promises, and the openLiveRun execution double.
  "tests/application/run-scoped-fanout.test.ts",
  // Born process-free (#444): headless commands use real local Bundle bytes and the
  // double-backed headless harness; scripted Projection/Resource reads launch no child.
  "tests/headless/screen-control-bytes.test.ts",
  // Born process-free (#431): composition uses the production Harness policies with
  // scripted Process acquisitions, Commands, child facts and fake Git throughout.
  "tests/composition/production-harness-parts.test.ts",
  // Born process-free (#433): real temporary Store/Catalog with injected fake Bundle
  // Process, fake Git and Harness; receipt ordering and crash reopen spawn no child.
  "tests/application/steer-history.test.ts",
  // Born process-free (#496): invocation start, real temporary files/SQLite, fake Process
  // and Harness, and an injected Renderer Port; no child spawns.
  "tests/composition/store-permissions.test.ts",
  // Production composition is present, but every wiring injects the fake Bundle
  // Process (#314): executable resolution (the default Codex Adapter's discovery
  // included), Commands, and Git stay on the double, and the scripted Turns run on
  // a fake Claude Code Adapter, so no wiring reaches the real Process.
  "tests/tui/live-run-workbench.test.tsx",
  // Born process-free (#187): wireApplication runs against the fake Process, fake
  // Git, and fake Harness Adapter, so no real child is ever reached.
  "tests/application/requested-model.test.ts",
  // Born process-free (#528): wireApplication runs against the fake Bundle Process,
  // fake Git, and scripted fake Harness Adapters; restarts reopen the same home.
  "tests/application/execution-fault-rest.test.ts",
  // Born process-free (#189): launch-preparation assessments create no Run, and the
  // one launch submitted is refused before creation, so the wired runExecution and
  // fake Run Group never reach a Command, Git probe, or Harness child.
  "tests/application/launch-preparation.test.ts",
  // Born process-free (#212): the Matt grill runs against the fake Process, fake Git,
  // and fake Harness Adapters under both Harness selections; no child is reached.
  "tests/application/matt-grill-launch.test.ts",
  // Born process-free (#221): the Matt remote-spec stage runs against the fake
  // Process, fake Git, and fake Harness Adapters; no child is reached.
  "tests/application/matt-remote-spec.test.ts",
  // Born process-free (#220): the Matt Local spec runs against the fake Bundle
  // Process and fake Harness Adapters under both Harness selections.
  "tests/application/matt-local-spec.test.ts",
  // Born process-free (#224): the Matt implementation stage runs against the fake
  // Bundle Process and fake Harness Adapters under both Harness selections.
  "tests/application/matt-local-implement.test.ts",
  // Construct an Application through the compatibility helper but reach no Command,
  // Git probe, or Harness child: catalog and projection behavior only, and the helper
  // now injects a throwing Process stub (#200 A21), so none can silently reach the
  // real Process without an explicit injection.
  "tests/application/bundle-catalog.test.ts",
  "tests/application/bundle-install.test.ts",
  "tests/application/harness-catalog.test.ts",
  "tests/application/projection-port.test.ts",
  "tests/application/shipped-bundles.test.ts",
  // Born process-free (#317): the spawn trap's own test reaches every spawn route,
  // and each lands on the trap, which throws before any child exists.
  "tests/helpers/spawnTrap.test.ts",
  // Written against the scripted Claude Process; no child spawns. Native channel fixtures replay
  // separately in standalone runtime conformance (#371).
  "tests/harness/claude-code-channel.test.ts",
  // Born process-free (#500): recorded MCP attachment and Turn bodies through the production
  // Harness with a scripted Process and in-process loopback servers, never real children.
  "tests/harness/claude-code-mcp-stdin.test.ts",
  // Written against the scripted Claude Process; no child spawns. The recorded model-change
  // fixtures replay separately in standalone runtime conformance (#348).
  "tests/harness/claude-code-model-change.test.ts",
  // Written over injected Process and Harness doubles from the start.
  "tests/application/agent-output-receipt.test.ts",
  // Written in place (#304) over the injected fake Harness and fake Process; no child spawns.
  "tests/application/continuation-preparation-failure.test.ts",
  // Born process-free (#393): public Projection Port over real temporary directories and Catalog,
  // with the throwing Process stub or openLiveRun's injected fake Process and execution. No child
  // spawns.
  "tests/application/operation-receipt.test.ts",
  // Born process-free: an ordinary Interactive Bundle runs over the fake Process with counting
  // Step-driver and owner doubles.
  "tests/application/retained-step-shutdown.test.ts",
  // Born process-free: ordinary Bundles run over the fake Bundle Process and fake Harness Adapter.
  "tests/application/run-progress.test.ts",
  // Written in place (#213) over the injected fake Harness and fake Process; no child spawns.
  "tests/application/suggested-gate.test.ts",
  // Written in place (#390) through runHeadless with scripted Projection Port streams and the
  // process-free headless harness; no child spawns.
  "tests/headless/readiness.test.ts",
  // Born process-free (#439): production composition and the Claude Adapter use scripted
  // Process streams and fake Git; history and transcript clients never reach a real child.
  "tests/headless/claude-fact-translation.test.ts",
  // Written over the fake Git Run group (#214).
  "tests/run/store/working-area.test.ts",
  // Born process-free (#513): the completion check reads a fake Git Run group's Store.
  "tests/run/execution/interactive-completion.test.ts",
  // Born process-free: fake view/Renderer Port controls, in-process Catalog, and an Application
  // whose injected helper Process throws on every launch route.
  "tests/tui/home-preferences.test.tsx",
  // Born process-free: Run reads use openLiveRun's fake Process; settlement uses
  // temporary Catalog/SQLite and the Application helper's throwing Process (#448).
  "tests/tui/run-view.test.ts",
  // Born process-free: the Application runs over the fake Bundle Process; every other case reads
  // fake snapshots.
  "tests/tui/run-workbench-interaction.test.tsx",
  // Born process-free: a command Bundle runs over the fake Process; every other case reads fake
  // snapshots.
  "tests/tui/screens.test.tsx",
  // Written in place (#319) over the injected fake Process and fake Harness Adapters; no child
  // spawns.
  "tests/composition/application-log.test.ts",
  // Written over the injected fake Process and fake Git from the start (#321); the fake reports
  // child facts to composition's observer, and no child spawns.
  "tests/composition/process-observer.test.ts",
  // Written over the injected fake Process and fake Harness Adapter from the start (#325); the
  // bearer comes from the in-process permission bridge, and no child spawns.
  "tests/composition/detail-log.test.ts",
  // Real temporary Catalog/SQLite and the Application fixture's refusing Process. No Harness
  // preparation or child work is consumed.
  "tests/application/preferences.test.ts",
  // Born process-free: Projection Port over real temporary files/Catalog and the scripted
  // helper Process (#484). Real ripgrep fixtures run only in standalone conformance.
  "tests/application/workspace-paths.test.ts",
  // Born process-free (#484): the headless harness injects scripted helper processes and fake
  // Git. Extraction/spawn from the shipped executable runs in compiled-binary acceptance.
  "tests/headless/workspace-paths.test.ts",
  // Real temporary Catalog/SQLite and the Application fixture's refusing Process; copied-binary
  // coverage is m10-settings-consumer.
  "tests/headless/settings.test.ts",
  // Preferences Projection with a refusing Process; palette data is read through the TypeScript AST
  // without rendering or launching children.
  "tests/architecture/preferences-palettes.test.ts",
  // Born process-free (#411): copied real SQLite plus injected fake Git through the public Store.
  // Artifact-byte and relocated-home evidence run in copied-binary acceptance.
  "tests/run/store/conversation-migration.test.ts",
  // Born process-free (#434): copied predecessor SQLite, fake Git and injected Process
  // through Application/Projection and headless Interfaces. No execution or child spawns.
  "tests/application/session-history-legacy.test.ts",
  "tests/headless/legacy-conversation.test.ts",
]);

const SUBPROCESS_SOURCE_PATTERNS = [
  // A module specifier is the one literal codeOf keeps, so this reads an import,
  // an export, or a CommonJS require of the child-process module.
  /["'`](?:node:)?child_process["'`]/,
  /(?<!\.)\bspawnCommand\(/,
  /(?<!\.)\bspawnOwnedProcess\(/,
  /\binstall(?:Synthetic)?CodexReplayer\(/,
  /\binstallReplayer\(/,
  /\bwrite(?:Command|Repeat|Materialization)Bundle\(/,
  /\bopen(?:RunGroup|ArtifactRepo|HeadlessHarness)\(/,
  /(?<!\.)\bcreateApplication\(/,
  /\bwireApplication\(/,
  /\bexecuteRouting\(/,
  /\bemitEntryDeclarations\(/,
];
const EVIDENCE_LAYERS = new Set([
  "process-free semantic suite",
  "standalone runtime conformance",
  "compiled-binary acceptance",
]);
const LEDGER_STATUSES = new Set(["open", "done"]);

interface LedgerRow {
  readonly path: string;
  readonly assertion: string;
  readonly layer: string;
  readonly replacement: string;
  readonly status: string;
}

function relativePath(path: string): string {
  return relative(root, path).split(sep).join("/");
}

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/** A module specifier is the one literal the patterns read: an import or export's,
 *  or the module a CommonJS require names (#317). */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    isRequire(parent.expression)
  );
}

/** A CommonJS require: `require`, a `.require` member such as `module.require`,
 *  or the function a `createRequire(…)` call returns. */
function isRequire(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === "require";
  }
  return (
    ts.isCallExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "createRequire"
  );
}

/** The source as the patterns should read it: every comment and every literal
 *  but a module specifier is blanked to spaces, keeping offsets and line breaks,
 *  so the spawning words count only as code. A template's substitutions are code
 *  and stay, and so does JSX text, which errs toward discovery. The TypeScript
 *  parser decides what is a literal, a regular expression, or a comment (#301). */
function codeOf(path: string, source: string): string {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const code = source.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      if (code[index] !== "\n" && code[index] !== "\r") code[index] = " ";
    }
  };
  const visit = (node: ts.Node) => {
    // A JSDoc block is part of the next token's leading trivia.
    const children = node
      .getChildren(file)
      .filter((child) => !ts.isJSDoc(child));
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    // Between a token's full start and its start lie only whitespace and comments.
    blank(node.getFullStart(), node.getStart(file));
    if (LITERAL_KINDS.has(node.kind) && !isModuleSpecifier(node)) {
      blank(node.getStart(file), node.getEnd());
    }
  };
  visit(file);
  return code.join("");
}

function discoversSubprocess(path: string, source: string): boolean {
  if (PROCESS_FREE_TEST_FILES.has(path)) return false;
  const code = codeOf(path, source);
  return SUBPROCESS_SOURCE_PATTERNS.some((pattern) => pattern.test(code));
}

function ledgerRows(markdown: string): LedgerRow[] {
  return markdown.split("\n").flatMap((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 5) return [];
    const path = /^`([^`]+\.test\.tsx?)`$/.exec(cells[0]!)?.[1];
    if (path === undefined) return [];
    return [
      {
        path,
        assertion: cells[1]!,
        layer: cells[2]!,
        replacement: cells[3]!,
        status: cells[4]!,
      },
    ];
  });
}

function missingLedgerFiles(
  spawning: readonly string[],
  recorded: ReadonlySet<string>,
): string[] {
  return spawning.filter((path) => !recorded.has(path));
}

test("[evidence-ledger] discovery finds direct and indirect children without matching process-free tests", () => {
  const spawningSources = [
    'import { spawn } from "node:child_process";',
    'import type { ChildProcess } from "child_process";',
    'export { spawn } from "child_process";',
    'export * from "node:child_process";',
    "spawnCommand(options);",
    "const label = `run ${spawnCommand(options)}`;",
    "spawnOwnedProcess(options);",
    'installCodexReplayer("completion");',
    "installSyntheticCodexReplayer();",
    'installReplayer("1.0.0", fixture);',
    "writeCommandBundle();",
    "writeRepeatBundle(options);",
    "writeMaterializationBundle(options);",
    "openRunGroup(home, workspace);",
    "createApplication({ catalog });",
    "openArtifactRepo(runDir);",
    "openHeadlessHarness(t);",
    "wireApplication(options);",
    "executeRouting(routing, options);",
    "emitEntryDeclarations(root);",
    "fixture.wireApplication(options);",
    // A CommonJS require of the child-process module (#317), in each form an ESM
    // file can write it.
    'const { spawnSync } = require("node:child_process");',
    "const childProcess = require('child_process');",
    "const childProcess = require(`child_process`);",
    'import childProcess = require("child_process");',
    'const require = createRequire(import.meta.url);\nrequire("node:child_process");',
    'createRequire(import.meta.url)("node:child_process");',
    'createRequire(new URL(import.meta.url))("child_process");',
    'module.require("child_process");',
    'const { spawn } = require(\n  "node:child_process",\n);',
  ];
  for (const source of spawningSources) {
    assert.equal(
      discoversSubprocess("tests/example/spawning.test.ts", source),
      true,
      source,
    );
  }
  assert.equal(
    discoversSubprocess("tests/example/values.test.ts", "makeTempDir('x');"),
    false,
  );
  // A bare-only helper reached as a method is some other object's method.
  assert.equal(
    discoversSubprocess(
      "tests/example/values.test.ts",
      "harness.spawnCommand(options);",
    ),
    false,
  );
  // The same words as data or prose are not code, so they spawn nothing (#301).
  const literalSources = [
    `const fixture = 'import { spawnSync } from "node:child_process";';`,
    "const fixture = `spawnCommand(options);\n${name}\nwireApplication(options);`;",
    'const pattern = /from "node:child_process"|createApplication(?=\\()/u;',
    '// spawnOwnedProcess(options);\n/* import { spawn } from "child_process"; */\n' +
      "/** Calls executeRouting(routing, options). */\nexport function run() {}\n" +
      "// openRunGroup(home, workspace);",
    // A require in data or prose, as a fixture program's source carries it, spawns
    // nothing; neither does a require of another module or the bare module name.
    "const program = \"const{spawn}=require('node:child_process');\";",
    '// const { spawn } = require("child_process");',
    'const pattern = /require\\("child_process"\\)/;',
    'const fs = require("node:fs");',
    'console.log("child_process");',
  ];
  for (const source of literalSources) {
    assert.equal(
      discoversSubprocess("tests/example/fixture.test.ts", source),
      false,
      source,
    );
  }
  assert.equal(
    discoversSubprocess(
      "tests/tui/live-run-workbench.test.tsx",
      "wireApplication({ harnessAdapter: createFake() });",
    ),
    false,
  );
  assert.deepEqual(
    missingLedgerFiles(["tests/example/spawning.test.ts"], new Set<string>()),
    ["tests/example/spawning.test.ts"],
  );
});

test("m10-audit-guidance-refresh: every subprocess-backed test file has a migration row", () => {
  assert.equal(
    existsSync(ledgerPath),
    true,
    `${relativePath(ledgerPath)} is missing`,
  );
  const rows = ledgerRows(readFileSync(ledgerPath, "utf8"));
  const recorded = new Set(rows.map((row) => row.path));
  const spawning = testFiles(testsRoot)
    .map(relativePath)
    .filter((path) =>
      discoversSubprocess(path, readFileSync(join(root, path), "utf8")),
    )
    .sort();
  const missing = missingLedgerFiles(spawning, recorded);

  assert.deepEqual(
    missing,
    [],
    `Subprocess-backed test files need ledger rows:\n${missing.join("\n")}`,
  );
  for (const row of rows) {
    assert.notEqual(row.assertion, "", `${row.path} has no assertion`);
    assert.equal(
      EVIDENCE_LAYERS.has(row.layer),
      true,
      `${row.path} has unknown evidence layer ${row.layer}`,
    );
    assert.notEqual(row.replacement, "", `${row.path} has no replacement`);
    assert.equal(
      LEDGER_STATUSES.has(row.status),
      true,
      `${row.path} has unknown status ${row.status}`,
    );
    // The migration is complete (#185): every row's replacement is landed, so the
    // ledger is closed. A new `open` row would mean a subprocess test slipped back
    // into an evidence layer without its replacement — fail until it is migrated.
    assert.notEqual(
      row.status,
      "open",
      `${row.path} has an open ledger row; the subprocess-test migration is closed (#185)`,
    );
  }
});

// These suites were introduced over in-process resources and injected Process
// doubles. They never had a real-child assertion to migrate (#454, audit A33).
test("m10-audit-guidance-refresh: born process-free suites are classified outside the migration ledger", () => {
  const rows = ledgerRows(readFileSync(ledgerPath, "utf8"));
  for (const path of [
    "tests/tui/home-preferences.test.tsx",
    // Born process-free: Run reads use openLiveRun's fake Process; settlement uses
    // temporary Catalog/SQLite and the Application helper's throwing Process (#448).
    "tests/tui/run-view.test.ts",
    "tests/application/preferences.test.ts",
    "tests/application/workspace-paths.test.ts",
    "tests/headless/settings.test.ts",
    "tests/architecture/preferences-palettes.test.ts",
    "tests/run/store/conversation-migration.test.ts",
  ]) {
    assert.equal(
      discoversSubprocess(path, readFileSync(join(root, path), "utf8")),
      false,
      path,
    );
    assert.equal(
      rows.some((row) => row.path === path),
      false,
      path,
    );
  }
});

test("m10-audit-guidance-refresh: process-free classifications have live files and no migration rows", () => {
  const recorded = new Set(
    ledgerRows(readFileSync(ledgerPath, "utf8")).map((row) => row.path),
  );
  for (const path of PROCESS_FREE_TEST_FILES) {
    assert.equal(existsSync(join(root, path)), true, path);
    assert.equal(recorded.has(path), false, path);
  }
});
