import { storedProcess } from "../helpers/wiringDoubles.js";
import { ownPreparations } from "../harness/preparation-double.js";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Problem } from "../../src/application/projection-port.js";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { HarnessDefaults } from "../../src/harness/harness.js";
import type { RunOwner } from "../../src/run/store/store.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import {
  fakeHarnessProfile,
  createFake,
  type FakeScript,
  type FakeTurnRequestRecord,
} from "../harness/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// One shared fake Git repository backs every wiring in this file, so a legacy
// fixture's Store commits made under the setup wiring still read back after the
// home is copied and reopened under a fresh wiring — mirroring how
// `openFakeRunGroup` shares a single fake Git process across Run Stores. Objects
// are content-hashed in memory; refs land on disk under each home's Git dir and
// travel with the `cpSync` relocation.
const sharedGit = createFakeGitProcess();

// A deterministic Process double for `wireApplication`, so no real child spawns:
// git Store operations delegate to the shared fake Git; command Steps map their
// `-e process.exit(N)` script to the exit status; executables always resolve
// (these fixtures declare no git-worktree-root prerequisite, so `rev-parse` is
// never probed).
function fakeProcess(): ProcessAdapter {
  return storedProcess({
    git: sharedGit,
    script: {
      commandHandler: (options) => {
        const script = options.args[1] ?? "";
        const status = Number(
          /process\.exit\((\d+)\)/.exec(script)?.[1] ?? "0",
        );
        return { kind: "exited", status, text: new Uint8Array() };
      },
    },
  });
}

type LegacyKind = "agent" | "command";

interface LegacyFixture {
  readonly home: string;
  readonly workspace: string;
  readonly runId: string;
}

/** What the fake reports as its own Model choice, which a legacy Run resolves
 *  through preselection once on resume (ADR 0034). */
const REPORTED: HarnessDefaults = {
  kind: "reported",
  choice: { model: "legacy-opus", effort: "high" },
};

function completedScript(
  defaults: HarnessDefaults = REPORTED,
  turnRequests?: FakeTurnRequestRecord[],
): FakeScript {
  return {
    profile: fakeHarnessProfile({
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
    }),
    defaults,
    ...(turnRequests !== undefined ? { turnRequests } : {}),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

function writeBundle(kind: LegacyKind): {
  readonly folder: string;
  readonly id: string;
} {
  const folder = makeTempDir(`secant-legacy-${kind}-bundle-`);
  const id = `dev.secant.legacy-${kind}`;
  const assets =
    kind === "agent" ? [{ path: "prompts/go.md", kind: "prompt" }] : [];
  if (kind === "agent") {
    mkdirSync(join(folder, "prompts"), { recursive: true });
    writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  }
  const routing =
    kind === "agent"
      ? [
          {
            id: "work",
            kind: "agent",
            retry: 0,
            session: "s",
            prompt: { asset: "prompts/go.md" },
          },
        ]
      : [
          {
            id: "work",
            kind: "command",
            command: {
              executable: RUNTIME_NAME,
              arguments: ["-e", "process.exit(0)"],
            },
          },
        ];
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        bundle: {
          id,
          version: "1.0.0",
          name: `Legacy ${kind}`,
          description: `A relocatable legacy ${kind} Run fixture.`,
        },
        platforms: ["windows", "macos", "linux"],
        inputs: {},
        assets,
        routing,
      },
      null,
      2,
    ),
  );
  return { folder, id };
}

function setLegacyRest(owner: RunOwner, afterAttempt: boolean): void {
  if (afterAttempt) {
    assert.deepEqual(
      owner.publishAttempt({
        attemptId: "0.0:work",
        outcome: "failed",
        required: [],
        outputs: [],
        at: new Date("2026-09-01T00:00:01.000Z"),
        advanceState: "failed",
      }),
      { ok: true },
    );
  } else {
    assert.deepEqual(owner.writeState("halted"), { ok: true });
  }
  assert.deepEqual(owner.release(), { ok: true });
}

