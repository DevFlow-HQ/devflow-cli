/** Target ownership from the topology decision; directories are created only by implementation slices. */
export const modules = [
  {
    name: "cli",
    root: "src/cli/",
    entry: "main.ts",
    imports: ["composition", "tui", "headless"],
  },
  {
    name: "composition",
    root: "src/composition/",
    entry: "main.ts",
    imports: [
      "application",
      "workflow",
      "bundle",
      "catalog",
      "execution",
      "store",
      "harness",
      "tui",
      "renderer",
      "headless",
      "process",
    ],
  },
  {
    name: "application",
    root: "src/application/",
    entry: "application.ts",
    contracts: ["projection-port.ts", "bundle-management.ts"],
    imports: [
      "workflow",
      "bundle",
      "catalog",
      "execution",
      "store",
      "harness",
      "process",
    ],
  },
  {
    name: "workflow",
    root: "src/workflow/",
    entry: "workflow.ts",
    imports: [],
  },
  {
    name: "bundle",
    root: "src/bundle/",
    entry: "bundle.ts",
    imports: ["workflow"],
  },
  {
    name: "catalog",
    root: "src/catalog/",
    entry: "catalog.ts",
    imports: ["workflow", "drizzle"],
  },
  {
    name: "drizzle",
    root: "src/drizzle/",
    entry: "migrations.ts",
    imports: [],
  },
  {
    name: "execution",
    root: "src/run/execution/",
    entry: "execution.ts",
    imports: ["workflow", "store", "harness", "process"],
  },
  {
    name: "process",
    root: "src/process/",
    entry: "process.ts",
    imports: [],
  },
  {
    name: "store",
    root: "src/run/store/",
    entry: "store.ts",
    imports: ["workflow", "harness", "artifacts", "drizzle", "process"],
  },
  {
    name: "artifacts",
    root: "src/run/store/artifacts/",
    entry: "artifacts.ts",
    imports: ["workflow", "process"],
  },
  {
    name: "harness",
    root: "src/harness/",
    entry: "harness.ts",
    imports: ["process"],
  },
  {
    name: "tui",
    root: "src/tui/",
    entry: "tui.ts",
    imports: ["application", "renderer"],
  },
  {
    name: "renderer",
    root: "src/tui/renderer/",
    entry: "renderer.ts",
    imports: [],
  },
  {
    name: "headless",
    root: "src/headless/",
    entry: "headless.ts",
    imports: ["application"],
  },
] as const;

export type ModuleName = (typeof modules)[number]["name"];

/** The client Modules: they receive Application Interfaces, never its construction entry. */
export function isClient(name: ModuleName | undefined): boolean {
  return name === "tui" || name === "headless";
}

export function ownerOf(path: string) {
  return [...modules]
    .sort((left, right) => right.root.length - left.root.length)
    .find((module) => path.startsWith(module.root));
}

const sqliteOwners: readonly ModuleName[] = ["store", "catalog"];

/** External dependencies only their owners may import. */
const fencedDependencies: readonly {
  owners: readonly ModuleName[];
  matches(specifier: string): boolean;
}[] = [
  { owners: ["tui", "renderer"], matches: (s) => s.startsWith("@opentui/") },
  // `bun:sqlite` is the sole admitted SQLite driver (ADR 0030), fenced to the
  // Run Store and Catalog.
  { owners: sqliteOwners, matches: (s) => s === "bun:sqlite" },
  // Pino is the operational log's writer, and composition owns that sink (#318):
  // every other Module reports through an observer and never logs directly.
  {
    owners: ["composition"],
    matches: (s) => s === "pino" || s.startsWith("pino/"),
  },
  {
    owners: ["harness"],
    matches: (s) =>
      /^(?:@anthropic-ai\/|@agentclientprotocol\/|@modelcontextprotocol\/|@google\/genai|@openai\/|openai(?:\/|$))/.test(
        s,
      ),
  },
];

export type ExternalViolation =
  | { kind: "excluded" }
  | { kind: "fenced"; owners: readonly ModuleName[] }
  | { kind: "sqlite-driver"; owners: readonly ModuleName[] }
  | { kind: "loader" };

export function externalViolation(
  owner: ModuleName,
  specifier: string,
): ExternalViolation | undefined {
  // Strip the runtime builtin prefix so a runtime-agnostic rule below can key on
  // the bare name (runtime neutrality itself is the allowlist's job).
  const name = specifier.replace(/^(?:node|bun):/, "");
  if (specifier.startsWith("@opencode-ai/") || specifier === "node-pty")
    return { kind: "excluded" };
  const fenced = fencedDependencies.find((dependency) =>
    dependency.matches(specifier),
  );
  if (fenced)
    return fenced.owners.includes(owner)
      ? undefined
      : { kind: "fenced", owners: fenced.owners };
  // `node:sqlite` (its Windows close() lock) and better-sqlite3 are no longer
  // admitted anywhere.
  if (name === "sqlite" || specifier === "better-sqlite3")
    return { kind: "sqlite-driver", owners: sqliteOwners };
  if (name === "module" || name === "vm") return { kind: "loader" };
  return undefined;
}
