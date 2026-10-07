import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CANDIDATE_CHECK_JOBS } from "../../scripts/release-gate.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  CI_WORKFLOW,
  checkScenarioSelection,
  checkReleasePromotion,
  checkReleaseWorkflow,
  checkReleaseProtection,
  checkValidationWorkflow,
  readWorkflow,
} from "./check-release-workflow.js";
import {
  CHECK_SCENARIO,
  CHECK_SCENARIO_FILES,
  CHECK_SCENARIO_SOURCES,
  jobsToEdit,
  stepsToEdit,
  validWorkflow,
} from "./release-workflow-fixture.js";
import type { Finding, RuleId } from "./rule-catalogue.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function fixtureSource(overrides: Record<string, string> = {}) {
  return (path: string) =>
    overrides[path] ?? CHECK_SCENARIO_SOURCES[path] ?? "";
}

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

test("the workflow is read from YAML and checked by all four policies", async () => {
  const root = makeTempDir("secant-workflow-");
  await mkdir(dirname(join(root, CI_WORKFLOW)), { recursive: true });
  await writeFile(join(root, CI_WORKFLOW), "on: push\njobs: {}\n");
  assert.deepEqual(
    checkReleaseWorkflow(root).map((finding) => finding.rule),
    [
      "release/check-triggers",
      "release/check-job",
      "release/dispatch-trigger",
      "release/no-build-job",
      "release/protection-no-promote-job",
      "release/promotion-no-promote-job",
    ],
  );
});

test("the minimal valid workflow passes, so each negative isolates one guard", () => {
  assert.deepEqual(
    checkScenarioSelection(
      validWorkflow(),
      (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
    ),
    [],
  );
  assert.deepEqual(checkValidationWorkflow(validWorkflow()), []);
});

test("m12-focused-check-scenarios: a named scenario without a test-name filter is rejected", () => {
  for (const mutation of ["filter", "separator"] as const) {
    const workflow = validWorkflow();
    const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
      (step) => step.name === CHECK_SCENARIO,
    )!;
    scenario.run =
      mutation === "filter"
        ? `bun run test -- ${CHECK_SCENARIO_FILES.join(" ")}`
        : `bun run test ${CHECK_SCENARIO_FILES.join(" ")}`;

    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/scenario-filter",
        { scenario: CHECK_SCENARIO },
      ),
    );
  }
});

test("m12-focused-check-scenarios: a filter for a different scenario is rejected", () => {
  for (const mutation of ["drifted", "duplicated", "suffixed"] as const) {
    const workflow = validWorkflow();
    const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
      (step) => step.name === CHECK_SCENARIO,
    )!;
    if (mutation === "drifted")
      scenario.run = String(scenario.run).replace(
        `^${CHECK_SCENARIO}(:|$)`,
        "^some-other-scenario(:|$)",
      );
    if (mutation === "duplicated")
      scenario.run = `${String(scenario.run)} -t '^some-other-scenario(:|$)'`;
    if (mutation === "suffixed")
      scenario.run = String(scenario.run).replace(
        `-t '^${CHECK_SCENARIO}(:|$)'`,
        `-t '^${CHECK_SCENARIO}(:|$)'garbage`,
      );

    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/scenario-filter",
        { scenario: CHECK_SCENARIO },
      ),
    );
  }
});

test("m12-focused-check-scenarios: a named selection with no matching test is rejected", () => {
  for (const source of [
    'test("some-other-scenario: evidence", () => {});',
    `test.skip("${CHECK_SCENARIO}: skipped evidence", () => {});`,
    `test.todo("${CHECK_SCENARIO}: future evidence");`,
  ]) {
    const workflow = validWorkflow();
    const sources = Object.fromEntries(
      CHECK_SCENARIO_FILES.map((path) => [path, source]),
    );
    assert.ok(
      reports(
        checkScenarioSelection(workflow, fixtureSource(sources)),
        "release/scenario-selection-empty",
        { scenario: CHECK_SCENARIO },
      ),
    );
  }
});

