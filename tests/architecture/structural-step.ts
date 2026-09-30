// The structural step of the canonical gate (`bun run structure:check`), run after
// lint and before the tests. It is the only place structural violations print: each
// as `<file>:<line>:<col>  <rule-id>  <what is wrong>`, then `fix:`, then `see:`,
// with nothing else on stdout. It fails on any violation, including a `see:` anchor
// that names no heading.
import {
  checkModuleBoundaries,
  checkTestDomainMirror,
} from "./check-module-boundaries.js";
import { checkReleaseWorkflow } from "./check-release-workflow.js";
import { formatFinding, unresolvedAnchors } from "./rule-catalogue.js";

/** Reports every structural violation under `root` and returns the exit code. */
export function runStructuralStep(
  root: string,
  write: (text: string) => void,
): number {
  const findings = [
    ...unresolvedAnchors(root),
    ...checkModuleBoundaries(root),
    ...checkTestDomainMirror(root),
    ...checkReleaseWorkflow(root),
  ];
  for (const finding of findings) write(formatFinding(finding) + "\n");
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main)
  process.exitCode = runStructuralStep(process.cwd(), (text) =>
    process.stdout.write(text),
  );
