import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  headings,
  moduleSections,
  sidecarKeys,
  type SidecarKey,
} from "./check-guidance-structure.js";
import { isClient, modules, type ModuleName } from "./module-policy.js";

/** A structural rule: where its reason lives, and how a violation of it reads. The
 *  fix names only a change to the violating code, built from the violation's data;
 *  where no allowed route exists it tells the reader to stop and ask a human. */
interface Rule<Data> {
  readonly see: `docs/agents/${string}.md#${string}`;
  problem(data: Data): string;
  fix(data: Data): string;
}

type Family =
  "module" | "topology" | "guidance" | "release" | "vendor" | "unused";

type NoData = Record<never, never>;

const rule = <Data>(entry: Rule<Data>) => entry;

const TOPOLOGY_OWNERSHIP = "docs/agents/topology.md#ownership";
const TOPOLOGY_IMPORTS = "docs/agents/topology.md#interfaces-and-imports";
const TOPOLOGY_ENFORCEMENT = "docs/agents/topology.md#enforcement-and-tests";
const BASELINE_SCOPE = "docs/agents/engineering-baseline.md#scope";
const GUIDANCE_SHAPE = "docs/agents/guidance.md#shape";
const GUIDANCE_MODULE_LOCAL = "docs/agents/guidance.md#module-local-agentsmd";
const GUIDANCE_LIMITS = "docs/agents/guidance.md#limits";
const RECORDED_FIXTURES = "docs/agents/testing.md#recorded-harness-fixtures";
const RELEASE_VALIDATION =
  "docs/agents/release-workflow.md#candidate-validation";
const RELEASE_PROTECTION =
  "docs/agents/release-workflow.md#release-protection-policy";
const RELEASE_PROMOTION =
  "docs/agents/release-workflow.md#release-promotion-state-machine";
const DECLARE_JOBS = "declare the gate's jobs as a mapping under jobs:";
const THIRD_PARTY_PROVENANCE =
  "docs/agents/dependencies.md#third-party-provenance";
const RELEASE_LEGAL_CLOSURE =
  "docs/agents/release-consumers.md#release-legal-closure";

/** A Bun runtime API a file touches, and the files where that API may be touched. */
interface BunApi {
  api: string;
  homes: readonly string[];
}

interface Crossing {
  importer: ModuleName;
  module: ModuleName;
}

