import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import type { ChangePreferencesInput } from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

function fixture(t: TestContext, home = makeTempDir("secant-appearance-")) {
  const catalog = openCatalog(home);
  const application = createApplication({
    catalog,
    harnessRegistry: [
      {
        choice: {
          id: "codex",
          name: "Codex",
          availability: "available",
        },
        servedCapabilities: [],
        inputRules: [],
        discover() {
          assert.fail("Preferences must not discover a Harness");
        },
        async qualify() {
          assert.fail("Preferences must not qualify a Harness");
        },
      },
    ],
    launchWorkspacePath: makeTempDir("secant-appearance-ws-"),
  });
  const database = new Database(join(home, "catalog.db"));
  t.after(async () => {
    await application.shutdown();
    database.close();
    catalog.close();
  });
  const port = application.projectionPort;
  return {
    home,
    catalog,
    database,
    port,
    read() {
      const view = port.openProjection({ family: "preferences" });
      view.close();
      return view.snapshot;
    },
    change(operationId: string, input: ChangePreferencesInput) {
      const admission = port.submit({
        operation: "change-preferences",
        operationId,
        input,
      });
      assert.equal(admission.admitted, true);
      const view = port.openProjection({ family: "operation", operationId });
      view.close();
      return view.snapshot;
    },
  };
}

test("m10-home-and-preferences: defaults and invalid keys resolve independently without preparing a Harness", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.read().preferences, {
    theme: "everforest",
    appearance: "dark",
  });
  assert.equal(f.read().supportedThemes.length, 25);
  assert.deepEqual(f.read().actionOffers, [{ action: "change-preferences" }]);
  f.catalog.setPreference("theme", "nord");
  f.catalog.setPreference("appearance", "LIGHT");
  assert.deepEqual(f.read().preferences, { theme: "nord", appearance: "dark" });
  f.catalog.setPreference("theme", '"nord"');
  f.catalog.setPreference("appearance", "light");
  assert.deepEqual(f.read().preferences, {
    theme: "everforest",
    appearance: "light",
  });
  f.database.exec("UPDATE preferences SET value = x'00' WHERE key = 'theme'");
  assert.deepEqual(f.read().preferences, {
    theme: "everforest",
    appearance: "light",
  });
  assert.ok(f.read().notice);
});

