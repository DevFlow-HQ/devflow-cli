// The deterministic release-workflow policy check (spec #137, "Release workflow and
// legal gate"): it proves, over the parsed CI workflow, the properties acceptance
// #157 names for the candidate-validation path — job dependencies, immutable
// candidate reuse, credential placement, and validation-mode non-publication. It is
// pure over the parsed YAML object, so the real workflow and synthetic violations
// both exercise it (each guard is proven by a workflow that breaks exactly that
// guard). `checkReleaseWorkflow` parses the real file with `Bun.YAML` for the
// structural step; a missing or unparseable workflow is a tool failure, not a
// finding. No finding has a native line, so each reports at 1:1.
//
// The validation path is not a second workflow: it is the manual-dispatch mode of
// the one CI gate (check.yml), which assembles the candidate once and adds the
// authenticated npm dry-run in the build job under `if: workflow_dispatch`. So the
// guards run over that one workflow — and, since #158, so does the tag-triggered
// promotion. `checkValidationWorkflow` owns the non-publishing validation; the
// `release-protection-policy` scenario (`checkReleaseProtection`, #158) owns the
// tag-admission and protected-`release`-environment boundary that rides in the same
// workflow. The two are complementary: validation forbids an `environment` on every
// job EXCEPT the one protected promotion job, and the protection scenario requires it
// there. Publication of the bytes themselves — a real publish step and its
// publication credential — is owned by `checkReleasePromotion` (#159).
// `checkScenarioSelection` (#469) owns the same workflow's trigger set, anchored
// named-scenario filters, contributing file lists, and one complete Test step.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import type { Finding } from "./rule-catalogue.js";

export const CI_WORKFLOW = ".github/workflows/check.yml";

type ReleaseRule = Extract<Finding["rule"], `release/${string}`>;

/** Collects findings against the workflow, each at its first line and column. */
function collector() {
  const found: Finding[] = [];
  const add = <Id extends ReleaseRule>(
    rule: Id,
    data: Extract<Finding, { rule: Id }>["data"],
  ) => {
    found.push({
      rule,
      file: CI_WORKFLOW,
      line: 1,
      column: 1,
      data,
    } as Finding);
  };
  return { found, add };
}

// The candidate is assembled ONCE on the build job; only it may run these. Any other
// job running one would rebuild downstream instead of reusing the immutable artifact.
const BUILD_JOB = "build";
// The tag-admission and protected-promotion jobs (#158). The `release-approval` job
// gathers the candidate evidence and runs the tag/version gate; the `promote` job
// carries the protected `release` environment and is the human approval boundary.
const APPROVAL_JOB = "release-approval";
const PROMOTE_JOB = "promote";
const RELEASE_ENVIRONMENT = "release";
// The tag/version gate the approval job runs, and the ref form that gates both jobs to
// a `v*` tag so promotion never runs on a branch or a non-`v` tag. The `v` prefix is
// part of the invariant, so the guard requires it — not just any `refs/tags/`.
const TAG_GATE_SCRIPT = "scripts/release-gate.ts";
const TAG_REF = "refs/tags/v";
const ASSEMBLY_SCRIPTS = [
  "scripts/build.ts",
  "scripts/assemble.ts",
  "scripts/pack.ts",
  "scripts/pack-launcher.ts",
];
// The authenticated dry-run the validation path adds, and where it must live.
const DRY_RUN_SCRIPT = "scripts/npm-dry-run.ts";
const PROMOTION_SCRIPT = "scripts/release-promote.ts";
const PUBLISH_SECRET = "NPM_PUBLISH_TOKEN";
const CANDIDATE_ARTIFACTS = ["release-archives", "platform-packages"];

