import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { modules } from "./module-policy.js";
import type { Finding } from "./rule-catalogue.js";

// A structural check that guards the vendored-copy policy (ADR 0018, as extended
// by ADR 0030). It is the single runtime-neutrality mechanism: the import-specifier
// ban, the member-access ban, and the textual vendor scan collapse here, so target
// source may touch a Bun runtime API — a `Bun.*` access or a `bun:` import — only at
// an allowlisted site below, and there only the one API that site is keyed to.
// This file also holds the notices-to-dependencies cross-check (D7) and the entry
// declaration-surface check (S2) that guard the same policy from other angles.
//
// The Bun-API scan parses each file with the TypeScript syntax tree (the same
// loader the module-boundary suite uses, D8) rather than a regex: the old regex
// matched only literal `Bun.` or a quoted `bun:`, so the one real access in the
// tree — `(globalThis as { Bun?: … }).Bun?.main` — slipped through, as would
// `globalThis["Bun"]` or an alias. The AST names the exact API each site touches
// and, because comments are not nodes, an allowlist entry with zero real hits is
// caught as a dead grant. Once any vendored file exists the repository must carry
// both provenance records — `UPSTREAM` and `THIRD-PARTY-NOTICES.md`. A file is
// "vendored" when it carries the copy marker below. Pure over a directory tree, so
// it is exercised with synthetic graphs as well as the real repository. Every
// finding is a catalogued `vendor/…` rule; the structural step prints them.

const VENDOR_MARKER = "Vendored from OpenCode";
const NOTICES = "THIRD-PARTY-NOTICES.md";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The runtime-neutrality allowlist (ADR 0030): the few target-source sites that
// must touch a Bun API because no runtime-neutral equivalent exists, each keyed to
// the exact API it is permitted and nothing else. The CLI entry needs `Bun.main`
// to detect the compiled-binary entry (`import.meta.main` is false in a Bun binary
// on Windows). The Catalog and Run Store adapters import `bun:sqlite` behind their
// Interfaces. The Windows console guard imports `bun:ffi` for its `GetConsoleWindow`
// + `IsWindowVisible` conhost probe. The private Windows Process containment
// file imports `bun:ffi` for at-creation Job Objects and handle-based exit.
// A site reaching for a *different* Bun API —
// `Bun.spawn` in the Run Store, say — is rejected until ADR 0030 names it, so the
// grant is per API, not a blanket pass for the file; and an entry whose file no
// longer touches any Bun API is rejected as a dead grant.
//
// Scope: the scan walks `src/` only, so `scripts/` (e.g. `Bun.build` in
// scripts/build.ts) and `tests/` (e.g. `Bun.spawn` in the terminal suite) are
// outside the allowlist by design — runtime neutrality is a shipped-target-code
// rule, and build/test tooling runs under Bun (ADR 0030).
const BUN_API_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ["src/cli/main.ts", new Set(["Bun.main"])],
  ["src/catalog/catalog.ts", new Set(["bun:sqlite"])],
  ["src/run/store/store.ts", new Set(["bun:sqlite"])],
  ["src/tui/renderer/conhost-notice.ts", new Set(["bun:ffi"])],
  ["src/process/windows-containment.ts", new Set(["bun:ffi"])],
]);

/** The Bun API a node touching the `Bun` global reaches for, normalised to a
 *  `Bun.<member>` token. A computed member or a bare reference (an alias like
 *  `const b = Bun`) cannot be named, so it collapses to `Bun`, which no allowlist
 *  entry permits — the safe, fail-closed default. */
function bunMemberToken(reference: ts.Node): string {
  const parent = reference.parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference
  ) {
    return `Bun.${parent.name.text}`;
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
    const argument = parent.argumentExpression;
    return ts.isStringLiteralLike(argument) ? `Bun.${argument.text}` : "Bun";
  }
  return "Bun";
}

/** Every Bun runtime API and `bun:` specifier a source file touches, by parsing
 *  its syntax tree, each mapped to its first touching node in source order.
 *  Catches `Bun.x`, `Bun?.x`, `<expr>.Bun`, `<expr>["Bun"]`, a bare `Bun` alias,
 *  and `bun:` import/require specifiers — not comments or type positions. */
function bunApiTokens(source: ts.SourceFile): Map<string, ts.Node> {
  const touches = new Map<string, ts.Node>();
  const touch = (token: string, node: ts.Node) => {
    if (!touches.has(token)) touches.set(token, node);
  };
  const specifier = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith("bun:")) {
      touch(node.text, node);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifier(node.moduleSpecifier);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifier(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      specifier(node.arguments[0]);
    } else if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
        touch(`Bun.${node.name.text}`, node);
      } else if (node.name.text === "Bun") {
        touch(bunMemberToken(node), node);
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "Bun") {
        const argument = node.argumentExpression;
        touch(
          ts.isStringLiteralLike(argument) ? `Bun.${argument.text}` : "Bun",
          node,
        );
      } else if (
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "Bun"
      ) {
        touch(bunMemberToken(node), node);
      }
    } else if (
      ts.isIdentifier(node) &&
      node.text === "Bun" &&
      !isBunPropertyName(node)
    ) {
      touch(bunMemberToken(node), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return touches;
}

/** Whether a `Bun` identifier is a *name* rather than a value reference — the
 *  `.Bun` of a property access (handled separately) or a `Bun:` key in a type
 *  literal or object (`{ Bun?: … }`), neither of which reaches the Bun global. */
function isBunPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
  );
}

