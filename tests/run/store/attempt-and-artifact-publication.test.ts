import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import { startPermissionBridge } from "../../../src/harness/harness.js";
import type { ProducedArtifact } from "../../../src/workflow/workflow.js";
import {
  type OutputReceiptDirectoryResult,
  type PublishAttemptResult,
  type RunGroup,
  type RunOwner,
} from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

const WORKSPACE = "/work/example-project";
const AT = new Date("2026-09-12T12:00:00.000Z");
const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined) =>
  bytes && new TextDecoder().decode(bytes);
const candidate = (name: string, text: string) =>
  ({ name, type: "text", content: enc(text) }) as const;
const need = (...names: string[]): ProducedArtifact[] =>
  names.map((name) => ({ name, type: "text" }));

/** The private publication-ref directory of a Run's artifacts.git. */
function publicationRefs(home: string, runId: string): string {
  return join(
    groupDirOf(home),
    runId,
    "artifacts.git",
    "refs",
    "secant",
    "publications",
  );
}

function create(
  group: RunGroup,
  operationId: string,
  overrides: {
    digest?: string;
    launch?: unknown;
    selectedHarness?: "claude-code" | "codex";
  } = {},
) {
  return group.createRun({
    operationId,
    bundleSnapshotDigest: overrides.digest ?? "sha256:deadbeef",
    launch: overrides.launch ?? { goal: "ship it" },
    ...(overrides.selectedHarness !== undefined
      ? { selectedHarness: overrides.selectedHarness }
      : {}),
    at: AT,
  });
}

/** The group directory Secant home resolves for the test Workspace. */
function groupDirOf(home: string): string {
  const runs = join(home, "runs");
  return join(runs, readdirSync(runs)[0]!);
}

test("a succeeded Attempt publishes its whole output set as one version", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const first = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("verdict", "text"),
    outputs: [candidate("verdict", "pass"), candidate("text", "hello")],
    at: AT,
  });
  assert.ok(first.ok && first.versionId);
  assert.equal(owner.currentVersion("verdict"), first.versionId);
  assert.equal(owner.currentVersion("text"), first.versionId);
  // Exactly one commit backs the publication.
  assert.equal(readdirSync(publicationRefs(home, created.runId)).length, 1);

  // A second publication moves only `text`'s binding; the earlier version stays
  // readable by its own id, and `verdict` still points at the first commit.
  const second = owner.publishAttempt({
    attemptId: "a2",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "world")],
    at: AT,
  });
  assert.ok(second.ok && second.versionId);
  assert.notEqual(second.versionId, first.versionId);
  assert.equal(owner.currentVersion("text"), second.versionId);
  assert.equal(owner.currentVersion("verdict"), first.versionId);
  assert.equal(dec(owner.readArtifact(first.versionId, "text")), "hello");
  assert.equal(dec(owner.readArtifact(second.versionId, "text")), "world");
});

test("a failure between the commit and the transaction moves no binding and leaves the Attempt unsettled", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const first = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "keep")],
    at: AT,
  });
  assert.ok(first.ok && first.versionId);

  // Inject a fault the publication transaction hits after the commit is staged:
  // aborting the binding move must roll the whole transaction back.
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec(
    "CREATE TRIGGER boom BEFORE UPDATE ON artifact_binding " +
      "BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  raw.close();

  assert.throws(() =>
    owner.publishAttempt({
      attemptId: "a2",
      outcome: "succeeded",
      required: need("text"),
      outputs: [candidate("text", "changed")],
      at: AT,
    }),
  );
  // No partial state: the binding never moved and the Attempt never settled.
  assert.equal(owner.currentVersion("text"), first.versionId);
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.attemptId),
    ["a1"],
  );

  // Recovery: drop the fault and repeat the publication — it now succeeds.
  const raw2 = new Database(runDbPath);
  raw2.exec("DROP TRIGGER boom");
  raw2.close();
  const retry = owner.publishAttempt({
    attemptId: "a2",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "changed")],
    at: AT,
  });
  assert.ok(retry.ok && retry.versionId);
  assert.equal(owner.currentVersion("text"), retry.versionId);
  assert.equal(dec(owner.readArtifact(retry.versionId, "text")), "changed");
});

