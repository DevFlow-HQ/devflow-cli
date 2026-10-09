import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import {
  TRANSCRIPT_PAGE_SIZE,
  type RunExecution,
} from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import type {
  OpenedProjection,
  ProjectionPort,
  ProjectionSelector,
  RunSnapshot,
} from "../../src/application/projection-port.js";
import { createApplication } from "../helpers/application.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";
import {
  countingBundleProcess,
  createFakeBundleProcess,
} from "../helpers/fakeBundleProcess.js";
import {
  hostPlatform,
  repeatCommandGateRouting,
  writeCommandBundle,
  writeGateBundle,
  writeRepeatBundle,
  writeRoutingBundle,
  type GateBundleOptions,
  type RepeatBundleOptions,
} from "../helpers/commandBundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { openLiveRun } from "../helpers/liveRun.js";
import { makeTempDir } from "../helpers/tempDir.js";

const executionProcess = createFakeBundleProcess();

function harness(t: TestContext, opts: { commandTimeoutMs?: number } = {}) {
  const h = openHeadlessHarness(t, {
    slug: "secant-runcli",
    ...(opts.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: opts.commandTimeoutMs }
      : {}),
  });
  return {
    ...h,
    install: async (bundleOpts?: Parameters<typeof writeCommandBundle>[0]) => {
      const cmd = writeCommandBundle(bundleOpts);
      assert.equal(await h.run(["bundle", "build", cmd.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === cmd.id);
      assert.ok(entry);
      return { id: cmd.id, digest: entry.digest };
    },
    installRepeat: async (repeatOpts: RepeatBundleOptions) => {
      const bundle = writeRepeatBundle(repeatOpts);
      assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      return { id: bundle.id, digest: entry.digest };
    },
    installGate: async (gateOpts: GateBundleOptions) => {
      const bundle = writeGateBundle(gateOpts);
      assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      return { id: bundle.id, digest: entry.digest };
    },
    approve: () => h.catalog.approveWorkspace(h.workspace, new Date()),
  };
}

async function launchTrusted({
  h,
  bundle,
  expectedExit,
}: {
  h: ReturnType<typeof harness>;
  bundle: { id: string; digest: string };
  expectedExit: 0 | 1 | 2;
}) {
  assert.equal(
    await h.run(["run", "launch", bundle.id, "--trust", bundle.digest]),
    expectedExit,
    h.output(),
  );
  const runId = /^Run (\S+)$/m.exec(h.stdout())?.[1];
  assert.ok(runId, h.output());
  return runId;
}

test("run launch on an untrusted digest prints the summary, warning, and digest, and exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();

  assert.equal(await runHeadless(h.clients, ["run", "launch", id], h.io), 1);
  const err = h.stderr();
  assert.match(err, /bundle-trust-required/);
  assert.match(err, /Execution summary/);
  assert.match(err, /current user's authority/);
  assert.match(err, new RegExp(digest));
  assert.equal(h.stdout(), "");
});

test("m12-local-test-helpers: [headless-on-doubles] run launch --trust runs to succeeded, and a second launch needs no trust", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();

  await launchTrusted({ h, bundle: { id, digest }, expectedExit: 0 });
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: succeeded$/m);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["run", "launch", id], h.io), 0);
  assert.match(h.stdout(), /^State: succeeded$/m);
});

test("m10-audit-operation-settlement-owner: headless launch waits on the Port receipt and reports the settled Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const inner = h.clients.projectionPort;
  const calls: string[] = [];
  const open = (selector: ProjectionSelector): OpenedProjection => {
    assert.notEqual(
      selector.family,
      "operation",
      "settlement must not reopen a receipt",
    );
    return inner.openProjection(selector);
  };
  const port: ProjectionPort = {
    ...inner,
    openProjection: open as ProjectionPort["openProjection"],
    settledOperation(operationId) {
      calls.push(operationId);
      return inner.settledOperation(operationId);
    },
  };
  const code = await runHeadless(
    { ...h.clients, projectionPort: port },
    ["run", "launch", id, "--trust", digest],
    h.io,
  );
  assert.equal(calls.length, 1);
  assert.equal(code, 0, h.output());
  assert.match(h.stdout(), /^State: succeeded$/m);
});

test("m10-audit-operation-settlement-owner: headless shutdown ends the request follower and pending wait without reporting success", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const inner = h.clients.projectionPort;
  let runOpens = 0;
  let readAfterEnd = false;
  let terminalSeen = false;
  let followerEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    followerEnded = resolve;
  });
  let operationId = "";
  let answers = 0;
  let stopping: Promise<void> | undefined;
  const open = (selector: ProjectionSelector): OpenedProjection => {
    assert.notEqual(selector.family, "operation");
    const view = inner.openProjection(selector);
    if (selector.family !== "run") return view;
    runOpens++;
    return {
      ...view,
      updates: (async function* () {
        try {
          for await (const update of view.updates) {
            if (update.kind === "closed") terminalSeen = true;
            yield update;
            if (update.kind === "closed") {
              readAfterEnd = true;
              throw new Error("follower read past shutdown");
            }
          }
        } finally {
          followerEnded();
        }
      })(),
    };
  };
  const port: ProjectionPort = {
    ...inner,
    openProjection: open as ProjectionPort["openProjection"],
    async settledOperation(id) {
      operationId = id;
      const receipt = inner.settledOperation(id);
      stopping = h.clients.shutdown();
      const snapshot = await receipt;
      await ended;
      return snapshot;
    },
    submit(submission) {
      if (submission.operation === "answer-harness-request") answers++;
      return inner.submit(submission);
    },
  };
  const code = await runHeadless(
    { ...h.clients, projectionPort: port },
    ["run", "launch", id, "--trust", digest],
    h.io,
  );
  await stopping;
  assert.equal(code, 1);
  assert.match(h.stderr(), /operation-observation-ended/);
  assert.match(h.stderr(), /application-shutdown/);
  assert.doesNotMatch(h.stdout(), /State:|succeeded/);
  assert.equal(runOpens, 1);
  assert.equal(answers, 0);
  assert.equal(terminalSeen, true);
  assert.equal(readAfterEnd, false);
  const outcome = await inner.settledOperation(operationId);
  assert.notEqual(outcome.outcome.status, "pending");
});