test("m12-focused-check-scenarios: every listed test file must contribute selected evidence", () => {
  const workflow = validWorkflow();
  const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
    (step) => step.name === CHECK_SCENARIO,
  )!;
  const irrelevant = "tests/architecture/unrelated.test.ts";
  scenario.run = `${String(scenario.run)} ${irrelevant}`;

  assert.ok(
    reports(
      checkScenarioSelection(workflow, (path) =>
        path === irrelevant
          ? 'test("some-other-scenario: evidence", () => {});'
          : (CHECK_SCENARIO_SOURCES[path] ?? ""),
      ),
      "release/scenario-file-empty",
      { scenario: CHECK_SCENARIO, file: irrelevant },
    ),
  );
});

test("m12-focused-check-scenarios: an entrypoint contributes tests registered by its imported conformance module", () => {
  const workflow = validWorkflow();
  const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
    (step) => step.name === CHECK_SCENARIO,
  )!;
  const entrypoint = "tests/harness/preparation-ownership.test.ts";
  scenario.run = `bun run test -- -t '^${CHECK_SCENARIO}(:|$)' ${entrypoint}`;
  const sources: Record<string, string> = {
    [entrypoint]:
      'import { register } from "./preparation-conformance.js";\nregister(test);',
    "tests/harness/preparation-conformance.ts": `export function register(register) { register("${CHECK_SCENARIO}: imported evidence", () => {}); }`,
  };

  assert.deepEqual(
    checkScenarioSelection(workflow, fixtureSource(sources)),
    [],
  );
});

test("m12-focused-check-scenarios: dormant tests are not selected evidence", () => {
  const workflow = validWorkflow();
  const sources = Object.fromEntries(
    CHECK_SCENARIO_FILES.map((path) => [
      path,
      `export function dormant() { test("${CHECK_SCENARIO}: never registered", () => {}); }`,
    ]),
  );
  assert.ok(
    reports(
      checkScenarioSelection(workflow, fixtureSource(sources)),
      "release/scenario-selection-empty",
      { scenario: CHECK_SCENARIO },
    ),
  );
});

test("m12-focused-check-scenarios: only the called imported registrar contributes evidence", () => {
  const workflow = validWorkflow();
  const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
    (step) => step.name === CHECK_SCENARIO,
  )!;
  const entrypoint = "tests/harness/preparation-ownership.test.ts";
  scenario.run = `bun run test -- -t '^${CHECK_SCENARIO}(:|$)' ${entrypoint}`;
  const sources: Record<string, string> = {
    [entrypoint]:
      'import { dormant, register } from "./preparation-conformance.js";\nregister(test);',
    "tests/harness/preparation-conformance.ts":
      `export function register(test) { test("another scenario", () => {}); }\n` +
      `export function dormant() { test("${CHECK_SCENARIO}: never registered", () => {}); }`,
  };

  assert.ok(
    reports(
      checkScenarioSelection(workflow, fixtureSource(sources)),
      "release/scenario-file-empty",
      { scenario: CHECK_SCENARIO, file: entrypoint },
    ),
  );
});

test("m12-focused-check-scenarios: the Test step is the one complete semantic-suite run", () => {
  for (const mutation of ["missing", "duplicate", "renamed"] as const) {
    const workflow = validWorkflow();
    const steps = stepsToEdit(jobsToEdit(workflow).check);
    const full = steps.find((step) => step.name === "Test")!;
    if (mutation === "missing") steps.splice(steps.indexOf(full), 1);
    if (mutation === "duplicate")
      steps.splice(steps.indexOf(full), 0, {
        name: "Another full run",
        run: "bun run test",
      });
    if (mutation === "renamed") full.name = "Semantic suite";

    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/full-test-step",
      ),
    );
  }
});

test("m12-focused-check-scenarios: Check uses unfiltered push and manual dispatch without pull-request runs", () => {
  for (const triggers of [
    { push: null, pull_request: null, workflow_dispatch: null },
    { workflow_dispatch: null },
    { push: { branches: ["topic"] }, workflow_dispatch: null },
  ]) {
    const workflow = validWorkflow();
    workflow.on = triggers;
    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/check-triggers",
      ),
    );
  }
});

