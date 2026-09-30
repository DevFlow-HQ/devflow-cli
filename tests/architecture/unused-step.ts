// The unused-code link of the canonical gate (`bun run unused:check`), run right
// after the structural step. knip finds unused files, dependencies, exports, and
// types under `knip.jsonc`; this link reprints each finding in the structural report
// form (`<file>:<line>:<col>  unused/…  <what is wrong>`, then `fix:`, then `see:`),
// with nothing else on stdout. It fails on any finding, and on a knip report it
// cannot read, rather than passing it.
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { formatFinding, type Finding } from "./rule-catalogue.js";

const knipEntry = z.object({
  name: z.string(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
});

// Only the four enabled categories may appear; knip's `dependencies` category also
// reports the devDependencies and optionalPeerDependencies fields.
const knipReport = z.object({
  issues: z.array(
    z
      .object({
        file: z.string(),
        files: z.array(knipEntry),
        dependencies: z.array(knipEntry),
        devDependencies: z.array(knipEntry),
        optionalPeerDependencies: z.array(knipEntry),
        exports: z.array(knipEntry),
        types: z.array(knipEntry),
      })
      .strict(),
  ),
});

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalPeerDependencies",
] as const;

/** Every finding in knip's JSON report, as catalogued `unused/…` findings. An
 *  unused file has no native line, so it reports 1:1. */
function unusedFindings(json: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error("knip printed a report that is not JSON", { cause });
  }
  const report = knipReport.safeParse(parsed);
  if (!report.success)
    throw new Error(
      `knip printed an unexpected report: ${z.prettifyError(report.error)}`,
    );
  const findings: Finding[] = [];
  for (const issue of report.data.issues) {
    const locate = (entry: z.infer<typeof knipEntry>) => ({
      file: issue.file,
      line: entry.line ?? 1,
      column: entry.col ?? 1,
    });
    for (const entry of issue.files)
      findings.push({
        rule: "unused/file",
        file: entry.name,
        line: 1,
        column: 1,
        data: {},
      });
    for (const field of dependencyFields)
      for (const entry of issue[field])
        findings.push({
          rule: "unused/dependency",
          ...locate(entry),
          data: { name: entry.name, field },
        });
    for (const entry of issue.exports)
      findings.push({
        rule: "unused/export",
        ...locate(entry),
        data: { name: entry.name },
      });
    for (const entry of issue.types)
      findings.push({
        rule: "unused/type",
        ...locate(entry),
        data: { name: entry.name },
      });
  }
  return findings;
}

/** Reprints knip's JSON report through the report contract and returns the exit code. */
export function reprintKnipReport(
  json: string,
  write: (text: string) => void,
): number {
  const findings = unusedFindings(json);
  for (const finding of findings) write(formatFinding(finding) + "\n");
  return findings.length === 0 ? 0 : 1;
}

/** knip exits 0 when clean and 1 when it found issues. Any other exit, a report it
 *  cannot read, or an exit that disagrees with the report is knip's own failure,
 *  exit 2, and never a pass. */
function knipExitCode(status: number | null, stdout: string): number {
  if (status !== 0 && status !== 1) return 2;
  let exitCode: number;
  try {
    exitCode = reprintKnipReport(stdout, (text) => process.stdout.write(text));
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 2;
  }
  return exitCode === status ? exitCode : 2;
}

if (import.meta.main) {
  // `knip-bun` runs knip under Bun, so the link needs no Node toolchain.
  const knip = spawnSync(
    process.execPath,
    ["knip-bun", "--reporter", "json", "--no-progress"],
    { encoding: "utf8" },
  );
  process.exitCode = knipExitCode(knip.status, knip.stdout);
  if (process.exitCode === 2)
    process.stderr.write(knip.stderr || String(knip.error ?? "knip failed"));
}
