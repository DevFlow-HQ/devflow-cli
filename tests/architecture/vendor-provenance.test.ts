import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  checkEntryDeclarations,
  checkNoticesCoverage,
  checkVendorProvenance,
  scanEntryDeclaration,
} from "./check-vendor-provenance.js";
import type { Finding } from "./rule-catalogue.js";

// The checker logic over synthetic trees. The real repository is checked, and every
// report pinned, by the structural step (structural-step.test.ts).

const rulesOf = (findings: Finding[]) => findings.map((f) => f.rule);

/** Builds a synthetic repo tree under a shared-helper temp dir (auto-cleaned). */
function synthetic(build: (root: string) => void): string {
  const root = makeTempDir("secant-provenance-");
  mkdirSync(join(root, "src"), { recursive: true });
  build(root);
  return root;
}

test("a fenced package in a non-renderer entry declaration is flagged (S2)", () => {
  // A type inferred across the entry leaves this reference in the emitted .d.ts;
  // the import-graph check never sees it because there is no import.
  const issues = scanEntryDeclaration(
    "src/application/application.ts",
    'export declare function make(): import("@opentui/core").Renderable;\n',
  );
  assert.deepEqual(
    issues.map((issue) => [issue.rule, issue.file, issue.data]),
    [
      [
        "vendor/entry-declaration",
        "src/application/application.ts",
        { specifier: "@opentui/core" },
      ],
    ],
  );
});

test("Pino never crosses the composition entry's declarations (S2)", () => {
  // Composition may import Pino, but no Pino type may leak through its entry.
  assert.deepEqual(
    scanEntryDeclaration(
      "src/composition/main.ts",
      'export declare function log(): import("pino").Logger;\n',
    ).map((issue) => [issue.rule, issue.data]),
    [["vendor/entry-declaration", { specifier: "pino" }]],
  );
});

test("the renderer entry may name @opentui/core but not another fenced package (S2)", () => {
  assert.deepEqual(
    scanEntryDeclaration(
      "src/tui/renderer/renderer.ts",
      'export declare const r: import("@opentui/core").CliRenderer;\n',
    ),
    [],
  );
  const strayed = scanEntryDeclaration(
    "src/tui/renderer/renderer.ts",
    'export declare const c: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;\n',
  );
  assert.deepEqual(
    strayed.map((issue) => issue.data),
    [{ specifier: "@modelcontextprotocol/sdk/server/mcp.js" }],
  );
});

test("a runtime dependency missing from the notices is rejected", () => {
  const root = makeTempDir("secant-notices-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      dependencies: { present: "1.0.0", "missing-dep": "2.3.4" },
    }),
  );
  writeFileSync(
    join(root, "THIRD-PARTY-NOTICES.md"),
    "## present\n\n`present` pinned at `1.0.0`.\n",
  );
  assert.deepEqual(
    checkNoticesCoverage(root).map((issue) => [issue.rule, issue.data]),
    [["vendor/notices-section", { name: "missing-dep", version: "2.3.4" }]],
  );
});

test("a notices section that names the wrong pin is rejected", () => {
  const root = makeTempDir("secant-notices-pin-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { drifted: "9.9.9" } }),
  );
  writeFileSync(
    join(root, "THIRD-PARTY-NOTICES.md"),
    "## drifted\n\n`drifted` pinned at `1.0.0`.\n",
  );
  assert.deepEqual(
    checkNoticesCoverage(root).map((issue) => [issue.rule, issue.data]),
    [["vendor/notices-pin", { name: "drifted", version: "9.9.9" }]],
  );
});

test("a synthetic Bun.* call in target source is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "leak.ts"),
      "export const w = Bun.stringWidth('x');\n",
    );
    writeFileSync(join(r, "UPSTREAM"), "x\n");
    writeFileSync(join(r, "THIRD-PARTY-NOTICES.md"), "x\n");
  });
  assert.deepEqual(rulesOf(checkVendorProvenance(root)), ["vendor/bun-api"]);
});

test("a synthetic bun: import in target source is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "adapter.ts"),
      'import { Database } from "bun:sqlite";\nexport const db = Database;\n',
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(root)).includes("vendor/bun-api"),
    "expected a bun: import violation",
  );
});

test("a bun: specifier written as a template literal does not evade the check", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "sneaky.ts"),
      "export const db = await import(`bun:sqlite`);\n",
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(root)).includes("vendor/bun-api"),
    "expected the backtick-quoted bun: import to be flagged",
  );
});

test("an allowlisted target file may touch its permitted Bun API", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // src/cli/main.ts is keyed to `Bun.main` specifically; using exactly that
    // permitted API passes.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const isEntry = Bun.main === import.meta.url;\n",
    );
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});

test("an allowlisted file touching a Bun API other than its permitted one is rejected", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "run", "store"), { recursive: true });
    // store.ts is keyed to `bun:sqlite` only; the extra `Bun.spawn` is a
    // different Bun API and must be flagged even though the file is allowlisted.
    writeFileSync(
      join(r, "src", "run", "store", "store.ts"),
      'import { Database } from "bun:sqlite";\nexport const child = Bun.spawn(["true"]);\nexport const d = Database;\n',
    );
  });
  const issues = checkVendorProvenance(root);
  // Exactly the non-permitted API is flagged; the permitted `bun:sqlite` import
  // raises nothing on its own.
  assert.deepEqual(
    issues.map((issue) => [issue.rule, issue.line, issue.data]),
    [
      [
        "vendor/bun-api-scope",
        2,
        { api: "Bun.spawn", homes: [], permitted: ["bun:sqlite"] },
      ],
    ],
  );
});