/** The first `shell: true` spawn option in a file — a shell-out that ADR 0030 /
 *  #21 forbid in target source (every spawn resolves the executable directly). */
function shellTrue(source: ts.SourceFile): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "shell") ||
        (ts.isStringLiteralLike(node.name) && node.name.text === "shell")) &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Where each Bun API may be touched: the files keyed to it. */
function homesOf(api: string): string[] {
  return [...BUN_API_ALLOWLIST]
    .filter(([, permitted]) => permitted.has(api))
    .map(([file]) => file);
}

export function checkVendorProvenance(root: string): Finding[] {
  const issues: Finding[] = [];
  const sourceRoot = join(root, "src");
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");

  let vendored: string | undefined;
  const files: string[] = [];
  function discover(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) discover(path);
      else if (SOURCE_EXTENSION.test(entry.name)) files.push(path);
    }
  }
  discover(sourceRoot);

  const allowlistHits = new Set<string>();
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    const relPath = pathOf(file);
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const at = (node: ts.Node) => {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      return { file: relPath, line: line + 1, column: character + 1 };
    };
    const touches = bunApiTokens(source);
    if (touches.size > 0) {
      const permitted = BUN_API_ALLOWLIST.get(relPath);
      if (permitted === undefined) {
        // One finding per file, placed at its first touch.
        issues.push({
          rule: "vendor/bun-api",
          ...at(touches.values().next().value!),
          data: {
            apis: [...touches.keys()].map((api) => ({
              api,
              homes: homesOf(api),
            })),
          },
        });
      } else {
        allowlistHits.add(relPath);
        for (const [api, node] of touches) {
          if (!permitted.has(api)) {
            issues.push({
              rule: "vendor/bun-api-scope",
              ...at(node),
              data: { api, homes: homesOf(api), permitted: [...permitted] },
            });
          }
        }
      }
    }
    const shell = shellTrue(source);
    if (shell)
      issues.push({ rule: "vendor/shell-spawn", ...at(shell), data: {} });
    if (vendored === undefined && text.includes(VENDOR_MARKER))
      vendored = relPath;
  }

  // A dead grant: an allowlist entry whose file no longer touches any Bun API. The
  // grant would silently keep a future `Bun.*` addition unchecked, so it must be
  // retired when its last real use goes (D8).
  for (const [allowlisted, permitted] of BUN_API_ALLOWLIST) {
    const path = join(root, allowlisted);
    if (existsSync(path) && !allowlistHits.has(allowlisted)) {
      issues.push({
        rule: "vendor/dead-grant",
        file: allowlisted,
        line: 1,
        column: 1,
        data: { permitted: [...permitted] },
      });
    }
  }

  if (vendored !== undefined) {
    for (const record of ["UPSTREAM", NOTICES] as const) {
      const recordPath = join(root, record);
      if (!existsSync(recordPath) || !statSync(recordPath).isFile()) {
        issues.push({
          rule: "vendor/provenance-record",
          file: record,
          line: 1,
          column: 1,
          data: { record, vendored },
        });
      }
    }
  }

  return issues;
}

// Scope: every *declared* runtime dependency (package.json `dependencies`) must
// carry a THIRD-PARTY-NOTICES.md section that names the package and its exact pin
// (ADR 0018, D7). This answers ADR 0018's promise of an inventory without a
// generator: the notices are hand-written, and this check keeps them from drifting
// from `package.json`. It is scoped to declared runtime dependencies — transitive
// natives (the per-platform `@opentui/core-*` packages, `bun-ffi-structs`) are
// deferred to the M4 licence gate, which walks the shipped artifact's closure.
// devDependencies are not shipped and are out of scope.
export function checkNoticesCoverage(root: string): Finding[] {
  const issues: Finding[] = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const notices = readFileSync(join(root, NOTICES), "utf8");
  const dependencies: Record<string, string> = pkg.dependencies ?? {};
  const fileLevel = { file: NOTICES, line: 1, column: 1 };
  for (const [name, version] of Object.entries(dependencies)) {
    if (!notices.includes(`\`${name}\``)) {
      issues.push({
        rule: "vendor/notices-section",
        ...fileLevel,
        data: { name, version },
      });
      continue;
    }
    if (!notices.includes(`\`${version}\``)) {
      issues.push({
        rule: "vendor/notices-pin",
        ...fileLevel,
        data: { name, version },
      });
    }
  }
  return issues;
}

