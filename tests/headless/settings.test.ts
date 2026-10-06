import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Database } from "bun:sqlite";
import { openCatalog } from "../../src/catalog/catalog.js";
import { runHeadless, runHeadlessCli } from "../../src/headless/headless.js";
import { createApplication } from "../helpers/application.js";
import { makeTempDir } from "../helpers/tempDir.js";

function fixture(t: TestContext) {
  const home = makeTempDir("secant-settings-");
  const catalog = openCatalog(home);
  const database = new Database(join(home, "catalog.db"));
  const workspace = makeTempDir("secant-settings-ws-");
  const clients = createApplication({
    catalog,
    launchWorkspacePath: workspace,
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
          assert.fail("Settings must not discover a Harness");
        },
        async qualify() {
          assert.fail("Settings must not qualify a Harness");
        },
      },
    ],
  });
  t.after(async () => {
    await clients.shutdown();
    database.close();
    catalog.close();
  });
  let stdout = "",
    stderr = "";
  const io = {
    out: (text: string) => {
      stdout += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    cwd: () => workspace,
  };
  return {
    catalog,
    database,
    clients,
    io,
    async run(args: string[]) {
      stdout = "";
      stderr = "";
      const code = await runHeadless(clients, args, io);
      return { code, stdout, stderr };
    },
  };
}

test("settings show emits only the saved pair in JSON and names defaults in text without approval or Harness preparation", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.run(["settings", "show", "--json"]), {
    code: 0,
    stdout: '{\n  "theme": "everforest",\n  "appearance": "dark"\n}\n',
    stderr: "",
  });
  assert.deepEqual(await f.run(["settings", "show"]), {
    code: 0,
    stdout: "Theme: everforest\nAppearance: dark\n",
    stderr: "",
  });
  assert.equal(f.catalog.getWorkspaceApproval(f.io.cwd()), undefined);
});

test("settings set returns applied saved pairs for paired and partial changes in exact Operation JSON and text", async (t) => {
  const f = fixture(t);
  const encoded = '{ "model": "gpt-5" }';
  f.catalog.setPreference("last-model-choice:codex", encoded);
  const first = await f.run([
    "settings",
    "set",
    "--theme",
    "nord",
    "--appearance",
    "light",
    "--json",
  ]);
  assert.equal(first.code, 0);
  assert.equal(first.stderr, "");
  const receipt = JSON.parse(first.stdout);
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(receipt, {
    family: "operation",
    operationId: receipt.operationId,
    outcome: { status: "applied" },
    preferencesChange: { theme: "nord", appearance: "light" },
  });
  assert.deepEqual(await f.run(["settings", "set", "--theme", "ayu"]), {
    code: 0,
    stdout: "Theme: ayu\nAppearance: light\n",
    stderr: "",
  });
  assert.deepEqual(
    JSON.parse(
      (await f.run(["settings", "set", "--appearance", "dark", "--json"]))
        .stdout,
    ).preferencesChange,
    { theme: "ayu", appearance: "dark" },
  );
  assert.equal(f.catalog.getPreference("last-model-choice:codex"), encoded);
  assert.equal(f.catalog.getWorkspaceApproval(f.io.cwd()), undefined);
});

