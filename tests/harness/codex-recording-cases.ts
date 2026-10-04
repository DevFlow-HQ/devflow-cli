import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_RECORDING_INPUT = {
  agentCalls:
    "Call secant.step_done with reason 'recorded completion', then recording_external.needs_approval, then recording_external.ask_form, then recording_external.ask_url, in that exact order. If a request is declined, continue with the next tool. Do not call other tools. Finally reply: recorded channel.",
  agentCallsLegacy:
    "Call recording_external.needs_approval once. If declined, reply: recorded legacy decline. Do not call other tools.",
  completion: "Reply with exactly: recorded completion.",
  secondCompletion: "Reply with exactly: recorded second completion.",
  approval:
    "Run `touch /tmp/secant-codex-recording-approval` now. Do not do anything else.",
  steer:
    "Think silently about the number one until you receive more guidance. Do not inspect files or run tools.",
  steerGuidance: "Finish now with exactly: recorded steer.",
  leftover: "Reply with exactly: recorded leftover.",
  leftoverGuidance: "Now reply with exactly: recorded re-delivery.",
  sleep: "Run `sleep 30` now. Do not inspect files or do anything else.",
  resume: "Reply with exactly: recorded resume.",
} as const;

/** The Model choice each `two-turns` Turn requests (#345): one model at two
 *  efforts, so the recording carries per-Turn effort on `turn/start` and what
 *  `thread/read` reports back for each Turn. Test Repair requests its own below;
 *  every other case requests none. */
export const CODEX_RECORDING_MODEL_CHOICE = {
  first: { model: "gpt-5.5", effort: "low" },
  second: { model: "gpt-5.5", effort: "medium" },
} as const;

/** The Model choice the Test Repair recording's Turn requests (#342): the
 *  default the `codex-qualification` recording reports, so a flagless launch
 *  that qualifies against that recording replays this session unchanged. */
export const CODEX_TEST_REPAIR_MODEL_CHOICE = {
  model: "gpt-5.5",
  effort: "high",
} as const;

export function codexTestRepairPrompt(workspace: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "bundles",
      "test-repair-workflow",
      "prompts",
      "fix.md",
    ),
    "utf8",
  ).replace("{{artifact:failing-test}}", join(workspace, "sum.test.mjs"));
}