test("run launch --input accepts a multi-line text value unchanged, line endings included (#287)", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install({
    inputs: { note: { type: "text", description: "a note" } },
  });
  h.approve();
  const note = "line one\nline two\r\nline three\r";

  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest, "--input", `note=${note}`],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^State: succeeded$/m);
  const runs = h.runGroup?.listRuns() ?? [];
  assert.equal(runs.length, 1);
  const read = h.runGroup?.readRun(runs[0]?.runId ?? "");
  assert.ok(read?.ok);
  // Byte-exact: headless values are never normalised, unlike a TUI paste.
  assert.deepEqual(read.run.launch, { note });
});

test("[both-client-harness-selection] run launch rejects --harness for a Command-only Bundle", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest, "--harness", "codex"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /harness-selection-irrelevant/);
  assert.equal(h.runGroup?.listRuns().length, 0);
});

test("[requested-model-durability] run launch rejects --model for a Command-only Bundle", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest, "--model", "requested-opus"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /requested-model-irrelevant/);
  assert.equal(h.runGroup?.listRuns().length, 0);
});

test("[launch-preparation-headless] run launch prints every finding and exits without submitting when not ready", async (t) => {
  const h = await harness(t);
  const { id } = await h.install({
    inputs: { note: { type: "text", description: "a note" } },
  });
  h.approve();
  // A required input left unprovided AND no trust acknowledgement: the pre-launch
  // assessment prints both findings in one invocation and submits nothing.
  const code = await runHeadless(h.clients, ["run", "launch", id], h.io);
  assert.equal(code, 1);
  const err = h.stderr();
  assert.match(err, /launch-input-invalid/);
  assert.match(err, /bundle-trust-required/);
  assert.equal(h.stdout(), "");
  assert.equal(h.runGroup?.listRuns().length, 0);
});

test("[launch-preparation-headless] run launch --json prints the not-ready status with all findings", async (t) => {
  const h = await harness(t);
  const { id } = await h.install({
    inputs: { note: { type: "text", description: "a note" } },
  });
  h.approve();
  const code = await runHeadless(
    h.clients,
    ["run", "launch", id, "--json"],
    h.io,
  );
  assert.equal(code, 1);
  const parsed = JSON.parse(h.stdout());
  assert.equal(parsed.status, "not-ready");
  const codes = parsed.findings.map(
    (finding: { code: string }) => finding.code,
  );
  assert.ok(codes.includes("launch-input-invalid"));
  assert.ok(codes.includes("bundle-trust-required"));
  assert.equal(h.runGroup?.listRuns().length, 0);
});

test("run resume has no --model option", async (t) => {
  const h = await harness(t);
  const code = await runHeadless(
    h.clients,
    ["run", "resume", "some-run", "--model", "opus"],
    h.io,
  );
  assert.notEqual(code, 0);
  assert.match(h.stderr(), /unknown-option/);
});

test("run launch on an uninstalled Bundle exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  h.approve();
  assert.equal(
    await runHeadless(h.clients, ["run", "launch", "io.example.absent"], h.io),
    1,
  );
  assert.match(h.stderr(), /bundle-not-installed/);
});

test("run launch without an id exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["run", "launch"], h.io), 1);
  assert.match(h.stderr(), /missing-bundle-id/);
});

test("run show prints identity, state, progress, position, and timeline; --json carries the snapshot", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install({
    script: "console.log('shown-output')",
  });
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId);
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const text = h.stdout();
  assert.match(text, new RegExp(`Run ${runId}`));
  assert.match(text, /State: succeeded/);
  assert.match(text, /Progress:/);
  assert.match(text, /run-check \(command\): succeeded/);
  assert.match(text, /Position: at rest/);
  assert.match(text, /Timeline:/);
  assert.match(text, /run-created/);
  assert.doesNotMatch(text, /Selected Harness:/);
  assert.doesNotMatch(text, /Observed Harness:/);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    family: string;
    result: {
      found: boolean;
      run: {
        state: string;
        selectedHarness?: unknown;
        harness?: unknown;
        effectiveModel?: unknown;
      };
    };
  };
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.equal(snapshot.result.run.selectedHarness, undefined);
  assert.equal(snapshot.result.run.harness, undefined);
  assert.equal(snapshot.result.run.effectiveModel, undefined);
});

test("run launch of a Run that rests failed exits non-zero and shows the failed Step", async (t) => {
  // A resolvable executable whose Attempt fails at runtime: the command runs past
  // a short command timeout, so spawnSync kills it and reports no exit status —
  // a failed Attempt on every platform (a clean non-zero exit would instead be a
  // `fail` verdict on a *succeeded* Attempt, and Windows has no real signals to
  // force one). An off-PATH executable is now refused by Preflight before a Run
  // exists (see tests/application/preflight.test.ts).
  const h = await harness(t, { commandTimeoutMs: 200 });
  const { id, digest } = await h.install({
    script: "setTimeout(() => {}, 60000)",
    retry: 0,
  });
  h.approve();

  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 1,
  });
  assert.match(h.stdout(), /^State: failed$/m);
  assert.ok(runId);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(h.stdout(), /run-check \(command\): failed/);
});

test("run show on an unknown Run id exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["run", "show", "no-such-run"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-found/);
});

test("run read returns a text Artifact's content and a Verdict's value by reference", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install({ script: "console.log('read-me')" });
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/output`], h.io),
    0,
  );
  assert.match(h.stdout(), /read-me/);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/verdict`], h.io),
    0,
  );
  assert.equal(h.stdout(), "pass\n");
});

test("run read of an unknown output exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/absent`], h.io),
    1,
  );
  assert.match(h.stderr(), /run-output-not-found/);
});