// The fenced packages a Module entry's declaration surface must never name (S2).
// A public `.d.ts` that references one means an inferred type crossed the entry
// without an import — the module-boundary check sees no import, so only the emitted
// declaration catches it. The list mirrors the fenced specifiers `module-policy`
// bans (OpenTUI, the MCP SDK, OpenCode packages, PTY transport, the Harness-native
// SDKs).
const BANNED_ENTRY_SPECIFIERS = [
  "@opentui/",
  "@modelcontextprotocol/",
  "@opencode-ai/",
  "node-pty",
  "@anthropic-ai/",
  "@agentclientprotocol/",
  "@google/genai",
  "@openai/",
];

// The one sanctioned exception: the renderer wraps `@opentui/core` and exposes its
// types by design, so `renderer.d.ts` may name that one package and nothing else
// (A29). Every other entry declaration must be free of fenced packages.
const ENTRY_DECLARATION_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ["src/tui/renderer/renderer.ts", new Set(["@opentui/core"])],
]);

/** The fenced-package references in one entry's declaration text, minus that
 *  entry's allowlisted specifiers, each reported against the entry source. Pure,
 *  so a synthetic `.d.ts` exercises it. */
export function scanEntryDeclaration(
  entry: string,
  dtsText: string,
): Finding[] {
  const permitted = ENTRY_DECLARATION_ALLOWLIST.get(entry) ?? new Set<string>();
  const issues: Finding[] = [];
  const seen = new Set<string>();
  for (const banned of BANNED_ENTRY_SPECIFIERS) {
    const pattern = new RegExp(
      `["'\`](${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\`]*)["'\`]`,
      "g",
    );
    for (const match of dtsText.matchAll(pattern)) {
      const specifier = match[1]!;
      if (permitted.has(specifier) || seen.has(specifier)) continue;
      seen.add(specifier);
      issues.push({
        rule: "vendor/entry-declaration",
        file: entry,
        line: 1,
        column: 1,
        data: { specifier },
      });
    }
  }
  return issues;
}

/** What emitting the project's declarations produced: each Module entry's `.d.ts`
 *  text keyed by its entry source path, or the compiler's output when it failed. */
export type DeclarationEmit =
  | { ok: true; declarations: ReadonlyMap<string, string> }
  | { ok: false; output: string };

// Emit each Module entry's `.d.ts` with `tsc --emitDeclarationOnly` (S2). This is
// the one thing the import-graph check cannot see: a type inferred across an entry
// leaves no import specifier, only a reference in the emitted declaration. Runs the
// emit once for the whole project (~7 s) and reads each entry's declaration from the
// temp dir. It spawns `tsc`, so only the structural step calls it; tests inject a
// `DeclarationEmit` instead. Deliberately untested under the runner: the step runs
// it over the real repository on every gate, so a broken emit fails the gate.
export function emitEntryDeclarations(root: string): DeclarationEmit {
  const outDir = mkdtempSync(join(tmpdir(), "secant-entry-dts-"));
  try {
    const emit = spawnSync(
      process.execPath,
      [
        "tsc",
        "-p",
        join(root, "tsconfig.json"),
        "--declaration",
        "--emitDeclarationOnly",
        "--noEmit",
        "false",
        "--pretty",
        "false",
        "--outDir",
        outDir,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (emit.status !== 0)
      return { ok: false, output: `${emit.stdout ?? ""}${emit.stderr ?? ""}` };
    const declarations = new Map<string, string>();
    for (const module of modules) {
      const entry = `${module.root}${module.entry}`;
      const dtsPath = join(outDir, entry.replace(/\.tsx?$/, ".d.ts"));
      if (existsSync(dtsPath))
        declarations.set(entry, readFileSync(dtsPath, "utf8"));
    }
    return { ok: true, declarations };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Scans every emitted entry declaration for a fenced package (S2), or reports the
 *  compiler's first error, at its own location when it names one. */
export function checkEntryDeclarations(emit: DeclarationEmit): Finding[] {
  if (emit.ok)
    return [...emit.declarations].flatMap(([entry, dts]) =>
      scanEntryDeclaration(entry, dts),
    );
  const lines = emit.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const located = lines
    .map((line) => /^(.+?)\((\d+),(\d+)\): (error .*)$/.exec(line))
    .find(Boolean);
  const [where, error] = located
    ? [
        {
          file: located[1]!.split(sep).join("/"),
          line: Number(located[2]),
          column: Number(located[3]),
        },
        located[4]!,
      ]
    : [
        { file: "tsconfig.json", line: 1, column: 1 },
        lines[0] ?? "tsc exited without output",
      ];
  return [{ rule: "vendor/declaration-emit", ...where, data: { error } }];
}