test("failed, cancelled, and indeterminate Attempts keep the current bindings and log the outcome", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const pub = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "stable")],
    at: AT,
  });
  assert.ok(pub.ok && pub.versionId);

  for (const outcome of ["failed", "cancelled", "indeterminate"] as const) {
    const result: PublishAttemptResult = owner.publishAttempt({
      attemptId: `x-${outcome}`,
      outcome,
      required: [],
      outputs: [],
      at: AT,
    });
    assert.deepEqual(result, { ok: true });
  }
  // The previous binding is still current.
  assert.equal(owner.currentVersion("text"), pub.versionId);
  // Every outcome landed in the append-only log, in order.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "failed", "cancelled", "indeterminate"],
  );
});

test("a missing required output is refused with a Problem and nothing is published", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const result = owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("verdict", "text"),
    outputs: [candidate("text", "only text")],
    at: AT,
  });
  assert.ok(!result.ok && "problem" in result);
  assert.deepEqual(result.problem, { kind: "missing-output", name: "verdict" });
  // Nothing committed and nothing settled.
  assert.equal(owner.currentVersion("text"), undefined);
  assert.deepEqual(owner.attemptLog(), []);
});

test("publishing the same Attempt id twice yields one version", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const request = {
    attemptId: "a1",
    outcome: "succeeded" as const,
    required: need("text"),
    outputs: [candidate("text", "once")],
    at: AT,
  };
  const one = owner.publishAttempt(request);
  const two = owner.publishAttempt(request);
  assert.ok(one.ok && two.ok);
  assert.equal(two.versionId, one.versionId);
  assert.equal(readdirSync(publicationRefs(home, created.runId)).length, 1);
});

test("a fenced owner cannot publish", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");

  const stale = group.acquireRun(created.runId);
  assert.ok(stale);
  t.after(() => stale.close());
  const fresh = group.acquireRun(created.runId);
  assert.ok(fresh);
  t.after(() => fresh.close());

  const request = {
    attemptId: "a1",
    outcome: "succeeded" as const,
    required: need("text"),
    outputs: [candidate("text", "x")],
    at: AT,
  };
  assert.deepEqual(stale.publishAttempt(request), {
    ok: false,
    reason: "fenced",
  });
  const ok = fresh.publishAttempt(request);
  assert.ok(ok.ok && ok.versionId);
});

test("a gate answer binds a durable, readable Artifact without logging an Attempt (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const result = owner.recordGateAnswer({
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue",
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
  });
  assert.ok(result.ok && !result.replayed);

  // Bound and readable like any output, but the attempt log is untouched.
  const version = owner.currentVersion("human-gate-answer");
  assert.ok(version);
  assert.equal(
    dec(owner.readArtifact(version!, "human-gate-answer")),
    "continue",
  );
  assert.equal(owner.attemptLog().length, 0);
  const answers = owner.gateAnswers();
  assert.equal(answers.length, 1);
  assert.deepEqual(
    {
      operationId: answers[0]!.operationId,
      gateAttemptId: answers[0]!.gateAttemptId,
      answer: answers[0]!.answer,
      iterationsAtGrant: answers[0]!.iterationsAtGrant,
    },
    {
      operationId: "answer-1",
      gateAttemptId: "attempt-xyz",
      answer: "continue",
      iterationsAtGrant: 3,
    },
  );
});

test("recording a gate answer is idempotent per operation id (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const request = {
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue" as const,
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
  };
  const first = owner.recordGateAnswer(request);
  const replay = owner.recordGateAnswer(request);
  assert.ok(first.ok && replay.ok);
  assert.equal(replay.replayed, true);
  assert.equal(first.versionId, replay.versionId);
  assert.equal(owner.gateAnswers().length, 1);
});

test("a stop answer rests the Run failed in the same transaction (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId)!;
  t.after(() => owner.close());

  const result = owner.recordGateAnswer({
    operationId: "answer-1",
    gateAttemptId: "attempt-xyz",
    answer: "stop",
    iterationsAtGrant: 3,
    artifactName: "human-gate-answer",
    at: AT,
    advanceState: "failed",
  });
  assert.ok(result.ok);
  const read = group.readRun(created.runId);
  assert.ok(read.ok && read.run.state === "failed");
});

