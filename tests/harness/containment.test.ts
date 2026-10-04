import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createCodexAdapter,
  type HarnessContainmentObserver,
  type HarnessPhaseFact,
  type HarnessTurn,
  type TurnRequest,
} from "../../src/harness/harness.js";
import type {
  ProcessAdapter,
  ProcessLaunchContainment,
} from "../../src/process/process.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The recorded qualification replies are delivered only after their request,
// through an in-process owned child. No external Harness or process runs.
function codexProcess(
  containment: ProcessLaunchContainment | undefined,
  options: {
    readonly interrupt?: "confirm" | "ack-only" | "refuse";
    readonly complete?: boolean;
    readonly closeStatus?: number;
  } = {},
): ProcessAdapter {
  const fixture = join(
    import.meta.dirname,
    "fixtures/codex/codex-qualification",
  );
  const recording: { traffic: { direction: string; line: string }[] } =
    JSON.parse(readFileSync(join(fixture, "case.json"), "utf8"));
  const replies = recording.traffic
    .filter((frame) => frame.direction === "stdout")
    .map((frame) => frame.line);
  return createFakeProcess({
    resolutionHandler: () => ({
      kind: "found",
      executable: process.execPath,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      if (options.args.includes("generate-json-schema")) {
        const directory = options.args[options.args.indexOf("--out") + 1];
        assert.ok(directory);
        copyFileSync(
          join(fixture, "stable-schema.generated.json"),
          join(directory, "codex_app_server_protocol.schemas.json"),
        );
      }
      return {
        kind: "exited",
        status: 0,
        text: new TextEncoder().encode("codex-cli 0.160.0"),
      };
    },
    ownedProcesses: Array.from({ length: 3 }, () => {
      let threadNumber = 0;
      let threadId = "";
      let turnId = "";
      return {
        kind: "launched",
        containment: containment?.kind,
        containmentCause:
          containment?.kind === "fallback" ? containment.cause : undefined,
        emissions: [
          {
            kind: "terminal",
            trigger: "close-stdin",
            close: { kind: "exited", status: options.closeStatus ?? 0 },
          },
        ],
        stdinReplies: (bytes) => {
          const request: {
            id?: number;
            method?: string;
            params?: { threadId?: string };
          } = JSON.parse(new TextDecoder().decode(bytes));
          if (request.id === undefined) return [];
          const messages: unknown[] = [];
          const reply = (result: unknown) =>
            messages.push({ id: request.id, result });
          const terminal = (status: string) =>
            messages.push({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status, items: [], error: null },
              },
            });
          switch (request.method) {
            case "thread/start":
              threadId = `thread-${++threadNumber}`;
              reply({ thread: { id: threadId } });
              break;
            case "thread/resume":
              threadId = request.params?.threadId ?? "";
              reply({ thread: { id: threadId } });
              break;
            case "turn/start":
              threadId = request.params?.threadId ?? "";
              turnId = "turn-1";
              reply({ turn: { id: turnId } });
              if (options.complete) terminal("completed");
              break;
            case "thread/read":
              reply({ thread: { id: threadId } });
              break;
            case "turn/interrupt":
              if (options.interrupt === "refuse")
                messages.push({
                  id: request.id,
                  error: { code: -32600, message: "not now" },
                });
              else {
                reply({});
                if (options.interrupt !== "ack-only") terminal("interrupted");
              }
              break;
            default:
              break;
          }
          if (messages.length > 0)
            return [
              {
                kind: "stdout",
                bytes: new TextEncoder().encode(
                  messages
                    .map((message) => JSON.stringify(message) + "\n")
                    .join(""),
                ),
              },
            ];
          const recordedReply = replies.find(
            (line) => JSON.parse(line).id === request.id,
          );
          assert.ok(recordedReply, `recorded reply for ${request.id}`);
          return [
            { kind: "stdout", bytes: new TextEncoder().encode(recordedReply) },
          ];
        },
      } as const;
    }),
  });
}

for (const kind of ["contained", "fallback", undefined] as const) {
  test(`Codex reports ${kind ?? "no Windows"} evidence at prepare without native causes`, async (t) => {
    const facts: Parameters<HarnessContainmentObserver>[0][] = [];
    const containment =
      kind === undefined
        ? undefined
        : kind === "contained"
          ? { kind }
          : { kind, cause: new Error("forced job acquisition failure") };
    const prepared = await createCodexAdapter({ env: {} }).prepare({
      workspace: makeTempDir("secant-containment-ws-"),
      process: codexProcess(containment),
      containment: (fact) => facts.push(fact),
    });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    t.after(() => prepared.harness.close());
    assert.deepEqual(facts, kind === undefined ? [] : [{ kind }]);
  });
}

