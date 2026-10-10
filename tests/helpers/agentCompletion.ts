import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { wireApplication } from "../../src/composition/main.js";
import {
  type HarnessAdapter,
  TurnRequest,
  AgentCallAnswer,
} from "../../src/harness/harness.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
} from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import type { RunOwner } from "../../src/run/store/store.js";

export const completed: FakeScript["turns"][number]["result"] = {
  kind: "completed",
  detail: { effectiveModel: { known: false }, session: { state: "open" } },
};
export const call = (
  reason: string,
  key = reason,
  id: "step_done" | "stage_done" = "step_done",
) => ({
  callId: { opaque: key },
  id,
  reason,
});

export const reviewedLoop = (reviewCheckpoint?: object) => [
  {
    repeat: {
      control: "human",
      ...(reviewCheckpoint !== undefined ? { reviewCheckpoint } : {}),
      steps: [
        {
          id: "implement",
          kind: "interactive-agent",
          session: "s",
          entryTurn: true,
          agentCompletion: true,
          prompt: { asset: "prompt.md" },
        },
      ],
    },
  },
];
// One script across re-prepares: each continuation resumes where the last stopped.
export const across =
  (script: FakeScript["turns"]) => (_prepare: number, started: number) =>
    script.slice(started);
/** One Turn-event Store read: the kinds and Turn asked for, and the kinds returned. */
export interface TurnEventRead {
  readonly kinds?: Parameters<RunOwner["turnEventsOfKinds"]>[0];
  readonly turnId?: string;
  readonly kindsRead: readonly string[];
}
export async function launchAgentCompletionRun(
  t: TestContext,
  turns:
    | FakeScript["turns"]
    | ((prepare: number, started: number) => FakeScript["turns"]),
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
  observe: {
    /** Each Turn-event Store read of every owner the Application acquires. */
    onTurnEventRead?: (read: TurnEventRead) => void;
  } = {},
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
  const adapter = (): HarnessAdapter =>
    ownPreparations({
      async prepare(options) {
        const prepared = await createFake({
          profile: fakeHarnessProfile({
            agentCalls: {
              available: true,
              evidence: "scripted calls",
            },
            steer: { available: true, evidence: "scripted fake" },
          }),
          turns:
            typeof turns === "function"
              ? turns(prepares++, requests.length)
              : turns,
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
                changeModel: (choice) => turn.changeModel(choice),

                answerAgentCall(answer) {
                  answers.push(answer);
                  return turn.answerAgentCall(answer);
                },
              };
            },
          },
        };
      },
    });
  const home = makeTempDir("secant-agent-done-home-");
  const workspacePath = makeTempDir("secant-agent-done-ws-");
  const options = {
    secantHome: home,
    launchCwd: workspacePath,
    supportsInteractiveTurns: true,
    get harnessAdapter() {
      return adapter();
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
    const { onTurnEventRead } = observe;
    if (onTurnEventRead !== undefined) {
      const acquire = instance.runGroup.acquireRun;
      instance.runGroup.acquireRun = (...args) => {
        const owner = acquire(...args);
        if (owner === undefined) return undefined;
        return {
          ...owner,
          get record() {
            return owner.record;
          },
          turnEvents() {
            const events = owner.turnEvents();
            onTurnEventRead({ kindsRead: events.map((e) => e.kind) });
            return events;
          },
          turnEventsOfKinds(kinds, turnId) {
            const events = owner.turnEventsOfKinds(kinds, turnId);
            onTurnEventRead({
              kinds,
              ...(turnId === undefined ? {} : { turnId }),
              kindsRead: events.map((e) => e.kind),
            });
            return events;
          },
        };
      };
    }
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