test("a fenced owner cannot record a gate answer (#85)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const stale = group.acquireRun(created.runId)!;
  const fresh = group.acquireRun(created.runId)!; // bumps the epoch, fencing `stale`
  t.after(() => fresh.close());

  assert.deepEqual(
    stale.recordGateAnswer({
      operationId: "answer-1",
      gateAttemptId: "attempt-xyz",
      answer: "continue",
      iterationsAtGrant: 0,
      artifactName: "human-gate-answer",
      at: AT,
    }),
    { ok: false, reason: "fenced" },
  );
  assert.equal(fresh.gateAnswers().length, 0);
});

// --- Read-ingress validation of the two enum columns (A11) ------------------

test("a garbage attempt_log.outcome is rejected at the read, never trusted", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  owner.publishAttempt({
    attemptId: "a1",
    outcome: "succeeded",
    required: need("text"),
    outputs: [candidate("text", "ok")],
    at: AT,
  });
  // A drifted or corrupt store: an outcome outside the closed set. The read must
  // refuse it rather than cast it to a trusted AttemptOutcome (it would otherwise
  // reach the resume skip cursor and deriveRun).
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec("UPDATE attempt_log SET outcome = 'not-an-outcome'");
  raw.close();

  assert.throws(() => owner.attemptLog());
});

test("a garbage gate_answer.answer is rejected at the read, never trusted", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  const recorded = owner.recordGateAnswer({
    operationId: "grant-1",
    gateAttemptId: "attempt-xyz",
    answer: "continue",
    iterationsAtGrant: 0,
    artifactName: "human-gate-answer",
    at: AT,
  });
  assert.ok(recorded.ok);
  const runDbPath = join(groupDirOf(home), created.runId, "run.db");
  const raw = new Database(runDbPath);
  raw.exec("UPDATE gate_answer SET answer = 'maybe'");
  raw.close();

  assert.throws(() => owner.gateAnswers());
});

// --- Diagnostics 90-day retention pruned at group open (A9, ADR 0023) --------

test("the latest Agent-step Attempt's Harness identity is durable across reopening (#125)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");

  {
    const owner = group.acquireRun(created.runId);
    assert.ok(owner !== undefined);
    // A Command/Gate Attempt records no Harness identity, so it never becomes the
    // latest Agent-step Attempt.
    owner.publishAttempt({
      attemptId: "0.0:setup",
      outcome: "succeeded",
      required: [],
      outputs: [],
      at: AT,
    });
    // An earlier Agent Attempt under one profile.
    owner.publishAttempt({
      attemptId: "0.1:repair",
      outcome: "failed",
      required: [],
      outputs: [],
      at: new Date("2026-09-12T12:00:01.000Z"),
      agentEvidence: {
        kind: "agent",
        identity: {
          harness: "Claude Code",
          executable: "/old/claude",
          executableVersion: "0.9.0",
          steer: { available: false, evidence: "old profile evidence" },
        },
      },
    });
    // The latest Agent Attempt under the profile the identity must report — with an
    // effective model observed for the same Attempt.
    owner.publishAttempt({
      attemptId: "0.2:repair",
      outcome: "succeeded",
      required: [],
      outputs: [],
      at: new Date("2026-09-12T12:00:02.000Z"),
      agentEvidence: {
        kind: "agent",
        effectiveModel: "claude-opus-5",
        identity: {
          harness: "Claude Code",
          executable: "/usr/bin/claude",
          executableVersion: "1.2.3",
          steer: { available: false, evidence: "print mode has no steer" },
        },
      },
    });
    assert.deepEqual(owner.harnessEvidence(), {
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
        steer: { available: false, evidence: "print mode has no steer" },
      },
      effectiveModel: "claude-opus-5",
    });
    owner.release();
    owner.close();
  }

  // Reopen the whole home: the durable identity reads back identically, and the
  // effective model stays the model authoritatively observed for that Attempt.
  group.close();
  const reopened = openRunGroup(home, WORKSPACE);
  t.after(() => reopened.close());
  const owner2 = reopened.acquireRun(created.runId);
  assert.ok(owner2 !== undefined);
  t.after(() => owner2.close());
  assert.deepEqual(owner2.harnessEvidence(), {
    identity: {
      harness: "Claude Code",
      executable: "/usr/bin/claude",
      executableVersion: "1.2.3",
      steer: { available: false, evidence: "print mode has no steer" },
    },
    effectiveModel: "claude-opus-5",
  });
});