// The read-only npm identity is the ONLY pre-approval secret the workflow may name,
// and only on the dispatch-gated dry-run step in the build job. The publication
// credential is confined separately to protected promotion by checkReleasePromotion.
// Its secret name must read as read-only so a publish-capable token cannot be
// dropped in under the same reference.
const READONLY_SECRET = /READ_?ONLY/i;
const DISPATCH_GUARD = "workflow_dispatch";
// The step condition that POSITIVELY gates on a manual dispatch. A substring test
// would also pass a negated guard (`github.event_name != 'workflow_dispatch'`), which
// runs on every push and skips only on dispatch — the exact opposite — so match
// the equality form explicitly.
const DISPATCH_GATE = /github\.event_name\s*==\s*['"]workflow_dispatch['"]/;

// Publication surfaces that must not appear anywhere in a non-publishing workflow:
// a real `npm publish` (no `--dry-run`), a GitHub-release action or `gh release`, or
// a retry wrapper (a flaky release step is fixed, never re-run to green).
const RELEASE_ACTIONS =
  /(?:softprops\/action-gh-release|actions\/create-release|ncipollo\/release-action)/;
const RETRY_ACTIONS = /nick-fields\/retry|wandalen\/wretry/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trigger names of an `on:` node, which YAML may render as a string, a list, or
 *  a mapping. An unrecognised shape yields no triggers, so the dispatch guard fails
 *  closed. */
function triggerNames(on: unknown): Set<string> {
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on)) {
    return new Set(
      on.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  if (isRecord(on)) return new Set(Object.keys(on));
  return new Set();
}

/** The steps of a job as records (non-mapping entries dropped). */
function stepsOf(job: Record<string, unknown>): Record<string, unknown>[] {
  const steps = job.steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(isRecord);
}

/** Every `run:` script body in a job, flattened to one searchable string. */
function runScripts(job: Record<string, unknown>): string {
  return stepsOf(job)
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
}

/** Every `uses:` action reference in a job. */
function usesActions(job: Record<string, unknown>): string[] {
  return stepsOf(job).flatMap((step) =>
    typeof step.uses === "string" ? [step.uses] : [],
  );
}

/** Every `secrets.<NAME>` reference anywhere in a serialisable value. */
function secretsIn(value: unknown): string[] {
  if (value === undefined) return [];
  return [...JSON.stringify(value).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1]!,
  );
}

/** The `needs` of a job, normalised to a set (YAML allows a scalar or a list). */
function needsOf(job: Record<string, unknown>): Set<string> {
  const needs = job.needs;
  if (typeof needs === "string") return new Set([needs]);
  if (Array.isArray(needs)) {
    return new Set(
      needs.filter((entry): entry is string => typeof entry === "string"),
    );
  }
  return new Set();
}

/** Conditions may be written bare or inside GitHub's expression delimiters. */
function condition(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
        .trim()
    : "";
}

const TEST_FILE = /\btests\/[A-Za-z0-9_./-]+\.test\.tsx?\b/g;
const TEST_COMMAND = /\bbun\s+run\s+test(?:\s|$)/;

export const NAMED_CHECK_SCENARIOS = [
  "operation-receipt-identity-and-lifetime",
  "m10-audit-operation-settlement-owner",
  "Codex semantic schema qualification",
  "model-choice-bounded-eligibility",
  "Claude fallback cleanup retains owner",
  "retained-step-fault-shutdown",
  "authoritative-run-summary",
  "m10-commands-and-input-rules",
  "m10-workspace-mentions",
  "m10-audit-run-keyed-workspace-paths",
  "m10-home-and-preferences",
  "m10-full-transcript-prepend",
  "m10-workbench-interaction",
  "m10-confirmation-target-identity",
  "m10-audit-production-harness-parts-in-doubles",
  "m10-initial-preparation-ownership",
  "m10-previous-release-conversation",
  "m10-audit-legacy-turn-order",
  "m10-session-history",
  "m10-audit-entry-prompt-kind",
  "m10-paused-history-identity",
  "m10-interruption-and-transcript",
  "m10-observed-harness-facts",
  "m10-audit-workbench-test-domains",
  "m10-audit-row-layout-once",
  "m10-audit-changed-file-cap",
  "m10-audit-truthful-keys",
  "m10-audit-windows-release-check",
  "m10-audit-guidance-refresh",
  "m10-audit-file-input-resolution",
  "m10-audit-claude-fact-translation",
  "m10-audit-embedded-ripgrep-release",
  "m10-audit-store-permissions",
  "m12-focused-check-scenarios",
  "m12-test-interface-ownership",
  "m12-renderer-test-lifecycle",
  "m12-local-test-helpers",
  "m12-candidate-retention",
  "m12-harness-run-test-helpers",
  "m12-wiring-test-helpers",
  "m12-audit-working-area-boundary",
  "m10-audit-runtime-failure-causes",
  "m10-audit-turn-event-refusal",
  "m10-audit-headless-output-parity",
] as const;