test("the `globalThis.Bun?.main` form the old regex missed is flagged (D8)", () => {
  const root = synthetic((r) => {
    // The exact bypass the regex let through: a member access whose *name* is
    // `Bun`, reached through `globalThis`. At HEAD this passed unchecked.
    writeFileSync(
      join(r, "src", "sneaky.ts"),
      "export const m = (globalThis as { Bun?: { main?: string } }).Bun?.main;\n",
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(root)).includes("vendor/bun-api"),
    "expected globalThis.Bun?.main to be flagged",
  );
});

test('`globalThis["Bun"]` and a bare `Bun` alias are flagged (D8)', () => {
  const bracket = synthetic((r) => {
    writeFileSync(
      join(r, "src", "bracket.ts"),
      'export const s = (globalThis as Record<string, { spawn(x: string[]): unknown }>)["Bun"].spawn(["true"]);\n',
    );
  });
  assert.ok(rulesOf(checkVendorProvenance(bracket)).includes("vendor/bun-api"));
  const alias = synthetic((r) => {
    writeFileSync(
      join(r, "src", "alias.ts"),
      "declare const Bun: { spawn(x: string[]): unknown };\nconst b = Bun;\nexport const s = b.spawn([]);\n",
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(alias)).includes("vendor/bun-api"),
    "aliasing the Bun global must not evade the check",
  );
});

test("a `shell: true` spawn in target source is rejected (D8)", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "spawner.ts"),
      'import { spawnSync } from "node:child_process";\nexport const r = spawnSync("ls", { shell: true });\n',
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(root)).includes("vendor/shell-spawn"),
    "expected a shell: true spawn to be flagged",
  );
});

test("an allowlist entry with no live Bun access is a dead grant (D8)", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // src/cli/main.ts is allowlisted for `Bun.main`, but this copy touches no Bun
    // API, so the grant is dead and must be retired.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const isEntry = import.meta.url;\n",
    );
  });
  assert.ok(
    rulesOf(checkVendorProvenance(root)).includes("vendor/dead-grant"),
    "expected the unused allowlist entry to be reported",
  );
});

test("the allowlisted `globalThis.Bun?.main` entry form is accepted (D8)", () => {
  const root = synthetic((r) => {
    mkdirSync(join(r, "src", "cli"), { recursive: true });
    // The real main.ts shape resolves to the `Bun.main` token it is keyed to.
    writeFileSync(
      join(r, "src", "cli", "main.ts"),
      "export const m = (globalThis as { Bun?: { main?: string } }).Bun?.main;\n",
    );
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});

test("a vendored file without the provenance records is rejected", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "copied.ts"),
      "// Vendored from OpenCode at commit deadbeef.\nexport const x = 1;\n",
    );
  });
  assert.deepEqual(
    checkVendorProvenance(root).map((issue) => [issue.rule, issue.file]),
    [
      ["vendor/provenance-record", "UPSTREAM"],
      ["vendor/provenance-record", "THIRD-PARTY-NOTICES.md"],
    ],
  );
});

test("a vendored file with both records present is accepted", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "copied.ts"),
      "// Vendored from OpenCode at commit deadbeef.\nexport const x = 1;\n",
    );
    writeFileSync(join(r, "UPSTREAM"), "provenance\n");
    writeFileSync(join(r, "THIRD-PARTY-NOTICES.md"), "notices\n");
  });
  assert.deepEqual(checkVendorProvenance(root), []);
});

test("a file touching several Bun APIs is one finding at its first touch", () => {
  const root = synthetic((r) => {
    writeFileSync(
      join(r, "src", "leak.ts"),
      'export const w = 1;\nexport const m = Bun.main;\nimport { Database } from "bun:sqlite";\nexport const d = Database;\n',
    );
  });
  assert.deepEqual(
    checkVendorProvenance(root).map((issue) => [
      issue.rule,
      issue.line,
      issue.column,
      issue.data,
    ]),
    [
      [
        "vendor/bun-api",
        2,
        18,
        {
          apis: [
            { api: "Bun.main", homes: ["src/cli/main.ts"] },
            {
              api: "bun:sqlite",
              homes: ["src/catalog/catalog.ts", "src/run/store/store.ts"],
            },
          ],
        },
      ],
    ],
  );
});

test("a declaration emit failure naming no location reports tsconfig.json with its first line", () => {
  assert.deepEqual(
    checkEntryDeclarations({
      ok: false,
      output: "\nerror TS5058: The specified path does not exist.\nmore\n",
    }),
    [
      {
        rule: "vendor/declaration-emit",
        file: "tsconfig.json",
        line: 1,
        column: 1,
        data: { error: "error TS5058: The specified path does not exist." },
      },
    ],
  );
});

test("clean emitted declarations raise nothing", () => {
  assert.deepEqual(
    checkEntryDeclarations({
      ok: true,
      declarations: new Map([
        ["src/tui/renderer/renderer.ts", 'import("@opentui/core");\n'],
        ["src/application/application.ts", "export {};\n"],
      ]),
    }),
    [],
  );
});