test("a Command-only Run has no Harness identity (#125)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner !== undefined);
  t.after(() => owner.close());
  owner.publishAttempt({
    attemptId: "0.0:build",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
  });
  assert.equal(owner.harnessEvidence(), undefined);
});

test("a legacy model-only Attempt remains readable as co-sourced Harness evidence", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-legacy-model");
  const owner = group.acquireRun(created.runId)!;
  owner.publishAttempt({
    attemptId: "0.0:legacy-agent",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
  });
  owner.close();

  const raw = new Database(join(groupDirOf(home), created.runId, "run.db"));
  raw
    .query("UPDATE attempt SET effective_model = ? WHERE attempt_id = ?")
    .run("legacy-model", "0.0:legacy-agent");
  raw.close();

  const reopened = group.acquireRun(created.runId)!;
  t.after(() => reopened.close());
  assert.deepEqual(reopened.harnessEvidence(), {
    effectiveModel: "legacy-model",
  });
});

test("a partial persisted steer capability is rejected at the Harness-identity read", (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-steer-corrupt");
  const owner = group.acquireRun(created.runId)!;
  owner.publishAttempt({
    attemptId: "0.0:repair",
    outcome: "succeeded",
    required: [],
    outputs: [],
    at: AT,
    agentEvidence: {
      kind: "agent",
      identity: {
        harness: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
        steer: { available: false, evidence: "profile evidence" },
      },
    },
  });
  owner.release();
  owner.close();

  const raw = new Database(join(groupDirOf(home), created.runId, "run.db"));
  raw
    .query("UPDATE attempt SET steer_evidence = NULL WHERE attempt_id = ?")
    .run("0.0:repair");
  raw.close();

  const corrupted = group.acquireRun(created.runId)!;
  t.after(() => corrupted.close());
  assert.throws(() => corrupted.harnessEvidence());
});

/** The prepared receipt directory, asserting preparation succeeded. */
function receiptDirOf(owner: RunOwner, attemptId: string): string {
  const prepared = owner.outputReceiptDirectory(attemptId);
  assert.ok(prepared.ok, JSON.stringify(prepared));
  return prepared.path;
}

/** The typed Problem of a refused receipt preparation. */
function receiptProblemOf(
  owner: RunOwner,
  attemptId: string,
): Extract<OutputReceiptDirectoryResult, { ok: false }>["problem"] {
  const prepared = owner.outputReceiptDirectory(attemptId);
  assert.equal(prepared.ok, false, JSON.stringify(prepared));
  if (prepared.ok) throw new Error("unreachable");
  return prepared.problem;
}