/** Every structural rule, declared once. A checker reports only these ids. */
export const rules = {
  "topology/test-mirror": rule<{ prefix: string; roots: string[] }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ prefix, roots }) =>
      `this test sits under tests/${prefix}/ but crosses only ${list(roots, "and")}`,
    fix: ({ roots }) =>
      `move it to ${list(
        roots.map((root) => `tests/${root.slice("src/".length)}`),
        "or",
      )}, the folder mirroring the Module it crosses`,
  }),
  "topology/unowned-source": rule<NoData>({
    see: TOPOLOGY_OWNERSHIP,
    problem: () => "no Module owns this source file",
    fix: () =>
      "move it under the src/ Module that owns its behaviour; if no Module fits, stop and ask a human",
  }),
  "topology/source-symlink": rule<NoData>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: () => "this source file is a symlink, which bypasses ownership",
    fix: () => "replace the symlink with an ordinary source file",
  }),
  "module/private-import": rule<{
    importer?: ModuleName;
    module: ModuleName;
    target: string;
  }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ module, target }) =>
      `imports ${target}, which is private to ${module}`,
    fix: ({ importer, module }) => {
      // A front door the importer may not use is no fix; route it as a crossing.
      if (importer && !importsOf(importer).includes(module))
        return crossingFix(importer, module);
      const doors = frontDoors(importer, module);
      return `import it from ${list(doors, "or")}, ${module}'s front door${doors.length > 1 ? "s" : ""}`;
    },
  }),
  "module/import-direction": rule<Crossing>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ importer, module }) =>
      `${importer} imports ${module}, which ${importer} may not import`,
    fix: ({ importer, module }) => crossingFix(importer, module),
  }),
  "module/composition-invocation": rule<{ importer: ModuleName }>({
    see: "docs/agents/dependencies.md#dependency-discipline",
    problem: ({ importer }) =>
      `${importer} invokes the outer composition root, which only the CLI host invokes`,
    fix: () =>
      "remove this import and receive what composition builds from your caller",
  }),
  "module/foreign-reexport": rule<Crossing & { target: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ module, target }) =>
      `re-exports ${target}, which is ${module}'s surface`,
    fix: ({ importer }) =>
      `remove this re-export and export a value or type ${importer} declares itself`,
  }),
  "module/client-construction": rule<{ importer: ModuleName }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ importer }) =>
      `${importer} imports ${entryOf("application")}, the construction surface only composition uses`,
    fix: ({ importer }) =>
      `import the Interface from ${list(frontDoors(importer, "application"), "or")} and receive the Application from composition`,
  }),
  "module/client-contract-implementation": rule<{ target: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ target }) =>
      `this client contract imports ${target}, which is not a client contract`,
    fix: () =>
      `declare it in ${list([...clientContracts(), "src/application/contracts/"], "or")} instead of importing it`,
  }),
  "module/client-contract-external": rule<{ specifier: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ specifier }) =>
      `this client contract imports ${specifier}, an external package or native type`,
    fix: ({ specifier }) =>
      `declare a normalized type in the contract instead of importing ${specifier}`,
  }),
  "module/unowned-import": rule<{ target: string }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ target }) => `imports ${target}, which no Module owns`,
    fix: ({ target }) =>
      `move ${target} under the src/ Module that owns its behaviour and import it from there; if no Module fits, stop and ask a human`,
  }),
  "module/unresolved-import": rule<{ specifier: string }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ specifier }) =>
      `"${specifier}" resolves to neither owned source nor an installed dependency`,
    fix: () =>
      "correct the specifier so it names a file under src/ or an installed dependency",
  }),
  "module/dependency-owner": rule<{
    importer: ModuleName;
    specifier: string;
    owners: readonly ModuleName[];
  }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ importer, specifier, owners }) =>
      `${importer} imports ${specifier}, which only ${list(owners, "and")} may import`,
    fix: ({ importer, specifier, owners }) => {
      const routes = owners.filter((owner) =>
        importsOf(importer).includes(owner),
      );
      if (routes.length === 0)
        return `move the code that needs ${specifier} into ${list(owners, "or")}; if it does not belong there, stop and ask a human`;
      return `remove this import and use ${specifier} through ${list(
        routes.map(entryOf),
        "or",
      )}, ${routes.length > 1 ? `the front doors of ${list(routes, "and")}` : `${routes[0]}'s front door`}`;
    },
  }),
  "module/excluded-dependency": rule<{ specifier: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ specifier }) =>
      `imports ${specifier}, but target code excludes OpenCode domain packages and PTY transport`,
    fix: () =>
      "remove this import; if the change needs an OpenCode domain package or PTY transport, stop and ask a human",
  }),
  "module/sqlite-driver": rule<{
    importer: ModuleName;
    specifier: string;
    owners: readonly ModuleName[];
  }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ specifier }) =>
      `imports ${specifier}, but SQLite is admitted only as bun:sqlite`,
    fix: ({ importer, specifier, owners }) =>
      owners.includes(importer)
        ? `import SQLite from bun:sqlite instead of ${specifier}`
        : `move the code that needs SQLite into ${list(owners, "or")} and import bun:sqlite there; if it does not belong there, stop and ask a human`,
  }),
  "module/custom-loader": rule<{ specifier: string }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ specifier }) =>
      `imports ${specifier}, a custom loader or evaluated module graph mechanism`,
    fix: () =>
      "remove this import; if the change needs a custom loader or an evaluated module graph, stop and ask a human",
  }),
  "module/workflow-builtin": rule<{ specifier: string }>({
    see: TOPOLOGY_OWNERSHIP,
    problem: ({ specifier }) =>
      `workflow imports ${specifier}, but workflow is execution-free`,
    fix: ({ specifier }) =>
      `remove this import and move the behaviour that needs ${specifier} to the Module that executes it`,
  }),
  "module/triple-slash-reference": rule<NoData>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: () => "uses a triple-slash reference directive",
    fix: () => "replace the triple-slash reference with an explicit import",
  }),
  "module/wildcard-export": rule<{ specifier: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ specifier }) =>
      `export * from "${specifier}" is a wildcard barrel`,
    fix: ({ specifier }) =>
      `name each export instead: export { … } from "${specifier}"`,
  }),
  "module/require-assignment": rule<{ specifier: string }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ specifier }) =>
      `import … = require("${specifier}") is a require-style import assignment`,
    fix: ({ specifier }) =>
      `replace it with an ESM import: import … from "${specifier}"`,
  }),
  "module/computed-import": rule<NoData>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: () => "imports a computed specifier, which cannot be checked",
    fix: () => 'replace it with a table of literal import("…") calls',
  }),
  "module/require-or-eval": rule<{ callee: "require" | "eval" }>({
    see: TOPOLOGY_ENFORCEMENT,
    problem: ({ callee }) =>
      `calls ${callee}, which bypasses the declared ESM graph`,
    fix: ({ callee }) =>
      callee === "require"
        ? "replace require(…) with a static ESM import"
        : "remove eval and import the code it runs as an ESM module",
  }),
  "unused/file": rule<NoData>({
    see: BASELINE_SCOPE,
    problem: () => "nothing imports or runs this file",
    fix: () =>
      "delete this file, or import it from the code that needs it; if it is run by hand, stop and ask a human",
  }),
  "unused/dependency": rule<{
    name: string;
    field: "dependencies" | "devDependencies" | "optionalPeerDependencies";
  }>({
    see: BASELINE_SCOPE,
    problem: ({ name, field }) =>
      `${field} declares ${name}, but nothing uses it`,
    fix: ({ name, field }) =>
      `remove ${name} from ${field}; if something still needs it, stop and ask a human`,
  }),
  "unused/export": rule<{ name: string }>({
    see: BASELINE_SCOPE,
    problem: ({ name }) => `exports ${name}, which no other file imports`,
    fix: ({ name }) =>
      `stop exporting ${name}, and delete it only if nothing in this file uses it either`,
  }),
  "unused/type": rule<{ name: string }>({
    see: BASELINE_SCOPE,
    problem: ({ name }) =>
      `exports the type ${name}, which no other file imports`,
    fix: ({ name }) =>
      `stop exporting the type ${name}, and delete it only if nothing in this file uses it either`,
  }),
  "guidance/unresolved-see-anchor": rule<{
    file: string;
    anchor: string;
    ids: string[];
  }>({
    see: "docs/agents/engineering-baseline.md#minimum-verification",
    problem: ({ anchor, ids }) =>
      `no heading here resolves #${anchor}, the see: anchor of ${list(ids, "and")}`,
    fix: ({ file, anchor }) =>
      `restore a heading whose slug is ${anchor} in ${file}; if it was retired on purpose, stop and ask a human`,
  }),
  "guidance/root-index": rule<NoData>({
    see: GUIDANCE_SHAPE,
    problem: () => "root AGENTS.md, the always-loaded index, is missing",
    fix: () =>
      "create AGENTS.md at the repository root with one trigger line per focused document and per Module-local AGENTS.md",
  }),
  "guidance/root-length": rule<{ limit: number }>({
    see: GUIDANCE_LIMITS,
    problem: ({ limit }) =>
      `root AGENTS.md is too long for its ${limit}-line limit`,
    fix: ({ limit }) =>
      `shorten AGENTS.md to fewer than ${limit} lines by moving detail into the focused document it routes to`,
  }),
  "guidance/claude-symlink": rule<NoData>({
    see: GUIDANCE_SHAPE,
    problem: () =>
      "CLAUDE.md is a symlink, which Git checks out as plain text where symlinks are off",
    fix: () => "replace the symlink with a file whose only line is @AGENTS.md",
  }),
  "guidance/claude-import": rule<NoData>({
    see: GUIDANCE_SHAPE,
    problem: () => "CLAUDE.md holds more than the @AGENTS.md import",
    fix: () =>
      "reduce CLAUDE.md to the single line @AGENTS.md and move anything else into AGENTS.md or a focused document",
  }),
  "guidance/focused-length": rule<{ limit: number }>({
    see: GUIDANCE_LIMITS,
    problem: ({ limit }) =>
      `this guidance is too long for its ${limit}-line limit`,
    fix: ({ limit }) =>
      `split it by concern or move detail into a deeper document until it has fewer than ${limit} lines`,
  }),
  "guidance/module-local-placement": rule<{
    directory: string;
    ownerRoot?: string;
  }>({
    see: GUIDANCE_MODULE_LOCAL,
    problem: ({ directory }) =>
      `this Module-local AGENTS.md sits in ${directory}, which is not a Module root`,
    fix: ({ ownerRoot }) =>
      ownerRoot
        ? `move its facts into ${ownerRoot}AGENTS.md, the guidance at the owning Module's root, and delete this file`
        : "move its facts into the AGENTS.md at the root of the Module they describe; if no Module owns them, stop and ask a human",
  }),
  "guidance/module-local-unlisted": rule<{ file: string }>({
    see: GUIDANCE_MODULE_LOCAL,
    problem: ({ file }) => `root AGENTS.md does not list ${file} by path`,
    fix: ({ file }) =>
      `add a trigger line naming ${file} to the Module-local guidance list in AGENTS.md`,
  }),
  "guidance/module-section": rule<
    | { heading: string; kind: "disallowed" }
    | { heading: string; kind: "repeated" }
    | { heading: string; kind: "out-of-order"; after: string }
  >({
    see: GUIDANCE_MODULE_LOCAL,
    problem: (data) => {
      if (data.kind === "disallowed")
        return `## ${data.heading} is not a Module guidance section`;
      if (data.kind === "repeated")
        return `## ${data.heading} appears a second time`;
      return `## ${data.heading} comes after ## ${data.after}`;
    },
    fix: (data) => {
      if (data.kind === "disallowed")
        return `rename it to ${list(moduleSections, "or")}, or make it a ### heading inside one of those sections`;
      if (data.kind === "repeated")
        return `merge this section into the first ## ${data.heading}, keeping any subheading as ###`;
      return `move the ## ${data.heading} section above ## ${data.after}; the order is ${moduleSections.join(", ")}`;
    },
  }),
  "guidance/prose-width": rule<{ columns: number; limit: number }>({
    see: GUIDANCE_LIMITS,
    problem: ({ columns, limit }) =>
      `this line is ${columns} characters, over the ${limit}-character prose limit`,
    fix: ({ limit }) => `wrap it at ${limit} characters`,
  }),
  "guidance/broken-link": rule<{ target: string }>({
    see: GUIDANCE_LIMITS,
    problem: ({ target }) => `links to ${target}, which does not exist`,
    fix: ({ target }) =>
      `point ${target} at an existing file, or remove the link`,
  }),
  "guidance/unresolved-path": rule<{ target: string }>({
    see: GUIDANCE_LIMITS,
    problem: ({ target }) =>
      `names ${target}, which resolves neither beside this file nor from the repository root`,
    fix: ({ target }) =>
      `correct ${target} to an existing guidance path, or remove it`,
  }),
  "guidance/fixture-sidecar": rule<{ sidecar: string }>({
    see: RECORDED_FIXTURES,
    problem: () => "this recorded fixture has no recording.json",
    fix: ({ sidecar }) => `add ${sidecar} naming ${list(sidecarKeys, "and")}`,
  }),
  "guidance/sidecar-missing-keys": rule<{ keys: SidecarKey[] }>({
    see: RECORDED_FIXTURES,
    problem: ({ keys }) => `recording.json lacks ${list(keys, "and")}`,
    fix: ({ keys }) => `add ${list(keys, "and")} to recording.json`,
  }),
  "guidance/sidecar-unexpected-keys": rule<{ keys: string[] }>({
    see: RECORDED_FIXTURES,
    problem: ({ keys }) => `recording.json has unexpected ${list(keys, "and")}`,
    fix: ({ keys }) => `remove ${list(keys, "and")} from recording.json`,
  }),
  "guidance/sidecar-invalid-value": rule<{ key: SidecarKey }>({
    see: RECORDED_FIXTURES,
    problem: ({ key }) => `recording.json has an invalid ${key}`,
    fix: ({ key }) => {
      if (key === "recordedAt")
        return 'set recordedAt to an ISO-8601 instant such as 2026-09-06T00:00:00.000Z, or to "synthetic" for a hand-authored case';
      if (key === "redactions")
        return "set redactions to an array of { placeholder, reason } entries, each a non-empty string";
      return `set ${key} to a non-empty string`;
    },
  }),
  "guidance/codex-protocol-version": rule<NoData>({
    see: RECORDED_FIXTURES,
    problem: () =>
      "this Codex recording's protocolVersion names no codex-probe revision",
    fix: () =>
      'set protocolVersion to "codex-probe-<n>", the probe revision the case was recorded against',
  }),
  "guidance/synthetic-refresh": rule<NoData>({
    see: RECORDED_FIXTURES,
    problem: () =>
      "this synthetic recording's refreshCommand does not say why it is synthetic",
    fix: () =>
      'set refreshCommand to "synthetic -- <why a real Harness cannot produce this case>"',
  }),
  "guidance/fixture-credential": rule<{ labels: string[] }>({
    see: RECORDED_FIXTURES,
    problem: ({ labels }) =>
      `this recording still matches the credential pattern${labels.length > 1 ? "s" : ""} ${list(labels, "and")}`,
    fix: () =>
      "replace the matching bytes with a placeholder listed in recording.json redactions, or re-record the case",
  }),
  "release/workflow-not-mapping": rule<NoData>({
    see: RELEASE_VALIDATION,
    problem: () => "the workflow is not a YAML mapping",
    fix: () => "rewrite the workflow as a mapping with on: and jobs: keys",
  }),
  "release/workflow-env-secret": rule<{ secret: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ secret }) =>
      `the workflow-level env references secret ${secret}, which reaches every job on every run`,
    fix: ({ secret }) =>
      `remove secrets.${secret} from the workflow-level env; if a step needs it, stop and ask a human`,
  }),
  "release/dispatch-trigger": rule<{ trigger: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ trigger }) =>
      `the workflow has no ${trigger} trigger, so candidate validation has no manual entrypoint`,
    fix: ({ trigger }) => `add ${trigger} under on:`,
  }),
  "release/validation-no-jobs": rule<NoData>({
    see: RELEASE_VALIDATION,
    problem: () =>
      "the workflow declares no jobs, so no candidate is assembled or validated",
    fix: () => DECLARE_JOBS,
  }),
  "release/no-build-job": rule<{ build: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ build }) =>
      `the workflow has no ${build} job to assemble the one candidate`,
    fix: ({ build }) =>
      `restore the ${build} job that assembles the candidate once; if it was removed on purpose, stop and ask a human`,
  }),
  "release/missing-dry-run": rule<{
    build: string;
    script: string;
    trigger: string;
  }>({
    see: RELEASE_VALIDATION,
    problem: ({ build, script }) =>
      `the ${build} job never runs ${script}, the candidate-validation dry-run`,
    fix: ({ build, script, trigger }) =>
      `add a step to the ${build} job that runs ${script}, gated on github.event_name == '${trigger}'`,
  }),
  "release/job-not-mapping": rule<{ job: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job }) => `job ${job} is not a mapping`,
    fix: ({ job }) =>
      `rewrite job ${job} as a mapping with runs-on: and steps:`,
  }),
  "release/needs-build": rule<{ job: string; build: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, build }) =>
      `job ${job} does not need ${build}, so it cannot consume the one candidate`,
    fix: ({ job, build }) => `add ${build} to the needs: of job ${job}`,
  }),
  "release/candidate-download": rule<{ job: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job }) => `job ${job} never downloads the candidate artifact`,
    fix: ({ job }) =>
      `add an actions/download-artifact step to job ${job} and use the candidate it downloads instead of rebuilding it`,
  }),
  "release/reassembly": rule<{ job: string; script: string; build: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, script, build }) =>
      `job ${job} runs ${script}, but the candidate is assembled once on ${build}`,
    fix: ({ job, script }) =>
      `remove ${script} from job ${job} and download the candidate artifact instead`,
  }),
  "release/job-env-secret": rule<{
    job: string;
    secret: string;
    build: string;
  }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, secret }) =>
      `job ${job}'s env references secret ${secret}, which reaches every step on every run`,
    fix: ({ job, secret, build }) =>
      job === build
        ? `move secrets.${secret} from job ${job}'s env to the env of the dispatch-gated step that needs it`
        : `remove secrets.${secret} from job ${job}'s env; if the job needs it, stop and ask a human`,
  }),
  "release/secret-outside-build": rule<{ job: string; build: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, build }) =>
      `job ${job} references a secret, but before approval only the ${build} dry-run step may hold one`,
    fix: ({ job }) =>
      `remove the secret from job ${job}; if the job needs a credential, stop and ask a human`,
  }),
  "release/ungated-credential": rule<{ job: string; trigger: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, trigger }) =>
      `the credentialed step in job ${job} is not gated on a ${trigger} run, so it runs on every push`,
    fix: ({ job, trigger }) =>
      `gate the credentialed step in job ${job} with if: github.event_name == '${trigger}'`,
  }),
  // The read-only guard reads only the secret's name, so the fix never offers a rename.
  "release/secret-not-read-only": rule<{ job: string; secret: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ secret }) =>
      `secret ${secret} does not read as a read-only identity, so it may carry publication authority`,
    fix: ({ job, secret }) =>
      `remove secrets.${secret} from the step in job ${job}; the dry-run authenticates only with the read-only npm identity, so if the step needs ${secret}, stop and ask a human`,
  }),
  "release/stray-environment": rule<{ job: string; promote: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, promote }) =>
      `job ${job} declares an environment, but only the protected ${promote} job may`,
    fix: ({ job }) => `remove environment: from job ${job}`,
  }),
  "release/real-publish": rule<{ job: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job }) =>
      `job ${job} runs a real npm publish, but validation publishes only with --dry-run`,
    fix: ({ job }) => `add --dry-run to the npm publish in job ${job}`,
  }),
  "release/gh-release": rule<{ job: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job }) =>
      `job ${job} runs gh release, but validation exposes no public release`,
    fix: ({ job }) => `remove the gh release command from job ${job}`,
  }),
  "release/release-action": rule<{ job: string; action: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, action }) =>
      `job ${job} uses release action ${action}, but validation exposes no public release`,
    fix: ({ job, action }) => `remove the ${action} step from job ${job}`,
  }),
  "release/retry-action": rule<{ job: string; action: string }>({
    see: RELEASE_VALIDATION,
    problem: ({ job, action }) =>
      `job ${job} uses retry action ${action}, which re-runs a flaky release step instead of fixing it`,
    fix: ({ job, action }) =>
      `remove the ${action} wrapper from job ${job} and run its step directly`,
  }),
  "release/protection-no-jobs": rule<NoData>({
    see: RELEASE_PROTECTION,
    problem: () =>
      "the workflow declares no jobs, so no protected boundary guards promotion",
    fix: () => DECLARE_JOBS,
  }),
  "release/protection-no-promote-job": rule<{
    promote: string;
    environment: string;
  }>({
    see: RELEASE_PROTECTION,
    problem: ({ promote, environment }) =>
      `the workflow has no ${promote} job to hold publication behind the protected ${environment} environment`,
    fix: ({ promote, environment }) =>
      `restore the ${promote} job with environment: ${environment}; if it was removed on purpose, stop and ask a human`,
  }),
  "release/no-approval-job": rule<{ approval: string; script: string }>({
    see: RELEASE_PROTECTION,
    problem: ({ approval }) =>
      `the workflow has no ${approval} job to run the tag and version gate and write the approval summary`,
    fix: ({ approval, script }) =>
      `restore the ${approval} job that runs ${script}; if it was removed on purpose, stop and ask a human`,
  }),
  "release/protection-environment": rule<{
    promote: string;
    environment: string;
  }>({
    see: RELEASE_PROTECTION,
    problem: ({ promote, environment }) =>
      `job ${promote} does not target the protected ${environment} environment`,
    fix: ({ promote, environment }) =>
      `set environment: ${environment} on job ${promote}`,
  }),
  "release/promote-needs": rule<{
    job: string;
    promote: string;
    approval: string;
  }>({
    see: RELEASE_PROTECTION,
    problem: ({ job, promote }) =>
      `job ${job} does not gate job ${promote}: it is outside ${promote}'s transitive needs`,
    fix: ({ job, promote, approval }) =>
      job === approval
        ? `add ${approval} to the needs: of job ${promote}`
        : `add ${job} to the needs: of job ${approval}`,
  }),
  "release/tag-ref-gate": rule<{ job: string; ref: string }>({
    see: RELEASE_PROTECTION,
    problem: ({ job, ref }) =>
      `job ${job} is not gated on a ${ref}* tag ref, so it can run on a branch`,
    fix: ({ job, ref }) =>
      `add startsWith(github.ref, '${ref}') to the if: of job ${job}`,
  }),
  "release/missing-tag-gate": rule<{ approval: string; script: string }>({
    see: RELEASE_PROTECTION,
    problem: ({ approval, script }) =>
      `job ${approval} never runs ${script}, so a tag is admitted without matching the package version`,
    fix: ({ approval, script }) =>
      `add a step to job ${approval} that runs ${script}`,
  }),
  "release/approval-secret": rule<{ approval: string; secrets: string[] }>({
    see: RELEASE_PROTECTION,
    problem: ({ approval, secrets }) =>
      `job ${approval} references secret${secrets.length > 1 ? "s" : ""} ${list(secrets, "and")}, but no credential may exist before the protected boundary`,
    fix: ({ approval, secrets }) =>
      `remove ${list(
        secrets.map((secret) => `secrets.${secret}`),
        "and",
      )} from job ${approval}; if the job needs a credential, stop and ask a human`,
  }),
  "release/promotion-no-jobs": rule<NoData>({
    see: RELEASE_PROMOTION,
    problem: () =>
      "the workflow declares no jobs, so no protected job promotes the release",
    fix: () => DECLARE_JOBS,
  }),
  "release/promotion-no-promote-job": rule<{ promote: string }>({
    see: RELEASE_PROMOTION,
    problem: ({ promote }) =>
      `the workflow has no ${promote} job to run release promotion`,
    fix: ({ promote }) =>
      `restore the ${promote} job; if it was removed on purpose, stop and ask a human`,
  }),
  "release/promotion-environment": rule<{
    promote: string;
    environment: string;
  }>({
    see: RELEASE_PROMOTION,
    problem: ({ promote, environment }) =>
      `job ${promote} does not target the protected ${environment} environment, so publication waits for no approval`,
    fix: ({ promote, environment }) =>
      `set environment: ${environment} on job ${promote}`,
  }),
  "release/missing-promotion-script": rule<{ promote: string; script: string }>(
    {
      see: RELEASE_PROMOTION,
      problem: ({ promote, script }) =>
        `job ${promote} never runs ${script}, the one publication state machine`,
      fix: ({ promote, script }) =>
        `add a step to job ${promote} that runs ${script}`,
    },
  ),
  "release/promote-download": rule<{ promote: string; artifact: string }>({
    see: RELEASE_PROMOTION,
    problem: ({ promote, artifact }) =>
      `job ${promote} does not download the approved ${artifact} artifact`,
    fix: ({ promote, artifact }) =>
      `add an actions/download-artifact step with name: ${artifact} to job ${promote}`,
  }),
  "release/promote-permissions": rule<{ promote: string }>({
    see: RELEASE_PROMOTION,
    problem: ({ promote }) =>
      `job ${promote} lacks permissions: contents: write, so it cannot expose the approved GitHub release assets`,
    fix: ({ promote }) => `set permissions: contents: write on job ${promote}`,
  }),
  "release/promote-unexpected-secret": rule<{
    promote: string;
    secret: string;
    credential: string;
  }>({
    see: RELEASE_PROMOTION,
    problem: ({ promote, secret, credential }) =>
      `job ${promote} references secret ${secret}, but only ${credential} belongs on its state-machine step`,
    fix: ({ promote, secret }) =>
      `remove secrets.${secret} from job ${promote}; if promotion needs it, stop and ask a human`,
  }),
  "release/credential-placement": rule<{
    job: string;
    credential: string;
    promote: string;
    script: string;
  }>({
    see: RELEASE_PROMOTION,
    problem: ({ job, credential, promote, script }) =>
      `job ${job} references ${credential} outside the ${promote} step that runs ${script}`,
    fix: ({ job, credential, promote, script }) =>
      job === promote
        ? `move secrets.${credential} to the ${promote} step that runs ${script}`
        : `remove secrets.${credential} from job ${job}`,
  }),
  "release/credential-count": rule<{
    count: number;
    credential: string;
    promote: string;
    script: string;
  }>({
    see: RELEASE_PROMOTION,
    problem: ({ count, credential, promote, script }) =>
      count === 0
        ? `no ${promote} step that runs ${script} references ${credential}`
        : `the ${promote} steps that run ${script} reference ${credential} ${count} times, not once`,
    fix: ({ count, credential, promote, script }) =>
      count === 0
        ? `add secrets.${credential} to the env of the ${promote} step that runs ${script}`
        : `keep one secrets.${credential} reference, on the one ${promote} step that runs ${script}`,
  }),
  "release/promotion-script-placement": rule<{
    job: string;
    script: string;
    promote: string;
  }>({
    see: RELEASE_PROMOTION,
    problem: ({ job, script, promote }) =>
      `job ${job} runs ${script}, which may run only in the protected ${promote} job`,
    fix: ({ job, script }) => `remove ${script} from job ${job}`,
  }),
  "vendor/bun-api": rule<{ apis: readonly BunApi[] }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ apis }) =>
      `touches ${list(
        apis.map(({ api }) => bunApiName(api)),
        "and",
      )}, but target source is runtime-neutral`,
    fix: ({ apis }) =>
      `${apis.map(bunApiRoute).join("; ")}; if none fits, stop and ask a human`,
  }),
  "vendor/bun-api-scope": rule<BunApi & { permitted: readonly string[] }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ api, permitted }) =>
      `touches ${bunApiName(api)}, but this file may touch only ${list(permitted, "and")}`,
    fix: (data) => `${bunApiRoute(data)}; if none fits, stop and ask a human`,
  }),
  "vendor/dead-grant": rule<{ permitted: readonly string[] }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ permitted }) =>
      `touches no Bun runtime API, but this file may still touch ${list(permitted, "and")}`,
    fix: ({ permitted }) =>
      `stop and ask a human whether this file still needs ${list(permitted, "or")}`,
  }),
  "vendor/shell-spawn": rule<NoData>({
    see: TOPOLOGY_IMPORTS,
    problem: () =>
      "spawns with shell: true, which runs the command through a shell",
    fix: () =>
      "remove shell: true and spawn the resolved executable with its arguments directly",
  }),
  "vendor/provenance-record": rule<{
    record: "UPSTREAM" | "THIRD-PARTY-NOTICES.md";
    vendored: string;
  }>({
    see: THIRD_PARTY_PROVENANCE,
    problem: ({ record, vendored }) =>
      `${record} is missing, but vendored source such as ${vendored} needs it at the repository root`,
    fix: ({ record }) =>
      record === "UPSTREAM"
        ? "add UPSTREAM at the repository root, recording each copied path's OpenCode commit, local modifications, and date"
        : "add THIRD-PARTY-NOTICES.md at the repository root, carrying the licence notices for the copied code",
  }),
  "vendor/notices-section": rule<{ name: string; version: string }>({
    see: RELEASE_LEGAL_CLOSURE,
    problem: ({ name }) => `no section names the runtime dependency ${name}`,
    fix: ({ name, version }) =>
      `add a section naming \`${name}\` and its exact pin \`${version}\``,
  }),
  "vendor/notices-pin": rule<{ name: string; version: string }>({
    see: RELEASE_LEGAL_CLOSURE,
    problem: ({ name, version }) =>
      `the notices for ${name} do not name its exact pin ${version}`,
    fix: ({ name, version }) =>
      `name the pin \`${version}\` from package.json in the section for \`${name}\``,
  }),
  "vendor/entry-declaration": rule<{ specifier: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ specifier }) =>
      `this Module entry's emitted declarations name the fenced package ${specifier}`,
    fix: ({ specifier }) =>
      `give the export whose type is inferred from ${specifier} an explicit type this Module declares`,
  }),
  "vendor/declaration-emit": rule<{ error: string }>({
    see: TOPOLOGY_IMPORTS,
    problem: ({ error }) =>
      `declarations do not emit, so no Module entry's surface is checked: ${error}`,
    fix: () =>
      "resolve this compiler error so every Module entry's declarations emit",
  }),
} satisfies { [id: `${Family}/${string}`]: Rule<never> };