test("m12-focused-check-scenarios: the three-OS Check job cannot disappear", () => {
  const workflow = validWorkflow();
  delete jobsToEdit(workflow).check;
  assert.ok(
    reports(
      checkScenarioSelection(
        workflow,
        (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
      ),
      "release/check-job",
    ),
  );
});

test("m12-focused-check-scenarios: named scenario steps cannot disappear or drift", () => {
  for (const mutation of ["missing", "renamed", "unnamed"] as const) {
    const workflow = validWorkflow();
    const steps = stepsToEdit(jobsToEdit(workflow).check);
    const scenario = steps.find((step) => step.name === CHECK_SCENARIO)!;
    if (mutation === "missing") steps.splice(steps.indexOf(scenario), 1);
    if (mutation === "renamed") scenario.name = "renamed scenario";
    if (mutation === "unnamed") delete scenario.name;

    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/scenario-step",
        { scenario: CHECK_SCENARIO },
      ),
    );
  }
});

test("m12-focused-check-scenarios: an unknown test command cannot add another unfiltered suite run", () => {
  for (const extra of [
    { step: "<unnamed>", value: { run: "bun run test --" } },
    { step: "Test", value: { name: "Test", run: "bun run test --" } },
    {
      step: "Environment full run",
      value: { name: "Environment full run", run: "CHECK=1 bun run test" },
    },
    {
      step: "Quoted environment full run",
      value: {
        name: "Quoted environment full run",
        run: 'CHECK="one two" bun run test',
      },
    },
    {
      step: "env full run",
      value: { name: "env full run", run: "env CHECK=1 bun run test" },
    },
  ]) {
    const workflow = validWorkflow();
    const steps = stepsToEdit(jobsToEdit(workflow).check);
    steps.splice(
      steps.findIndex((step) => step.name === "Test"),
      0,
      extra.value,
    );

    assert.ok(
      reports(
        checkScenarioSelection(
          workflow,
          (path) => CHECK_SCENARIO_SOURCES[path] ?? "",
        ),
        "release/unexpected-test-step",
        { step: extra.step },
      ),
    );
  }
});