function acquiredOwner(t: TestContext): RunOwner {
  const group = openRunGroup(makeTempDir("secant-store-"), WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  return owner;
}

test("m12-audit-working-area-boundary: a file squatting a usable working area's receipt root is a typed Problem, not a throw (#305)", (t) => {
  const owner = acquiredOwner(t);
  const area = owner.workingArea();
  assert.ok(area.ok);
  const root = join(area.path, ".receipts");
  writeFileSync(root, "squatter");

  const problem = receiptProblemOf(owner, "0.0:publish");

  assert.equal(problem.kind, "output-receipt-directory-unavailable");
  assert.equal(problem.path, root);
  assert.ok(problem.cause instanceof Error, String(problem.cause));
  // The working area itself stays usable, and the squatter is never replaced.
  assert.ok(owner.workingArea().ok);
  assert.equal(readFileSync(root, "utf8"), "squatter");
  // Clearing the conflict lets the same Attempt prepare an empty directory.
  rmSync(root);
  assert.deepEqual(readdirSync(receiptDirOf(owner, "0.0:publish")), []);
});

test("m12-audit-working-area-boundary: a receipt root redirected outside the working area is refused without emptying its target (#305)", (t) => {
  const owner = acquiredOwner(t);
  const dir = receiptDirOf(owner, "0.0:publish");
  const root = dirname(dir);
  // A link the agent could plant where the Store expects its own directory; a
  // junction needs no privilege on Windows and is an ordinary link elsewhere.
  const elsewhere = makeTempDir("secant-store-elsewhere-");
  mkdirSync(join(elsewhere, basename(dir)));
  writeFileSync(
    join(elsewhere, basename(dir), "keep"),
    "not candidate storage",
  );
  rmSync(root, { recursive: true });
  symlinkSync(elsewhere, root, "junction");

  const problem = receiptProblemOf(owner, "0.0:publish");

  assert.equal(problem.kind, "output-receipt-directory-unavailable");
  assert.equal(problem.path, root);
  assert.equal(
    readFileSync(join(elsewhere, basename(dir), "keep"), "utf8"),
    "not candidate storage",
  );
});

test("m12-audit-working-area-boundary: a link planted at an Attempt's own receipt path is replaced, never emptied through (#305)", (t) => {
  const owner = acquiredOwner(t);
  const dir = receiptDirOf(owner, "0.0:publish");
  const elsewhere = makeTempDir("secant-store-elsewhere-");
  writeFileSync(join(elsewhere, "keep"), "not candidate storage");
  rmSync(dir, { recursive: true });
  symlinkSync(elsewhere, dir, "junction");

  assert.equal(receiptDirOf(owner, "0.0:publish"), dir);

  assert.deepEqual(readdirSync(dir), []);
  assert.equal(
    readFileSync(join(elsewhere, "keep"), "utf8"),
    "not candidate storage",
  );
});

test("m12-audit-working-area-boundary: keeping an Attempt's receipt directory returns it without emptying it (#354)", (t) => {
  const owner = acquiredOwner(t);
  const dir = receiptDirOf(owner, "0.0:publish");
  writeFileSync(join(dir, "summary"), "written in the first Turn");

  const kept = owner.outputReceiptDirectory("0.0:publish", { keep: true });

  assert.deepEqual(kept, { ok: true, path: dir });
  assert.equal(
    readFileSync(join(dir, "summary"), "utf8"),
    "written in the first Turn",
  );
  // The agent removed its directory: keeping creates it again, empty.
  rmSync(dir, { recursive: true });
  assert.deepEqual(
    owner.outputReceiptDirectory("0.0:publish", { keep: true }),
    { ok: true, path: dir },
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("m12-audit-working-area-boundary: keeping refuses a link or a file at the Attempt's own receipt path (#354)", (t) => {
  const owner = acquiredOwner(t);
  const dir = receiptDirOf(owner, "0.0:publish");
  const elsewhere = makeTempDir("secant-store-elsewhere-");
  writeFileSync(join(elsewhere, "summary"), "outside the working area");
  rmSync(dir, { recursive: true });
  symlinkSync(elsewhere, dir, "junction");

  const linked = owner.outputReceiptDirectory("0.0:publish", { keep: true });

  assert.equal(linked.ok, false, JSON.stringify(linked));
  if (linked.ok) throw new Error("unreachable");
  assert.equal(linked.problem.kind, "output-receipt-directory-unavailable");
  assert.equal(linked.problem.path, dir);
  // Nothing is followed or removed: the target keeps its file.
  assert.equal(
    readFileSync(join(elsewhere, "summary"), "utf8"),
    "outside the working area",
  );

  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "squatter");
  const squatted = owner.outputReceiptDirectory("0.0:publish", { keep: true });
  assert.equal(squatted.ok, false, JSON.stringify(squatted));
  assert.equal(readFileSync(dir, "utf8"), "squatter");
});

// Named gap: a removal or creation that fails after the root check (EPERM/EBUSY on
// the per-Attempt directory) shares the conflict's catch-and-type path, but no
// deterministic, portable fault can be injected there without a production
// test-only Seam, so it is not exercised here.

test("m12-audit-working-area-boundary: an unusable working area fails receipt preparation typed with its cause (#305)", (t) => {
  const owner = acquiredOwner(t);
  const area = owner.workingArea();
  assert.ok(area.ok);
  rmSync(area.path, { recursive: true });
  writeFileSync(area.path, "squatter");

  const problem = receiptProblemOf(owner, "0.0:publish");

  assert.equal(problem.kind, "working-area-unavailable");
  assert.equal(basename(problem.path), "working");
  assert.ok(problem.cause instanceof Error, String(problem.cause));
  assert.equal(readFileSync(area.path, "utf8"), "squatter");
});

test("m12-audit-working-area-boundary: an Attempt's output receipt directory is a fresh, Run-owned directory per Attempt (#215)", async (t) => {
  const home = makeTempDir("secant-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-1");
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());

  // Execution's Attempt ids carry a `:` that is not a legal Windows file name, so
  // the directory must still be created on every OS.
  const first = receiptDirOf(owner, "0.0:publish");
  assert.ok(isAbsolute(first));
  // Inside the working area, the one directory a Harness is granted (#220), so
  // the agent can write its receipt under a sandbox.
  const area = owner.workingArea();
  assert.ok(area.ok);
  const inside = relative(area.path, first);
  assert.ok(inside !== "" && !inside.startsWith(".."), first);
  assert.deepEqual(readdirSync(first), []);

  // Each Attempt receives its own directory, so a retry never reads the receipt a
  // previous Attempt left behind.
  const second = receiptDirOf(owner, "0.1:publish");
  assert.notEqual(second, first);

  // Preparing the same Attempt again empties it: a stale receipt cannot satisfy it.
  writeFileSync(join(first, "spec-ref"), "stale");
  assert.equal(receiptDirOf(owner, "0.0:publish"), first);
  assert.deepEqual(readdirSync(first), []);

  // The receipts share the Run's lifecycle: deleting the Run removes them.
  owner.close();
  assert.equal(
    group.deleteRun({ operationId: "op-del", runId: created.runId }).outcome,
    "deleted",
  );
  assert.ok(!existsSync(first));
});

test("m11-receipt-failure-evidence: publication stores immutable evidence atomically, persists it, and fences stale owners", async (t) => {
  const home = makeTempDir("secant-failure-store-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-evidence");
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  const request = {
    attemptId: "a1",
    outcome: "failed" as const,
    required: [],
    outputs: [],
    at: AT,
    failureEvidence: {
      source: "receipt",
      code: "receipt-missing",
      possibleEffects: "unknown" as const,
      details: { outputName: "spec-ref" },
    },
  };
  assert.ok(owner.publishAttempt(request).ok);
  const first = owner.failureEvidence();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.attemptId, "a1");
  assert.equal(first[0]?.details, '{"outputName":"spec-ref"}');
  assert.ok(
    owner.publishAttempt({
      ...request,
      failureEvidence: { ...request.failureEvidence, code: "other" },
    }).ok,
  );
  assert.deepEqual(owner.failureEvidence(), first);
  owner.close();
  const reopened = group.acquireRun(created.runId);
  assert.ok(reopened);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.failureEvidence(), first);
  assert.throws(
    () =>
      reopened.publishAttempt({
        ...request,
        attemptId: "too-big",
        failureEvidence: {
          ...request.failureEvidence,
          details: { outputName: "x".repeat(4096) },
        },
      }),
    /4096-byte limit/,
  );
  assert.deepEqual(
    reopened.attemptLog().map((e) => e.attemptId),
    ["a1"],
  );
  assert.deepEqual(reopened.failureEvidence(), first);
  const successor = group.acquireRun(created.runId);
  assert.ok(successor);
  t.after(() => successor.close());
  assert.equal(
    reopened.publishAttempt({ ...request, attemptId: "fenced" }).ok,
    false,
  );
  assert.deepEqual(successor.failureEvidence(), first);
});