function testFilesIn(script: string): string[] {
  return [...new Set(script.match(TEST_FILE) ?? [])].filter(
    (path) => !path.split("/").includes(".."),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSource(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function nodeDeclaresScenario(
  root: ts.Node,
  scenario: string,
  testCallees = new Set(["test"]),
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isTest = ts.isIdentifier(callee) && testCallees.has(callee.text);
      const name = node.arguments[0];
      const prefix =
        name && ts.isStringLiteralLike(name)
          ? name.text
          : name && ts.isTemplateExpression(name)
            ? name.head.text
            : undefined;
      if (
        isTest &&
        prefix !== undefined &&
        (prefix === scenario || prefix.startsWith(`${scenario}:`))
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function exportedRegistrar(
  source: ts.SourceFile,
  name: string,
):
  | { readonly body: ts.ConciseBody; readonly testParameter?: string }
  | undefined {
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.body
    ) {
      const parameter = statement.parameters[0]?.name;
      return {
        body: statement.body,
        ...(parameter && ts.isIdentifier(parameter)
          ? { testParameter: parameter.text }
          : {}),
      };
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        const parameter = declaration.initializer.parameters[0]?.name;
        return {
          body: declaration.initializer.body,
          ...(parameter && ts.isIdentifier(parameter)
            ? { testParameter: parameter.text }
            : {}),
        };
      }
    }
  }
  return undefined;
}

function sourceDeclaresScenario(
  path: string,
  source: string | undefined,
  scenario: string,
  readSource: (path: string) => string | undefined,
): boolean {
  if (source === undefined) return false;
  const parsed = parseSource(path, source);
  if (nodeDeclaresScenario(parsed, scenario)) return true;

  // A conformance entrypoint may register tests by calling an imported registrar
  // at top level. Follow only the called export, not the imported module as a whole.
  const imports = new Map<
    string,
    { readonly imported: string; readonly module: string }
  >();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".") ||
      !statement.importClause ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        module: statement.moduleSpecifier.text,
      });
    }
  }
  for (const statement of parsed.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression) ||
      !ts.isIdentifier(statement.expression.expression)
    ) {
      continue;
    }
    const called = imports.get(statement.expression.expression.text);
    if (called === undefined) continue;
    const resolved = posix.normalize(
      posix.join(posix.dirname(path), called.module),
    );
    if (!resolved.startsWith("tests/") || resolved.split("/").includes(".."))
      continue;
    const candidates = resolved.endsWith(".js")
      ? [`${resolved.slice(0, -3)}.ts`, `${resolved.slice(0, -3)}.tsx`]
      : [resolved, `${resolved}.ts`, `${resolved}.tsx`];
    for (const candidate of candidates) {
      const importedSource = readSource(candidate);
      if (importedSource === undefined) continue;
      const registrar = exportedRegistrar(
        parseSource(candidate, importedSource),
        called.imported,
      );
      const testCallees = new Set(["test"]);
      if (registrar?.testParameter) testCallees.add(registrar.testParameter);
      if (
        registrar &&
        nodeDeclaresScenario(registrar.body, scenario, testCallees)
      )
        return true;
    }
  }
  return false;
}

