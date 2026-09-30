import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findCredentials } from "../harness/redact.js";
import { ownerOf } from "./module-policy.js";
import type { Finding } from "./rule-catalogue.js";

export const limits = {
  rootLines: 60,
  focusedLines: 120,
  proseColumns: 175,
} as const;

/** The second-level headings a Module-local AGENTS.md may use, in order. */
export const moduleSections = [
  "Owns",
  "Never owns",
  "Invariants",
  "Tests",
  "Read next",
] as const;

export const sidecarKeys = [
  "harness",
  "executableVersion",
  "protocolVersion",
  "recordedAt",
  "redactions",
  "refreshCommand",
] as const;

export type SidecarKey = (typeof sidecarKeys)[number];

type Located = Pick<Finding, "file" | "line" | "column">;
type Report = (finding: Finding) => void;

/** Markdown headings outside code fences, with their 1-based line. */
export function headings(markdown: string) {
  const found: { level: number; text: string; line: number }[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((text, index) => {
    if (text.trimStart().startsWith("```")) fenced = !fenced;
    const heading = !fenced && /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(text);
    if (heading)
      found.push({
        level: heading[1]!.length,
        text: heading[2]!,
        line: index + 1,
      });
  });
  return found;
}

/** Reads the guidance tree as text; loads and executes nothing. */
export function checkGuidanceStructure(root: string): Finding[] {
  const findings: Finding[] = [];
  const pathOf = (path: string) => relative(root, path).split(sep).join("/");
  const at = (file: string, line = 1, column = 1): Located => ({
    file: pathOf(file),
    line,
    column,
  });
  const report: Report = (finding) => findings.push(finding);
  const linesOf = (file: string) => readFileSync(file, "utf8").split("\n");

  const rootIndex = join(root, "AGENTS.md");
  if (!existsSync(rootIndex)) {
    report({ ...at(rootIndex), rule: "guidance/root-index", data: {} });
    return findings;
  }
  const rootText = readFileSync(rootIndex, "utf8");
  if (linesOf(rootIndex).length > limits.rootLines)
    report({
      ...at(rootIndex),
      rule: "guidance/root-length",
      data: { limit: limits.rootLines },
    });

  const claude = join(root, "CLAUDE.md");
  if (isSymlink(claude))
    report({ ...at(claude), rule: "guidance/claude-symlink", data: {} });
  else if (
    existsSync(claude) &&
    readFileSync(claude, "utf8").trim() !== "@AGENTS.md"
  )
    report({ ...at(claude), rule: "guidance/claude-import", data: {} });

  const focused = markdownIn(join(root, "docs/agents"));
  const local = existsSync(join(root, "src"))
    ? findNamed(join(root, "src"), "AGENTS.md")
    : [];
  const wrapped = [
    rootIndex,
    ...focused,
    ...local,
    ...optional(join(root, "CONTEXT.md")),
    ...markdownIn(join(root, "docs/glossary")),
  ];
  const linked = [
    ...wrapped,
    ...markdownIn(join(root, "docs/adr")),
    ...markdownIn(join(root, "docs/research")),
  ];
  const pathChecked = new Set([rootIndex, ...focused]);

  for (const file of [...focused, ...local]) {
    if (linesOf(file).length > limits.focusedLines)
      report({
        ...at(file),
        rule: "guidance/focused-length",
        data: { limit: limits.focusedLines },
      });
  }

  for (const file of local) {
    const directory = pathOf(dirname(file)) + "/";
    const owner = ownerOf(directory);
    if (owner?.root !== directory)
      report({
        ...at(file),
        rule: "guidance/module-local-placement",
        data: { directory, ...(owner && { ownerRoot: owner.root }) },
      });
    if (!rootText.includes(pathOf(file)))
      report({
        ...at(file),
        rule: "guidance/module-local-unlisted",
        data: { file: pathOf(file) },
      });
    checkModuleSections(
      readFileSync(file, "utf8"),
      (line) => at(file, line),
      report,
    );
  }

  for (const file of linked) {
    let fenced = false;
    linesOf(file).forEach((text, index) => {
      const line = index + 1;
      if (text.trimStart().startsWith("```")) fenced = !fenced;
      if (fenced) return;
      if (
        wrapped.includes(file) &&
        text.length > limits.proseColumns &&
        !/https?:\/\//.test(text) &&
        !text.startsWith("|")
      )
        report({
          ...at(file, line, limits.proseColumns + 1),
          rule: "guidance/prose-width",
          data: { columns: text.length, limit: limits.proseColumns },
        });
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^(?:[a-z]+:|#)/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target.split("#")[0]!)))
          report({
            ...at(file, line, match.index + 3),
            rule: "guidance/broken-link",
            data: { target },
          });
      }
      if (!pathChecked.has(file)) return;
      for (const match of text.matchAll(/`([^`<>\s@]+\.md)`/g)) {
        const target = match[1]!;
        if (
          !existsSync(resolve(dirname(file), target)) &&
          !existsSync(resolve(root, target))
        )
          report({
            ...at(file, line, match.index + 2),
            rule: "guidance/unresolved-path",
            data: { target },
          });
      }
    });
  }

  const fixtures = join(root, "tests/harness/fixtures");
  if (existsSync(fixtures)) {
    for (const harness of subdirectories(fixtures)) {
      for (const recording of subdirectories(harness)) {
        const sidecar = join(recording, "recording.json");
        if (!existsSync(sidecar)) {
          report({
            ...at(recording),
            rule: "guidance/fixture-sidecar",
            data: { sidecar: pathOf(sidecar) },
          });
          continue;
        }
        const metadata = parseObject(sidecar);
        const missing = sidecarKeys.filter((key) => !(key in metadata));
        if (missing.length)
          report({
            ...at(sidecar),
            rule: "guidance/sidecar-missing-keys",
            data: { keys: missing },
          });
        const extra = Object.keys(metadata).filter(
          (key) => !sidecarKeys.includes(key as SidecarKey),
        );
        if (extra.length)
          report({
            ...at(sidecar),
            rule: "guidance/sidecar-unexpected-keys",
            data: { keys: extra },
          });
        validateRecordingMetadata(metadata, at(sidecar), report);
        for (const file of filesIn(recording)) {
          const labels = findCredentials(readFileSync(file, "utf8"));
          if (labels.length > 0)
            report({
              ...at(file),
              rule: "guidance/fixture-credential",
              data: { labels },
            });
        }
      }
    }
  }

  return findings;
}

/** A Module-local AGENTS.md uses only the Module sections as `##` headings, each
 *  once and in order; a missing section is allowed. */
function checkModuleSections(
  markdown: string,
  at: (line: number) => Located,
  report: Report,
): void {
  const seen = new Set<string>();
  let highest = -1;
  for (const { level, text: heading, line } of headings(markdown)) {
    if (level !== 2) continue;
    const rank = (moduleSections as readonly string[]).indexOf(heading);
    const where = { ...at(line), rule: "guidance/module-section" } as const;
    if (rank < 0) report({ ...where, data: { heading, kind: "disallowed" } });
    else if (seen.has(heading))
      report({ ...where, data: { heading, kind: "repeated" } });
    else if (rank < highest)
      report({
        ...where,
        data: {
          heading,
          kind: "out-of-order",
          after: moduleSections[highest]!,
        },
      });
    if (rank < 0) continue;
    seen.add(heading);
    highest = Math.max(highest, rank);
  }
}

function validateRecordingMetadata(
  metadata: Record<string, unknown>,
  sidecar: Located,
  report: Report,
): void {
  const invalid = (key: SidecarKey) =>
    report({
      ...sidecar,
      rule: "guidance/sidecar-invalid-value",
      data: { key },
    });
  for (const key of [
    "harness",
    "executableVersion",
    "protocolVersion",
    "refreshCommand",
  ] as const) {
    if (
      typeof metadata[key] !== "string" ||
      metadata[key].trim().length === 0
    ) {
      invalid(key);
    }
  }
  if (
    metadata.recordedAt !== "synthetic" &&
    (typeof metadata.recordedAt !== "string" ||
      !isIsoInstant(metadata.recordedAt))
  ) {
    invalid("recordedAt");
  }
  if (
    !Array.isArray(metadata.redactions) ||
    metadata.redactions.some(
      (entry) =>
        !isObject(entry) ||
        typeof entry.placeholder !== "string" ||
        entry.placeholder.length === 0 ||
        typeof entry.reason !== "string" ||
        entry.reason.length === 0,
    )
  ) {
    invalid("redactions");
  }
  if (
    metadata.harness === "codex" &&
    (typeof metadata.protocolVersion !== "string" ||
      !/^codex-probe-\d+$/.test(metadata.protocolVersion))
  ) {
    report({ ...sidecar, rule: "guidance/codex-protocol-version", data: {} });
  }
  if (
    metadata.recordedAt === "synthetic" &&
    (typeof metadata.refreshCommand !== "string" ||
      !/^synthetic -- .+/.test(metadata.refreshCommand))
  ) {
    report({ ...sidecar, rule: "guidance/synthetic-refresh", data: {} });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function optional(path: string) {
  return existsSync(path) ? [path] : [];
}

function markdownIn(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(directory, name));
}

function subdirectories(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
    .sort();
}

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

function findNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findNamed(path, name);
      return entry.name === name ? [path] : [];
    });
}

function parseObject(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
