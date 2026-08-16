import fs from "fs-extra";
import { join } from "node:path";

const DEVFLOW_HOOK_ENTRY_SPECS = [
  { eventName: "SessionStart", matcher: "startup" },
  { eventName: "SessionStart", matcher: "resume" },
  { eventName: "UserPromptSubmit" },
  { eventName: "Stop" },
] as const;

type ClaudeHookEntrySpec = (typeof DEVFLOW_HOOK_ENTRY_SPECS)[number];
type ClaudeHookEventName = ClaudeHookEntrySpec["eventName"];

interface ClaudeHookSettingsOptions {
  configDirectory: string;
  hookScriptPath: string;
}

export interface CleanupClaudeHookSettingsOptions extends ClaudeHookSettingsOptions {
  deleteIfEmptyAndCreatedByDevFlow: boolean;
}

type JsonObject = Record<string, unknown>;

interface ClaudeHookCommand {
  type: "command";
  command: string;
}

interface ClaudeHookMatcherEntry {
  matcher?: string;
  hooks: unknown[];
}

export class ClaudeHookSettingsError extends Error {
  readonly settingsPath: string;
  readonly cause: unknown;

  constructor(settingsPath: string, cause: unknown) {
    const causeMessage =
      cause instanceof Error ? cause.message : "Unknown settings failure";

    super(
      `Could not read Claude settings at ${settingsPath}: ${causeMessage}.`,
    );
    this.name = "ClaudeHookSettingsError";
    this.settingsPath = settingsPath;
    this.cause = cause;
  }
}

export async function installClaudeHookSettings(
  options: ClaudeHookSettingsOptions,
): Promise<void> {
  const settingsPath = claudeUserSettingsPath(options.configDirectory);
  const settings = await readClaudeSettings(settingsPath);
  const hooks = ensureObjectProperty(settings, "hooks");
  const command = claudeHookCommand(options.hookScriptPath);

  for (const spec of DEVFLOW_HOOK_ENTRY_SPECS) {
    const entries = ensureArrayProperty(hooks, spec.eventName);

    if (hasHookMatcherEntry(entries, spec, command)) {
      continue;
    }

    entries.push(claudeHookMatcherEntry(spec, command));
  }

  await fs.ensureDir(options.configDirectory);
  await fs.writeJson(settingsPath, settings, { spaces: 2 });
}

export async function cleanupClaudeHookSettings(
  options: CleanupClaudeHookSettingsOptions,
): Promise<void> {
  const settingsPath = claudeUserSettingsPath(options.configDirectory);

  if (!(await fs.pathExists(settingsPath))) {
    return;
  }

  const settings = await readClaudeSettings(settingsPath);
  const hooks = getObjectProperty(settings, "hooks");

  if (hooks) {
    for (const eventName of devflowHookEventNames()) {
      removeDevFlowHookEntries(hooks, eventName, options.hookScriptPath);
    }

    pruneEmptyObjectProperty(settings, "hooks");
  }

  if (options.deleteIfEmptyAndCreatedByDevFlow && isEmptyObject(settings)) {
    await fs.remove(settingsPath);
    return;
  }

  await fs.writeJson(settingsPath, settings, { spaces: 2 });
}

export function claudeHookCommand(hookScriptPath: string): string {
  return `node ${shellQuote(hookScriptPath)}`;
}

function claudeUserSettingsPath(configDirectory: string): string {
  return join(configDirectory, "settings.json");
}

async function readClaudeSettings(settingsPath: string): Promise<JsonObject> {
  if (!(await fs.pathExists(settingsPath))) {
    return {};
  }

  try {
    const settings = (await fs.readJson(settingsPath)) as unknown;

    if (!isObject(settings) || Array.isArray(settings)) {
      throw new Error("expected a JSON object");
    }

    return settings;
  } catch (error) {
    throw new ClaudeHookSettingsError(settingsPath, error);
  }
}

function claudeHookMatcherEntry(
  spec: ClaudeHookEntrySpec,
  command: string,
): ClaudeHookMatcherEntry {
  const entry: ClaudeHookMatcherEntry = {
    hooks: [
      {
        type: "command",
        command,
      } satisfies ClaudeHookCommand,
    ],
  };

  if ("matcher" in spec) {
    entry.matcher = spec.matcher;
  }

  return entry;
}

function hasHookMatcherEntry(
  entries: unknown[],
  spec: ClaudeHookEntrySpec,
  command: string,
): boolean {
  return entries.some(
    (entry) =>
      isObject(entry) &&
      matcherMatchesSpec(entry.matcher, spec) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some(
        (hook) =>
          isObject(hook) && hook.type === "command" && hook.command === command,
      ),
  );
}

function matcherMatchesSpec(
  matcher: unknown,
  spec: ClaudeHookEntrySpec,
): boolean {
  return "matcher" in spec ? matcher === spec.matcher : matcher === undefined;
}

function devflowHookEventNames(): ClaudeHookEventName[] {
  return Array.from(
    new Set(DEVFLOW_HOOK_ENTRY_SPECS.map((spec) => spec.eventName)),
  );
}

function removeDevFlowHookEntries(
  hooks: JsonObject,
  eventName: ClaudeHookEventName,
  hookScriptPath: string,
): void {
  const entries = hooks[eventName];

  if (!Array.isArray(entries)) {
    return;
  }

  const command = claudeHookCommand(hookScriptPath);
  const filteredEntries = entries
    .map((entry) => removeDevFlowCommandsFromMatcherEntry(entry, command))
    .filter((entry) => entry !== undefined);

  if (filteredEntries.length > 0) {
    hooks[eventName] = filteredEntries;
    return;
  }

  delete hooks[eventName];
}

function removeDevFlowCommandsFromMatcherEntry(
  entry: unknown,
  command: string,
): unknown | undefined {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) {
    return entry;
  }

  const remainingHooks = entry.hooks.filter(
    (hook) =>
      !(isObject(hook) && hook.type === "command" && hook.command === command),
  );

  if (remainingHooks.length === 0) {
    return undefined;
  }

  return {
    ...entry,
    hooks: remainingHooks,
  };
}

function ensureObjectProperty(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];

  if (isObject(value) && !Array.isArray(value)) {
    return value;
  }

  const nextValue: JsonObject = {};
  parent[key] = nextValue;
  return nextValue;
}

function getObjectProperty(
  parent: JsonObject,
  key: string,
): JsonObject | undefined {
  const value = parent[key];

  return isObject(value) && !Array.isArray(value) ? value : undefined;
}

function ensureArrayProperty(parent: JsonObject, key: string): unknown[] {
  const value = parent[key];

  if (Array.isArray(value)) {
    return value;
  }

  const nextValue: unknown[] = [];
  parent[key] = nextValue;
  return nextValue;
}

function pruneEmptyObjectProperty(parent: JsonObject, key: string): void {
  const value = parent[key];

  if (isObject(value) && !Array.isArray(value) && isEmptyObject(value)) {
    delete parent[key];
  }
}

function isEmptyObject(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