export type RuleId = keyof typeof rules;
type DataOf<Id extends RuleId> =
  (typeof rules)[Id] extends Rule<infer Data> ? Data : never;

/** One violation of a catalogued rule; `line` and `column` are 1-based. */
export type Finding = {
  [Id in RuleId]: {
    rule: Id;
    file: string;
    line: number;
    column: number;
    data: DataOf<Id>;
  };
}[RuleId];

/** The report contract: location, rule id, and what is wrong; then fix; then see. */
export function formatFinding(finding: Finding): string {
  const entry = rules[finding.rule] as Rule<typeof finding.data>;
  return [
    `${finding.file}:${finding.line}:${finding.column}  ${finding.rule}  ${entry.problem(finding.data)}`,
    `fix: ${entry.fix(finding.data)}`,
    `see: ${entry.see}`,
  ].join("\n");
}

/** GitHub's heading anchor: lower-cased, punctuation dropped, spaces to hyphens. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text } of headings(markdown)) {
    const slug = headingSlug(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/** Every `see:` anchor that names no heading in its guidance file under `root`. */
export function unresolvedAnchors(root: string): Finding[] {
  const byAnchor = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(rules))
    byAnchor.set(entry.see, [...(byAnchor.get(entry.see) ?? []), id]);
  const findings: Finding[] = [];
  for (const [see, ids] of byAnchor) {
    const [file, anchor] = see.split("#") as [string, string];
    const path = join(root, file);
    if (
      existsSync(path) &&
      headingAnchors(readFileSync(path, "utf8")).has(anchor)
    )
      continue;
    findings.push({
      rule: "guidance/unresolved-see-anchor",
      file,
      line: 1,
      column: 1,
      data: { file, anchor, ids },
    });
  }
  return findings;
}