/** Every release-workflow violation in the real CI workflow under `root`. */
export function checkReleaseWorkflow(root: string): Finding[] {
  const workflow = readWorkflow(root);
  return [
    ...checkScenarioSelection(workflow, (path) => {
      const source = join(root, path);
      return existsSync(source) ? readFileSync(source, "utf8") : undefined;
    }),
    ...checkValidationWorkflow(workflow),
    ...checkReleaseProtection(workflow),
    ...checkReleasePromotion(workflow),
  ];
}

/** The parsed CI workflow under `root`; throws when it is missing or unparseable. */
export function readWorkflow(root: string): unknown {
  const text = readFileSync(join(root, CI_WORKFLOW), "utf8");
  try {
    return Bun.YAML.parse(text);
  } catch (error) {
    throw new Error(`${CI_WORKFLOW} is not valid YAML`, { cause: error });
  }
}

export function checkValidationWorkflow(workflow: unknown): Finding[] {
  const { found, add } = collector();

  if (!isRecord(workflow)) {
    add("release/workflow-not-mapping", {});
    return found;
  }

  // A workflow-level env applies to every job on every run, so it can never be
  // dispatch-gated — no secret may live there.
  for (const secret of secretsIn(workflow.env))
    add("release/workflow-env-secret", { secret });

  // 1. The validation entrypoint exists: the gate is manually dispatchable, so the
  //    dry-run runs on one commit on demand rather than off an earlier branch run.
  if (!triggerNames(workflow.on).has(DISPATCH_GUARD))
    add("release/dispatch-trigger", { trigger: DISPATCH_GUARD });

  const jobs = workflow.jobs;
  if (!isRecord(jobs)) {
    add("release/validation-no-jobs", {});
    return found;
  }
  const buildJob = jobs[BUILD_JOB];
  if (!isRecord(buildJob)) {
    add("release/no-build-job", { build: BUILD_JOB });
    return found;
  }

  // The authenticated dry-run must live on the build job, on its just-packed bytes.
  if (!runScripts(buildJob).includes(DRY_RUN_SCRIPT)) {
    add("release/missing-dry-run", {
      build: BUILD_JOB,
      script: DRY_RUN_SCRIPT,
      trigger: DISPATCH_GUARD,
    });
  }

  // Pin the trigger-sensitive expression rather than interpret arbitrary Actions
  // expressions. This catches missing branches and incorrect event/ref guards.
  const bulkUploads = stepsOf(buildJob).filter(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact"),
  );
  for (const artifact of ["binaries", ...CANDIDATE_ARTIFACTS]) {
    const uploads = bulkUploads.filter(
      (step) => isRecord(step.with) && step.with.name === artifact,
    );
    if (
      uploads.length !== 1 ||
      uploads.some(
        (step) =>
          !isRecord(step.with) ||
          step.with["retention-days"] !==
            "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 35 || github.event_name == 'workflow_dispatch' && 30 || 1 }}",
      )
    )
      add("release/candidate-retention", { artifact });
  }

  for (const [name, jobValue] of Object.entries(jobs)) {
    if (!isRecord(jobValue)) {
      add("release/job-not-mapping", { job: name });
      continue;
    }
    const job = jobValue;
    const runs = runScripts(job);

    // 2. Job dependencies + immutable reuse. Every job but the canonical `check`
    //    gate and the `build` job that assembles the candidate must depend on
    //    `build` and consume its artifact — download it, never re-assemble. The
    //    protected `promote` job is exempt: it is the human approval gate, not an
    //    artifact consumer, and it depends on the `release-approval` job (which does
    //    download the candidate) rather than on `build` directly. Its full
    //    dependency closure is proven by `checkReleaseProtection`.
    if (name !== "check" && name !== BUILD_JOB && name !== PROMOTE_JOB) {
      if (!needsOf(job).has(BUILD_JOB))
        add("release/needs-build", { job: name, build: BUILD_JOB });
      if (
        !usesActions(job).some((a) => a.startsWith("actions/download-artifact"))
      )
        add("release/candidate-download", { job: name });
    }
    if (name !== BUILD_JOB) {
      for (const script of ASSEMBLY_SCRIPTS) {
        if (runs.includes(script))
          add("release/reassembly", { job: name, script, build: BUILD_JOB });
      }
    }

    // The canonical gate and every downstream consumer retain failed-job logs.
    if (name !== BUILD_JOB && name !== APPROVAL_JOB && name !== PROMOTE_JOB) {
      const steps = stepsOf(job);
      const setup = steps.find((step) => typeof step.run === "string");
      const setupEnv = isRecord(setup?.env) ? setup.env : {};
      const logEnvScript = `printf 'SECANT_LOG_DIR=%s\\n' "$SECANT_LOG_DIR" >> "$GITHUB_ENV"`;
      const overridden = [
        workflow.env,
        job.env,
        ...steps.filter((step) => step !== setup).map((step) => step.env),
      ].some((env) => isRecord(env) && "SECANT_LOG_DIR" in env);
      if (
        setup?.shell !== "bash" ||
        setupEnv.SECANT_LOG_DIR !==
          "${{ runner.temp }}/secant-operational-logs" ||
        setup?.run !== logEnvScript ||
        "if" in (setup ?? {}) ||
        setup?.["continue-on-error"] === true ||
        overridden
      )
        add("release/log-directory", { job: name });
      const uploads = steps.filter(
        (step) =>
          typeof step.uses === "string" &&
          step.uses.startsWith("actions/upload-artifact"),
      );
      const upload = uploads[0];
      const inputs = isRecord(upload?.with) ? upload.with : {};
      if (
        uploads.length !== 1 ||
        steps.at(-1) !== upload ||
        upload?.uses !== "actions/upload-artifact@v4" ||
        inputs.name !== `operational-logs-${name}-\${{ matrix.os }}` ||
        inputs.path !== "${{ env.SECANT_LOG_DIR }}" ||
        inputs["retention-days"] !== 30 ||
        inputs["if-no-files-found"] !== "ignore"
      )
        add("release/log-upload-shape", { job: name });
      const trigger =
        name === "check"
          ? "failure()"
          : "failure() && steps.consumer_result.outcome == 'failure'";
      const aggregation = steps.at(-2);
      if (
        upload &&
        (condition(upload.if) !== trigger ||
          upload["continue-on-error"] === true ||
          (name !== "check" &&
            (aggregation?.id !== "consumer_result" ||
              aggregation?.name !==
                "Require every consumer scenario to succeed" ||
              condition(aggregation?.if) !== "always()" ||
              aggregation?.["continue-on-error"] === true)))
      )
        add("release/log-upload-trigger", { job: name, trigger });
    }

    // 3. Credential placement. A secret may appear only inside a step's env, on a
    //    step positively gated on a manual dispatch, in the build job, and only as a
    //    read-only npm identity — never at job level (which applies to every step on
    //    every run and cannot be gated), never a publication credential.
    for (const secret of secretsIn(job.env))
      add("release/job-env-secret", { job: name, secret, build: BUILD_JOB });
    for (const step of stepsOf(job)) {
      const secrets = secretsIn(step);
      if (secrets.length === 0) continue;
      if (name !== BUILD_JOB && name !== PROMOTE_JOB)
        add("release/secret-outside-build", { job: name, build: BUILD_JOB });
      if (name === PROMOTE_JOB) continue;
      const guard = typeof step.if === "string" ? step.if : "";
      if (!DISPATCH_GATE.test(guard))
        add("release/ungated-credential", {
          job: name,
          trigger: DISPATCH_GUARD,
        });
      for (const secret of secrets) {
        if (!READONLY_SECRET.test(secret))
          add("release/secret-not-read-only", { job: name, secret });
      }
    }

    // 4. Non-publication. Only the protected `promote` job (#158) may carry an
    //    environment; any other job declaring one would be a second protected/publish
    //    surface. No real publish, no GitHub release, no retry wrapper — nothing that
    //    could publish or hide a flake. (`promote` HAVING `environment: release` is
    //    required by `checkReleaseProtection`.)
    if ("environment" in job && name !== PROMOTE_JOB)
      add("release/stray-environment", { job: name, promote: PROMOTE_JOB });
    if (
      name !== PROMOTE_JOB &&
      /npm\s+publish/.test(runs) &&
      !/--dry-run/.test(runs)
    )
      add("release/real-publish", { job: name });
    if (name !== PROMOTE_JOB && /gh\s+release\s+/.test(runs))
      add("release/gh-release", { job: name });
    for (const action of usesActions(job)) {
      if (name !== PROMOTE_JOB && RELEASE_ACTIONS.test(action))
        add("release/release-action", { job: name, action });
      if (RETRY_ACTIONS.test(action))
        add("release/retry-action", { job: name, action });
    }
  }

  return found;
}

