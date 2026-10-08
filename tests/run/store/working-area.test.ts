import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import type { RunGroup, RunOwner } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";
import { openFakeRunGroup as openRunGroup } from "./fake-git-process.js";

// #214 at the Run Store Interface: each Run owns one editable working area, a
// lifecycle child of the Run isolated from its private database and Artifact
// repository. It survives reacquisition (halt and resume), is removed with the
// Run, and a path that cannot be a directory is a typed Problem.

const AT = new Date("2026-09-23T12:00:00.000Z");

function group(
  t: TestContext,
  options: { readonly aliasHome?: boolean } = {},
): { g: RunGroup; home: string } {
  const home = makeTempDir("secant-store-working-area-");
  const storeHome = options.aliasHome
    ? join(makeTempDir("secant-store-working-alias-"), "home")
    : home;
  if (options.aliasHome) symlinkSync(home, storeHome, "junction");
  const g = openRunGroup(storeHome, "/work/project");
  t.after(() => g.close());
  return { g, home };
}

function freshRun(g: RunGroup): string {
  const created = g.createRun({
    operationId: `op-${Math.random()}`,
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: AT,
  });
  assert.ok(created.outcome === "created");
  return created.runId;
}

function acquire(t: TestContext, g: RunGroup, runId: string): RunOwner {
  const owner = g.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());
  return owner;
}

function areaOf(owner: RunOwner): string {
  const area = owner.workingArea();
  assert.ok(area.ok, JSON.stringify(area));
  return area.path;
}

/** Every private Run Store file under the home: databases and Artifact repos. */
function privateStoreFiles(home: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === "run.db" || entry.name === "artifacts.git") {
        found.push(path);
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(home);
  return found;
}

test("m12-audit-working-area-boundary: a Run's working area is an empty absolute directory that grants no private Store file", (t) => {
  const { g, home } = group(t);
  const owner = acquire(t, g, freshRun(g));
  // Publish once so the lazily created Artifact repository exists too.
  assert.ok(
    owner.publishAttempt({
      attemptId: "a1",
      outcome: "succeeded",
      required: [{ name: "x", type: "text" }],
      outputs: [
        { name: "x", type: "text", content: new TextEncoder().encode("x") },
      ],
      at: AT,
    }).ok,
  );

  const area = areaOf(owner);
  assert.ok(isAbsolute(area));
  assert.ok(statSync(area).isDirectory());
  assert.deepEqual(readdirSync(area), []);
  const privateFiles = privateStoreFiles(home);
  assert.ok(privateFiles.some((path) => path.endsWith("run.db")));
  assert.ok(privateFiles.some((path) => path.endsWith("artifacts.git")));
  for (const path of privateFiles) {
    assert.ok(
      relative(area, path).startsWith(".."),
      `${path} must not lie inside the working area ${area}`,
    );
  }
  // Asking again names the same directory.
  assert.equal(areaOf(owner), area);
});

test("m12-audit-working-area-boundary: two Runs own distinct working areas", (t) => {
  const { g } = group(t);
  const first = areaOf(acquire(t, g, freshRun(g)));
  const second = areaOf(acquire(t, g, freshRun(g)));
  assert.notEqual(first, second);
  assert.ok(relative(first, second).startsWith(".."));
  assert.ok(relative(second, first).startsWith(".."));
});

test("m12-audit-working-area-boundary: working files survive the Run being released and reacquired", (t) => {
  const { g } = group(t);
  const runId = freshRun(g);
  const owner = acquire(t, g, runId);
  const area = areaOf(owner);
  writeFileSync(join(area, "spec.md"), "# Spec\n");
  owner.writeState("halted");
  owner.release();
  owner.close();
  g.endRun(runId);

  assert.equal(g.resumeRun(runId).outcome, "resumed");
  const resumed = acquire(t, g, runId);
  assert.equal(areaOf(resumed), area);
  assert.equal(readFileSync(join(area, "spec.md"), "utf8"), "# Spec\n");
});

test("m12-audit-working-area-boundary: deleting the Run removes its working files", (t) => {
  const { g } = group(t);
  const runId = freshRun(g);
  const owner = acquire(t, g, runId);
  const area = areaOf(owner);
  writeFileSync(join(area, "ticket-1.md"), "ticket");
  owner.close();

  assert.equal(
    g.deleteRun({ operationId: "op-delete", runId }).outcome,
    "deleted",
  );
  assert.equal(existsSync(area), false);
});

test("m12-audit-working-area-boundary: a working-area path that is not a directory is a typed Problem", (t) => {
  const { g } = group(t);
  const owner = acquire(t, g, freshRun(g));
  const area = areaOf(owner);
  rmSync(area, { recursive: true });
  writeFileSync(area, "squatter");

  const result = owner.workingArea();
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.problem.kind, "working-area-unavailable");
  assert.equal(realpathSync(result.problem.path), area);
  assert.ok(result.problem.cause !== undefined);
  // The squatting file is left untouched, never replaced.
  assert.equal(readFileSync(area, "utf8"), "squatter");
});

