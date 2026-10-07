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
  artifactUploadToEdit,
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

test("a credentialed step not gated on workflow_dispatch is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  const step = stepsToEdit(jobs.build)[5]!;
  delete step.if;
  assert.ok(
    reports(checkValidationWorkflow(workflow), "release/ungated-credential"),
  );
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

test("a promote job without the protected release environment is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.promote.environment;
  assert.ok(
    reports(checkReleaseProtection(workflow), "release/protection-environment"),
  );
});

test("a promote job not gated on a tag ref is rejected", () => {
  const workflow = validWorkflow();
  const jobs = jobsToEdit(workflow);
  delete jobs.promote.if;
  assert.ok(reports(checkReleaseProtection(workflow), "release/tag-ref-gate"));
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

test("release promotion rejects a different protected environment", () => {
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

test("promotion must download the approved release archives", () => {
  for (const missing of ["release-archives"]) {
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

test("m12-candidate-retention: every bulk upload rejects missing retention", () => {
  for (const artifact of [
    "binaries",
    "release-archives",
    "platform-packages",
  ]) {
    const workflow = validWorkflow();
    const { inputs } = artifactUploadToEdit({
      job: jobsToEdit(workflow).build,
      artifact,
    });
    delete inputs["retention-days"];
    assert.deepEqual(checkValidationWorkflow(workflow), [
      {
        rule: "release/candidate-retention",
        file: CI_WORKFLOW,
        line: 1,
        column: 1,
        data: { artifact },
      },
    ]);
  }
});

test("m12-candidate-retention: wrong durations and missing trigger exceptions are rejected", () => {
  const approved =
    "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 35 || github.event_name == 'workflow_dispatch' && 30 || 1 }}";
  const mutations = [
    1,
    30,
    35,
    90,
    "1",
    "",
    null,
    approved.replace("&& 35", "&& 34"),
    approved.replace("&& 30", "&& 29"),
    approved.replace("|| 1 }}", "|| 2 }}"),
    "${{ github.event_name == 'workflow_dispatch' && 30 || 1 }}",
    "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 35 || 1 }}",
    approved.replace("== 'push'", "!= 'push'"),
    approved.replace("== 'workflow_dispatch'", "!= 'workflow_dispatch'"),
    approved.replace("refs/tags/v", "refs/tags/"),
    approved.replace("refs/tags/v", "refs/heads/v"),
    approved.replace("github.event_name == 'push' && ", ""),
    approved.replace("${{ ", "").replace(" }}", ""),
  ];
  for (const artifact of [
    "binaries",
    "release-archives",
    "platform-packages",
  ]) {
    for (const retention of mutations) {
      const workflow = validWorkflow();
      const { inputs } = artifactUploadToEdit({
        job: jobsToEdit(workflow).build,
        artifact,
      });
      inputs["retention-days"] = retention;
      assert.deepEqual(
        checkValidationWorkflow(workflow),
        [
          {
            rule: "release/candidate-retention",
            file: CI_WORKFLOW,
            line: 1,
            column: 1,
            data: { artifact },
          },
        ],
        `${artifact}: ${retention}`,
      );
    }
  }
});

test("m12-candidate-retention: missing or duplicate bulk uploads cannot escape the rule", () => {
  for (const artifact of [
    "binaries",
    "release-archives",
    "platform-packages",
  ]) {
    for (const mutation of ["missing", "duplicate", "rename", "action"]) {
      const workflow = validWorkflow();
      const job = jobsToEdit(workflow).build;
      const steps = stepsToEdit(job);
      const { step: upload, inputs } = artifactUploadToEdit({ job, artifact });
      if (mutation === "missing")
        job.steps = steps.filter((step) => step !== upload);
      if (mutation === "duplicate") steps.push(structuredClone(upload));
      if (mutation === "rename") inputs.name = "untracked";
      if (mutation === "action") upload.uses = "actions/download-artifact@v4";
      assert.deepEqual(checkValidationWorkflow(workflow), [
        {
          rule: "release/candidate-retention",
          file: CI_WORKFLOW,
          line: 1,
          column: 1,
          data: { artifact },
        },
      ]);
    }
  }
});

test("m12-candidate-retention: approved bulk retention preserves every release and failure-log guard", () => {
  const workflow = validWorkflow();
  assert.deepEqual(checkValidationWorkflow(workflow), []);
  assert.deepEqual(checkReleaseProtection(workflow), []);
  assert.deepEqual(checkReleasePromotion(workflow), []);
});