function createLegacyFixture(
  kind: LegacyKind,
  afterAttempt: boolean,
  /** A Run created after M4 selected its Harness but before #342 held a Model
   *  choice; otherwise a pre-M4 Run with neither. */
  selectedHarness?: "claude-code",
): LegacyFixture {
  const fixtureHome = makeTempDir(`secant-legacy-${kind}-fixture-`);
  const workspace = makeTempDir(`secant-legacy-${kind}-workspace-`);
  const bundle = writeBundle(kind);
  const setup = wireApplication({
    secantHome: fixtureHome,
    launchCwd: workspace,
    process: fakeProcess(),
  });
  const built = setup.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok);
  const entry = setup.catalog
    .listEntries()
    .find((candidate) => candidate.id === bundle.id);
  assert.ok(entry);
  setup.catalog.approveWorkspace(
    workspace,
    new Date("2026-09-01T00:00:00.000Z"),
  );
  setup.catalog.grantTrust({
    operationId: `trust-${kind}-${afterAttempt}`,
    digest: entry.digest,
    installationGeneration: entry.installationGeneration,
    grantedAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  const created = setup.runGroup.createRun({
    operationId: `legacy-${kind}-${afterAttempt}`,
    bundleSnapshotDigest: entry.digest,
    launch: {},
    ...(selectedHarness !== undefined ? { selectedHarness } : {}),
    at: new Date("2026-09-01T00:00:00.000Z"),
  });
  const owner = setup.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  setLegacyRest(owner, afterAttempt);
  owner.close();
  setup.runGroup.close();
  setup.catalog.close();
  const relocatedHome = makeTempDir(`secant-legacy-${kind}-relocated-`);
  cpSync(fixtureHome, relocatedHome, { recursive: true });
  return { home: relocatedHome, workspace, runId: created.runId };
}

function openFixture(
  fixture: LegacyFixture,
  script = completedScript(),
): Wiring {
  return wireApplication({
    secantHome: fixture.home,
    launchCwd: fixture.workspace,
    process: fakeProcess(),
    harnessAdapter: createFake(script)(),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "configured",
        name: "fixture-claude",
        description: "injected fixture discovery",
      },
    }),
  });
}

function openRun(wiring: Wiring, runId: string): Problem | undefined {
  const opened = wiring.projectionPort.openProjection({ family: "run", runId });
  try {
    return opened.snapshot.result.found
      ? undefined
      : opened.snapshot.result.problem;
  } finally {
    opened.close();
  }
}

for (const afterAttempt of [false, true]) {
  test(`[legacy-run-harness-upgrade] an Agent Run ${afterAttempt ? "after" : "before"} its first Attempt upgrades its Harness and Model choice once, then resumes to completion`, async (t) => {
    const fixture = createLegacyFixture("agent", afterAttempt);
    const requests: FakeTurnRequestRecord[] = [];
    const first = openFixture(fixture, completedScript(REPORTED, requests));
    if (!afterAttempt) {
      assert.equal(openRun(first, fixture.runId), undefined);
      const upgradedOnReopen = first.runGroup.readRun(fixture.runId);
      assert.ok(upgradedOnReopen.ok);
      assert.equal(upgradedOnReopen.run.selectedHarness, "claude-code");
      // Reopen is synchronous and qualifies nothing, so the choice waits for
      // the resume.
      assert.equal(upgradedOnReopen.run.modelChoice, undefined);
    }
    const resume = first.projectionPort.submit({
      operationId: `resume-${afterAttempt}`,
      operation: "resume-run",
      input: { runId: fixture.runId },
    });
    assert.ok(resume.admitted, JSON.stringify(resume));
    const upgradedBeforeExecution = first.runGroup.readRun(fixture.runId);
    assert.ok(upgradedBeforeExecution.ok);
    assert.equal(upgradedBeforeExecution.run.selectedHarness, "claude-code");
    // The drive reads the upgraded record, not the one read at acquire: the
    // resume applies, and the Turn requests the resolved choice.
    const outcome = await awaitSettled(
      first.projectionPort,
      resume.operationId,
    );
    assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    assert.deepEqual(requests, [
      { session: "s", modelChoice: { model: "legacy-opus", effort: "high" } },
    ]);
    const resolved = first.runGroup.readRun(fixture.runId);
    assert.ok(resolved.ok);
    assert.equal(resolved.run.state, "succeeded");
    assert.deepEqual(resolved.run.modelChoice, {
      model: "legacy-opus",
      effort: "high",
    });
    first.runGroup.close();
    first.catalog.close();

    // Once: a later process whose Harness reports another default changes
    // neither fact.
    const reopened = openFixture(
      fixture,
      completedScript({ kind: "reported", choice: { model: "later" } }),
    );
    t.after(() => {
      reopened.runGroup.close();
      reopened.catalog.close();
    });
    assert.equal(openRun(reopened, fixture.runId), undefined);
    const stillSelected = reopened.runGroup.readRun(fixture.runId);
    assert.ok(stillSelected.ok);
    assert.equal(stillSelected.run.selectedHarness, "claude-code");
    assert.deepEqual(stillSelected.run.modelChoice, resolved.run.modelChoice);
  });
}