test("m12-audit-working-area-boundary: a link to the private Run parent is refused without widening the grant", (t) => {
  const { g } = group(t, { aliasHome: true });
  const owner = acquire(t, g, freshRun(g));
  const area = areaOf(owner);
  const parent = dirname(area);
  const database = readFileSync(join(parent, "run.db"));
  rmSync(area, { recursive: true });
  symlinkSync(parent, area, "junction");

  const result = owner.workingArea();

  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.problem.kind, "working-area-unavailable");
  // Resolve only the parent: following the rejected leaf would name its target.
  assert.equal(realpathSync(dirname(result.problem.path)), dirname(area));
  assert.equal(basename(result.problem.path), "working");
  assert.ok(result.problem.cause instanceof Error);
  assert.ok(lstatSync(area).isSymbolicLink());
  assert.equal(realpathSync(area), parent);
  assert.deepEqual(readFileSync(join(parent, "run.db")), database);
});

for (const keep of [false, true]) {
  test(`m12-audit-working-area-boundary: ${keep ? "retained" : "ordinary"} receipt allocation refuses an external working link and preserves its target`, (t) => {
    const { g } = group(t, { aliasHome: true });
    const owner = acquire(t, g, freshRun(g));
    const area = areaOf(owner);
    const receipt = owner.outputReceiptDirectory("0.0:publish");
    assert.ok(receipt.ok);
    const target = makeTempDir("secant-working-target-");
    const matchingReceipt = join(target, relative(area, receipt.path));
    mkdirSync(matchingReceipt, { recursive: true });
    writeFileSync(join(matchingReceipt, "summary"), "existing receipt");
    writeFileSync(join(target, "independent"), "external working file");
    rmSync(area, { recursive: true });
    symlinkSync(target, area, "junction");

    const result = owner.outputReceiptDirectory("0.0:publish", { keep });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.problem.kind, "working-area-unavailable");
    // Resolve only the parent: following the rejected leaf would name its target.
    assert.equal(realpathSync(dirname(result.problem.path)), dirname(area));
    assert.equal(basename(result.problem.path), "working");
    assert.ok(result.problem.cause instanceof Error);
    // A new Attempt cannot create receipts through the redirected base either.
    const fresh = owner.outputReceiptDirectory("0.1:publish", { keep });
    assert.equal(fresh.ok, false, JSON.stringify(fresh));
    if (fresh.ok) throw new Error("unreachable");
    assert.equal(fresh.problem.kind, "working-area-unavailable");
    assert.equal(fresh.problem.path, result.problem.path);
    assert.deepEqual(readdirSync(dirname(matchingReceipt)), [
      basename(receipt.path),
    ]);
    assert.equal(
      readFileSync(join(matchingReceipt, "summary"), "utf8"),
      "existing receipt",
    );
    assert.equal(
      readFileSync(join(target, "independent"), "utf8"),
      "external working file",
    );
    assert.ok(lstatSync(area).isSymbolicLink());
    assert.equal(realpathSync(area), realpathSync(target));
  });
}

test("m12-audit-working-area-boundary: parent aliases allow first creation, reuse, reacquisition and receipts at the canonical working path", (t) => {
  const home = makeTempDir("secant-working-home-");
  const alias = join(makeTempDir("secant-working-alias-"), "home");
  symlinkSync(home, alias, "junction");
  const g = openRunGroup(alias, "/work/project");
  t.after(() => g.close());
  const runId = freshRun(g);
  const owner = acquire(t, g, runId);
  const area = areaOf(owner);
  assert.ok(relative(realpathSync(home), area).startsWith(`runs`));
  assert.equal(area, realpathSync(area));
  assert.ok(lstatSync(area).isDirectory());
  writeFileSync(join(area, "spec.md"), "working file");
  const receipt = owner.outputReceiptDirectory("0.0:publish");
  assert.ok(receipt.ok);
  writeFileSync(join(receipt.path, "summary"), "receipt");
  assert.deepEqual(
    owner.outputReceiptDirectory("0.0:publish", { keep: true }),
    receipt,
  );
  assert.equal(readFileSync(join(receipt.path, "summary"), "utf8"), "receipt");
  assert.equal(areaOf(owner), area);
  owner.writeState("halted");
  owner.release();
  owner.close();
  g.endRun(runId);
  assert.equal(g.resumeRun(runId).outcome, "resumed");
  const resumed = acquire(t, g, runId);
  assert.equal(areaOf(resumed), area);
  assert.equal(readFileSync(join(area, "spec.md"), "utf8"), "working file");
  resumed.close();
  assert.equal(
    g.deleteRun({ operationId: "delete-aliased", runId }).outcome,
    "deleted",
  );
  assert.equal(existsSync(area), false);
  assert.ok(lstatSync(alias).isSymbolicLink());
});
