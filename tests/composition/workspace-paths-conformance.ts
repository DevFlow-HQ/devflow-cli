import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { wireApplication } from "../../src/composition/main.js";
import {
  createProcessAdapter,
  type ProcessAdapter,
} from "../../src/process/process.js";
import { stage, withRunnerObserver } from "../helpers/standalone.js";
import { makeTempDir } from "../helpers/tempDir.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";

/** Real ignore engines and links belong in the supervised standalone layer. */
export function registerWorkspacePathCases(
  register: (test: RunnerCase) => void,
): void {
  register({
    name: "m10-audit-token-ripgrep-listing: real non-Git ignores, hidden paths and symlinks",
    body: nonGit,
  });
  register({
    name: "m10-audit-token-ripgrep-listing: real parent/global/exclude rules, linked worktrees and submodules",
    body: gitWorkspaces,
  });
}

function fixture() {
  const root = makeTempDir("rg-");
  const config = join(root, "config");
  mkdirSync(join(config, "git"), { recursive: true });
  writeFileSync(join(config, "git", "ignore"), "global-ignored.txt\n");
  const hostileConfig = join(root, "rg-config");
  writeFileSync(hostileConfig, "--follow\n--no-ignore\n");
  const real = createProcessAdapter(withRunnerObserver());
  const spawns: Parameters<ProcessAdapter["spawnOwnedProcess"]>[0][] = [];
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) => real.resolveExecutable(name, options),
    spawnCommand: (options) => real.spawnCommand(options),
    spawnCommandSync: (options) => real.spawnCommandSync(options),
    spawnOwnedProcess: (options) => {
      spawns.push(options);
      return real.spawnOwnedProcess({
        ...options,
        env: {
          ...options.env,
          XDG_CONFIG_HOME: config,
          RIPGREP_CONFIG_PATH: hostileConfig,
        },
      });
    },
  };
  const git = (cwd: string, args: string[]) =>
    stage(`git ${args[0]}`, () => {
      const result = real.spawnCommandSync({
        role: "git",
        executable: "git",
        args: [
          "-c",
          "user.name=Secant Test",
          "-c",
          "user.email=secant@example.invalid",
          ...args,
        ],
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "no-gitconfig"),
        },
        maxBufferBytes: 1024 * 1024,
      });
      assert.equal(result.kind, "exited");
      if (result.kind === "exited")
        assert.equal(result.status, 0, Buffer.from(result.stderr).toString());
    });
  const search = async (workspace: string) => {
    const wired = wireApplication({
      launchCwd: workspace,
      secantHome: join(root, "state"),
      process: processAdapter,
    });
    try {
      const run = wired.runGroup.createRun({
        operationId: `paths-${workspace}`,
        bundleSnapshotDigest: "sha256:paths",
        launch: {},
        at: new Date(),
      });
      const controller = new AbortController();
      const query = async (text: string) => {
        const result = await stage(`path query ${text}`, () =>
          wired.projectionPort.searchWorkspacePaths({
            runId: run.runId,
            query: text,
            signal: controller.signal,
          }),
        );
        assert.equal(
          result.status,
          "available",
          result.status === "unavailable" ? String(result.cause) : "",
        );
        return result.status === "available" ? result.candidates : [];
      };
      return {
        query,
        close: async () => {
          controller.abort();
          await wired.close();
        },
      };
    } catch (cause) {
      await wired.close();
      throw cause;
    }
  };
  return { root, git, search, spawns };
}