test("one multi-page transcript reads through both clients, no real Harness (#124)", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId);
  assert.ok(h.runGroup);

  // Seed a multi-page transcript directly in the Run Store — no Harness runs.
  const total = TRANSCRIPT_PAGE_SIZE + 5;
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  for (let i = 0; i < total; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:agent",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native",
      harness: "claude-code",
      at: new Date(),
    });
  }
  owner.close();

  // Client one — headless `run read --transcript`: a bounded newest page (with an
  // "older" hint) and the complete export.
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", runId, "--transcript"], h.io),
    0,
  );
  const printed = h.stdout();
  assert.match(printed, /Transcript page \(s\)/);
  assert.match(printed, new RegExp(`input ${total - 1}`));
  assert.match(printed, /older entries retained/);
  assert.match(printed, /Complete transcript \(s\)/);
  assert.match(printed, /input 0\b/);

  // Client two — the Projection Port read seam the Workbench uses: the same page
  // is bounded and carries an opaque cursor; the export is complete.
  const opened = h.clients.projectionPort.openProjection({
    family: "run",
    runId,
  });
  const snapshot = opened.snapshot;
  opened.close();
  assert.ok(snapshot.result.found);
  const session = snapshot.result.run.sessions?.find((s) => s.session === "s");
  assert.ok(session?.transcriptPage);
  assert.ok(session.transcriptExport);
  const page = h.clients.projectionPort.readTranscript(session.transcriptPage);
  assert.ok(page.found && page.type === "transcript-page");
  assert.equal(page.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.ok(page.older, "the bounded page carries an opaque older cursor");
  const complete = h.clients.projectionPort.readTranscript(
    session.transcriptExport,
  );
  assert.ok(complete.found && complete.type === "transcript-export");
  assert.equal(complete.entries.length, total);
});

test("m10-interruption-and-transcript: headless maps exact stored metadata and excludes Resource identity", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId && h.runGroup);
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  const at = new Date("2026-10-06T00:00:00.000Z");
  owner.admitTurn({
    turnId: "message-turn",
    attemptId: "0.0:agent",
    session: "s",
    origin: "managed",
    kind: "interactive-agent",
    input: "Entry",
    recoveryCoordinate: "native",
    harness: "claude-code",
    at,
  });
  owner.appendTurnEvent({
    turnId: "message-turn",
    kind: "assistant-content",
    payload: JSON.stringify({ messageId: "first", content: "First" }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "message-turn",
    kind: "steer",
    payload: JSON.stringify({
      steerId: "steer-id",
      text: "Direction",
      sentAt: at.toISOString(),
      settlement: { kind: "delivered", delivery: "after-boundary" },
    }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "message-turn",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "partial",
      content: "Partial",
      incomplete: true,
    }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "message-turn",
    kind: "tool-call",
    payload: JSON.stringify({
      callId: "file-call",
      tool: "file-change",
      input: "requested.ts",
      outcome: { kind: "completed" },
      files: [
        {
          path: "observed.ts",
          patch: { kind: "unified", content: "PRIVATE_CALL_PATCH" },
        },
      ],
    }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "message-turn",
    kind: "turn-diff",
    payload: JSON.stringify({
      files: [{ path: "cumulative.ts" }],
      content: "PRIVATE_TURN_DIFF",
    }),
    at,
  });
  owner.settleTurn({
    turnId: "message-turn",
    session: "s",
    resultKind: "interrupted",
    resultDetail: "{}",
    availability: "open",
    at,
  });
  owner.close();
  h.reset();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "read", runId, "--transcript", "--json"],
      h.io,
    ),
    0,
  );
  const read = JSON.parse(h.stdout());
  const entries = [
    {
      session: "s",
      role: "user",
      content: "Entry",
      step: "agent",
      kind: "entry-prompt",
      turn: "message-turn",
    },
    {
      session: "s",
      role: "assistant",
      content: "First",
      step: "agent",
      kind: "message",
      turn: "message-turn",
    },
    {
      session: "s",
      role: "user",
      content: "Direction",
      step: "agent",
      kind: "steer",
      turn: "message-turn",
      steer: { id: "steer-id", delivery: "after-boundary" },
    },
    {
      session: "s",
      role: "assistant",
      content: "Partial",
      step: "agent",
      kind: "message",
      turn: "message-turn",
      incomplete: true,
    },
  ];
  assert.deepEqual(read, {
    page: { found: true, type: "transcript-page", entries },
    export: { found: true, type: "transcript-export", entries },
  });
  // The new fields belong only to transcript reads. run show carries its existing
  // durable timeline/session shape and never inlines conversation rows.
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const shown = JSON.parse(h.stdout());
  assert.deepEqual(Object.keys(shown.result.run).sort(), [
    "actionOffers",
    "bundle",
    "launchedAt",
    "liveness",
    "outputs",
    "position",
    "progress",
    "runId",
    "sessions",
    "state",
    "timeline",
    "turnPosition",
    "workspacePath",
  ]);
  assert.equal("transcript" in shown.result.run, false);
  assert.equal("entries" in shown.result.run, false);
  assert.doesNotMatch(
    h.stdout(),
    /PRIVATE_CALL_PATCH|PRIVATE_TURN_DIFF|observed.ts|cumulative.ts|turn-diff/,
  );
});

// --- Repeat groups (#84, ADR 0020) -----------------------------------------

test("m12-local-test-helpers: run launch on a blocking Repeat group names the Run and blocked, and exits 2 at the checkpoint", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installRepeat({ interval: 3 });
  h.approve();

  // A Run resting `blocked` at its Human Gate exits 2, distinct from a failure (A36).
  await launchTrusted({ h, bundle: { id, digest }, expectedExit: 2 });
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: blocked$/m);
});

test("run show prints the Review checkpoint facts for a blocked Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installRepeat({
    interval: 3,
    message: "human, please look",
  });
  h.approve();

  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 2,
  });
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  assert.match(out, /Review checkpoint:/);
  assert.match(out, /message: human, please look/);
  assert.match(out, /cadence: every 3 iteration/);
  assert.match(out, /completed iterations: 3/);
  assert.match(out, /latest verdict: passing = fail/);
  assert.match(out, /gate: approve-reject at step check/);
});