test("settings accepts all 25 exact identifiers and rejects empty, unsupported, case-changed and mixed-invalid patches without writes", async (t) => {
  const f = fixture(t);
  const view = f.clients.projectionPort.openProjection({
    family: "preferences",
  });
  view.close();
  assert.equal(view.snapshot.supportedThemes.length, 25);
  for (const id of view.snapshot.supportedThemes) {
    const result = await f.run(["settings", "set", "--theme", id, "--json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).preferencesChange, {
      theme: id,
      appearance: "dark",
    });
  }
  for (const flags of [
    [],
    ["--theme", ""],
    ["--theme", "Nord"],
    ["--theme", "custom"],
    ["--appearance", ""],
    ["--appearance", "Dark"],
    ["--theme", "ayu", "--appearance", "bad"],
  ]) {
    const result = await f.run(["settings", "set", ...flags, "--json"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const problem = JSON.parse(result.stdout);
    assert.equal(problem.code, "invalid-preferences");
    assert.equal(problem.possibleEffects, "none");
    assert.equal(problem.family, undefined);
    assert.equal(f.catalog.getPreference("theme"), "carbonfox");
    assert.equal(f.catalog.getPreference("appearance"), undefined);
  }
  const text = await f.run(["settings", "set", "--theme", "bad"]);
  assert.equal(text.code, 1);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /Error \[invalid-preferences\]/);
});

for (const event of ["INSERT", "UPDATE"]) {
  test(`settings ${event} failure has not-applied Operation JSON and rolls back both keys`, async (t) => {
    const f = fixture(t);
    if (event === "UPDATE") {
      f.catalog.setPreference("theme", "everforest");
      f.catalog.setPreference("appearance", "dark");
    }
    f.database.exec(
      `CREATE TRIGGER fail_pair BEFORE ${event} ON preferences WHEN NEW.key = 'appearance' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    const result = await f.run([
      "settings",
      "set",
      "--theme",
      "ayu",
      "--appearance",
      "light",
      "--json",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(receipt).sort(), [
      "family",
      "operationId",
      "outcome",
    ]);
    assert.equal(receipt.family, "operation");
    assert.equal(receipt.outcome.status, "not-applied");
    assert.equal(receipt.outcome.problem.code, "preferences-save-failed");
    assert.equal(receipt.outcome.problem.possibleEffects, "none");
    assert.deepEqual(
      JSON.parse((await f.run(["settings", "show", "--json"])).stdout),
      { theme: "everforest", appearance: "dark" },
    );
    const text = await f.run(["settings", "set", "--appearance", "light"]);
    assert.equal(text.code, 1);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /preferences-save-failed/);
    f.database.exec("DROP TRIGGER fail_pair");
    assert.equal(
      (
        await f.run([
          "settings",
          "set",
          "--theme",
          "ayu",
          "--appearance",
          "light",
        ])
      ).code,
      0,
    );
  });
}

test("settings preference read notices and startup notices stay on stderr, successful fallback exits zero", async (t) => {
  const f = fixture(t);
  f.database.exec("DROP TABLE preferences");
  const result = await f.run(["settings", "show", "--json"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /preferences-read-failed/);
  assert.deepEqual(JSON.parse(result.stdout), {
    theme: "everforest",
    appearance: "dark",
  });
  assert.equal(
    (result.stdout + result.stderr).includes(String.fromCharCode(27)),
    false,
  );
  const code = await runHeadless(
    {
      ...f.clients,
      startupNotices: [
        {
          code: "startup",
          explanation: "startup notice",
          remediation: "retry",
          possibleEffects: "none",
        },
      ],
    },
    ["settings", "show", "--json"],
    f.io,
  );
  assert.equal(code, 0);
});

test("bare settings shows help without composition and malformed syntax preserves usage errors", async (t) => {
  const f = fixture(t);
  let wired = 0;
  const code = await runHeadlessCli(["settings"], f.io, "0.2.0", (run) => {
    wired++;
    return run(f.clients);
  });
  assert.equal(code, 0);
  assert.equal(wired, 0);
  const help = await f.run(["settings"]);
  assert.match(help.stdout, /show/);
  assert.match(help.stdout, /set/);
  assert.equal(help.stderr, "");
  for (const args of [
    ["settings", "unknown"],
    ["settings", "set", "--theme"],
    ["settings", "set", "--reset"],
    ["settings", "set", "--model", "x"],
    ["settings", "show", "extra"],
  ]) {
    const result = await f.run(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown-|missing-|unexpected-argument/);
    assert.equal(result.stdout, "");
  }
});