test("m11-receipt-failure-evidence: the database rejects duplicate subjects but permits evidence before Attempt publication", (t) => {
  const home = makeTempDir("secant-evidence-index-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-index");
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;
  const db = new Database(join(groupDirOf(home), created.runId, "run.db"));
  try {
    const insert = db.prepare(
      "INSERT INTO failure_evidence (evidence_id, attempt_id, turn_id, source, code, possible_effects, at) VALUES (?, ?, ?, 'receipt', 'receipt-missing', 'unknown', ?)",
    );
    insert.run("e1", "unpublished", null, AT.toISOString());
    assert.throws(
      () => insert.run("e2", "unpublished", null, AT.toISOString()),
      /UNIQUE constraint/,
    );
    insert.run("e3", "unpublished", "t1", AT.toISOString());
    assert.throws(
      () => insert.run("e4", "another", "t1", AT.toISOString()),
      /UNIQUE constraint/,
    );
    insert.run("e5", "unpublished", "t2", AT.toISOString());
    assert.deepEqual(
      db.query("SELECT count(*) AS n FROM failure_evidence").get(),
      { n: 3 },
    );
  } finally {
    db.close();
  }
});

test("m11-pre-turn-agent-evidence: blocked Entry evidence survives rewalk, reopen, later publication, and fencing", (t) => {
  const home = makeTempDir("secant-entry-evidence-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-entry");
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  const failure = {
    source: "agent",
    code: "prompt-refused",
    possibleEffects: "none" as const,
    diagnostic: {
      kind: "prompt-refused",
      harnessDiagnostics: 'The prompt starts with "/model".',
    },
  };
  const entry = { attemptId: "entry", at: AT, failure };
  assert.ok(owner.writeState("blocked", undefined, entry).ok);
  assert.deepEqual(owner.attemptLog(), []);
  const blocked = group.readRun(created.runId);
  assert.ok(blocked.ok);
  assert.equal(blocked.run.state, "blocked");
  const first = owner.failureEvidence();
  assert.equal(first.length, 1);
  const id = first[0]?.diagnosticId;
  assert.ok(id);
  const diagnostic = owner.readDiagnostic(id);
  assert.match(
    new TextDecoder().decode(diagnostic),
    /Harness diagnostics:\nThe prompt starts with "\/model"/,
  );
  assert.ok(
    owner.writeState("blocked", undefined, {
      ...entry,
      failure: { ...failure, code: "different" },
    }).ok,
  );
  assert.deepEqual(owner.failureEvidence(), first);
  owner.close();
  const reopened = group.acquireRun(created.runId);
  assert.ok(reopened);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.failureEvidence(), first);
  assert.ok(
    reopened.publishAttempt({
      attemptId: "entry",
      outcome: "failed",
      required: [],
      outputs: [],
      at: AT,
      failureEvidence: { ...failure, code: "replacement" },
    }).ok,
  );
  assert.deepEqual(reopened.failureEvidence(), first);
  assert.deepEqual(reopened.readDiagnostic(id), diagnostic);
  const dir = join(groupDirOf(home), created.runId, "diagnostics");
  assert.deepEqual(readdirSync(dir), [id]);
  const successor = group.acquireRun(created.runId);
  assert.ok(successor);
  t.after(() => successor.close());
  assert.equal(
    reopened.writeState("blocked", undefined, { ...entry, attemptId: "stale" })
      .ok,
    false,
  );
  assert.deepEqual(successor.failureEvidence(), first);
  assert.deepEqual(readdirSync(dir), [id]);
  assert.throws(
    () =>
      successor.writeState("running", undefined, {
        ...entry,
        attemptId: "invalid",
      }),
    /blocked state/,
  );
  assert.deepEqual(successor.failureEvidence(), first);
});