test("run show --json carries the checkpoint for a blocked Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installRepeat({ interval: 2 });
  h.approve();

  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 2,
  });
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    result: {
      found: boolean;
      run: {
        state: string;
        checkpoint?: {
          completedIterations: number;
          gate: { attemptId: string; stepId: string };
        };
      };
    };
  };
  assert.ok(snapshot.result.found);
  assert.equal(snapshot.result.run.state, "blocked");
  assert.equal(snapshot.result.run.checkpoint?.completedIterations, 2);
  assert.equal(snapshot.result.run.checkpoint?.gate.stepId, "check");
  assert.match(snapshot.result.run.checkpoint?.gate.attemptId ?? "", /\S/);
});

// --- Answering the Human Gate (#85, ADR 0020) ------------------------------

/** Launch a blocking Repeat Bundle and return its blocked Run id. */
async function launchBlocked(
  h: Awaited<ReturnType<typeof harness>>,
  opts: RepeatBundleOptions,
): Promise<string> {
  const { id, digest } = await h.installRepeat(opts);
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 2,
  });
  h.reset();
  return runId;
}

test("run answer --continue grants an interval that passes and rests the Run succeeded", async (t) => {
  const h = await harness(t);
  // interval 2, passes on the 3rd iteration: the first interval blocks, the
  // granted interval reaches the pass.
  const runId = await launchBlocked(h, { interval: 2, passAt: 3 });

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    0,
  );
  const out = h.stdout();
  assert.match(out, /Answered: continue/);
  assert.match(out, /^State: succeeded$/m);
});

test("run answer --continue that keeps failing blocks again with a fresh interval", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 }); // always fails

  // The first gate.
  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const before = parseRun(h.stdout());
  h.reset();
  assert.equal(before.checkpoint?.completedIterations, 2);
  const firstGate = before.checkpoint?.gate.attemptId;

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    2, // blocked again at the checkpoint (A36)
  );
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // The count reset to the interval since the grant, and the block moved to a
  // fresh Attempt — a new interval actually ran.
  assert.equal(after.checkpoint?.completedIterations, 2);
  assert.notEqual(after.checkpoint?.gate.attemptId, firstGate);
});