test("m10-home-and-preferences: paired and partial saves preserve Model-choice bytes, replay receipts, and home isolation", (t) => {
  const f = fixture(t);
  const second = fixture(t, f.home);
  const isolated = fixture(t);
  const encoded = '{ "model": "gpt-5", "effort": "high" }';
  f.catalog.setPreference("last-model-choice:codex", encoded);
  const saved = f.change("first", { theme: "nord", appearance: "light" });
  assert.deepEqual(saved, {
    family: "operation",
    operationId: "first",
    outcome: { status: "applied" },
    preferencesChange: { theme: "nord", appearance: "light" },
  });
  assert.deepEqual(second.read().preferences, saved.preferencesChange);
  assert.deepEqual(
    second.change("second", { theme: "ayu" }).preferencesChange,
    { theme: "ayu", appearance: "light" },
  );
  assert.deepEqual(
    f.change("first", { appearance: "light", theme: "nord" }),
    saved,
  );
  const conflict = f.port.submit({
    operation: "change-preferences",
    operationId: "first",
    input: { theme: "dracula" },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted)
    assert.equal(conflict.problem.code, "operation-id-reused");
  assert.deepEqual(f.read().preferences, { theme: "ayu", appearance: "light" });
  assert.deepEqual(fixture(t, f.home).read().preferences, {
    theme: "ayu",
    appearance: "light",
  });
  assert.deepEqual(isolated.read().preferences, {
    theme: "everforest",
    appearance: "dark",
  });
  assert.equal(f.catalog.getPreference("last-model-choice:codex"), encoded);
});

test("m10-home-and-preferences: invalid and empty patches refuse before writes, while failed saves settle and retry uses a fresh id", (t) => {
  const f = fixture(t);
  f.change("initial", { theme: "nord", appearance: "light" });
  for (const input of [
    {},
    { theme: "" },
    { theme: "Nord" },
    { theme: "unknown" },
    { appearance: "LIGHT" },
    { appearance: "" },
    { theme: "ayu", appearance: "bad" },
  ]) {
    const admission = f.port.submit({
      operation: "change-preferences",
      operationId: "invalid",
      input,
    });
    assert.equal(admission.admitted, false);
    if (!admission.admitted) {
      assert.equal(admission.problem.code, "invalid-preferences");
      assert.equal(admission.problem.possibleEffects, "none");
    }
    assert.deepEqual(f.read().preferences, {
      theme: "nord",
      appearance: "light",
    });
  }
  // Refused ids are unconsumed.
  f.change("invalid", { theme: "nord" });
  f.database.exec(
    "CREATE TRIGGER fail_appearance BEFORE UPDATE ON preferences WHEN NEW.key = 'appearance' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const failed = f.change("failed", { theme: "ayu", appearance: "dark" });
  assert.equal(failed.outcome.status, "not-applied");
  if (failed.outcome.status === "not-applied") {
    assert.equal(failed.outcome.problem.code, "preferences-save-failed");
    assert.equal(failed.outcome.problem.possibleEffects, "none");
  }
  assert.equal(failed.preferencesChange, undefined);
  assert.deepEqual(f.read().preferences, {
    theme: "nord",
    appearance: "light",
  });
  f.database.exec("DROP TRIGGER fail_appearance");
  assert.deepEqual(
    f.change("failed", { theme: "ayu", appearance: "dark" }),
    failed,
  );
  assert.deepEqual(
    f.change("retry", { theme: "ayu", appearance: "dark" }).preferencesChange,
    { theme: "ayu", appearance: "dark" },
  );
});

test("m10-home-and-preferences: preference-only read failure falls back without masking Catalog-wide failure", (t) => {
  const f = fixture(t);
  f.database.exec("DROP TABLE preferences");
  assert.deepEqual(f.read().preferences, {
    theme: "everforest",
    appearance: "dark",
  });
  assert.equal(f.read().notice?.code, "preferences-read-failed");
  const workspace = f.port.openProjection({ family: "workspace" });
  workspace.close();
  assert.equal(workspace.snapshot.approval.state, "unapproved");
  f.database.exec("DROP TABLE workspace_approvals");
  assert.throws(() => f.port.openProjection({ family: "workspace" }));
});

test("m10-home-and-preferences: open readers receive saved pairs and no update for refused or rolled-back changes", async (t) => {
  const f = fixture(t);
  const view = f.port.openProjection({ family: "preferences" });
  const updates = view.updates[Symbol.asyncIterator]();
  f.change("save", { appearance: "light" });
  const next = await updates.next();
  assert.ok(!next.done && next.value.kind === "durable");
  assert.deepEqual(next.value.snapshot.preferences, {
    theme: "everforest",
    appearance: "light",
  });
  f.port.submit({
    operation: "change-preferences",
    operationId: "refuse",
    input: {},
  });
  f.database.exec(
    "CREATE TRIGGER fail_write BEFORE INSERT ON preferences BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  f.change("failed", { theme: "ayu" });
  view.close();
  assert.equal((await updates.next()).done, true);
});

test("m10-home-and-preferences: partial saves default malformed omitted keys while preserving their bytes", (t) => {
  const f = fixture(t);
  f.database.exec(
    "INSERT INTO preferences (key,value) VALUES ('theme', x'00')",
  );
  assert.deepEqual(
    f.change("appearance", { appearance: "light" }).preferencesChange,
    { theme: "everforest", appearance: "light" },
  );
  assert.deepEqual(
    f.database
      .query("SELECT hex(value) AS bytes FROM preferences WHERE key = 'theme'")
      .get(),
    { bytes: "00" },
  );
  assert.equal(f.read().notice?.code, "preferences-read-failed");
  f.database.exec(
    "UPDATE preferences SET value = x'01' WHERE key = 'appearance'",
  );
  assert.deepEqual(f.change("theme", { theme: "nord" }).preferencesChange, {
    theme: "nord",
    appearance: "dark",
  });
  assert.deepEqual(
    f.database
      .query(
        "SELECT hex(value) AS bytes FROM preferences WHERE key = 'appearance'",
      )
      .get(),
    { bytes: "01" },
  );
});

test("m10-audit-headless-output-parity: Preferences projection reads its pair from the Catalog snapshot", (t) => {
  const f = fixture(t);
  f.database.exec("PRAGMA journal_mode = WAL");
  const other = openCatalog(f.home);
  t.after(() => other.close());
  f.change("initial", { theme: "nord", appearance: "light" });
  const readPreferences = f.catalog.readPreferences;
  f.catalog.readPreferences = (read) =>
    readPreferences((getPreference) =>
      read((key) => {
        const value = getPreference(key);
        if (key === "theme")
          other.changePreferences(
            { theme: "ayu", appearance: "dark" },
            () => undefined,
          );
        return value;
      }),
    );
  assert.deepEqual(f.read().preferences, {
    theme: "nord",
    appearance: "light",
  });
  assert.equal(other.getPreference("theme"), "ayu");
  assert.equal(other.getPreference("appearance"), "dark");
  f.catalog.readPreferences = readPreferences;
  assert.deepEqual(f.read().preferences, { theme: "ayu", appearance: "dark" });
});

test("m10-audit-headless-output-parity: a failed Preference read transaction defaults the pair with a notice", (t) => {
  const f = fixture(t);
  f.change("initial", { theme: "nord", appearance: "light" });
  const cause = new Error("unavailable transaction");
  f.catalog.readPreferences = () => {
    throw cause;
  };
  const snapshot = f.read();
  assert.deepEqual(snapshot.preferences, {
    theme: "everforest",
    appearance: "dark",
  });
  assert.equal(snapshot.notice?.code, "preferences-read-failed");
  assert.equal(snapshot.notice?.possibleEffects, "none");
  assert.equal(snapshot.notice?.cause, cause);
});
