import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANDIDATE_CHECK_JOBS } from "../../scripts/release-gate.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  CI_WORKFLOW,
  checkReleasePromotion,
  checkReleaseWorkflow,
  checkReleaseProtection,
  checkValidationWorkflow,
  readWorkflow,
} from "./check-release-workflow.js";
import {
  jobsToEdit,
  stepsToEdit,
  validWorkflow,
} from "./release-workflow-fixture.js";
import type { Finding, RuleId } from "./rule-catalogue.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// These tests prove each guard over a synthetic workflow that breaks exactly that
// guard. The real workflow is reported only by the structural step (`bun run
// structure:check`); its report wording is pinned in structural-step.test.ts.

/** Whether `findings` report `rule`, with `data` among its fields when given. */
function reports(
  findings: Finding[],
  rule: RuleId,
  data: Record<string, unknown> = {},
) {
  return findings.some(
    (finding) =>
      finding.rule === rule &&
      Object.entries(data).every(
        ([key, value]) =>
          (finding.data as Record<string, unknown>)[key] === value,
      ),
  );
}

test("the approval summary's blocking-jobs list matches release-approval's needs", () => {
  // The reviewer-facing CANDIDATE_CHECK_JOBS list and the workflow's actual gating
  // edges must not drift; checkReleaseProtection guards the needs graph, this guards
  // the display copy.
  const jobs = (
    readWorkflow(repoRoot) as { jobs: Record<string, { needs: string[] }> }
  ).jobs;
  assert.deepEqual(
    [...CANDIDATE_CHECK_JOBS].sort(),
    [...jobs["release-approval"]!.needs].sort(),
  );
});

test("a missing or unparseable workflow is a tool failure, not a finding", async () => {
  const root = makeTempDir("secant-workflow-");
  assert.throws(() => checkReleaseWorkflow(root), /ENOENT/);
  await mkdir(dirname(join(root, CI_WORKFLOW)), { recursive: true });
  await writeFile(join(root, CI_WORKFLOW), "jobs: [unclosed\n");
  assert.throws(
    () => checkReleaseWorkflow(root),
    new RegExp(`${CI_WORKFLOW} is not valid YAML`),
  );
});

test("the workflow is read from YAML and checked by all three scenarios", async () => {
  const root = makeTempDir("secant-workflow-");
  await mkdir(dirname(join(root, CI_WORKFLOW)), { recursive: true });
  await writeFile(join(root, CI_WORKFLOW), "on: push\njobs: {}\n");
  assert.deepEqual(
    checkReleaseWorkflow(root).map((finding) => finding.rule),
    [
      "release/dispatch-trigger",
      "release/no-build-job",
      "release/protection-no-promote-job",
      "release/promotion-no-promote-job",
    ],
  );
});

test("the minimal valid workflow passes, so each negative isolates one guard", () => {
  assert.deepEqual(checkValidationWorkflow(validWorkflow()), []);
});

test("a non-mapping workflow fails closed", () => {
  for (const workflow of ["not a workflow", null])
    assert.deepEqual(
      checkValidationWorkflow(workflow).map((finding) => finding.rule),
      ["release/workflow-not-mapping"],
    );
});

test("a workflow without a manual dispatch entrypoint is rejected", () => {
  const workflow = validWorkflow();
  workflow.on = { push: null, pull_request: null };
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/dispatch-trigger"),
  );
});

test("a build job that never runs the dry-run is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.build.steps = stepsToEdit(jobs.build).slice(0, 5);
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/missing-dry-run"),
  );
});

test("a downstream job missing `needs: build` is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.smoke.needs;
  assert.ok(reports(checkValidationWorkflow(workflow), "release/needs-build"));
});

test("a downstream job that does not download the artifact is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.smoke.steps = [
    { run: "bun scripts/package-smoke.ts dist/secant-linux-x64" },
  ];
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/candidate-download"),
  );
});

test("a non-build job that re-runs an assembly script is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { run: "bun run scripts/assemble.ts" },
  ];
  assert.ok(reports(checkValidationWorkflow(workflow), "release/reassembly"));
});

test("a secret outside the build dry-run step is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    {
      if: "github.event_name == 'workflow_dispatch'",
      env: { TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" },
      run: "echo hi",
    },
  ];
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/secret-outside-build"),
  );
});