test("run answer --stop rests the Run failed with its history and Artifacts intact", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 });

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /Answered: stop/);
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // The answer is a durable, readable Artifact; the loop's Verdict is still
  // readable; the timeline records the answer.
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "read", `${runId}/human-gate-answer`],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^stop$/m);
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/passing`], h.io),
    0,
  );
  assert.match(h.stdout(), /^fail$/m);
  h.reset();
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.match(h.stdout(), /gate-answered stop/);
});

test("run show offers the answer action only while blocked, naming each consequence", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2, passAt: 3 });

  // While blocked, the offer appears and states the consequence of each answer.
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  const blocked = h.stdout();
  assert.match(blocked, /Answer the checkpoint:/);
  assert.match(
    blocked,
    /run answer .* --continue .*grant one more review interval/,
  );
  assert.match(blocked, /run answer .* --stop .*end the Run failed/);
  h.reset();

  // Once answered (and succeeded), the offer is gone.
  await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io);
  h.reset();
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.doesNotMatch(h.stdout(), /Answer the checkpoint:/);
});

test("run answer on a Run that is not blocked is refused, changing nothing", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install(); // a straight-line Bundle that succeeds
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-blocked/);
});

test("run answer needs exactly one of --continue or --stop", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", "some-run"], h.io),
    1,
  );
  assert.match(h.stderr(), /invalid-answer/);
});

test("two invocations: block under one instance, continue under a fresh instance over the same home (#85, AC6)", async (t) => {
  const catalogHome = makeTempDir("secant-2inv-cat-");
  const storeHome = makeTempDir("secant-2inv-store-");
  const workspace = realpathSync.native(makeTempDir("secant-2inv-ws-"));
  const mkExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
      process: executionProcess,
    });
  const sink = () => {
    const lines: string[] = [];
    const io: HeadlessIO = {
      out: (t) => lines.push(t),
      err: (t) => lines.push(t),
      cwd: () => workspace,
    };
    return { io, text: () => lines.join("") };
  };

  // A Repeat Bundle that passes on its 3rd iteration, interval 2: the first
  // instance blocks after two iterations, the second instance's granted interval
  // reaches the pass.
  const bundle = writeRepeatBundle({ interval: 2, passAt: 3 });

  // Instance A: build, approve, launch → blocked.
  const catA = openCatalog(catalogHome);
  const groupA = openRunGroup(storeHome, workspace);
  const appA = createApplication({
    catalog: catA,
    launchWorkspacePath: workspace,
    runGroup: groupA,
    runExecution: mkExecution,
    process: executionProcess,
  });
  const a = sink();
  assert.equal(
    await runHeadless(appA, ["bundle", "build", bundle.folder], a.io),
    0,
  );
  const entry = catA.listEntries().find((e) => e.id === bundle.id)!;
  catA.approveWorkspace(workspace, new Date());
  const launch = sink();
  assert.equal(
    await runHeadless(
      appA,
      ["run", "launch", bundle.id, "--trust", entry.digest],
      launch.io,
    ),
    2, // blocked at the checkpoint (A36)
  );
  const runId = /^Run (\S+)$/m.exec(launch.text())![1]!;
  assert.match(launch.text(), /^State: blocked$/m);
  groupA.close();
  catA.close();

  // Instance B: a fresh Application over the same Secant home answers the durable
  // Gate and drives the Run to completion.
  const catB = openCatalog(catalogHome);
  const groupB = openRunGroup(storeHome, workspace);
  t.after(() => groupB.close());
  const appB = createApplication({
    catalog: catB,
    launchWorkspacePath: workspace,
    runGroup: groupB,
    runExecution: mkExecution,
    process: executionProcess,
  });
  t.after(() => catB.close());
  const b = sink();
  assert.equal(
    await runHeadless(appB, ["run", "answer", runId, "--continue"], b.io),
    0,
  );
  assert.match(b.text(), /^State: succeeded$/m);
});

test("run resume reports a live foreign owner and --takeover continues while fencing it", async (t) => {
  const catalogHome = makeTempDir("secant-takeover-cat-");
  const storeHome = makeTempDir("secant-takeover-store-");
  const workspace = realpathSync.native(makeTempDir("secant-takeover-ws-"));
  const catalog = openCatalog(catalogHome);
  t.after(() => catalog.close());
  const first = openRunGroup(storeHome, workspace, { selfPid: 1000 });
  t.after(() => first.close());
  const buildApp = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    runGroup: first,
    process: executionProcess,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
  });
  const bundle = writeCommandBundle({ id: "dev.secant.takeover" });
  const built = buildApp.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog
    .listEntries()
    .find((candidate) => candidate.id === bundle.id);
  assert.ok(entry);
  catalog.approveWorkspace(workspace, new Date());
  catalog.grantTrust({
    operationId: "trust-takeover",
    digest: entry.digest,
    installationGeneration: entry.installationGeneration,
    grantedAt: new Date(),
  });
  const created = first.createRun({
    operationId: "create-takeover",
    bundleSnapshotDigest: entry.digest,
    launch: {},
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  const priorOwner = first.acquireRun(created.runId);
  assert.ok(priorOwner);
  t.after(() => priorOwner.close());
  assert.deepEqual(priorOwner.writeState("running"), { ok: true });

  const second = openRunGroup(storeHome, workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    runGroup: second,
    process: executionProcess,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
  });
  const output: string[] = [];
  const io: HeadlessIO = {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    cwd: () => workspace,
  };

  assert.equal(await runHeadless(app, ["run", "resume", created.runId], io), 1);
  assert.match(output.join(""), /run-live-elsewhere/);
  assert.match(output.join(""), /process 1000/);
  output.length = 0;

  // `run show` names the foreign owner in its header while the Run is live
  // elsewhere (ADR 0031).
  assert.equal(await runHeadless(app, ["run", "show", created.runId], io), 0);
  assert.match(
    output.join(""),
    /^Live: in another instance \(process 1000\)$/m,
  );
  output.length = 0;

  assert.equal(
    await runHeadless(app, ["run", "resume", created.runId, "--takeover"], io),
    0,
  );
  assert.match(output.join(""), /^State: succeeded$/m);
  assert.deepEqual(priorOwner.writeState("cancelled"), {
    ok: false,
    reason: "fenced",
  });
  assert.deepEqual(priorOwner.release(), { ok: false, reason: "fenced" });
});

test("run resume of a Run rested failed by a checkpoint stop resets bounds and blocks after another full interval (#86, AC2)", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 }); // always fails

  // Stop at the checkpoint: the Run rests failed.
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // Resume the failed Run: its Iteration bounds reset, so it runs another full
  // interval and blocks again (exit 2 at the checkpoint, A36), rather than failed.
  assert.equal(await runHeadless(h.clients, ["run", "resume", runId], h.io), 2);
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // A full fresh interval ran since the grant, not zero and not a partial count.
  assert.equal(after.checkpoint?.completedIterations, 2);
});

test("run show offers the resume action only while resting failed or halted (#86)", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 });
  await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io); // rest failed
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId], h.io);
  const failed = h.stdout();
  assert.match(failed, /^State: failed$/m);
  assert.match(failed, /Resume:/);
  assert.match(failed, /secant run resume .*grant another try/);
  h.reset();

  // A succeeded Run offers no resume.
  const { id, digest } = await h.install();
  h.approve();
  const doneId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  h.reset();
  await runHeadless(h.clients, ["run", "show", doneId], h.io);
  assert.match(h.stdout(), /^State: succeeded$/m);
  assert.doesNotMatch(h.stdout(), /Resume:/);
});

test("run show warns that resuming an indeterminate Command Attempt may repeat effects (#194 story 39)", async (t) => {
  const h = await harness(t);
  const { digest } = await h.install();
  assert.ok(h.runGroup);
  // Seed a halted Run whose command Attempt ended indeterminate directly in the Run
  // Store — no child spawns; the resume section must carry the additive warning line.
  const created = h.runGroup.createRun({
    operationId: "op-indeterminate",
    bundleSnapshotDigest: digest,
    launch: {},
    at: new Date(),
  });
  assert.ok(created.outcome === "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = h.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  owner.publishAttempt({
    attemptId: "0.0:build",
    outcome: "indeterminate",
    required: [],
    outputs: [],
    at: new Date(),
    advanceState: "halted",
  });
  owner.close();

  await runHeadless(h.clients, ["run", "show", created.runId], h.io);
  const out = h.stdout();
  assert.match(out, /^State: halted$/m);
  assert.match(out, /Resume:/);
  assert.match(out, /warning: .*effects may repeat/);
});

/** Parse a `run show --json` snapshot's run view (blocked-run shape). */
function parseRun(json: string): {
  state: string;
  checkpoint?: {
    completedIterations: number;
    gate: { attemptId: string };
  };
} {
  const snapshot = JSON.parse(json) as {
    result: { found: boolean; run: ReturnType<typeof parseRun> };
  };
  assert.ok(snapshot.result.found);
  return snapshot.result.run;
}

// --- Authored Human Gate, headless end to end (#108) ------------------------

/** Launch an authored Human Gate Bundle and return its blocked Run id, asserting
 *  it exits 2 at the gate and names the follow-up answer command. */
async function launchGate(
  h: Awaited<ReturnType<typeof harness>>,
  opts: GateBundleOptions,
): Promise<string> {
  const { id, digest } = await h.installGate(opts);
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 2,
  });
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  h.reset();
  return runId;
}

test("a free-text gate rests blocked naming run answer --text, and answering continues the Run reading the bound answer (#108, AC1)", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installGate({
    shape: "free-text",
    message: "name the release",
    outputName: "answer",
  });
  h.approve();

  // The Run rests blocked at the gate, exits 2, and names the follow-up command.
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 2,
  });
  const launch = h.stdout();
  assert.match(launch, /^State: blocked$/m);
  assert.match(launch, /run answer .*--text/);
  h.reset();

  // A later invocation answers with free text; the Run continues in that process
  // and the downstream Command reads the bound answer, resting succeeded (exit 0).
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", runId, "--text", "v2.0.0"],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /Answered: v2\.0\.0/);
  assert.match(h.stdout(), /^State: succeeded$/m);
  h.reset();

  // The free-text answer is published as the gate's declared `text` output.
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/answer`], h.io),
    0,
  );
  assert.match(h.stdout(), /^v2\.0\.0$/m);
});

