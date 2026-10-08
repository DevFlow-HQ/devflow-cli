import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeTempDir } from "../helpers/tempDir.js";
import { checkGuidanceStructure, limits } from "./check-guidance-structure.js";
import type { Finding } from "./rule-catalogue.js";

// The checker over synthetic guidance trees. The structural step prints its findings
// and pins each rule's report; these tests pin which findings a tree produces.

async function audit(files: Record<string, string>) {
  const root = makeTempDir("devflow-guidance-structure-");
  const contents = { "AGENTS.md": "# Agent Instructions\n", ...files };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, issues: checkGuidanceStructure(root) };
}

const ids = (issues: Finding[]) => issues.map((issue) => issue.rule);

test("a compliant tree with an indexed Module-local file passes", async () => {
  const { issues } = await audit({
    "AGENTS.md":
      "# Agent Instructions\n\n- Before editing under `src/harness/`, read `src/harness/AGENTS.md`.\n- Read `docs/agents/testing.md`.\n",
    "CLAUDE.md": "@AGENTS.md\n",
    "docs/agents/testing.md": "# Testing\n\nSee [guidance](./guidance.md).\n",
    "docs/agents/guidance.md": "# Guidance\n",
    "src/harness/AGENTS.md": "# Harness\n\n## Owns\n\nQualification.\n",
    "tests/harness/fixtures/codex/resume/recording.jsonl": "{}\n",
    "tests/harness/fixtures/codex/resume/recording.json": JSON.stringify({
      harness: "codex",
      executableVersion: "0.1.0",
      protocolVersion: "codex-probe-2",
      recordedAt: "2026-09-06T00:00:00.000Z",
      redactions: [{ placeholder: "«HOME»", reason: "user home path" }],
      refreshCommand: "bun tests/harness/record-codex.ts resume",
    }),
  });
  assert.deepEqual(issues, []);
});

test("m10-audit-guidance-refresh: the root index and focused documents have hard line caps", async () => {
  const { issues } = await audit({
    "AGENTS.md": "- line\n".repeat(limits.rootLines + 1),
    "docs/agents/testing.md": "line\n".repeat(limits.focusedLines + 1),
  });
  assert.deepEqual(ids(issues), [
    "guidance/root-length",
    "guidance/focused-length",
  ]);
});

test("CLAUDE.md must be the @AGENTS.md import, never a symlink or other text", async () => {
  const symlinked = await audit({});
  await symlink("AGENTS.md", join(symlinked.root, "CLAUDE.md"));
  assert.deepEqual(ids(checkGuidanceStructure(symlinked.root)), [
    "guidance/claude-symlink",
  ]);
  const { issues } = await audit({ "CLAUDE.md": "# Duplicate\n" });
  assert.deepEqual(ids(issues), ["guidance/claude-import"]);
});

test("prose wraps at the column limit while URLs, table rows, and fences are exempt", async () => {
  const long = "a".repeat(limits.proseColumns + 1);
  const { issues } = await audit({
    "docs/agents/testing.md": [
      long,
      `see https://example.com/${long}`,
      `| ${long} |`,
      "```",
      long,
      "```",
      "",
    ].join("\n"),
  });
  assert.deepEqual(ids(issues), ["guidance/prose-width"]);
  assert.equal(issues[0]?.line, 1);
});

test("m10-audit-guidance-refresh: relative links and backticked guidance paths must resolve", async () => {
  const { issues } = await audit({
    "AGENTS.md": "# Agent Instructions\n\n- Read `docs/agents/missing.md`.\n",
    "docs/agents/testing.md":
      "[gone](./gone.md) [ok](../../AGENTS.md) [anchor](#here) [web](https://x.test/a.md)\n",
    "docs/adr/0001-x.md":
      "See [adr](./0002-missing.md) and `some/opencode/AGENTS.md`.\n",
  });
  assert.deepEqual(
    issues.map(({ rule, file, data }) => ({ rule, file, data })),
    [
      {
        rule: "guidance/unresolved-path",
        file: "AGENTS.md",
        data: { target: "docs/agents/missing.md" },
      },
      {
        rule: "guidance/broken-link",
        file: "docs/agents/testing.md",
        data: { target: "./gone.md" },
      },
      {
        rule: "guidance/broken-link",
        file: "docs/adr/0001-x.md",
        data: { target: "./0002-missing.md" },
      },
    ],
  );
});

