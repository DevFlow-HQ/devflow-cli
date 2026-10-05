import assert from "node:assert/strict";
import { readSync, writeSync } from "node:fs";
import { Database } from "bun:sqlite";
import { openRunGroup } from "../../../src/run/store/store.js";
import { createProcessAdapter } from "../../../src/process/process.js";

const [home, workspacePath, operationId, mode] = process.argv.slice(2);
if (
  !home ||
  !workspacePath ||
  !operationId ||
  !["staged", "published", "open"].includes(mode ?? "")
) {
  throw new Error(
    "expected home, Workspace path, operation id, and staged/published/open mode",
  );
}

function signal(message: string): void {
  writeSync(1, `${message}\n`);
}

function park(): void {
  signal("parked");
  assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1);
}

// These barriers observe the native coordination transaction, not Run policy.
// Wrapping its callback parks publication after rename and before commit without
// adding a production hook. The opener signals immediately before lock admission.
const transaction = Database.prototype.transaction;
let creating = false;
let signalledAdmission = false;
Database.prototype.transaction = function <A extends unknown[], T>(
  this: Database,
  callback: (...args: A) => T,
) {
  const coordination = this.filename.endsWith("coordination.db");
  const native = (transaction<A, T>).call(this, (...args: A): T => {
    const result = callback(...args);
    if (coordination && creating && mode === "published") park();
    return result;
  });
  return Object.assign((...args: A): T => native(...args), {
    deferred: native.deferred,
    exclusive: native.exclusive,
    immediate: (...args: A): T => {
      if (coordination && mode === "open" && !signalledAdmission) {
        signalledAdmission = true;
        signal("release-writer");
      }
      return native.immediate(...args);
    },
  });
};

const group = openRunGroup(home, workspacePath, {
  process: createProcessAdapter(),
  now: () => {
    // On the old path there is no startup admission. Its clock runs after the
    // destructive quarantine cleanup, allowing that defect to fail deterministically.
    if (mode === "open" && !signalledAdmission) signal("release-writer");
    return new Date("2026-10-05T00:00:00.000Z");
  },
});
try {
  if (mode === "open") {
    const listed = group.listRuns();
    assert.equal(listed.length, 1);
    const run = listed[0];
    assert.ok(run);
    assert.equal(run.live, true);
    assert.equal(run.ownedByThisProcess, false);
    const read = group.readRun(run.runId);
    assert.ok(read.ok);
    assert.deepEqual(read.run.launch, { source: "startup-collision" });
    assert.equal(read.run.state, "created");
    signal("readable");
  } else {
    creating = true;
    const result = group.createRun({
      operationId,
      bundleSnapshotDigest: "sha256:startup-collision",
      launch: {
        toJSON() {
          if (mode === "staged") park();
          return { source: "startup-collision" };
        },
      },
      at: new Date("2026-10-05T00:00:00.000Z"),
    });
    creating = false;
    assert.equal(result.outcome, "created");
    assert.ok(group.readRun(result.runId).ok);
    signal("created");
    // Keep the writer alive until the opener has verified ownership and bytes.
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
  }
} finally {
  group.close();
}