test("[repeat-command-gate-progress] run show targets the Gate after a passing Repeat and an outside Command, and run answer re-runs no Command (#384)", async (t) => {
  const { process, runs } = countingBundleProcess();
  const h = openHeadlessHarness(t, { slug: "secant-runcli", process });
  const bundle = writeRoutingBundle({
    id: "dev.secant.repeat-command-gate",
    routing: repeatCommandGateRouting(),
  });
  assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
  h.reset();
  const digest = h.catalog
    .listEntries()
    .find((entry) => entry.id === bundle.id)!.digest;
  h.catalog.approveWorkspace(h.workspace, new Date());
  assert.equal(await h.run(["run", "launch", bundle.id, "--trust", digest]), 2);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(await h.run(["run", "show", runId]), 0);
  const shown = h.stdout();
  assert.match(shown, /^State: blocked$/m);
  assert.match(shown, /^Position: step 4 of 5$/m);
  assert.match(shown, /durable Human Gate/);
  assert.match(shown, /message: approve the outside change/);
  assert.match(
    shown,
    /gate: approve-reject at step gate \(attempt 0\.0:gate\)/,
  );
  assert.ok(
    shown.includes(`secant run answer ${runId} --continue  # approve:`),
    shown,
  );
  assert.match(shown, /^ {2}outside \(command\): succeeded$/m);
  assert.match(shown, /^ {2}gate \(human-gate\): blocked$/m);
  h.reset();

  assert.equal(await h.run(["run", "show", runId, "--json"]), 0);
  const run = (
    JSON.parse(h.stdout()) as {
      result: {
        run: {
          progress: { id: string; status: string }[];
          position: number;
          pendingGate?: { gate: unknown };
          checkpoint?: unknown;
          actionOffers: { action: string; gate?: unknown }[];
        };
      };
    }
  ).result.run;
  h.reset();
  const gate = {
    runId,
    stepId: "gate",
    attemptId: "0.0:gate",
    shape: "approve-reject",
  };
  assert.deepEqual(
    run.progress.map((step) => `${step.id}:${step.status}`),
    [
      "baseline:succeeded",
      "check:succeeded",
      "outside:succeeded",
      "gate:blocked",
      "after:pending",
    ],
  );
  assert.equal(run.position, 3);
  assert.deepEqual(run.pendingGate?.gate, gate);
  assert.equal(run.checkpoint, undefined);
  assert.deepEqual(
    run.actionOffers.find((offer) => offer.action === "answer-human-gate")
      ?.gate,
    gate,
  );
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1 });

  assert.equal(await h.run(["run", "answer", runId, "--continue"]), 0);
  assert.match(h.stdout(), /^State: succeeded$/m);
  assert.deepEqual(runs, { baseline: 1, check: 1, outside: 1, after: 1 });
});

test("an authored approve-reject gate: --continue advances succeeded, --stop rests failed (#108, AC2)", async (t) => {
  const h = await harness(t);
  const approveId = await launchGate(h, {
    id: "dev.secant.gate-cli-approve",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", approveId, "--continue"],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^State: succeeded$/m);
  h.reset();

  const rejectId = await launchGate(h, {
    id: "dev.secant.gate-cli-reject",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", rejectId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
});

test("run show and --json carry the authored pending gate; blocked reads durable Human Gate (#108, AC4)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, {
    shape: "free-text",
    message: "name the release",
    outputName: "answer",
  });

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  assert.match(out, /durable Human Gate/);
  assert.match(out, /shape: free-text/);
  assert.match(out, /message: name the release/);
  assert.match(out, /output: answer/);
  assert.match(out, /Answer the gate:/);
  assert.match(out, /run answer .*--text/);
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    result: {
      found: boolean;
      run: {
        state: string;
        pendingGate?: {
          message: string;
          outputArtifactName?: string;
          gate: { shape: string; stepId: string; attemptId: string };
        };
      };
    };
  };
  assert.ok(snapshot.result.found);
  // Frozen existing field unchanged; new pending-gate fields are additive.
  assert.equal(snapshot.result.run.state, "blocked");
  assert.equal(snapshot.result.run.pendingGate?.gate.shape, "free-text");
  assert.equal(snapshot.result.run.pendingGate?.message, "name the release");
  assert.equal(snapshot.result.run.pendingGate?.outputArtifactName, "answer");
  assert.match(snapshot.result.run.pendingGate?.gate.attemptId ?? "", /\S/);
});

test("run show presents a cancelled authored-Gate Run without a gate or refused actions (#336)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, { shape: "free-text" });
  assert.equal(await h.run(["run", "cancel", runId]), 0);
  h.reset();

  assert.equal(await h.run(["run", "show", runId]), 0);
  const out = h.stdout();
  assert.match(out, /^State: cancelled$/m);
  assert.match(out, new RegExp(`run delete ${runId}`));
  assert.doesNotMatch(
    out,
    /durable Human Gate|Answer the gate:|run answer|run cancel/,
  );
  h.reset();

  assert.equal(await h.run(["run", "show", runId, "--json"]), 0);
  const snapshot = JSON.parse(h.stdout()) as RunSnapshot;
  assert.ok(snapshot.result.found);
  if (!snapshot.result.found) throw new Error("unreachable");
  assert.equal(snapshot.result.run.state, "cancelled");
  assert.equal(snapshot.result.run.pendingGate, undefined);
  assert.deepEqual(
    snapshot.result.run.actionOffers.map((offer) => offer.action),
    ["delete-run"],
  );
});