test("a credentialed step not gated on workflow_dispatch is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  const step = stepsToEdit(jobs.build)[5]!;
  delete step.if;
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/ungated-credential"),
  );
});

test("a NEGATED dispatch guard on a credentialed step is rejected", () => {
  // The exact opposite gate — runs on every push/PR, skips only on dispatch — still
  // contains the substring "workflow_dispatch", so a substring test would pass it.
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  const step = stepsToEdit(jobs.build)[5]!;
  step.if = "github.event_name != 'workflow_dispatch'";
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/ungated-credential"),
  );
});

test("a job-level env secret is rejected", () => {
  // Placed on the whole job (sibling of steps), it cannot be dispatch-gated: an
  // ungated step then runs with the credential on every push.
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.build.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/job-env-secret"),
  );
});

test("a workflow-level env secret is rejected", () => {
  const workflow = validWorkflow();
  workflow.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_READONLY_TOKEN }}" };
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/workflow-env-secret"),
  );
});

test("a publication-capable secret is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  const step = stepsToEdit(jobs.build)[5]!;
  step.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" };
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/secret-not-read-only"),
  );
});

test("a protected environment is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.build.environment = "release";
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/stray-environment"),
  );
});

test("a real npm publish is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  stepsToEdit(jobs.smoke).push({
    run: "npm publish dist/packages/secant.tgz",
  });
  assert.ok(reports(checkValidationWorkflow(workflow), "release/real-publish"));
});

test("a GitHub-release action or `gh release` is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { uses: "softprops/action-gh-release@v2" },
  ];
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/release-action"),
  );

  const withGhRelease = validWorkflow();
  const jobs2 = jobsToEdit(withGhRelease);
  stepsToEdit(jobs2.smoke).push({
    run: "gh release create v1.0.0",
  });
  assert.ok(
    reports(checkValidationWorkflow(withGhRelease), "release/gh-release"),
  );
});

test("a retry action is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.smoke.steps = [
    { uses: "actions/download-artifact@v4" },
    { uses: "nick-fields/retry@v3" },
  ];
  assert.ok(reports(checkValidationWorkflow(workflow), "release/retry-action"));
});

// --- release-protection-policy scenario (#158) -----------------------------------
// The minimal valid workflow passes protection too, so each negative below isolates one
// protection guard.

test("the minimal valid workflow passes release protection", () => {
  assert.deepEqual(checkReleaseProtection(validWorkflow()), []);
});

test("release protection fails closed on a non-mapping workflow", () => {
  for (const workflow of ["nope", null])
    assert.deepEqual(
      checkReleaseProtection(workflow).map((finding) => finding.rule),
      ["release/protection-no-jobs"],
    );
});

test("a workflow without a promote job is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.promote;
  assert.ok(
    reports(
      checkReleaseProtection(workflow),
      "release/protection-no-promote-job",
    ),
  );
});

test("a promote job without the protected release environment is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.promote.environment;
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/protection-environment"),
  );
});

test("a promote job targeting the wrong environment is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.promote.environment = "staging";
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/protection-environment"),
  );
});

test("a candidate check that does not gate promotion is rejected", () => {
  // smoke drops out of the dependency chain, so the protected environment could be
  // reached without it.
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs["release-approval"].needs = ["check", "build"];
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/promote-needs", {
      job: "smoke",
    }),
  );
});

test("a promote job not gated on a tag ref is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.promote.if;
  assert.ok(reports(checkReleaseProtection(workflow), "release/tag-ref-gate"));
});

test("a job gated on a non-`v` tag ref is rejected", () => {
  // `refs/tags/` alone is not enough: the `v*` shape is part of the invariant.
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.promote.if = "startsWith(github.ref, 'refs/tags/')";
  assert.ok(reports(checkReleaseProtection(workflow), "release/tag-ref-gate"));
});

test("an approval job that never runs the tag/version gate is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs["release-approval"].steps = [{ uses: "actions/download-artifact@v4" }];
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/missing-tag-gate"),
  );
});

test("a publication credential on a pre-approval promotion job is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  stepsToEdit(jobs["release-approval"]).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "echo x",
  });
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/approval-secret"),
  );
});