/** The named Check scenarios select only their own tests. */
export function checkScenarioSelection(
  workflow: unknown,
  readSource: (path: string) => string | undefined,
): Finding[] {
  const { found, add } = collector();
  if (!isRecord(workflow)) return found;
  const triggers = [...triggerNames(workflow.on)].sort();
  const on = isRecord(workflow.on) ? workflow.on : {};
  const push = on.push;
  const pushIsUnfiltered =
    push === null || (isRecord(push) && Object.keys(push).length === 0);
  if (
    triggers.length !== 2 ||
    triggers[0] !== "push" ||
    triggers[1] !== "workflow_dispatch" ||
    !pushIsUnfiltered
  ) {
    add("release/check-triggers", {
      triggers,
      filteredPush: triggers.includes("push") && !pushIsUnfiltered,
    });
  }
  if (!isRecord(workflow.jobs)) return found;
  const check = workflow.jobs.check;
  if (!isRecord(check)) {
    add("release/check-job", {});
    return found;
  }

  const steps = stepsOf(check);
  const scenarioNames = new Set<string>(NAMED_CHECK_SCENARIOS);
  for (const step of steps) {
    if (typeof step.run !== "string" || !TEST_COMMAND.test(step.run)) continue;
    const name = typeof step.name === "string" ? step.name : "<unnamed>";
    const canonicalFullRun =
      name === "Test" && step.run.trim() === "bun run test";
    if (!canonicalFullRun && !scenarioNames.has(name)) {
      add("release/unexpected-test-step", { step: name });
    }
  }

  const fullRuns = steps.filter(
    (step) =>
      typeof step.run === "string" && step.run.trim() === "bun run test",
  );
  if (fullRuns.length !== 1 || fullRuns[0]?.name !== "Test") {
    add("release/full-test-step", {
      steps: fullRuns.map((step) =>
        typeof step.name === "string" ? step.name : "<unnamed>",
      ),
    });
  }

  for (const scenario of NAMED_CHECK_SCENARIOS) {
    const matching = steps.filter((step) => step.name === scenario);
    if (matching.length !== 1) {
      add("release/scenario-step", { scenario, count: matching.length });
      continue;
    }
    const step = matching[0]!;
    const expected = `-t '^${scenario}(:|$)'`;
    const script = typeof step.run === "string" ? step.run : "";
    const filterCount = [...script.matchAll(/(?:^|\s)-t(?=\s)/g)].length;
    const exactFilter = new RegExp(`${escapeRegExp(expected)}(?=\\s|$)`);
    if (
      !TEST_COMMAND.test(script) ||
      filterCount !== 1 ||
      !exactFilter.test(script)
    ) {
      add("release/scenario-filter", {
        scenario,
        expected,
      });
    }
    const files = testFilesIn(script);
    const selections = files.map((path) => ({
      path,
      selected: sourceDeclaresScenario(
        path,
        readSource(path),
        scenario,
        readSource,
      ),
    }));
    for (const selection of selections) {
      if (!selection.selected) {
        add("release/scenario-file-empty", {
          scenario,
          file: selection.path,
        });
      }
    }
    if (!selections.some((selection) => selection.selected)) {
      add("release/scenario-selection-empty", { scenario });
    }
  }
  return found;
}

