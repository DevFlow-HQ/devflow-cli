import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const testsRoot = join(root, "tests");
const ledgerPath = join(root, "docs", "subprocess-test-migration-ledger.md");

const PROCESS_FREE_MARKER_EXCEPTIONS = new Set([
  // Production composition is present, but every wiring injects the fake Bundle
  // Process (#314): executable resolution (the default Codex Adapter's discovery
  // included), Commands, and Git stay on the double, and the scripted Turns run on
  // a fake Claude Code Adapter, so no wiring reaches the real Process.
  "tests/tui/live-run-workbench.test.tsx",
  // Born process-free (#187): wireApplication runs against the fake Process, fake
  // Git, and fake Harness Adapter, so no real child is ever reached.
  "tests/application/requested-model.test.ts",
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
  if (PROCESS_FREE_MARKER_EXCEPTIONS.has(path)) return false;
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

test("[evidence-ledger] every subprocess-backed test file has a migration row", () => {
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