// --- release-promotion-state-machine scenario (#159) -----------------------------

test("the minimal valid workflow passes release promotion", () => {
  assert.deepEqual(checkReleasePromotion(validWorkflow()), []);
});

test("release promotion fails closed on a non-mapping workflow", () => {
  for (const workflow of ["nope", null])
    assert.deepEqual(
      checkReleasePromotion(workflow).map((finding) => finding.rule),
      ["release/promotion-no-jobs"],
    );
});

test("release promotion requires the protected promote job and environment", () => {
  const missing = validWorkflow();
  const missingJobs = jobsToEdit(missing);
  delete missingJobs.promote;
  assert.ok(
    reports(checkReleasePromotion(missing), "release/promotion-no-promote-job"),
  );

  const wrongEnvironment = validWorkflow();
  const wrongJobs = jobsToEdit(wrongEnvironment);
  wrongJobs.promote.environment = "staging";
  assert.ok(
    reports(
      checkReleasePromotion(wrongEnvironment),
      "release/promotion-environment",
    ),
  );
});

test("promotion must run the one release state-machine script", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  const steps = stepsToEdit(jobs.promote);
  steps[3]!.run = "echo approved";
  assert.ok(
    reports(
      checkReleasePromotion(workflow),
      "release/missing-promotion-script",
    ),
  );
});

test("promotion must download both approved candidate artifacts", () => {
  for (const missing of ["release-archives", "platform-packages"]) {
    const workflow = validWorkflow();
    const jobs = jobsToEdit(workflow);
    jobs.promote.steps = stepsToEdit(jobs.promote).filter(
      (step) =>
        (step.with as Record<string, unknown> | undefined)?.name !== missing,
    );
    assert.ok(
      reports(checkReleasePromotion(workflow), "release/promote-download", {
        artifact: missing,
      }),
    );
  }
});

test("the publication credential must exist only on the protected promote step", () => {
  const missingCredential = validWorkflow();
  const missingJobs = jobsToEdit(missingCredential);
  const promotionStep = stepsToEdit(missingJobs.promote)[3]!;
  promotionStep.env = { GH_TOKEN: "${{ github.token }}" };
  assert.ok(
    reports(
      checkReleasePromotion(missingCredential),
      "release/credential-count",
      { count: 0 },
    ),
  );

  const duplicateCredential = validWorkflow();
  const duplicateJobs = jobsToEdit(duplicateCredential);
  stepsToEdit(duplicateJobs.promote).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "bun scripts/release-promote.ts duplicate",
  });
  assert.ok(
    reports(
      checkReleasePromotion(duplicateCredential),
      "release/credential-count",
      { count: 2 },
    ),
  );

  const earlyCredential = validWorkflow();
  const earlyJobs = jobsToEdit(earlyCredential);
  stepsToEdit(earlyJobs.smoke).push({
    env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_PUBLISH_TOKEN }}" },
    run: "echo leaked",
  });
  assert.ok(
    reports(
      checkReleasePromotion(earlyCredential),
      "release/credential-placement",
      { job: "smoke" },
    ),
  );

  const extraCredential = validWorkflow();
  const extraJobs = jobsToEdit(extraCredential);
  const extraStep = stepsToEdit(extraJobs.promote)[3]!;
  extraStep.env = {
    ...(extraStep.env as Record<string, unknown>),
    EXTRA_TOKEN: "${{ secrets.EXTRA_TOKEN }}",
  };
  assert.ok(
    reports(
      checkReleasePromotion(extraCredential),
      "release/promote-unexpected-secret",
      { secret: "EXTRA_TOKEN" },
    ),
  );
});

test("the promotion state machine cannot run outside protected promote", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  stepsToEdit(jobs.smoke).push({
    run: "bun scripts/release-promote.ts dist/release dist/packages",
  });
  assert.ok(
    reports(
      checkReleasePromotion(workflow),
      "release/promotion-script-placement",
      { job: "smoke" },
    ),
  );
});

test("promotion needs GitHub contents write permission for release assets", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  jobs.promote.permissions = { contents: "read" };
  assert.ok(
    reports(checkReleasePromotion(workflow), "release/promote-permissions"),
  );
});