test("m10-audit-guidance-refresh: Module-local AGENTS.md sits at a declared Module root and is indexed in root AGENTS.md", async () => {
  const { issues } = await audit({
    "src/harness/AGENTS.md": "# Harness\n",
    "src/harness/native/AGENTS.md": "# Native\n",
  });
  assert.deepEqual(
    issues.map(({ rule, file }) => ({ rule, file })),
    [
      { rule: "guidance/module-local-unlisted", file: "src/harness/AGENTS.md" },
      {
        rule: "guidance/module-local-placement",
        file: "src/harness/native/AGENTS.md",
      },
      {
        rule: "guidance/module-local-unlisted",
        file: "src/harness/native/AGENTS.md",
      },
    ],
  );
});

test("recorded Harness fixtures carry a complete recording.json sidecar", async () => {
  const { issues } = await audit({
    "tests/harness/fixtures/codex/bare/events.jsonl": "{}\n",
    "tests/harness/fixtures/claude/partial/recording.json": JSON.stringify({
      harness: "claude",
    }),
  });
  assert.deepEqual(
    issues.find((issue) => issue.rule === "guidance/fixture-sidecar")?.file,
    "tests/harness/fixtures/codex/bare",
  );
  assert.deepEqual(
    issues.find((issue) => issue.rule === "guidance/sidecar-missing-keys")
      ?.data,
    {
      keys: [
        "executableVersion",
        "protocolVersion",
        "recordedAt",
        "redactions",
        "refreshCommand",
      ],
    },
  );
});

test("recorded Harness provenance is exact and unsafe fixture bytes are refused", async () => {
  const { issues } = await audit({
    "tests/harness/fixtures/codex/bad/case.json":
      '{"token":"sk-abcdefghijklmnopqrstuvwxyz012345"}\n',
    "tests/harness/fixtures/codex/bad/recording.json": JSON.stringify({
      harness: "codex",
      executableVersion: "",
      protocolVersion: "app-server v1",
      recordedAt: "synthetic",
      redactions: ["paths"],
      refreshCommand: "bun record",
      extra: true,
    }),
  });
  assert.deepEqual(
    issues.map(({ rule, data }) => ({ rule, data })),
    [
      { rule: "guidance/sidecar-unexpected-keys", data: { keys: ["extra"] } },
      {
        rule: "guidance/sidecar-invalid-value",
        data: { key: "executableVersion" },
      },
      { rule: "guidance/sidecar-invalid-value", data: { key: "redactions" } },
      { rule: "guidance/codex-protocol-version", data: {} },
      { rule: "guidance/synthetic-refresh", data: {} },
      {
        rule: "guidance/fixture-credential",
        data: { labels: ["OpenAI-style API key"] },
      },
    ],
  );
});

test("Module-local AGENTS.md uses only the Module sections, each once and in order", async () => {
  const listed =
    "# Agent Instructions\n\n- `src/harness/AGENTS.md`\n- `src/tui/AGENTS.md`\n";
  const { issues } = await audit({
    "AGENTS.md": listed,
    // Every section missing but one is allowed; a fenced or deeper heading is not a section.
    "src/tui/AGENTS.md":
      "# tui\n\n## Tests\n\n### Anything\n\n```\n## Owns\n```\n",
    "src/harness/AGENTS.md": [
      "# harness",
      "## Owns",
      "## Never owns",
      "## Invariants",
      "## Tests",
      "## Read next",
      "## Notes",
      "## Tests",
      "## Invariants",
      "",
    ].join("\n"),
  });
  assert.deepEqual(
    issues.map(({ file, line, data }) => ({ file, line, data })),
    [
      {
        file: "src/harness/AGENTS.md",
        line: 7,
        data: { heading: "Notes", kind: "disallowed" },
      },
      {
        file: "src/harness/AGENTS.md",
        line: 8,
        data: { heading: "Tests", kind: "repeated" },
      },
      {
        file: "src/harness/AGENTS.md",
        line: 9,
        data: { heading: "Invariants", kind: "repeated" },
      },
    ],
  );
  const reordered = await audit({
    "AGENTS.md": "# Agent Instructions\n\n- `src/harness/AGENTS.md`\n",
    "src/harness/AGENTS.md":
      "# harness\n\n## Tests\n\n## Invariants\n\n## Owns\n\n## Read next\n",
  });
  assert.deepEqual(
    reordered.issues.map(({ line, data }) => ({ line, data })),
    [
      {
        line: 5,
        data: { heading: "Invariants", kind: "out-of-order", after: "Tests" },
      },
      {
        line: 7,
        data: { heading: "Owns", kind: "out-of-order", after: "Tests" },
      },
    ],
  );
});

test("m10-audit-guidance-refresh: the current guidance tree passes its structural check", () => {
  assert.deepEqual(checkGuidanceStructure(process.cwd()), []);
});
