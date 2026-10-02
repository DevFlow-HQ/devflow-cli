// PROTOTYPE — frozen fixtures, not a maintained Harness/model catalogue.
export type Model = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
};
const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_MODELS: Model[] = [
  {
    id: "opus",
    label: "Opus (latest)",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "sonnet",
    label: "Sonnet (latest)",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "haiku",
    label: "Haiku (latest)",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "default",
    label: "Default",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "opusplan",
    label: "Opus Plan",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "opus[1m]",
    label: "Opus (latest) · 1M",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "sonnet[1m]",
    label: "Sonnet (latest) · 1M",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
  {
    id: "other",
    label: "Other… exact model name",
    efforts: claudeEfforts,
    defaultEffort: "medium",
  },
];
export const CODEX_MODELS: Model[] = [
  {
    id: "gpt-6-astra",
    label: "gpt-6-astra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-sol",
    label: "gpt-6-sol",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    id: "gpt-6-luna",
    label: "gpt-6-luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
];
export type Scenario = {
  key: string;
  title: string;
  harness: "Claude Code" | "Codex";
  model: string;
  effort?: string;
  source: string;
  locked?: string;
  noEffort?: boolean;
};
export const SCENARIOS: Scenario[] = [
  {
    key: "codex-last",
    title: "Codex · last choice",
    harness: "Codex",
    model: "gpt-6-astra",
    effort: "xhigh",
    source: "Your last choice for Codex",
  },
  {
    key: "codex-default",
    title: "Codex · reported default",
    harness: "Codex",
    model: "gpt-6-sol",
    effort: "medium",
    source: "From your Codex settings",
  },
  {
    key: "claude-last",
    title: "Claude Code · last choice",
    harness: "Claude Code",
    model: "sonnet",
    effort: "high",
    source: "Your last choice for Claude Code",
  },
  {
    key: "claude-default",
    title: "Claude Code · reported default",
    harness: "Claude Code",
    model: "opus",
    effort: "medium",
    source: "From your Claude Code settings",
  },
  {
    key: "locked",
    title: "Claude Code · locked effort",
    harness: "Claude Code",
    model: "opus",
    effort: "high",
    source: "Your last choice for Claude Code",
    locked: "high",
  },
  {
    key: "no-effort",
    title: "Claude Code · no effort setting",
    harness: "Claude Code",
    model: "example-model-without-effort",
    source: "Your last choice for Claude Code",
    noEffort: true,
  },
  {
    key: "fallback",
    title: "Claude Code · settings unavailable",
    harness: "Claude Code",
    model: "opus",
    effort: "medium",
    source:
      "Could not read Claude Code settings. Starting with Opus (latest) and medium effort.",
  },
];
