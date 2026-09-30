// The structural step of the canonical gate (`bun run structure:check`), run after
// lint and before the tests. It is the only place structural violations print: each
// as `<file>:<line>:<col>  <rule-id>  <what is wrong>`, then `fix:`, then `see:`,
// with nothing else on stdout. It fails on any violation, including a `see:` anchor
// that names no heading. It spawns `tsc` once to emit the Module entries'
// declarations; its tests inject that emit.
import { checkGuidanceStructure } from "./check-guidance-structure.js";
import {
  checkModuleBoundaries,
  checkTestDomainMirror,
} from "./check-module-boundaries.js";
import { checkReleaseWorkflow } from "./check-release-workflow.js";
import {
  checkEntryDeclarations,
  checkNoticesCoverage,
  checkVendorProvenance,
  emitEntryDeclarations,
  type DeclarationEmit,
} from "./check-vendor-provenance.js";
import { formatFinding, unresolvedAnchors } from "./rule-catalogue.js";

/** Reports every structural violation under `root` and returns the exit code. */
export function runStructuralStep(
  root: string,
  write: (text: string) => void,
  emitDeclarations: (root: string) => DeclarationEmit,
): number {
  const findings = [
    ...unresolvedAnchors(root),
    ...checkModuleBoundaries(root),
    ...checkTestDomainMirror(root),
    ...checkGuidanceStructure(root),
    ...checkReleaseWorkflow(root),
    ...checkVendorProvenance(root),
    ...checkNoticesCoverage(root),
    ...checkEntryDeclarations(emitDeclarations(root)),
  ];
  for (const finding of findings) write(formatFinding(finding) + "\n");
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main)
  process.exitCode = runStructuralStep(
    process.cwd(),
    (text) => process.stdout.write(text),
    emitEntryDeclarations,
  );
