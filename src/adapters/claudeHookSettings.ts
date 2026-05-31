import fs from "fs-extra";
import { join } from "node:path";

const DEVFLOW_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;

type ClaudeHookEventName = (typeof DEVFLOW_HOOK_EVENTS)[number];

interface ClaudeHookSettingsOptions {
  configDirectory: string;
  hookScriptPath: string;
}

export interface CleanupClaudeHookSettingsOptions
  extends ClaudeHookSettingsOptions {
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
      `Could not read Claude local settings at ${settingsPath}: ${causeMessage}.`,
    );
    this.name = "ClaudeHookSettingsError";
    this.settingsPath = settingsPath;
    this.cause = cause;
  }
}

export async function installClaudeHookSettings(
  options: ClaudeHookSettingsOptions,
): Promise<void> {
  const settingsPath = claudeLocalSettingsPath(options.configDirectory);
  const settings = await readClaudeLocalSettings(settingsPath);
  const hooks = ensureObjectProperty(settings, "hooks");

  for (const eventName of DEVFLOW_HOOK_EVENTS) {
    const entries = ensureArrayProperty(hooks, eventName);
    entries.push(claudeHookMatcherEntry(eventName, options.hookScriptPath));
  }

  await fs.ensureDir(options.configDirectory);
  await fs.writeJson(settingsPath, settings, { spaces: 2 });
}

export async function cleanupClaudeHookSettings(
  options: CleanupClaudeHookSettingsOptions,
): Promise<void> {
  const settingsPath = claudeLocalSettingsPath(options.configDirectory);

  if (!(await fs.pathExists(settingsPath))) {
    return;
  }

  const settings = await readClaudeLocalSettings(settingsPath);
  const hooks = getObjectProperty(settings, "hooks");

  if (hooks) {
    for (const eventName of DEVFLOW_HOOK_EVENTS) {
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

function claudeLocalSettingsPath(configDirectory: string): string {
  return join(configDirectory, "settings.local.json");
}

async function readClaudeLocalSettings(settingsPath: string): Promise<JsonObject> {
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
  eventName: ClaudeHookEventName,
  hookScriptPath: string,
): ClaudeHookMatcherEntry {
  const entry: ClaudeHookMatcherEntry = {
    hooks: [
      {
        type: "command",
        command: claudeHookCommand(hookScriptPath),
      } satisfies ClaudeHookCommand,
    ],
  };

  if (eventName === "SessionStart") {
    entry.matcher = "startup";
  }

  return entry;
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
  pruneEmptyObjectProperty(hooks, eventName);
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
      !(
        isObject(hook) &&
        hook.type === "command" &&
        hook.command === command
      ),
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

function getObjectProperty(parent: JsonObject, key: string): JsonObject | undefined {
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