async function nonGit() {
  const { root, search, spawns } = fixture();
  const workspace = join(root, "w");
  mkdirSync(workspace);
  for (const folder of ["src", ".hidden", "ignored", "empty", "src/.git"])
    mkdirSync(join(workspace, folder));
  writeFileSync(
    join(workspace, ".gitignore"),
    "*.tmp\n!keep.tmp\nignored/\nignore-me.txt\n",
  );
  writeFileSync(join(workspace, ".ignore"), "!ignore-me.txt\nprecedence.txt\n");
  writeFileSync(join(workspace, ".rgignore"), "!precedence.txt\n");
  writeFileSync(
    join(workspace, "src", ".gitignore"),
    "!nested.tmp\nsecret.txt\n",
  );
  for (const name of [
    "visible.ts",
    "ignore-me.txt",
    "precedence.txt",
    "keep.tmp",
    "drop.tmp",
    "src/nested.tmp",
    "src/secret.txt",
    ".hidden/config",
    "ignored/a",
    "src/.git/internal",
  ])
    writeFileSync(join(workspace, name), "never read contents");
  symlinkSync(
    join(workspace, "src"),
    join(workspace, "inside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    root,
    join(workspace, "outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  if (process.platform !== "win32")
    symlinkSync(join(workspace, "visible.ts"), join(workspace, "file-link"));
  const paths = await search(workspace);
  try {
    assert.deepEqual(await paths.query(""), [
      { path: "src", kind: "folder" },
      { path: "ignore-me.txt", kind: "file" },
      { path: "keep.tmp", kind: "file" },
      { path: "precedence.txt", kind: "file" },
      { path: "visible.ts", kind: "file" },
    ]);
    assert.equal(spawns[0]?.args.includes("--no-require-git"), true);
    assert.deepEqual(await paths.query("nested"), [
      { path: "src/nested.tmp", kind: "file" },
    ]);
    assert.deepEqual(await paths.query(".hidden/"), [
      { path: ".hidden", kind: "folder" },
      { path: ".hidden/config", kind: "file" },
    ]);
    for (const query of [
      "secret",
      "ignored",
      "empty",
      "inside",
      "outside",
      "file-link",
      "src/.git/internal",
    ])
      assert.deepEqual(await paths.query(query), []);
    writeFileSync(join(workspace, "fresh.ts"), "");
    assert.deepEqual(await paths.query("fresh"), []);
  } finally {
    await paths.close();
  }
  const fresh = await search(workspace);
  try {
    assert.deepEqual(await fresh.query("fresh"), [
      { path: "fresh.ts", kind: "file" },
    ]);
  } finally {
    await fresh.close();
  }
}

async function gitWorkspaces() {
  const { root, git, search } = fixture();
  const parent = join(root, "parent");
  mkdirSync(parent);
  git(parent, ["init"]);
  writeFileSync(join(parent, ".gitignore"), "parent-ignored.txt\n");
  writeFileSync(join(parent, "base.ts"), "");
  git(parent, ["add", "."]);
  git(parent, ["commit", "-m", "fixture"]);
  writeFileSync(join(parent, ".git", "info", "exclude"), "info-ignored.txt\n");
  const nested = join(parent, "nested");
  mkdirSync(nested);
  for (const name of [
    "parent-ignored.txt",
    "info-ignored.txt",
    "global-ignored.txt",
    "visible.ts",
  ])
    writeFileSync(join(nested, name), "");
  const linked = join(root, "linked");
  git(parent, ["worktree", "add", "--detach", linked, "HEAD"]);
  for (const name of [
    "parent-ignored.txt",
    "info-ignored.txt",
    "global-ignored.txt",
    "visible.ts",
  ])
    writeFileSync(join(linked, name), "");
  const module = join(root, "module");
  mkdirSync(module);
  git(module, ["init"]);
  writeFileSync(join(module, "module.ts"), "");
  git(module, ["add", "."]);
  git(module, ["commit", "-m", "module fixture"]);
  git(linked, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    module,
    "module",
  ]);
  for (const workspace of [nested, linked]) {
    const paths = await search(workspace);
    try {
      assert.deepEqual(await paths.query("ignored"), [], workspace);
      assert.deepEqual(await paths.query("visible"), [
        { path: "visible.ts", kind: "file" },
      ]);
      assert.deepEqual(await paths.query(".git/internal"), []);
      if (workspace === linked)
        assert.deepEqual(await paths.query("module.ts"), [
          { path: "module/module.ts", kind: "file" },
        ]);
    } finally {
      await paths.close();
    }
  }
}