test("a suggested free-text gate: run show names the suggestions, --json carries them, and --text answers with one (#213)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, {
    id: "dev.secant.gate-cli-suggested",
    shape: "free-text",
    message: "Where should the spec live?",
    outputName: "tracker",
    suggestions: ["Local", "GitHub"],
  });

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(
    h.stdout(),
    /^ {2}suggestions: Local, GitHub \(or any other text\)$/m,
  );
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    result: { run: { pendingGate?: { suggestions?: string[] } } };
  };
  assert.deepEqual(snapshot.result.run.pendingGate?.suggestions, [
    "Local",
    "GitHub",
  ]);
  h.reset();

  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", runId, "--text", "GitHub"],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^State: succeeded$/m);
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/tracker`], h.io),
    0,
  );
  assert.match(h.stdout(), /^GitHub$/m);
});

test("answer-shape mismatches are refused and change nothing (#108, AC3)", async (t) => {
  const h = await harness(t);
  // --text to an approve-reject gate is refused; the Run stays blocked.
  const approveId = await launchGate(h, {
    id: "dev.secant.gate-cli-mismatch-a",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", approveId, "--text", "nope"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /gate-shape-mismatch/);
  h.reset();
  await runHeadless(h.clients, ["run", "show", approveId], h.io);
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  // --continue to a free-text gate is refused; the Run stays blocked.
  const freeTextId = await launchGate(h, {
    id: "dev.secant.gate-cli-mismatch-f",
    shape: "free-text",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", freeTextId, "--continue"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /gate-shape-mismatch/);
});

test("run answer needs exactly one of --continue, --stop, or --text (#108)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, {
    id: "dev.secant.gate-cli-invalid",
    shape: "free-text",
  });
  // Two answer forms at once is refused before any submission.
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", runId, "--continue", "--text", "x"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /invalid-answer/);
});

for (const url of ["https://example.com/setup", undefined]) {
  test(`run show renders declined elicitation safely ${url === undefined ? "without" : "with"} a URL and preserves JSON evidence`, async (t) => {
    const h = await harness(t);
    const { digest } = await h.install();
    assert.ok(h.runGroup);
    const created = h.runGroup.createRun({
      operationId: "elicitation-display",
      bundleSnapshotDigest: digest,
      launch: {},
      at: new Date(),
    });
    assert.equal(created.outcome, "created");
    if (created.outcome !== "created") throw new Error("unreachable");
    const owner = h.runGroup.acquireRun(created.runId);
    assert.ok(owner);
    const evidence = {
      harness: "claude-code",
      server: "setup",
      message: "Finish\u0000setup\u001b[31m now\u001b[0m",
      ...(url === undefined ? {} : { url }),
    };
    assert.deepEqual(
      owner.admitTurn({
        turnId: "turn-1",
        attemptId: "attempt-1",
        session: "repair",
        origin: "managed",
        kind: "agent",
        input: "repair",
        recoveryCoordinate: "native-1",
        harness: "claude-code",
        at: new Date(),
      }),
      { ok: true },
    );
    assert.ok(
      owner.appendTurnEvent({
        turnId: "turn-1",
        kind: "elicitation-declined",
        payload: JSON.stringify(evidence),
        at: new Date(),
      }).ok,
    );
    assert.deepEqual(owner.writeState("succeeded"), { ok: true });
    owner.close();
    h.reset();
    assert.equal(await h.run(["run", "show", created.runId]), 0);
    const text = h.stdout();
    assert.match(
      text,
      /elicitation-declined claude-code\/setup: Finishsetup now/,
    );
    assert.match(
      text,
      /Finish setup in Claude Code directly before continuing/,
    );
    assert.equal(text.includes(String.fromCharCode(0)), false);
    assert.equal(text.includes(String.fromCharCode(27)), false);
    assert.doesNotMatch(text, /\[31m|\[0m/);
    if (url !== undefined) assert.ok(text.includes(url));
    else assert.doesNotMatch(text, /https:\/\/example.com\/setup|undefined/);
    h.reset();
    assert.equal(await h.run(["run", "show", created.runId, "--json"]), 0);
    const snapshot = z
      .object({
        result: z.object({
          run: z.object({
            timeline: z.array(
              z.object({
                event: z.string(),
                elicitation: z
                  .object({
                    harness: z.string(),
                    server: z.string(),
                    message: z.string(),
                    url: z.string().optional(),
                  })
                  .optional(),
              }),
            ),
          }),
        }),
      })
      .parse(JSON.parse(h.stdout()));
    assert.deepEqual(
      snapshot.result.run.timeline.find(
        (event) => event.event === "elicitation-declined",
      )?.elicitation,
      evidence,
    );
  });
}

test("m10-observed-harness-facts: run show JSON is byte-identical across live accounting reports", async (t) => {
  const live = await openLiveRun(t);
  t.after(live.finish);
  const h = harness(t);
  const clients = {
    projectionPort: live.port,
    bundleManagement: h.clients.bundleManagement,
  };
  assert.equal(
    await runHeadless(clients, ["run", "show", live.runId, "--json"], h.io),
    0,
  );
  const before = h.stdout();
  h.reset();
  live.channel.observe({
    context: { usedTokens: 9000, limitTokens: 2, percentage: 150 },
    usage: "total input 124304, last input 25435",
  });
  assert.equal(
    await runHeadless(clients, ["run", "show", live.runId, "--json"], h.io),
    0,
  );
  assert.equal(h.stdout(), before);
  assert.doesNotMatch(
    h.stdout(),
    /usedTokens|limitTokens|percentage|total input|last input/,
  );
  assert.deepEqual(live.owner.turnEvents(), []);
  await live.finish();
});

test("m10-audit-headless-output-parity: text transcript annotates Entry prompts, Steers and incomplete replies", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(runId && h.runGroup);
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  const at = new Date("2026-10-06T00:00:00.000Z");
  owner.admitTurn({
    turnId: "annotated-turn",
    attemptId: "0.0:agent",
    session: "s",
    origin: "managed",
    kind: "interactive-agent",
    input: "Entry",
    recoveryCoordinate: "native",
    harness: "claude-code",
    at,
  });
  owner.appendTurnEvent({
    turnId: "annotated-turn",
    kind: "assistant-content",
    payload: JSON.stringify({ messageId: "first", content: "First" }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "annotated-turn",
    kind: "steer",
    payload: JSON.stringify({
      steerId: "direction",
      text: "Direction",
      sentAt: at.toISOString(),
      settlement: { kind: "delivered", delivery: "after-boundary" },
    }),
    at,
  });
  owner.appendTurnEvent({
    turnId: "annotated-turn",
    kind: "assistant-content",
    payload: JSON.stringify({
      messageId: "partial",
      content: "\u001b[31mPartial\u001b[0m",
      incomplete: true,
    }),
    at,
  });
  owner.settleTurn({
    turnId: "annotated-turn",
    session: "s",
    resultKind: "interrupted",
    resultDetail: "{}",
    availability: "open",
    at,
  });
  owner.close();
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", runId, "--transcript"], h.io),
    0,
  );
  const entries =
    "user · Entry prompt: Entry\nassistant: First\nuser · Steer: Direction\nassistant · incomplete: Partial\n";
  assert.equal(
    h.stdout(),
    `Transcript page (s):\n${entries}\nComplete transcript (s):\n${entries}`,
  );
  assert.equal(h.stderr(), "");
});

test("m10-audit-changed-file-cap: headless transcript and export keep complete message text beside 300-file tool and Turn diffs", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(h.runGroup);
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  const at = new Date("2026-10-08T00:00:00Z");
  const files = Array.from({ length: 300 }, (_, index) => ({
    path: `file-${index}.ts`,
    patch: { kind: "unified", content: `+patch-${index}` },
  }));
  const content = files.map((file) => file.path).join("\n");
  owner.admitTurn({
    turnId: "large-turn",
    attemptId: "0.0:agent",
    session: "s",
    origin: "human",
    kind: "interactive-agent",
    input: "Review these changes",
    recoveryCoordinate: "native",
    harness: "codex",
    at,
  });
  owner.appendTurnEvent({
    turnId: "large-turn",
    kind: "tool-call",
    at,
    payload: JSON.stringify({
      callId: "large-call",
      tool: "file-change",
      input: content,
      files,
      outcome: { kind: "completed" },
    }),
  });
  owner.appendTurnEvent({
    turnId: "large-turn",
    kind: "turn-diff",
    at,
    payload: JSON.stringify({ files, content }),
  });
  owner.appendTurnEvent({
    turnId: "large-turn",
    kind: "assistant-content",
    at,
    payload: JSON.stringify({
      messageId: "large-message",
      content,
    }),
  });
  owner.settleTurn({
    turnId: "large-turn",
    session: "s",
    resultKind: "completed",
    resultDetail: "{}",
    availability: "open",
    at,
  });
  owner.close();
  h.reset();
  assert.equal(
    await h.run(["run", "read", runId, "--transcript", "--json"]),
    0,
  );
  const entries = [
    {
      session: "s",
      role: "user",
      content: "Review these changes",
      step: "agent",
      kind: "message",
      turn: "large-turn",
    },
    {
      session: "s",
      role: "assistant",
      content,
      step: "agent",
      kind: "message",
      turn: "large-turn",
    },
  ];
  assert.deepEqual(JSON.parse(h.stdout()), {
    page: { found: true, type: "transcript-page", entries },
    export: { found: true, type: "transcript-export", entries },
  });
  assert.doesNotMatch(h.stdout(), /more files|large-call|patch-299/);
  h.reset();
  assert.equal(await h.run(["run", "read", runId, "--transcript"]), 0);
  assert.equal(h.stdout().split(content).length - 1, 2);
});

test("m10-audit-conversation-order: headless JSON orders first appearances and keeps the frozen page/export mapper", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  const runId = await launchTrusted({
    h,
    bundle: { id, digest },
    expectedExit: 0,
  });
  assert.ok(h.runGroup);
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  const at = new Date("2026-10-06T00:00:00.000Z");
  assert.ok(
    owner.admitTurn({
      turnId: "ordered",
      attemptId: "0.0:agent",
      session: "s",
      origin: "human",
      kind: "agent",
      input: "Input",
      recoveryCoordinate: "native",
      harness: "codex",
      at,
    }).ok,
  );
  for (const [messageId, content, historyOrder, incomplete] of [
    ["later", "Settled first", 2, false],
    ["earlier", "Interrupted partial", 0, true],
  ] as const) {
    assert.ok(
      owner.appendTurnEvent({
        turnId: "ordered",
        kind: "assistant-content",
        payload: JSON.stringify({
          messageId,
          content,
          historyOrder,
          ...(incomplete ? { incomplete } : {}),
        }),
        at,
      }).ok,
    );
  }
  assert.ok(
    owner.appendTurnEvent({
      turnId: "ordered",
      kind: "steer",
      payload: JSON.stringify({
        steerId: "direction",
        text: "Sent early",
        historyOrder: 1,
        sentAt: at.toISOString(),
        settlement: { kind: "delivered", delivery: "after-boundary" },
      }),
      at,
    }).ok,
  );
  owner.close();
  h.reset();
  assert.equal(
    await h.run(["run", "read", runId, "--transcript", "--json"]),
    0,
    h.output(),
  );
  const entries = [
    {
      session: "s",
      role: "user",
      content: "Input",
      step: "agent",
      kind: "message",
      turn: "ordered",
    },
    {
      session: "s",
      role: "assistant",
      content: "Interrupted partial",
      step: "agent",
      kind: "message",
      turn: "ordered",
      incomplete: true,
    },
    {
      session: "s",
      role: "user",
      content: "Sent early",
      step: "agent",
      kind: "steer",
      turn: "ordered",
      steer: { id: "direction", delivery: "after-boundary" },
    },
    {
      session: "s",
      role: "assistant",
      content: "Settled first",
      step: "agent",
      kind: "message",
      turn: "ordered",
    },
  ];
  assert.deepEqual(JSON.parse(h.stdout()), {
    page: { found: true, type: "transcript-page", entries },
    export: { found: true, type: "transcript-export", entries },
  });
});