test("[legacy-run-harness-upgrade] a Run that selected its Harness before Model choices upgrades only its choice on resume", async (t) => {
  const fixture = createLegacyFixture("agent", true, "claude-code");
  const requests: FakeTurnRequestRecord[] = [];
  const wiring = openFixture(
    fixture,
    completedScript(
      {
        kind: "fallback",
        choice: { model: "opus", effort: "medium" },
        reason: "Settings were not read.",
      },
      requests,
    ),
  );
  t.after(() => {
    wiring.runGroup.close();
    wiring.catalog.close();
  });
  const resume = wiring.projectionPort.submit({
    operationId: "resume-selected",
    operation: "resume-run",
    input: { runId: fixture.runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const outcome = await awaitSettled(wiring.projectionPort, resume.operationId);
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  // The fallback is a real choice like any other preselection.
  assert.deepEqual(requests, [
    { session: "s", modelChoice: { model: "opus", effort: "medium" } },
  ]);
  const run = wiring.runGroup.readRun(fixture.runId);
  assert.ok(run.ok);
  assert.equal(run.run.selectedHarness, "claude-code");
  assert.deepEqual(run.run.modelChoice, { model: "opus", effort: "medium" });
});

test("[legacy-run-harness-upgrade] a legacy Run whose Harness reports nothing to preselect halts with a run model correction", async (t) => {
  const fixture = createLegacyFixture("agent", true, "claude-code");
  const requests: FakeTurnRequestRecord[] = [];
  const wiring = openFixture(
    fixture,
    completedScript(
      { kind: "unavailable", reason: "Nothing is listed." },
      requests,
    ),
  );
  t.after(() => {
    wiring.runGroup.close();
    wiring.catalog.close();
  });
  const resume = wiring.projectionPort.submit({
    operationId: "resume-unavailable",
    operation: "resume-run",
    input: { runId: fixture.runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const outcome = await awaitSettled(wiring.projectionPort, resume.operationId);
  assert.equal(outcome.status, "not-applied", JSON.stringify(outcome));
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.correction, "model");
    assert.match(outcome.problem.remediation, /secant run model/);
  }
  assert.deepEqual(requests, []);
  const run = wiring.runGroup.readRun(fixture.runId);
  assert.ok(run.ok);
  assert.equal(run.run.state, "halted");
  assert.equal(run.run.modelChoice, undefined);
  const changed = wiring.projectionPort.submit({
    operationId: "correct-model",
    operation: "change-model-choice",
    input: { runId: fixture.runId, model: "chosen-model" },
  });
  assert.ok(changed.admitted);
  assert.equal(
    (await awaitSettled(wiring.projectionPort, changed.operationId)).status,
    "applied",
  );
  const retry = wiring.projectionPort.submit({
    operationId: "resume-corrected",
    operation: "resume-run",
    input: { runId: fixture.runId },
  });
  assert.ok(retry.admitted);
  assert.equal(
    (await awaitSettled(wiring.projectionPort, retry.operationId)).status,
    "applied",
  );
  assert.deepEqual(requests, [
    { session: "s", modelChoice: { model: "chosen-model" } },
  ]);
});

test("[legacy-run-harness-upgrade] a Command-only Run remains unselected and prepares no Harness", async (t) => {
  const fixture = createLegacyFixture("command", false);
  let prepareCount = 0;
  const adapter = createFake(completedScript())();
  const wiring = wireApplication({
    secantHome: fixture.home,
    launchCwd: fixture.workspace,
    process: fakeProcess(),
    harnessAdapter: ownPreparations({
      prepare(options) {
        prepareCount++;
        return adapter.prepare(options);
      },
    }),
  });
  t.after(() => {
    wiring.runGroup.close();
    wiring.catalog.close();
  });
  assert.equal(openRun(wiring, fixture.runId), undefined);
  const unchanged = wiring.runGroup.readRun(fixture.runId);
  assert.ok(unchanged.ok);
  assert.equal(unchanged.run.selectedHarness, undefined);
  const resume = wiring.projectionPort.submit({
    operationId: "resume-command",
    operation: "resume-run",
    input: { runId: fixture.runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(wiring.projectionPort, resume.operationId);
  assert.equal(prepareCount, 0);
});

test("[legacy-run-harness-upgrade] an unavailable pinned Snapshot returns the existing Problem without guessing", (t) => {
  const home = makeTempDir("secant-legacy-missing-home-");
  const workspace = makeTempDir("secant-legacy-missing-workspace-");
  const setup = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
  });
  const created = setup.runGroup.createRun({
    operationId: "legacy-missing",
    bundleSnapshotDigest: "sha256:missing",
    launch: {},
    at: new Date("2026-09-01T00:00:00.000Z"),
  });
  const owner = setup.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("halted"), { ok: true });
  assert.deepEqual(owner.release(), { ok: true });
  owner.close();
  setup.runGroup.close();
  setup.catalog.close();

  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  assert.equal(openRun(reopened, created.runId)?.code, "bundle-bytes-missing");
  const unchanged = reopened.runGroup.readRun(created.runId);
  assert.ok(unchanged.ok);
  assert.equal(unchanged.run.selectedHarness, undefined);
});

test("a legacy resume uses the last choice once without rewriting that Preference", async (t) => {
  const fixture = createLegacyFixture("agent", true, "claude-code");
  const requests: FakeTurnRequestRecord[] = [];
  const wiring = openFixture(fixture, completedScript(REPORTED, requests));
  t.after(() => {
    wiring.runGroup.close();
    wiring.catalog.close();
  });
  const encoded = JSON.stringify({ model: "remembered-opus", effort: "low" });
  wiring.catalog.setPreference("last-model-choice:claude-code", encoded);
  const resume = wiring.projectionPort.submit({
    operationId: "resume-last",
    operation: "resume-run",
    input: { runId: fixture.runId },
  });
  assert.ok(resume.admitted);
  assert.equal(
    (await awaitSettled(wiring.projectionPort, resume.operationId)).status,
    "applied",
  );
  assert.deepEqual(requests, [
    { session: "s", modelChoice: { model: "remembered-opus", effort: "low" } },
  ]);
  assert.equal(
    wiring.catalog.getPreference("last-model-choice:claude-code"),
    encoded,
  );
});

test("[legacy-run-harness-upgrade] run model upgrades a pre-M4 Harness and chooses a model on its first submission", async (t) => {
  const fixture = createLegacyFixture("agent", false);
  const wiring = openFixture(
    fixture,
    completedScript({ kind: "unavailable", reason: "No default." }),
  );
  t.after(() => {
    wiring.runGroup.close();
    wiring.catalog.close();
  });
  const submitted = wiring.projectionPort.submit({
    operationId: "pre-m4-choice",
    operation: "change-model-choice",
    input: { runId: fixture.runId, model: "chosen-model" },
  });
  assert.ok(submitted.admitted);
  const outcome = await awaitSettled(
    wiring.projectionPort,
    submitted.operationId,
  );
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  const run = wiring.runGroup.readRun(fixture.runId);
  assert.ok(run.ok);
  assert.equal(run.run.selectedHarness, "claude-code");
  assert.deepEqual(run.run.modelChoice, { model: "chosen-model" });
  assert.equal(run.run.state, "halted");
});
