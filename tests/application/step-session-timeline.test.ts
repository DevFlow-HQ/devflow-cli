import { readRun } from "./run-test-helpers.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type TurnResult,
  type TurnEvent,
} from "../../src/harness/harness.js";
import type { RunTimelineEvent } from "../../src/application/projection-port.js";
import type { ProcessAdapter, SpawnResult } from "../../src/process/process.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeTurnScript,
} from "../harness/fake-adapter.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// [step-session-timeline] Every Step-scoped timeline event and transcript entry
// names its Step, and every Turn names its Harness Session in plain words (#289),
// through the shared Projection Port over the real Application and Run Store with
// the fake Harness Adapter. The Bundle shares one Session across two Agent Steps
// (the second retried once), runs a Command step, then a Repeat group whose Agent
// step opens a `fresh` Session per Iteration. The clock is frozen, so every event
// shares one instant and only the Application's ordering keeps each Step's events
// together.

const sharedGit = createFakeGitProcess();

const BASELINE = "process.exit(1)";
const CHECK = "check";

/** Commands play the Bundle: the baseline Verdict fails so the group runs, and the
 *  group's check fails its first Iteration and passes its second. */
function fakeProcess(): ProcessAdapter {
  let checks = 0;
  const exited = (status: number): SpawnResult => ({
    kind: "exited",
    status,
    text: new TextEncoder().encode(""),
  });
  return storedProcess({
    git: sharedGit,
    script: {
      commandHandler: (options) => {
        const script = options.args[1];
        if (script === BASELINE) return exited(1);
        if (script === CHECK) return exited(++checks >= 2 ? 0 : 1);
        throw new Error(`unexpected fake Command script: ${script}`);
      },
    },
  });
}

const COMPLETED: TurnResult = {
  kind: "completed",
  detail: {
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

const FAILED: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "turn",
      category: "native-failure",
      possibleEffects: "none",
      diagnostics: "a transient fault",
    },
    effectiveModel: { known: false },
    session: { state: "open" },
  },
};

function turn(content: string, result: TurnResult): FakeTurnScript {
  return {
    events: [
      { kind: "assistant-content", messageId: `message-${content}`, content },
    ],
    result,
  };
}

const BUNDLE_ID = "dev.secant.step-session-timeline";