test("a throwing containment observer cannot fail Codex preparation", async (t) => {
  const prepared = await createCodexAdapter({ env: {} }).prepare({
    workspace: makeTempDir("secant-containment-ws-"),
    process: codexProcess({
      kind: "fallback",
      cause: new Error("forced failure"),
    }),
    containment: () => {
      throw new Error("observer failure");
    },
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  t.after(() => prepared.harness.close());
});

function request(session: string): TurnRequest {
  return {
    session,
    origin: "managed",
    correlationKey: { opaque: session },
    input: { text: "go" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  };
}
function sessionOpen(turn: HarnessTurn): Promise<void> {
  return new Promise((resolve) =>
    turn.subscribe((event) => {
      if (event.kind === "session") resolve();
    }),
  );
}
for (const kind of ["contained", "fallback"] as const) {
  test(`Codex ${kind} confirmation ends its shared generation and resumes each thread`, async () => {
    const runtimeOptions = { complete: true, closeStatus: 9 };
    const runtime = codexProcess(
      kind === "contained"
        ? { kind }
        : { kind, cause: new Error("unavailable") },
      runtimeOptions,
    );
    const phases: HarnessPhaseFact[] = [];
    const frames: string[] = [];
    let launches = 0;
    const adapter: ProcessAdapter = {
      resolveExecutable: (name, opts) => runtime.resolveExecutable(name, opts),
      spawnCommand: (opts) => runtime.spawnCommand(opts),
      spawnCommandSync: (opts) => runtime.spawnCommandSync(opts),
      spawnOwnedProcess: async (options) => {
        launches += 1;
        const spawned = await runtime.spawnOwnedProcess(options);
        if (!spawned.ok) return spawned;
        const owned = spawned.process;
        return {
          ...spawned,
          process: {
            stdout: owned.stdout,
            stderr: owned.stderr,
            closeStdin: (ms) => owned.closeStdin(ms),
            interrupt: (ms) => owned.interrupt(ms),
            closed: () => owned.closed(),
            writeStdin: (bytes) => {
              frames.push(new TextDecoder().decode(bytes));
              return owned.writeStdin(bytes);
            },
          },
        };
      },
    };
    const prepared = await createCodexAdapter({ env: {} }).prepare({
      workspace: makeTempDir("secant-codex-stop-"),
      process: adapter,
      phases: (fact) => phases.push(fact),
    });
    assert.ok(prepared.ok);
    for (const session of ["one", "two"]) {
      assert.equal(
        (await prepared.harness.startTurn(request(session)).result()).kind,
        "completed",
      );
    }
    runtimeOptions.complete = false;
    const turn = prepared.harness.startTurn(request("one"));
    await sessionOpen(turn);
    assert.equal((await turn.interrupt()).outcome, "accepted");
    const result = await turn.result();
    assert.equal(result.kind, "interrupted");
    if (result.kind !== "interrupted") throw new Error("unreachable");
    assert.equal(result.detail.interruption.mode, "active-turn");
    runtimeOptions.complete = true;
    for (const session of ["two", "one"]) {
      assert.equal(
        (await prepared.harness.startTurn(request(session)).result()).kind,
        "completed",
      );
    }
    assert.equal(launches, 2);
    const resumes = frames
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.method === "thread/resume");
    assert.deepEqual(
      resumes.map((frame) => frame.params.threadId),
      ["thread-2", "thread-1"],
    );
    assert.ok(
      phases.some(
        (fact) =>
          fact.kind === "phase-end" &&
          fact.phase === "cleanup" &&
          fact.session === "one" &&
          fact.outcome === "ok",
      ),
    );
    assert.equal((await prepared.harness.close()).clean, false);
  });
}

test("a Windows Codex interrupt acknowledged without a terminal reaps and settles lost within its control bound", async () => {
  const prepared = await createCodexAdapter({
    env: {},
    controlTimeoutMs: 20,
  }).prepare({
    workspace: makeTempDir("secant-codex-unknown-"),
    process: codexProcess({ kind: "contained" }, { interrupt: "ack-only" }),
  });
  assert.ok(prepared.ok);
  const turn = prepared.harness.startTurn(request("one"));
  await sessionOpen(turn);
  assert.equal((await turn.interrupt()).outcome, "accepted");
  const result = await turn.result();
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  await prepared.harness.close();
});
