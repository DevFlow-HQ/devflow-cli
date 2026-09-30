import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isClient, modules, type ModuleName } from "./module-policy.js";

/** A structural rule: where its reason lives, and how a violation of it reads. The
 *  fix names only a change to the violating code, built from the violation's data;
 *  where no allowed route exists it tells the reader to stop and ask a human. */
interface Rule<Data> {
  readonly see: `docs/agents/${string}.md#${string}`;
  problem(data: Data): string;
  fix(data: Data): string;
}

type Family = "module" | "topology" | "guidance";

type NoData = Record<never, never>;

const rule = <Data>(entry: Rule<Data>) => entry;

const TOPOLOGY_OWNERSHIP = "docs/agents/topology.md#ownership";
const TOPOLOGY_IMPORTS = "docs/agents/topology.md#interfaces-and-imports";
const TOPOLOGY_ENFORCEMENT = "docs/agents/topology.md#enforcement-and-tests";

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
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!heading) continue;
    const slug = headingSlug(heading[1]!);
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

function list(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)}`;
}
