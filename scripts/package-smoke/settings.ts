import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** Copied-binary acceptance, using unapproved directories and a fresh home. */
export async function settingsConsumer(
  binary: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const home = env.SECANT_HOME;
  assert.ok(home);
  const otherWorkspace = join(root, "settings-other-workspace");
  mkdirSync(otherWorkspace);
  function invoke(args: string[], expected = 0, cwd = root) {
    const result = spawnSync(binary, ["settings", ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      expected,
      `${args.join(" ")}: ${result.stdout}${result.stderr}`,
    );
    assert.equal(
      (result.stdout + result.stderr).includes(String.fromCharCode(27)),
      false,
    );
    return result;
  }
  function show(theme: string, appearance: string, cwd = root) {
    const result = invoke(["show", "--json"], 0, cwd);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { theme, appearance });
  }
  show("everforest", "dark");
  assert.equal(
    invoke(["show"]).stdout,
    "Theme: everforest\nAppearance: dark\n",
  );
  assert.match(invoke([]).stdout, /show[\s\S]*set/);
  const database = new Database(join(home, "catalog.db"));
  try {
    const encoded = '{ "model": "gpt-5", "effort": "high" }';
    database
      .prepare("INSERT INTO preferences (key,value) VALUES (?,?)")
      .run("last-model-choice:codex", encoded);
    const paired = invoke([
      "set",
      "--theme",
      "nord",
      "--appearance",
      "light",
      "--json",
    ]);
    assert.equal(paired.stderr, "");
    const receipt = JSON.parse(paired.stdout);
    assert.match(receipt.operationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(receipt, {
      family: "operation",
      operationId: receipt.operationId,
      outcome: { status: "applied" },
      preferencesChange: { theme: "nord", appearance: "light" },
    });
    show("nord", "light", otherWorkspace);
    assert.equal(
      invoke(["set", "--theme", "ayu"]).stdout,
      "Theme: ayu\nAppearance: light\n",
    );
    assert.deepEqual(
      JSON.parse(invoke(["set", "--appearance", "dark", "--json"]).stdout)
        .preferencesChange,
      { theme: "ayu", appearance: "dark" },
    );
    show("ayu", "dark");
    for (const args of [
      [],
      ["--theme", ""],
      ["--theme", "Nord"],
      ["--theme", "custom"],
      ["--appearance", "LIGHT"],
      ["--appearance", ""],
      ["--theme", "nord", "--appearance", "bad"],
    ]) {
      const refusal = invoke(["set", ...args, "--json"], 1);
      assert.equal(refusal.stderr, "");
      assert.equal(JSON.parse(refusal.stdout).code, "invalid-preferences");
      show("ayu", "dark");
    }
    const textRefusal = invoke(["set", "--theme", "bad"], 1);
    assert.equal(textRefusal.stdout, "");
    assert.match(textRefusal.stderr, /invalid-preferences/);
    const model = database
      .prepare("SELECT value FROM preferences WHERE key = ?")
      .get("last-model-choice:codex");
    assert.deepEqual(model, { value: encoded });
    assert.deepEqual(
      database
        .prepare("SELECT count(*) AS count FROM workspace_approvals")
        .get(),
      { count: 0 },
    );
    database.exec(
      "CREATE TRIGGER fail_settings BEFORE UPDATE ON preferences WHEN NEW.key = 'appearance' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const failed = JSON.parse(
      invoke(["set", "--theme", "nord", "--appearance", "light", "--json"], 1)
        .stdout,
    );
    assert.equal(failed.outcome.status, "not-applied");
    assert.equal(failed.outcome.problem.possibleEffects, "none");
    assert.equal(failed.preferencesChange, undefined);
    show("ayu", "dark");
    database.exec("DROP TRIGGER fail_settings; DROP TABLE preferences");
    const fallback = invoke(["show", "--json"]);
    assert.deepEqual(JSON.parse(fallback.stdout), {
      theme: "everforest",
      appearance: "dark",
    });
    assert.match(fallback.stderr, /preferences-read-failed/);
  } finally {
    database.close();
  }
}