test("m11-pre-turn-agent-evidence: diagnostics redact before bounding Harness text and keep cause sections first", async (t) => {
  const bridge = await startPermissionBridge(async () => ({
    decision: "deny",
    message: "unused",
  }));
  const token = bridge.session("failure").bearer;
  await bridge.close();
  const home = makeTempDir("secant-entry-diagnostic-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = create(group, "op-bounded-entry");
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.ok(
    owner.writeState("blocked", undefined, {
      attemptId: "entry",
      at: AT,
      failure: {
        source: "agent",
        code: "prompt-render-failed",
        possibleEffects: "none",
        diagnostic: {
          kind: "prompt-render-failed",
          cause: new Error(`failure ${token}`),
          harnessDiagnostics: `${token} ${"界".repeat(8000)} END`,
        },
      },
    }).ok,
  );
  const id = owner.failureEvidence()[0]?.diagnosticId;
  assert.ok(id);
  const bytes = owner.readDiagnostic(id);
  assert.ok(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.ok(!text.includes(token));
  assert.match(text, /«redacted-bearer-token»/);
  assert.ok(text.indexOf("Kind:") < text.indexOf("Cause:"));
  assert.ok(text.indexOf("Stack:") < text.indexOf("Harness diagnostics:"));
  const section = text.split("Harness diagnostics:\n")[1];
  assert.ok(section);
  assert.ok(new TextEncoder().encode(section.trimEnd()).length <= 16384);
  assert.match(section, /Secant omitted further Harness diagnostics/);
  assert.ok(!section.includes("END"));
});
