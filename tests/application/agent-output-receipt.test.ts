import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { RunView } from "../../src/application/projection-port.js";
import { storedProcess } from "../helpers/wiringDoubles.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { readRun } from "./run-test-helpers.js";
import { launch, receiptAgent, writeBundle } from "./agent-receipt-fixture.js";
const sharedGit = createFakeGitProcess();

/** The text of the Run output `name` read back through the Port's resource read. */
function readOutput(wired: Wiring, run: RunView, name: string): string {
  const output = run.outputs.find((candidate) => candidate.name === name);
  assert.ok(output, `output ${name} is projected`);
  const read = wired.projectionPort.readResource(output.reference);
  assert.ok(read.found, JSON.stringify(read));
  return read.content;
}

test("[agent-output-receipt] a validated receipt binds the reference as a Run output a later prompt receives", async (t) => {
  // The consuming Step's Turn writes nothing; it declares no output.
  const consumer = receiptAgent([
    "https://github.com/example/repo/issues/12\n",
    undefined,
  ]);
  const { wired, runId } = await launch(
    t,
    consumer.adapter,
    writeBundle("consume"),
  );

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(
    readOutput(wired, run, "spec-ref"),
    "https://github.com/example/repo/issues/12",
  );
  // The later Step's prompt carries the bound reference, not the agent's prose.
  assert.equal(consumer.inputs.length, 2);
  assert.equal(
    consumer.inputs[1],
    "Slice the spec at https://github.com/example/repo/issues/12.\n",
  );
});

test("[agent-output-receipt] a completed Turn with no receipt fails the Run and leaves the earlier binding intact", async (t) => {
  // The first producer writes its receipt; the second completes its Turn (claiming
  // publication in prose) but writes none.
  const agent = receiptAgent(["LOCAL:spec.md", undefined]);
  const { wired, runId } = await launch(
    t,
    agent.adapter,
    writeBundle("republish"),
  );

  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "failed");
  assert.equal(agent.inputs.length, 2);
  assert.equal(readOutput(wired, run, "spec-ref"), "LOCAL:spec.md");
  // The Turn completed; only the Step failed — the timeline keeps both facts.
  const settled = run.timeline.filter(
    (event) => event.event === "turn-settled",
  );
  assert.deepEqual(
    settled.map((event) => event.detail),
    ["completed", "completed"],
  );
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "attempt-settled")
      .map((event) => event.detail),
    ["succeeded", "failed"],
  );
});

test("[agent-output-receipt] a receipt root the Store cannot prepare fails each Attempt before any Turn and binds nothing (#305)", async (t) => {
  const agent = receiptAgent(["never-written", "never-written"], {
    squatReceiptRoot: true,
  });
  const { wired, runId, launched } = await launch(
    t,
    agent.adapter,
    writeBundle("none", 1),
  );
  // The launch Operation itself applied; only the Run's Step failed.
  assert.equal(launched.status, "applied", JSON.stringify(launched));

  const run = readRun(wired.projectionPort, runId);
  // The existing failed-Attempt policy: retried within budget, then the Run fails.
  assert.equal(run.state, "failed");
  assert.deepEqual(
    run.timeline
      .filter((event) => event.event === "attempt-settled")
      .map((event) => event.detail),
    ["failed", "failed"],
  );
  // No Turn was sent or recorded, and no output was bound.
  assert.deepEqual(agent.inputs, []);
  assert.deepEqual(
    run.timeline.filter((event) => event.event.startsWith("turn-")),
    [],
  );
  assert.deepEqual(run.outputs, []);
  // The failed Attempts ran under the qualified Harness, so its identity projects.
  assert.equal(run.harness?.name, "Claude Code");
});

const INVALID_RECEIPTS = [
  {
    code: "receipt-missing",
    write: (_path: string) => {},
    wording: "was not written",
  },
  {
    code: "receipt-not-file",
    write: (path: string) => mkdirSync(path),
    wording: "is not a regular file",
  },
  {
    code: "receipt-symlink",
    write: (path: string) => {
      const target = `${path}-target`;
      writeFileSync(target, "valid text");
      symlinkSync(target, path, "file");
    },
    wording: "is a symbolic link",
  },
  {
    code: "receipt-too-large",
    write: (path: string) => writeFileSync(path, "x".repeat(65537)),
    wording: "exceeds the 65536-byte limit",
  },
  {
    code: "receipt-invalid-utf8",
    write: (path: string) => writeFileSync(path, new Uint8Array([0xff])),
    wording: "is not valid UTF-8 text",
  },
  {
    code: "receipt-blank",
    write: (path: string) => writeFileSync(path, " \n\t"),
    wording: "is empty",
  },
] as const;