/** The environment name a job targets, whether written as a string or a mapping with
 *  a `name`, or undefined when the job declares none. */
function environmentName(job: Record<string, unknown>): string | undefined {
  const environment = job.environment;
  if (typeof environment === "string") return environment;
  if (isRecord(environment) && typeof environment.name === "string") {
    return environment.name;
  }
  return undefined;
}

/** The transitive `needs` closure of a job: every job that must complete before it,
 *  directly or through the chain. Missing referents are ignored (fail closed elsewhere). */
function transitiveNeeds(
  jobs: Record<string, unknown>,
  start: string,
): Set<string> {
  const closure = new Set<string>();
  const queue = [
    ...needsOf(
      isRecord(jobs[start]) ? (jobs[start] as Record<string, unknown>) : {},
    ),
  ];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) continue;
    closure.add(name);
    const job = jobs[name];
    if (isRecord(job)) queue.push(...needsOf(job));
  }
  return closure;
}

/** The `release-protection-policy` scenario (#158, spec #137 "Release artifact set and
 *  publication workflow"): over the same parsed workflow, prove the tag-admission and
 *  protected-`release`-environment boundary — tag matching, dependency edges,
 *  environment placement, and credential boundaries. Pure over the parsed YAML, so the
 *  real workflow and synthetic violations both exercise it. */