function policyOf(name: ModuleName) {
  return modules.find((module) => module.name === name)!;
}

function importsOf(name: ModuleName): readonly ModuleName[] {
  return policyOf(name).imports;
}

function entryOf(name: ModuleName): string {
  const module = policyOf(name);
  return module.root + module.entry;
}

function clientContracts(): string[] {
  const application = policyOf("application");
  const contracts = "contracts" in application ? application.contracts : [];
  return contracts.map((door) => application.root + door);
}

/** The files `importer` may import `name` through. Clients reach Application
 *  through its client contracts only, never its construction entry. */
function frontDoors(importer: ModuleName | undefined, name: ModuleName) {
  if (name === "application" && isClient(importer)) return clientContracts();
  const module = policyOf(name);
  const contracts = "contracts" in module ? module.contracts : [];
  return [module.entry, ...contracts].map((door) => module.root + door);
}

/** How `importer` reaches `module`, which it may not import: through an allowed
 *  Module that reaches it, or, when none does, a human. */
function crossingFix(importer: ModuleName, module: ModuleName): string {
  const allowed = importsOf(importer);
  if (allowed.length === 0)
    return `remove this import; ${importer} may import no other Module, so stop and ask a human`;
  const may = `${importer} may import only ${list(allowed, "and")}`;
  const routes = allowed.filter((name) => reaches(name, module));
  if (routes.length === 0)
    return `remove this import; ${may}, which ${allowed.length > 1 ? "do" : "does"} not reach ${module}, so stop and ask a human`;
  return `remove this import and use ${module} through ${list(
    routes.map((name) => `${name}'s`),
    "or",
  )} Interface; ${may}`;
}

function reaches(from: ModuleName, to: ModuleName, seen = new Set()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return importsOf(from).some((next) => reaches(next, to, seen));
}

/** `Bun` alone is a bare alias or computed member: the global, unnamed. */
function bunApiName(api: string): string {
  return api === "Bun" ? "the Bun global" : api;
}

/** Where code touching `api` goes: into a file that may touch it, or onto a
 *  runtime-neutral replacement when no file may. */
function bunApiRoute({ api, homes }: BunApi): string {
  return homes.length > 0
    ? `move the code that needs ${api} into ${list(homes, "or")}`
    : `replace ${bunApiName(api)} with a node: built-in or a runtime-neutral library`;
}

function list(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)}`;
}
