import assert from "node:assert/strict";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  type HarnessTurn,
  type TurnRequest,
} from "../../src/harness/harness.js";
import {
  createProcessAdapter,
  type ChildFact,
} from "../../src/process/process.js";
import { openRunGroup } from "../../src/run/store/store.js";
import { installReplayer } from "../harness/replayer.js";
import { installSyntheticCodexReplayer } from "../harness/codex-replayer.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { stage, withRunnerObserver } from "../helpers/standalone.js";
import type { RunnerCase } from "../helpers/scenario-runner.js";
import { observeLifetime } from "./windows-contained-native.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const worker = fileURLToPath(
  new URL("./windows-contained-worker.ts", import.meta.url),
);
const ownerWorker = fileURLToPath(
  new URL("./windows-harness-owner.ts", import.meta.url),
);
const fixtures = fileURLToPath(
  new URL(
    "../harness/fixtures/claude-code/interrupt-recovery",
    import.meta.url,
  ),
);
const treeSchema = z.object({
  runtimePid: z.number().int().positive(),
  harnessPid: z.number().int().positive(),
  pids: z.array(z.number().int().positive()).length(2),
});
function holders(report: string) {
  const tree = treeSchema.parse(JSON.parse(readFileSync(report, "utf8")));
  return [tree.runtimePid, tree.harnessPid, ...tree.pids].map(observeLifetime);
}
function request(session: string, resume?: TurnRequest["resume"]): TurnRequest {
  return {
    session,
    origin: "human",
    correlationKey: { opaque: session },
    input: { text: "continue" },
    ...(resume ? { resume } : {}),
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  };
}
async function ready(
  turn: HarnessTurn,
  report: string,
  harness: "claude-code" | "codex",
): Promise<void> {
  await new Promise<void>((resolve) =>
    turn.subscribe((event) => {
      if (
        (harness === "claude-code" && event.kind === "session") ||
        (harness === "codex" && event.kind === "model")
      )
        resolve();
    }),
  );
  treeSchema.parse(JSON.parse(readFileSync(report, "utf8")));
}
function claudeTree(confirmed: boolean) {
  const directory = makeTempDir("w-harness-");
  cpSync(fixtures, directory, { recursive: true });
  const report = join(directory, "tree.json");
  const replay = JSON.parse(readFileSync(join(directory, "case.json"), "utf8"));
  replay.turns[0].backgroundTree = { worker, report };
  if (!confirmed) delete replay.turns[0].steps[1].control.emit;
  writeFileSync(join(directory, "case.json"), JSON.stringify(replay));
  return {
    installed: installReplayer("2.1.288 (Claude Code)", directory),
    report,
  };
}
export function registerWindowsHarnessCases(
  register: (test: RunnerCase) => void,
): void {
  if (process.platform !== "win32") return;
  for (const harness of ["claude-code", "codex"] as const)
    for (const confirmed of [true, false])
      register({
        name: `windows-${harness}-${confirmed ? "confirmed" : "unconfirmed"}-interrupt-tree-recovery`,
        body: () => interruptTree(harness, confirmed),
      });
}
export async function interruptTree(
  harness: "claude-code" | "codex",
  confirmed = true,
): Promise<void> {
  const facts: ChildFact[] = [];
  const runtime = createProcessAdapter(
    withRunnerObserver({ observeChild: (fact) => facts.push(fact) }),
  );
  const workspace = makeTempDir("w-harness-ws-");
  const claude = harness === "claude-code" ? claudeTree(confirmed) : undefined;
  const codex =
    harness === "codex" ? installSyntheticCodexReplayer() : undefined;
  const report = claude?.report ?? join(makeTempDir("w-tree-"), "tree.json");
  codex?.configureTurn({
    withholdTerminal: true,
    completedTurnsBeforeBlock: 2,
    completeAfterResume: true,
    ...(confirmed ? { interruptTerminal: "interrupted" } : {}),
    backgroundTree: { worker, report },
  });
  const adapter = claude
    ? createClaudeCodeAdapter({
        path: claude.installed.path,
        env: {},
        sessionId: () => id,
        controlTimeoutMs: confirmed ? 5000 : 500,
      })
    : createCodexAdapter({
        path: codex!.path,
        env: {},
        controlTimeoutMs: confirmed ? 5000 : 500,
      });
  const prepared = await adapter.prepare({ workspace, process: runtime });
  assert.ok(prepared.ok);
  if (codex)
    for (const session of ["one", "two"])
      assert.equal(
        (await prepared.harness.startTurn(request(session)).result()).kind,
        "completed",
      );
  const turn = prepared.harness.startTurn(request("one"));
  await stage("Harness tool descendants ready", () =>
    ready(turn, report, harness),
  );
  const observed = holders(report);
  try {
    assert.ok(observed.every((holder) => holder.alive()));
    await turn.interrupt();
    const result = await stage("native confirmation then whole-tree reap", () =>
      turn.result(),
    );
    assert.equal(result.kind, confirmed ? "interrupted" : "lost");
    assert.ok(
      observed.every((holder) => !holder.alive()),
      "every retained handle must signal before the Turn result",
    );
    assert.ok(
      facts.some(
        (fact) =>
          fact.kind === "spawn" &&
          fact.role === "harness-runtime" &&
          fact.containment === "contained",
      ),
    );
    if (result.kind !== "interrupted" && result.kind !== "lost")
      throw new Error("unreachable");
    assert.equal(result.detail.session.state, "detached");
    if (result.detail.session.state !== "detached")
      throw new Error("unreachable");
    if (!confirmed && result.kind === "lost")
      assert.equal(result.detail.failure?.category, "interruption-unknown");
    for (const session of codex ? ["two", "one"] : ["one"])
      assert.equal(
        (
          await prepared.harness
            .startTurn(
              request(
                session,
                session === "one"
                  ? result.detail.session.coordinate
                  : undefined,
              ),
            )
            .result()
        ).kind,
        "completed",
      );
    if (claude) {
      const launches = claude.installed
        .invocations()
        .filter((launch) => launch.args.includes("-p"));
      assert.equal(launches.length, 2);
      assert.ok(launches[1]?.args.includes("--resume"));
      assert.ok(launches[1]?.args.includes(id));
      assert.equal(launches[1]?.args.includes("--session-id"), false);
    } else {
      const servers = codex!
        .invocations()
        .filter((launch) => launch.args.join(" ") === "app-server");
      assert.equal(servers.length, 2);
      const frames = servers[1]!.stdinLines.map((line) => JSON.parse(line));
      assert.deepEqual(
        frames
          .filter((frame) => frame.method === "thread/resume")
          .map((frame) => frame.params.threadId),
        ["thread-2", "thread-1"],
      );
      assert.equal(
        frames.some((frame) => frame.method === "thread/start"),
        false,
      );
    }
  } finally {
    for (const holder of observed) holder.close();
    await prepared.harness.close();
  }
}
export async function harnessOwnerDeathRecovery(): Promise<void> {
  const runtime = createProcessAdapter(withRunnerObserver());
  const { installed, report } = claudeTree(true);
  const home = makeTempDir("w-owner-home-");
  const workspace = makeTempDir("w-owner-ws-");
  const owner = await runtime.spawnOwnedProcess({
    role: "command",
    executable: process.execPath,
    args: [ownerWorker, home, workspace, installed.path],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5000,
  });
  assert.ok(owner.ok);
  let output = "";
  for await (const bytes of owner.process.stdout) {
    output += new TextDecoder().decode(bytes);
    if (output.includes("ready\n")) break;
  }
  assert.match(output, /ready/);
  const observed = holders(report);
  try {
    await owner.process.interrupt(5000);
    assert.ok(
      observed.every((holder) => !holder.alive()),
      "owner death must reap every contained Harness descendant",
    );
    const group = openRunGroup(home, workspace, { process: runtime });
    try {
      const run = group.listRuns()[0];
      assert.ok(run);
      assert.equal(group.resumeRun(run.runId).outcome, "resumed");
      const reopened = group.acquireRun(run.runId);
      assert.ok(reopened);
      try {
        const coordinate = reopened.harnessSessions()[0]?.availabilityDetail;
        assert.equal(coordinate, id);
        const prepared = await createClaudeCodeAdapter({
          path: installed.path,
          env: {},
        }).prepare({ workspace, process: runtime });
        assert.ok(prepared.ok);
        try {
          assert.equal(
            (
              await prepared.harness
                .startTurn(request("planning", { opaque: coordinate! }))
                .result()
            ).kind,
            "completed",
          );
        } finally {
          await prepared.harness.close();
        }
        const launches = installed
          .invocations()
          .filter((launch) => launch.args.includes("-p"));
        assert.equal(launches.length, 2);
        assert.ok(launches[1]?.args.includes("--resume"));
        assert.ok(launches[1]?.args.includes(id));
        assert.equal(launches[1]?.args.includes("--session-id"), false);
      } finally {
        reopened.close();
      }
    } finally {
      group.close();
    }
  } finally {
    for (const holder of observed) holder.close();
    await owner.process.interrupt(5000);
  }
}