export function checkReleaseProtection(workflow: unknown): Finding[] {
  const { found, add } = collector();

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    add("release/protection-no-jobs", {});
    return found;
  }
  const jobs = workflow.jobs;

  const promote = jobs[PROMOTE_JOB];
  if (!isRecord(promote)) {
    add("release/protection-no-promote-job", {
      promote: PROMOTE_JOB,
      environment: RELEASE_ENVIRONMENT,
    });
    return found;
  }
  const approval = jobs[APPROVAL_JOB];
  if (!isRecord(approval)) {
    add("release/no-approval-job", {
      approval: APPROVAL_JOB,
      script: TAG_GATE_SCRIPT,
    });
    return found;
  }

  // Environment placement: the promote job targets the protected `release`
  // environment, so a human approval stands between the candidate and any later
  // publication.
  if (environmentName(promote) !== RELEASE_ENVIRONMENT) {
    add("release/protection-environment", {
      promote: PROMOTE_JOB,
      environment: RELEASE_ENVIRONMENT,
    });
  }

  // Dependency edges: the promote job's transitive needs must include every other
  // job, so the protected environment is unreachable until every candidate check is
  // green. (checkValidationWorkflow forbids any OTHER job carrying an environment.)
  const closure = transitiveNeeds(jobs, PROMOTE_JOB);
  for (const name of Object.keys(jobs)) {
    if (name === PROMOTE_JOB) continue;
    if (!closure.has(name)) {
      add("release/promote-needs", {
        job: name,
        promote: PROMOTE_JOB,
        approval: APPROVAL_JOB,
      });
    }
  }

  // Tag matching: both jobs are gated to a `v*` tag ref so promotion never runs on a
  // branch, and the approval job runs the tag/version gate that admits a tag only
  // when it exactly matches the package version.
  for (const [name, job] of [
    [APPROVAL_JOB, approval] as const,
    [PROMOTE_JOB, promote] as const,
  ]) {
    const guard = typeof job.if === "string" ? job.if : "";
    if (!guard.includes(TAG_REF))
      add("release/tag-ref-gate", { job: name, ref: TAG_REF });
  }
  if (!runScripts(approval).includes(TAG_GATE_SCRIPT)) {
    add("release/missing-tag-gate", {
      approval: APPROVAL_JOB,
      script: TAG_GATE_SCRIPT,
    });
  }

  // Credential boundary: the approval job is before the protected environment and
  // must remain credential-free. The protected promote job's publication credential
  // is required and confined by checkReleasePromotion (#159).
  const approvalSecrets = [...new Set(secretsIn(approval))];
  if (approvalSecrets.length > 0) {
    add("release/approval-secret", {
      approval: APPROVAL_JOB,
      secrets: approvalSecrets,
    });
  }

  return found;
}