test("m12-focused-check-scenarios: the parsed-workflow seam rejects an induced missing-filter defect", async () => {
  const root = makeTempDir("secant-workflow-");
  const workflow = validWorkflow();
  const scenario = stepsToEdit(jobsToEdit(workflow).check).find(
    (step) => step.name === CHECK_SCENARIO,
  )!;
  scenario.run = `bun run test -- ${CHECK_SCENARIO_FILES.join(" ")}`;
  await mkdir(dirname(join(root, CI_WORKFLOW)), { recursive: true });
  await writeFile(join(root, CI_WORKFLOW), JSON.stringify(workflow));
  for (const [path, source] of Object.entries(CHECK_SCENARIO_SOURCES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }

  assert.ok(
    reports(checkReleaseWorkflow(root), "release/scenario-filter", {
      scenario: CHECK_SCENARIO,
    }),
  );
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
  workflow.on = { push: null };
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
  // The exact opposite gate — runs on every push, skips only on dispatch — still
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

test("a gated job without its operational-log upload is rejected", () => {
  const workflow = validWorkflow();
  for (const name of ["check", "smoke"]) {
    const job = jobsToEdit(workflow)[name]!;
    job.steps = stepsToEdit(job).filter(
      (step) => step.uses !== "actions/upload-artifact@v4",
    );
  }
  assert.deepEqual(
    checkValidationWorkflow(workflow).map((finding) => finding.rule),
    ["release/log-upload-shape", "release/log-upload-shape"],
  );
});

test("a success or unconditional log-upload trigger is rejected", () => {
  for (const name of ["check", "smoke"]) {
    for (const trigger of [
      undefined,
      "success()",
      "always()",
      "!failure()",
      "failure() || success()",
      "failure() && steps.wrong.outcome == 'failure'",
    ]) {
      const workflow = validWorkflow();
      const upload = stepsToEdit(jobsToEdit(workflow)[name]!).at(-1)!;
      upload.if = trigger;
      assert.deepEqual(
        checkValidationWorkflow(workflow).map((finding) => finding.rule),
        ["release/log-upload-trigger"],
      );
    }
  }
});

test("logs must be configured outside test homes before any script runs", () => {
  for (const name of ["check", "smoke"]) {
    const workflow = validWorkflow();
    const job = jobsToEdit(workflow)[name]!;
    job.steps = stepsToEdit(job).filter(
      (step) => step.name !== "Configure operational logs",
    );
    assert.deepEqual(
      checkValidationWorkflow(workflow).map((finding) => finding.rule),
      ["release/log-directory"],
    );
  }
});

test("each upload pins retention, artifact identity, path, action version, and final position", () => {
  const cases = [
    { "retention-days": undefined },
    { "retention-days": 29 },
    { "retention-days": 31 },
    { name: "operational-logs" },
    { name: "operational-logs-${{ matrix.os }}" },
    { path: "${{ runner.temp }}/secant-tests" },
    { "if-no-files-found": "error" },
  ];
  for (const name of ["check", "smoke"]) {
    for (const edit of cases) {
      const workflow = validWorkflow();
      const upload = stepsToEdit(jobsToEdit(workflow)[name]!).at(-1)!;
      Object.assign(upload.with as Record<string, unknown>, edit);
      assert.deepEqual(
        checkValidationWorkflow(workflow).map((finding) => finding.rule),
        ["release/log-upload-shape"],
      );
    }
    for (const change of ["version", "position", "duplicate"]) {
      const workflow = validWorkflow();
      const steps = stepsToEdit(jobsToEdit(workflow)[name]!);
      const upload = steps.at(-1)!;
      if (change === "version") upload.uses = "actions/upload-artifact@v7";
      if (change === "position") steps.unshift(steps.pop()!);
      if (change === "duplicate") steps.unshift({ ...upload });
      assert.ok(
        reports(checkValidationWorkflow(workflow), "release/log-upload-shape", {
          job: name,
        }),
      );
    }
  }
});

test("the consumer upload requires its always-run blocking aggregation", () => {
  for (const edit of [
    { id: undefined },
    { id: "wrong" },
    { name: "some unrelated failure" },
    { if: "success()" },
    { "continue-on-error": true },
  ]) {
    const workflow = validWorkflow();
    const aggregation = stepsToEdit(jobsToEdit(workflow).smoke).at(-2)!;
    Object.assign(aggregation, edit);
    assert.deepEqual(
      checkValidationWorkflow(workflow).map((finding) => finding.rule),
      ["release/log-upload-trigger"],
    );
  }
  const workflow = validWorkflow();
  stepsToEdit(jobsToEdit(workflow).smoke).at(-1)!.if = "failure()";
  assert.deepEqual(
    checkValidationWorkflow(workflow).map((finding) => finding.rule),
    ["release/log-upload-trigger"],
  );
});

test("wrapped failure expressions preserve the upload policy", () => {
  const workflow = validWorkflow();
  for (const name of ["check", "smoke"]) {
    const steps = stepsToEdit(jobsToEdit(workflow)[name]!);
    const upload = steps.at(-1)!;
    upload.if = `\u0024{{ ${upload.if} }}`;
    if (name !== "check") steps.at(-2)!.if = "${{ always() }}";
  }
  assert.deepEqual(checkValidationWorkflow(workflow), []);
});

test("a log-directory setup cannot be late, gated, overridden, or inside a test home", () => {
  for (const name of ["check", "smoke"]) {
    for (const change of [
      "late",
      "gated",
      "continued",
      "folder",
      "shell",
      "write",
      "job-env",
      "step-env",
      "workflow-env",
    ]) {
      const workflow = validWorkflow();
      const job = jobsToEdit(workflow)[name]!;
      const steps = stepsToEdit(job);
      const index = steps.findIndex(
        (step) => step.name === "Configure operational logs",
      );
      const setup = steps[index]!;
      if (change === "late") {
        steps.splice(index, 1);
        steps.splice(index + 1, 0, setup);
      }
      if (change === "gated") setup.if = "success()";
      if (change === "continued") setup["continue-on-error"] = true;
      if (change === "folder")
        setup.env = { SECANT_LOG_DIR: "${{ runner.temp }}/secant-tests/logs" };
      if (change === "shell") setup.shell = "pwsh";
      if (change === "write") setup.run = "echo $SECANT_LOG_DIR";
      if (change === "job-env") job.env = { SECANT_LOG_DIR: "test-home/logs" };
      if (change === "workflow-env")
        workflow.env = { SECANT_LOG_DIR: "test-home/logs" };
      if (change === "step-env")
        steps.at(-1)!.env = { SECANT_LOG_DIR: "test-home/logs" };
      assert.deepEqual(
        checkValidationWorkflow(workflow).map((finding) => finding.rule),
        change === "workflow-env"
          ? ["release/log-directory", "release/log-directory"]
          : ["release/log-directory"],
      );
    }
  }
});