for (const receipt of INVALID_RECEIPTS) {
  test(`m11-receipt-failure-evidence: ${receipt.code} survives reopen with a completed Turn`, async (t) => {
    const { wired, home, workspace, runId } = await launch(
      t,
      receiptAgent([receipt.write]).adapter,
      writeBundle("none"),
    );
    await wired.shutdown();
    wired.runGroup.close();
    wired.catalog.close();
    const reopened = wireApplication({
      secantHome: home,
      launchCwd: workspace,
      process: storedProcess({ git: sharedGit }),
      harnessAdapter: receiptAgent([]).adapter,
    });
    t.after(async () => {
      await reopened.shutdown();
      reopened.runGroup.close();
      reopened.catalog.close();
    });
    const run = readRun(reopened.projectionPort, runId);
    assert.equal(run.state, "failed");
    assert.deepEqual(run.outputs, []);
    assert.deepEqual(
      run.timeline
        .filter((e) => e.event === "turn-settled")
        .map((e) => e.detail),
      ["completed"],
    );
    const failed = run.timeline.find((e) => e.event === "attempt-settled");
    assert.ok(
      failed?.failure,
      "failed Attempt carries durable Failure evidence",
    );
    assert.equal(failed.failure.source, "receipt");
    assert.equal(failed.failure.code, receipt.code);
    assert.equal(failed.failure.possibleEffects, "unknown");
    assert.deepEqual(
      failed.failure.details,
      receipt.code === "receipt-too-large"
        ? { outputName: "spec-ref", sizeLimit: 65536 }
        : { outputName: "spec-ref" },
    );
    assert.match(failed.failure.explanation, /The required output "spec-ref"/);
    assert.ok(failed.failure.explanation.includes(receipt.wording));
    assert.match(
      failed.failure.explanation,
      /It may have changed files before it stopped\./,
    );
    assert.equal(
      failed.failure.nextStep,
      "Resume the Run to try the Step again.",
    );
    assert.equal(failed.failure.diagnostic, undefined);
    const owner = reopened.runGroup.acquireRun(runId);
    assert.ok(owner);
    try {
      const evidence = owner.failureEvidence();
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.code, receipt.code);
      assert.equal(evidence[0]?.turnId, undefined);
    } finally {
      owner.close();
    }
    if (receipt.code === "receipt-symlink")
      t.diagnostic(
        `File symlink creation succeeded on ${process.platform}; receipt-symlink persisted after reopen.`,
      );
  });
}

for (const damaged of [
  {
    name: "unknown source",
    sql: "UPDATE failure_evidence SET source = 'future'",
    code: "unknown",
  },
  {
    name: "unknown code",
    sql: "UPDATE failure_evidence SET code = 'future'",
    code: "unknown",
  },
  {
    name: "unknown effects",
    sql: "UPDATE failure_evidence SET possible_effects = 'future'",
    code: "receipt-missing",
  },
  {
    name: "malformed JSON",
    sql: "UPDATE failure_evidence SET details = '{'",
    code: "unknown",
  },
  {
    name: "non-scalar details",
    sql: "UPDATE failure_evidence SET details = '{\"outputName\":[]}'",
    code: "unknown",
  },
  {
    name: "missing details",
    sql: "UPDATE failure_evidence SET details = NULL",
    code: "unknown",
  },
  { name: "no evidence", sql: "DELETE FROM failure_evidence", code: "unknown" },
  {
    name: "indeterminate with no evidence",
    sql: "DELETE FROM failure_evidence; UPDATE attempt_log SET outcome = 'indeterminate'",
    code: "unknown",
  },
] as const) {
  test(`m11-receipt-failure-evidence: ${damaged.name} narrows tolerantly at the Projection`, async (t) => {
    const { wired, runId, home } = await launch(
      t,
      receiptAgent([undefined]).adapter,
      writeBundle("none"),
    );
    const roots = join(home, "runs");
    const db = new Database(
      join(roots, readdirSync(roots)[0]!, runId, "run.db"),
    );
    try {
      db.exec(damaged.sql);
    } finally {
      db.close();
    }
    const event = readRun(wired.projectionPort, runId).timeline.find(
      (e) => e.event === "attempt-settled",
    );
    assert.equal(event?.failure?.code, damaged.code);
    assert.equal(event?.failure?.possibleEffects, "unknown");
    if (damaged.code === "unknown")
      assert.equal(
        event?.failure?.explanation,
        "This Step failed for unknown reasons. It may have changed files before it stopped.",
      );
  });
}

test("m11-receipt-failure-evidence: an unclassified receipt filesystem error fails without inventing a seventh code", async (t) => {
  const { wired, runId } = await launch(
    t,
    receiptAgent([
      (path) => {
        const directory = dirname(path);
        rmSync(directory, { recursive: true });
        writeFileSync(directory, "not a directory");
      },
    ]).adapter,
    writeBundle("none"),
  );
  const run = readRun(wired.projectionPort, runId);
  assert.equal(run.state, "failed");
  assert.deepEqual(run.outputs, []);
  assert.equal(
    run.timeline.find((e) => e.event === "turn-settled")?.detail,
    "completed",
  );
  assert.equal(
    run.timeline.find((e) => e.event === "attempt-settled")?.failure?.code,
    "unknown",
  );
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    assert.deepEqual(owner.failureEvidence(), []);
  } finally {
    owner.close();
  }
});

for (const effect of ["none", "partial"] as const) {
  test(`m11-receipt-failure-evidence: stored ${effect} effects control the warning without losing the receipt reason`, async (t) => {
    const { wired, runId, home } = await launch(
      t,
      receiptAgent([undefined]).adapter,
      writeBundle("none"),
    );
    const roots = join(home, "runs");
    const db = new Database(
      join(roots, readdirSync(roots)[0]!, runId, "run.db"),
    );
    try {
      db.query("UPDATE failure_evidence SET possible_effects = ?").run(effect);
    } finally {
      db.close();
    }
    const failure = readRun(wired.projectionPort, runId).timeline.find(
      (e) => e.event === "attempt-settled",
    )?.failure;
    assert.equal(failure?.possibleEffects, effect);
    assert.equal(failure?.code, "receipt-missing");
    assert.equal(
      failure?.explanation,
      'The required output "spec-ref" was not written.' +
        (effect === "partial"
          ? " It may have changed files before it stopped."
          : ""),
    );
  });
}
