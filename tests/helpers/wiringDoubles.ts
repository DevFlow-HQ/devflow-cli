import { readFileSync } from "node:fs";
import type {
  CleanupReport,
  HarnessAdapter,
  HarnessDefaults,
  HarnessProfile,
} from "../../src/harness/harness.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";

// The composition suites' Harness and Process doubles: a Harness that qualifies
// without a child, and a Process that resolves every command and answers Git
// probes in process, so a wired Application runs Command Runs spawn-free.

export const QUALIFICATION_PROFILE: HarnessProfile = {
  harness: "Claude Code",
  executable: "PATH name 'claude' -> /tools/claude",
  executableVersion: "9.9.9",
  platform: "linux",
  adapterRevision: "wiring-test-v1",
  configurationPosture: "Uses the user's existing Claude Code configuration.",
  recovery: { mode: "native-reattach", evidence: "Native resume." },
  interruption: { mode: "active-turn", evidence: "Native interrupt." },
  approvals: { available: true, evidence: "Native approvals." },
  agentCalls: {
    available: false,
    evidence: "Native agent-call attachment is not qualified yet.",
  },
  clarifications: { available: true, evidence: "Native questions." },
  steer: { available: true, evidence: "Native steering." },
  modelSelection: {
    at: "launch",
    declaration: { kind: "free-text", efforts: ["low", "medium", "high"] },
    evidence: "Launch model flag.",
  },
  modelObservation: { available: true, evidence: "Model events." },
  modelChange: { reach: "next-turn", evidence: "scripted fake" },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "Known before content.",
  },
  skillDelivery: { mode: "plain-path", evidence: "Path delivery." },
  fileDelivery: { mode: "plain-path", evidence: "Path delivery." },
};

/** What the qualification double reports as the Harness's own defaults. */
export const QUALIFICATION_DEFAULTS: HarnessDefaults = {
  kind: "reported",
  choice: { model: "wired-model", effort: "high" },
};

export function qualificationAdapter(
  trace: string[],
  cleanup: CleanupReport = { clean: true, detail: "closed" },
): HarnessAdapter {
  return {
    async prepare(options) {
      trace.push(`prepare:${options.workspace}`);
      return {
        ok: true,
        harness: {
          profile: QUALIFICATION_PROFILE,
          async readDefaults() {
            trace.push("defaults");
            return QUALIFICATION_DEFAULTS;
          },
          startTurn() {
            throw new Error("qualification must not start a Turn");
          },
          async close() {
            trace.push("close");
            return cleanup;
          },
        },
      };
    },
  };
}

export function wiringProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      const assetPath = options.args[0] === "-e" ? undefined : options.args[0];
      let text = "";
      if (assetPath !== undefined) {
        const script = readFileSync(assetPath, "utf8");
        text = script.includes("__filename")
          ? `${assetPath}\n`
          : `${/console\.log\('([^']*)'\)/.exec(script)?.[1] ?? ""}\n`;
      }
      return {
        kind: "exited",
        status: 0,
        text: new TextEncoder().encode(text),
      };
    },
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
}