function writeBundle(): string {
  const folder = makeTempDir("secant-step-session-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  for (const name of ["grill", "spec", "implement"]) {
    writeFileSync(join(folder, "prompts", `${name}.md`), `Do ${name}.\n`);
  }
  const command = (script: string) => ({
    executable: RUNTIME_NAME,
    arguments: ["-e", script],
  });
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: BUNDLE_ID,
      version: "1.0.0",
      name: "Step Session Timeline",
      description: "Steps that share, retry, and renew Harness Sessions.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: ["grill", "spec", "implement"].map((name) => ({
      path: `prompts/${name}.md`,
      kind: "prompt",
    })),
    routing: [
      {
        id: "grill",
        kind: "agent",
        retry: 0,
        session: "spec",
        prompt: { asset: "prompts/grill.md" },
      },
      {
        id: "write-spec",
        kind: "agent",
        retry: 1,
        session: "spec",
        prompt: { asset: "prompts/spec.md" },
      },
      {
        id: "baseline",
        kind: "command",
        produces: [{ name: "passing", type: "verdict" }],
        command: command(BASELINE),
      },
      {
        repeat: {
          until: "passing",
          reviewCheckpoint: { interval: 10, message: "review the loop" },
          steps: [
            {
              id: "implement",
              kind: "agent",
              retry: 0,
              session: "fresh",
              prompt: { asset: "prompts/implement.md" },
            },
            {
              id: "check",
              kind: "command",
              produces: [{ name: "passing", type: "verdict" }],
              command: command(CHECK),
            },
          ],
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return folder;
}

async function launch(
  t: TestContext,
  extra: FakeTurnScript["events"] = [],
): Promise<{
  wired: Wiring;
  runId: string;
}> {
  setEnvironmentForTest(t, { [CLAUDE_CODE_EXECUTABLE_ENV]: process.execPath });
  const adapter = createFake({
    profile: fakeHarnessProfile({
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
    }),
    turns: [
      {
        ...turn("grilled", COMPLETED),
        events: extra.length ? extra : turn("grilled", COMPLETED).events,
      },
      turn("spec draft", FAILED),
      turn("spec written", COMPLETED),
      turn("first ticket", COMPLETED),
      turn("second ticket", COMPLETED),
    ],
  })();
  const workspace = makeTempDir("secant-step-session-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-step-session-home-"),
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(
    wired.bundleManagement.build(writeBundle(), { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === BUNDLE_ID);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: BUNDLE_ID },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
      requestedModel: "fake-model",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId: admission.runId };
}

/** The Step sequence the timeline reads in, each run of one Step collapsed. */
function stepRuns(timeline: readonly RunTimelineEvent[]): string[] {
  const runs: string[] = [];
  for (const event of timeline) {
    if (event.step !== undefined && runs.at(-1) !== event.step) {
      runs.push(event.step);
    }
  }
  return runs;
}

const RUN_SCOPED = new Set([
  "run-created",
  "trust-granted",
  "iteration",
  "checkpoint-blocked",
  "gate-answered",
  "materialization-conflict",
]);

test("[step-session-timeline] every Step-scoped event names its Step, each Step's events stay together at one instant, and Sessions carry plain names", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: Date.parse("2026-10-01T09:00:00.000Z"),
  });
  const { wired, runId } = await launch(t);
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "succeeded");

  // Every event shares the frozen instant, so the order below is the Application's.
  assert.equal(new Set(run.timeline.map((event) => event.at)).size, 1);

  // Run-scoped and group-scoped events name no Step; every other event does.
  for (const event of run.timeline) {
    assert.equal(
      event.step === undefined,
      RUN_SCOPED.has(event.event),
      JSON.stringify(event),
    );
  }
  assert.deepEqual(stepRuns(run.timeline), [
    "grill",
    "write-spec",
    "baseline",
    "implement",
    "check",
    "implement",
    "check",
  ]);
  // Each Iteration's mark follows the check that completed it.
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "iteration")
      .map((event) => run.timeline[run.timeline.indexOf(event) - 1]?.step),
    ["check", "check"],
  );

  // The retry is the same Step: a failed then a succeeded Attempt, both named.
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "attempt-settled")
      .map((event) => `${event.step} ${event.detail}`),
    [
      "grill succeeded",
      "write-spec failed",
      "write-spec succeeded",
      "baseline succeeded",
      "implement succeeded",
      "check succeeded",
      "implement succeeded",
      "check succeeded",
    ],
  );

  // A shared Session keeps its authored name across Steps and the retry; a `fresh`
  // Session is named with its Iteration. Every Turn-scoped event names its Session.
  const started = run.timeline.filter(
    (event) => event.event === "turn-started",
  );
  assert.deepEqual(
    started.map((event) => `${event.step} · ${event.sessionName}`),
    [
      "grill · spec",
      "write-spec · spec",
      "write-spec · spec",
      "implement · fresh, iteration 1",
      "implement · fresh, iteration 2",
    ],
  );
  assert.equal(started[0]!.session, started[2]!.session);
  assert.notEqual(started[3]!.session, started[4]!.session);
  for (const event of run.timeline) {
    const turnScoped =
      event.event.startsWith("turn-") || event.event === "assistant-content";
    assert.equal(
      event.session !== undefined,
      turnScoped,
      JSON.stringify(event),
    );
    assert.equal(
      event.sessionName !== undefined,
      turnScoped,
      JSON.stringify(event),
    );
  }

  // Each Session's view carries the same plain name its Turns do.
  assert.deepEqual(
    (run.sessions ?? []).map((session) => session.name),
    ["spec", "fresh, iteration 1", "fresh, iteration 2"],
  );

  // Every transcript entry names its Step, through the page and export reads.
  const spec = run.sessions?.find((session) => session.name === "spec");
  assert.ok(spec?.transcriptPage && spec.transcriptExport);
  const page = wired.projectionPort.readTranscript(spec.transcriptPage);
  assert.ok(page.found && page.type === "transcript-page");
  // Identified settled messages remain readable even when their Turn later fails.
  assert.deepEqual(
    page.entries.map((entry) => `${entry.step} ${entry.role}`),
    [
      "grill user",
      "grill assistant",
      "write-spec user",
      "write-spec assistant",
      "write-spec user",
      "write-spec assistant",
    ],
  );
  assert.deepEqual(
    page.entries.filter((e) => e.role === "assistant").map((e) => e.content),
    ["grilled", "spec draft", "spec written"],
  );
  const exported = wired.projectionPort.readTranscript(spec.transcriptExport);
  assert.ok(exported.found && exported.type === "transcript-export");
  assert.deepEqual(
    exported.entries.map((entry) => entry.step),
    page.entries.map((entry) => entry.step),
  );
  const second = run.sessions?.find(
    (session) => session.name === "fresh, iteration 2",
  );
  assert.ok(second?.transcriptPage);
  const secondPage = wired.projectionPort.readTranscript(second.transcriptPage);
  assert.ok(secondPage.found && secondPage.type === "transcript-page");
  assert.deepEqual(
    secondPage.entries.map((entry) => entry.step),
    ["implement", "implement"],
  );
});

test("declined elicitation crosses Harness execution into durable Projection Port history", async (t) => {
  const evidence = {
    harness: "claude-code",
    server: "setup",
    message: "Confirm setup",
    url: "https://example.com/setup",
  } satisfies Omit<
    Extract<TurnEvent, { kind: "elicitation-declined" }>,
    "kind"
  >;
  const { wired, runId } = await launch(t, [
    { kind: "elicitation-declined", ...evidence },
  ]);
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "succeeded");
  const row = run.timeline.find(
    (event) => event.event === "elicitation-declined",
  );
  assert.ok(row);
  assert.deepEqual(row.elicitation, evidence);
  assert.equal(row.step, "grill");
  assert.equal(row.sessionName, "spec");
  assert.match(row.detail ?? "", /Finish setup in Claude Code directly/);
});
