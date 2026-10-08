import { z } from "zod";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openCatalog } from "../../src/catalog/catalog.js";
import { openRunGroup } from "../../src/run/store/store.js";
import { createProcessAdapter } from "../../src/process/process.js";
import { ripgrepInput } from "../embedded-ripgrep.js";
import { TARGETS, hostTargetKey } from "../targets.js";

/** The copied production executable, with neither runtime nor rg on PATH. */
export async function embeddedRipgrepConsumer(
  binary: string,
  root: string,
  inherited: NodeJS.ProcessEnv,
): Promise<void> {
  const workspace = join(root, "rgw"),
    home = join(root, "rgh"),
    emptyPath = join(root, "rgp");
  for (const path of [workspace, home, emptyPath]) mkdirSync(path);
  mkdirSync(join(workspace, "src"));
  mkdirSync(join(workspace, "ignored"));
  mkdirSync(join(workspace, "empty"));
  mkdirSync(join(workspace, ".hidden"));
  writeFileSync(join(workspace, ".gitignore"), "ignored/\n");
  writeFileSync(
    join(workspace, "src", "needle.ts"),
    "candidate contents stay unread",
  );
  writeFileSync(join(workspace, "ignored", "needle.ts"), "");
  writeFileSync(join(workspace, ".hidden", "config"), "");
  const cwd = realpathSync.native(workspace);
  const catalog = openCatalog(home);
  catalog.close();
  const group = openRunGroup(home, cwd, { process: createProcessAdapter() });
  let runId: string;
  try {
    runId = group.createRun({
      operationId: "compiled-paths",
      bundleSnapshotDigest: "sha256:paths",
      launch: {},
      at: new Date(),
    }).runId;
  } finally {
    group.close();
  }
  const env = { ...inherited, SECANT_HOME: home, PATH: emptyPath };
  const helpers = join(home, "helpers");
  assert.equal(existsSync(helpers), false);
  // Launch both before awaiting either. This is the Windows publication and
  // execution case as well as the POSIX case; neither process may clobber bytes.
  const replies = await Promise.allSettled([query("needle"), query("needle")]);
  for (const reply of replies) {
    if (reply.status === "rejected") throw reply.reason;
    assert.deepEqual(reply.value, {
      status: "available",
      candidates: [{ path: "src/needle.ts", kind: "file" }],
    });
  }
  const members = readdirSync(helpers);
  assert.equal(members.length, 1, "publication leaves no temporary helper");
  const helper = join(helpers, members[0]!);
  assert.match(members[0]!, /^rg-15\.1\.0-[a-f0-9]{16}(\.exe)?$/);
  const target = hostTargetKey(process.platform, process.arch);
  assert.ok(target);
  const pin = ripgrepInput(TARGETS[target]);
  assert.equal(
    createHash("sha256").update(readFileSync(helper)).digest("hex"),
    pin.memberSha256,
  );
  const before = statSync(helper);
  assert.deepEqual(await query(".hidden/"), {
    status: "available",
    candidates: [
      { path: ".hidden", kind: "folder" },
      { path: ".hidden/config", kind: "file" },
    ],
  });
  assert.deepEqual(await query("empty"), {
    status: "available",
    candidates: [],
  });
  assert.equal(
    statSync(helper).mtimeMs,
    before.mtimeMs,
    "reuse never replaces or rewrites the executable",
  );
  // A separate home tests pre-existing corrupt bytes without writing an
  // executable that the OS may still hold after a completed query.
  const damagedHome = join(root, "rgc");
  cpSync(home, damagedHome, { recursive: true });
  writeFileSync(join(damagedHome, "helpers", members[0]!), "unverified bytes");
  const damagedEnv = { ...env, SECANT_HOME: damagedHome };
  const refused = sync(["run", "paths", runId, "--json"], damagedEnv);
  assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
  const problem = JSON.parse(refused.stdout);
  assert.equal(problem.code, "workspace-path-search-unavailable");
  assert.equal("cause" in problem, false);
  assert.equal(
    sync(["settings", "show", "--json"], damagedEnv).status,
    0,
    "helper corruption never prevents ordinary shell use",
  );
  await cappedListing();

  // Past the cap the helper still has megabytes to write, so the listing must
  // stop a live helper and still answer from the first 100,000 records.
  async function cappedListing(): Promise<void> {
    const large = join(root, "rgl"),
      logs = join(root, "rgo");
    mkdirSync(large);
    mkdirSync(logs);
    const stem = "p".repeat(140);
    for (let folder = 0; folder < 11; folder++) {
      const directory = join(large, `d${String(folder).padStart(2, "0")}`);
      mkdirSync(directory);
      for (let file = 0; file < 10_000; file++)
        writeFileSync(
          join(directory, `${stem}${String(file).padStart(5, "0")}.ts`),
          "",
        );
    }
    const largeCwd = realpathSync.native(large);
    const largeGroup = openRunGroup(home, largeCwd, {
      process: createProcessAdapter(),
    });
    let largeRunId: string;
    try {
      largeRunId = largeGroup.createRun({
        operationId: "compiled-paths-capped",
        bundleSnapshotDigest: "sha256:paths",
        launch: {},
        at: new Date(),
      }).runId;
    } finally {
      largeGroup.close();
    }
    const reply = await query(".ts", {
      cwd: largeCwd,
      run: largeRunId,
      environment: { ...env, SECANT_LOG_DIR: logs },
    });
    const { candidates, ...rest } = z
      .object({
        candidates: z.array(z.object({ path: z.string(), kind: z.string() })),
      })
      .passthrough()
      .parse(reply);
    assert.deepEqual(rest, {
      status: "available",
      notice: "Large Workspace: only the first 100,000 files are searchable",
    });
    assert.equal(candidates.length, 10);
    for (const candidate of candidates) {
      assert.equal(candidate.kind, "file");
      assert.match(candidate.path, /^d(0\d|10)\/p{140}\d{5}\.ts$/);
    }
    const recordSchema = z.object({
      event: z.string(),
      childRole: z.string().optional(),
      childPid: z.number().int().optional(),
      signal: z.string().optional(),
    });
    const records = readdirSync(logs).flatMap((file) =>
      readFileSync(join(logs, file), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => recordSchema.parse(JSON.parse(line))),
    );
    const helperFacts = records.filter(
      (record) => record.childRole === "workspace-paths",
    );
    const pid = helperFacts[0]?.childPid;
    assert.ok(Number.isSafeInteger(pid), JSON.stringify(helperFacts));
    assert.ok(helperFacts.every((record) => record.childPid === pid));
    // Cancellation is recorded only for a live child; the reap proves it ended.
    assert.deepEqual(
      helperFacts.map((record) => record.event),
      process.platform === "win32"
        ? [
            "child-spawn",
            "child-cancellation",
            "child-kill-escalation",
            "child-reap",
          ]
        : ["child-spawn", "child-cancellation", "child-reap"],
    );
    if (process.platform !== "win32")
      assert.equal(helperFacts.at(-1)?.signal, "SIGTERM");
  }

  function sync(args: string[], environment = env) {
    const result = spawnSync(binary, args, {
      cwd,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    return result;
  }
  function query(
    text: string,
    target: {
      cwd: string;
      run: string;
      environment: NodeJS.ProcessEnv;
    } = { cwd, run: runId, environment: env },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        ["run", "paths", target.run, text, "--json"],
        {
          cwd: target.cwd,
          env: target.environment,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        stdout += text;
      });
      child.stderr.on("data", (text) => {
        stderr += text;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(`compiled path query exited ${code}: ${stdout}${stderr}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (cause) {
          reject(cause);
        }
      });
    });
  }
}
