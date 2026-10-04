import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { wireApplication } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_SERVED_CAPABILITIES,
  type HarnessAdapter,
  HarnessProfile,
  TurnRequest,
  AgentCallAnswer,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";

function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    agentCalls: {
      available: true,
      evidence: "scripted calls",
    },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: true, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    modelObservation: { available: true, evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

export const completed: FakeScript["turns"][number]["result"] = {
  kind: "completed",
  detail: { effectiveModel: { known: false }, session: { state: "open" } },
};
export const call = (reason: string, key = reason) => ({
  callId: { opaque: key },
  id: "step_done",
  reason,
});

export async function launchAgentCompletionRun(
  t: TestContext,
  turns: FakeScript["turns"] | ((prepare: number) => FakeScript["turns"]),
  steps: readonly unknown[] = [
    {
      id: "discuss",
      kind: "interactive-agent",
      session: "s",
      entryTurn: true,
      agentCompletion: ["step"],
      prompt: { asset: "prompt.md" },
    },
  ],
) {
  const folder = makeTempDir("secant-agent-done-bundle-");
  writeFileSync(join(folder, "prompt.md"), "Discuss the plan.");
  mkdirSync(join(folder, "skill"));
  writeFileSync(join(folder, "skill", "SKILL.md"), "Read carefully.");
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id: "dev.secant.agent-done",
        version: "1.0.0",
        name: "Agent done",
        description: "Completion fixture.",
      },
      inputs: {},
      assets: [
        { path: "prompt.md", kind: "prompt" },
        { path: "skill", kind: "skill" },
      ],
      routing: steps,
    }),
  );
  const requests: TurnRequest[] = [];
  const answers: AgentCallAnswer[] = [];
  let prepares = 0;
  const adapter: HarnessAdapter = {
    async prepare(options) {
      const prepared = await createFake({
        profile: profile(),
        turns: typeof turns === "function" ? turns(prepares++) : turns,
      })().prepare(options);
      if (!prepared.ok) return prepared;
      return {
        ok: true,
        harness: {
          ...prepared.harness,
          profile: prepared.harness.profile,
          readDefaults: () => prepared.harness.readDefaults(),
          close: () => prepared.harness.close(),
          startTurn(request) {
            requests.push(request);
            const turn = prepared.harness.startTurn(request);
            return {
              ...turn,
              result: () => turn.result(),
              subscribe: (listener) => turn.subscribe(listener),
              interrupt: () => turn.interrupt(),
              steer: (input) => turn.steer(input),
              answerRequest: (answer) => turn.answerRequest(answer),

              answerAgentCall(answer) {
                answers.push(answer);
                return turn.answerAgentCall(answer);
              },
            };
          },
        },
      };
    },
  };
  const home = makeTempDir("secant-agent-done-home-");
  const workspacePath = makeTempDir("secant-agent-done-ws-");
  const options = {
    secantHome: home,
    launchCwd: workspacePath,
    supportsInteractiveTurns: true,
    harnessAdapter: adapter,
    harnessCapabilities: {
      "claude-code": [
        ...Object.keys(CLAUDE_CODE_SERVED_CAPABILITIES),
        "agentCalls",
      ],
    },
    process: createFakeBundleProcess(),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: { source: "path", name: "claude", description: "fake" },
    }),
  } satisfies Parameters<typeof wireApplication>[0];
  const instances: ReturnType<typeof wireApplication>[] = [];
  const reopen = () => {
    const instance = wireApplication(options);
    instances.push(instance);
    return instance;
  };
  const wired = reopen();
  t.after(async () => {
    for (const instance of instances) {
      await instance.shutdown();
      instance.runGroup.close();
      instance.catalog.close();
    }
  });
  const built = wired.bundleManagement.build(folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.agent-done");
  assert.ok(entry);
  const workspace = wired.projectionPort.openProjection({
    family: "workspace",
  });
  assert.ok(
    wired.projectionPort.submit({
      operationId: "approve",
      operation: "approve-workspace",
      input: { path: workspacePath },
    }).admitted,
  );
  workspace.close();
  const admission = wired.projectionPort.submit({
    operationId: "launch",
    operation: "launch-run",
    input: {
      bundle: { id: entry.id },
      trustDigest: entry.digest,
      launchInputs: {},
      harness: "claude-code",
      requestedModel: "fake",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  return { wired, runId: admission.runId, requests, answers, reopen };
}

export function readCompletionRun(
  wired: Awaited<ReturnType<typeof launchAgentCompletionRun>>["wired"],
  runId: string,
): RunView {
  const view = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(view.snapshot.result.found);
    return view.snapshot.result.run;
  } finally {
    view.close();
  }
}