function downloadedArtifactNames(job: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const step of stepsOf(job)) {
    if (
      typeof step.uses !== "string" ||
      !step.uses.startsWith("actions/download-artifact") ||
      !isRecord(step.with) ||
      typeof step.with.name !== "string"
    ) {
      continue;
    }
    names.add(step.with.name);
  }
  return names;
}

/** The `release-promotion-state-machine` scenario (#159, spec #137 "Release
 * artifact set and publication workflow"): the protected job alone receives the
 * publication identity, downloads both immutable candidate artifacts, and invokes
 * the one state machine that verifies and publishes npm-first/GitHub-last. The
 * script's deterministic suite proves fresh, partial, identical-rerun, and conflict
 * behavior on every canonical test OS; this check proves its CI placement. */
export function checkReleasePromotion(workflow: unknown): Finding[] {
  const { found, add } = collector();

  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    add("release/promotion-no-jobs", {});
    return found;
  }
  const jobs = workflow.jobs;
  const promote = jobs[PROMOTE_JOB];
  if (!isRecord(promote)) {
    add("release/promotion-no-promote-job", { promote: PROMOTE_JOB });
    return found;
  }

  if (environmentName(promote) !== RELEASE_ENVIRONMENT) {
    add("release/promotion-environment", {
      promote: PROMOTE_JOB,
      environment: RELEASE_ENVIRONMENT,
    });
  }
  const runs = runScripts(promote);
  if (!runs.includes(PROMOTION_SCRIPT)) {
    add("release/missing-promotion-script", {
      promote: PROMOTE_JOB,
      script: PROMOTION_SCRIPT,
    });
  }
  const artifacts = downloadedArtifactNames(promote);
  for (const artifact of CANDIDATE_ARTIFACTS) {
    if (!artifacts.has(artifact))
      add("release/promote-download", { promote: PROMOTE_JOB, artifact });
  }
  const permissions = isRecord(promote.permissions)
    ? promote.permissions
    : undefined;
  if (permissions?.contents !== "write")
    add("release/promote-permissions", { promote: PROMOTE_JOB });

  let promotionCredentialCount = 0;
  for (const [name, jobValue] of Object.entries(jobs)) {
    if (!isRecord(jobValue)) continue;
    for (const step of stepsOf(jobValue)) {
      const secrets = secretsIn(step);
      for (const secret of secrets) {
        if (name === PROMOTE_JOB && secret !== PUBLISH_SECRET) {
          add("release/promote-unexpected-secret", {
            promote: PROMOTE_JOB,
            secret,
            credential: PUBLISH_SECRET,
          });
          continue;
        }
        if (secret !== PUBLISH_SECRET) continue;
        if (
          name === PROMOTE_JOB &&
          typeof step.run === "string" &&
          step.run.includes(PROMOTION_SCRIPT)
        ) {
          promotionCredentialCount += 1;
        } else {
          add("release/credential-placement", {
            job: name,
            credential: PUBLISH_SECRET,
            promote: PROMOTE_JOB,
            script: PROMOTION_SCRIPT,
          });
        }
      }
    }
  }
  if (promotionCredentialCount !== 1) {
    add("release/credential-count", {
      count: promotionCredentialCount,
      credential: PUBLISH_SECRET,
      promote: PROMOTE_JOB,
      script: PROMOTION_SCRIPT,
    });
  }

  for (const [name, jobValue] of Object.entries(jobs)) {
    if (name === PROMOTE_JOB || !isRecord(jobValue)) continue;
    if (runScripts(jobValue).includes(PROMOTION_SCRIPT)) {
      add("release/promotion-script-placement", {
        job: name,
        script: PROMOTION_SCRIPT,
        promote: PROMOTE_JOB,
      });
    }
  }

  return found;
}
