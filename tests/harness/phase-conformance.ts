// Native-phase conformance (#322): both native Adapters, over their recorded and
// synthetic replayers, attach the phase observer and report launch, handshake,
// control, recovery, and cleanup facts, each start settled once and keyed by the
// normalized Harness Session key where the phase is bound to one. No fact carries
// a raw frame or a launch argument. Like the other replayer cases this spawns, so
// it runs in the standalone runtime-conformance runner, never under `bun test`.
// The fake's own phase facts are what the composition suite reads instead.

import assert from "node:assert/strict";
import {
  translateCause,
  type HarnessFailure,
  type CleanupReport,
  type HarnessPhaseFact,
  type HarnessPhaseObserver,
  type HarnessTurn,
  type PreparedHarness,
  type RecoveryCoordinate,
  type TurnRequest,
} from "../../src/harness/harness.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../helpers/tempDir.js";
import { CODEX_RECORDING_INPUT } from "./codex-recording-cases.js";
import {
  installCodexReplayer,
  installSyntheticCodexReplayer,
  type InstalledCodexReplayer,
} from "./codex-replayer.js";
import type { RegisterConformanceCase } from "./conformance.js";
import { installReplayer } from "./replayer.js";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  type TestHarnessAdapter,
} from "./test-adapters.js";

const CLAUDE_VERSION = "2.1.234 (Claude Code)";
const SESSION = "planning";

const claudeCase = (name: string) =>
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "fixtures",
    "claude-code",
    name,
  );

/** The facts an observer collected, and the observer itself. */
function collector(): {
  readonly facts: HarnessPhaseFact[];
  readonly observer: HarnessPhaseObserver;
} {
  const facts: HarnessPhaseFact[] = [];
  return { facts, observer: (fact) => facts.push(fact) };
}

function turnRequest(
  options: {
    readonly text?: string;
    readonly resume?: RecoveryCoordinate;
  } = {},
): TurnRequest {
  return {
    session: SESSION,
    origin: "managed",
    correlationKey: { opaque: SESSION },
    input: { text: options.text ?? "do the thing" },
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  };
}

/** Prepare `adapter` with `observer` as this prepare's own phase observer. */
async function prepare(
  adapter: TestHarnessAdapter,
  observer: HarnessPhaseObserver,
): Promise<PreparedHarness> {
  const prepared = await adapter.prepare({
    workspace: makeTempDir("secant-phase-ws-"),
    phases: observer,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) throw new Error("unreachable");
  return prepared.harness;
}

/** Resolves once the Turn's Session is open, so an interrupt never races the
 *  replayer's startup signal handler. */
function sessionOpen(turn: HarnessTurn): Promise<void> {
  return new Promise((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "session") resolve();
    });
  });
}

/** One settlement as the assertions read it. */
type Settled = "ok" | "abandoned" | `failed:${string}`;

/** Each phase's settlements, in order, keyed by phase, step when the fact names
 *  a sub-step (#325), and Session (`-` when the phase is bound to none), after
 *  checking every start is settled exactly once, after it, with a
 *  whole-millisecond elapsed time. */
function settlements(
  facts: readonly HarnessPhaseFact[],
): Record<string, Settled[]> {
  const open = new Map<string, number>();
  const settled: Record<string, Settled[]> = {};
  for (const fact of facts) {
    const step = fact.step === undefined ? "" : `/${fact.step}`;
    const key = `${fact.phase}${step}@${fact.session ?? "-"}`;
    if (fact.kind === "phase-start") {
      open.set(key, (open.get(key) ?? 0) + 1);
      continue;
    }
    const starts = open.get(key) ?? 0;
    assert.ok(starts > 0, `${key} settled without a start`);
    open.set(key, starts - 1);
    assert.ok(Number.isInteger(fact.elapsedMs) && fact.elapsedMs >= 0);
    (settled[key] ??= []).push(
      fact.outcome === "failed"
        ? `failed:${fact.failure.phase}/${fact.failure.category}`
        : fact.outcome,
    );
  }
  for (const [key, starts] of open) {
    assert.equal(starts, 0, `${key} started without a settlement`);
  }
  return settled;
}

/** The facts as a record carries them, each failure's cause translated. */
function serialized(facts: readonly HarnessPhaseFact[]): string {
  return JSON.stringify(
    facts.map((fact) =>
      fact.kind === "phase-end" && fact.outcome === "failed"
        ? { ...fact, failure: withTranslatedCause(fact.failure) }
        : fact,
    ),
  );
}

function withTranslatedCause(failure: HarnessFailure) {
  return failure.cause === undefined
    ? failure
    : { ...failure, cause: translateCause(failure.cause) };
}

/** No launch argument the Adapter passed and no raw-frame marker appears in any
 *  fact. Short flags (`-p`) are skipped: they would match ordinary prose. */
function assertNoNativeDetail(
  facts: readonly HarnessPhaseFact[],
  launchArgs: readonly string[],
  frameMarkers: readonly string[],
): void {
  const text = serialized(facts);
  for (const arg of launchArgs.filter((value) => value.length >= 12)) {
    assert.equal(
      text.includes(arg),
      false,
      `a launch argument crossed: ${arg}`,
    );
  }
  for (const marker of frameMarkers) {
    assert.equal(
      text.includes(marker),
      false,
      `a raw frame crossed: ${marker}`,
    );
  }
}

const CLAUDE_FRAME_MARKERS = [
  "session_id",
  "subtype",
  "stream_event",
  "content_block",
  "control_request",
  "request_id",
];
const CODEX_FRAME_MARKERS = ["jsonrpc", '"method"', '"params"', "thread-1"];

export function registerHarnessPhaseConformance(
  register: RegisterConformanceCase,
): void {
  // --- Claude Code ------------------------------------------------------------

  register(
    "[claude-code phases] a fresh Turn launches and handshakes, a native interrupt is one ok control phase on every OS, and close is cleanup",
    async () => {
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const replayer = installReplayer(CLAUDE_VERSION, claudeCase("interrupt"));
      const { facts, observer } = collector();
      const prepared = await prepare(
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => id,
        }),
        observer,
      );
      // Qualification reports no phase: the version probe is not a protocol child.
      assert.deepEqual(facts, []);
      const turn = prepared.startTurn(turnRequest());
      await sessionOpen(turn);
      assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
      await turn.result();
      await prepared.close();
      await prepared.close();

      // The recorded native stop is confirmed, so no process stop follows.
      assert.deepEqual(settlements(facts), {
        [`launch@${SESSION}`]: ["ok"],
        [`handshake@${SESSION}`]: ["ok"],
        [`control@${SESSION}`]: ["ok"],
        "cleanup@-": ["ok"],
      });
      const launch = replayer
        .invocations()
        .find((invocation) => invocation.args.includes("-p"));
      assert.ok(launch);
      assert.ok(launch.args.includes(id));
      // The permission bridge's bearer, recovered from the launch's inline MCP
      // config, is its own needle: it must not appear even inside other text.
      const config = JSON.parse(
        launch.args[launch.args.indexOf("--mcp-config") + 1]!,
      );
      const bearer: string = config.mcpServers[
        "secant-permissions"
      ].headers.Authorization.replace("Bearer ", "");
      assert.ok(bearer.length >= 32);
      assertNoNativeDetail(facts, launch.args, [
        ...CLAUDE_FRAME_MARKERS,
        bearer,
      ]);
    },
  );

  register(
    "[claude-code phases] an observer that throws changes no Turn or cleanup outcome",
    async () => {
      const replayer = installReplayer(CLAUDE_VERSION, claudeCase("completed"));
      let calls = 0;
      const prepared = await prepare(
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => "11111111-1111-4111-8111-111111111111",
        }),
        () => {
          calls += 1;
          throw new Error("observer failure");
        },
      );
      const turn = prepared.startTurn(turnRequest());
      assert.equal((await turn.result()).kind, "completed");
      assert.equal((await prepared.close()).clean, true);
      // launch, handshake, and cleanup each reported a start and an end.
      assert.equal(calls, 6);
    },
  );

  register(
    "[claude-code phases] each Prepared Harness reports only through its own prepare's observer",
    async () => {
      const replayer = installReplayer(CLAUDE_VERSION, claudeCase("completed"));
      const adapter = createClaudeCodeAdapter({
        path: replayer.path,
        env: {},
        sessionId: () => "11111111-1111-4111-8111-111111111111",
      });
      const first = collector();
      const second = collector();
      // Both are prepared before either runs, so a fact routed to the latest
      // prepare's observer would land in the wrong collector.
      const preparedFirst = await prepare(adapter, first.observer);
      const preparedSecond = await prepare(adapter, second.observer);
      const each = {
        [`launch@${SESSION}`]: ["ok"],
        [`handshake@${SESSION}`]: ["ok"],
        "cleanup@-": ["ok"],
      };
      const firstTurn = preparedFirst.startTurn(turnRequest());
      assert.equal((await firstTurn.result()).kind, "completed");
      await preparedFirst.close();
      assert.deepEqual(settlements(first.facts), each);
      assert.deepEqual(second.facts, []);

      const secondTurn = preparedSecond.startTurn(turnRequest());
      assert.equal((await secondTurn.result()).kind, "completed");
      await preparedSecond.close();
      assert.deepEqual(settlements(second.facts), each);
      assert.equal(first.facts.length, 6);
    },
  );

  register(
    "[claude-code phases] a resumed launch's init is the recovery phase",
    async () => {
      const id = "55555555-5555-4555-8555-555555555555";
      const replayer = installReplayer(CLAUDE_VERSION, claudeCase("resume"));
      const { facts, observer } = collector();
      const prepared = await prepare(
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => id,
        }),
        observer,
      );
      const turn = prepared.startTurn(turnRequest({ resume: { opaque: id } }));
      assert.equal((await turn.result()).kind, "completed");
      await prepared.close();

      assert.deepEqual(settlements(facts), {
        [`launch@${SESSION}`]: ["ok"],
        [`recovery@${SESSION}`]: ["ok"],
        "cleanup@-": ["ok"],
      });
      const launch = replayer
        .invocations()
        .find((invocation) => invocation.args.includes("--resume"));
      assert.ok(launch);
      assertNoNativeDetail(facts, launch.args, CLAUDE_FRAME_MARKERS);
    },
  );

  register(
    "[claude-code phases] an unacknowledged resume fails the recovery phase with its typed failure",
    async () => {
      const id = "66666666-6666-4666-8666-666666666666";
      const replayer = installReplayer(
        CLAUDE_VERSION,
        claudeCase("resume-unacknowledged"),
      );
      const { facts, observer } = collector();
      const prepared = await prepare(
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => id,
        }),
        observer,
      );
      const turn = prepared.startTurn(turnRequest({ resume: { opaque: id } }));
      assert.equal((await turn.result()).kind, "failed");
      await prepared.close();

      const settled = settlements(facts);
      assert.deepEqual(settled[`recovery@${SESSION}`], [
        "failed:recovery/recovery-unacknowledged",
      ]);
      // The unacknowledged child is stopped through the control phase.
      assert.equal(settled[`control@${SESSION}`]?.length, 1);
      assert.deepEqual(settled[`launch@${SESSION}`], ["ok"]);
      assert.deepEqual(settled["cleanup@-"], ["ok"]);
      const launch = replayer
        .invocations()
        .find((invocation) => invocation.args.includes("--resume"));
      assert.ok(launch);
      assertNoNativeDetail(facts, launch.args, CLAUDE_FRAME_MARKERS);
    },
  );

  // --- Codex ------------------------------------------------------------------

  const codexAdapter = (installed: InstalledCodexReplayer) =>
    createCodexAdapter({ path: installed.path, env: {} });
  const codexLaunchArgs = (installed: InstalledCodexReplayer) =>
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("app-server"))
      .flatMap((invocation) => [...invocation.args, ...invocation.stdinLines]);

  for (const failsIdentity of [false, true]) {
    register(
      `[codex phases] codex replacement ${failsIdentity ? "identity failure" : "launch and handshake"} settles recovery`,
      async () => {
        const installed = installSyntheticCodexReplayer();
        const { facts, observer } = collector();
        let end: (() => Promise<CleanupReport>) | undefined;
        const prepared = await prepare(
          createCodexAdapter({
            path: installed.path,
            env: {},
            observeAppServerLifecycle: (control) => {
              end = control.end;
            },
          }),
          observer,
        );
        try {
          assert.equal(
            (await prepared.startTurn(turnRequest()).result()).kind,
            "completed",
          );
          assert.ok(end);
          await end();
          if (failsIdentity) installed.changeVersionOnly("codex-cli changed");
          assert.equal(
            (await prepared.startTurn(turnRequest()).result()).kind,
            failsIdentity ? "failed" : "completed",
          );
          await prepared.close();
          const occurrences: Settled[] = failsIdentity ? ["ok"] : ["ok", "ok"];
          assert.deepEqual(settlements(facts), {
            "launch@-": occurrences,
            "handshake@-": occurrences,
            "handshake/protocol-initialize@-": occurrences,
            "handshake/account-check@-": occurrences,
            "handshake/model-list@-": occurrences,
            [`handshake@${SESSION}`]: ["ok"],
            [`recovery@${SESSION}`]: failsIdentity
              ? ["failed:recovery/recovery-identity"]
              : ["ok", "ok"],
            "cleanup@-": ["ok"],
          });
          assertNoNativeDetail(
            facts,
            codexLaunchArgs(installed),
            CODEX_FRAME_MARKERS,
          );
        } finally {
          await prepared.close();
        }
      },
    );
  }

  register(
    "[codex phases] prepare launches and handshakes, a fresh thread is the Session's handshake, and close is cleanup",
    async () => {
      const installed = installCodexReplayer("completion");
      const { facts, observer } = collector();
      const prepared = await prepare(codexAdapter(installed), observer);
      // The prepare handshake's three exchanges are its semantic steps (#325),
      // each nested inside the handshake's own start and end.
      const handshakeSteps = {
        "handshake/protocol-initialize@-": ["ok"],
        "handshake/account-check@-": ["ok"],
        "handshake/model-list@-": ["ok"],
      };
      assert.deepEqual(settlements(facts), {
        "launch@-": ["ok"],
        "handshake@-": ["ok"],
        ...handshakeSteps,
      });
      assert.deepEqual(
        facts
          .filter((fact) => fact.phase === "handshake")
          .map((fact) => `${fact.kind}:${fact.step ?? "-"}`),
        [
          "phase-start:-",
          "phase-start:protocol-initialize",
          "phase-end:protocol-initialize",
          "phase-start:account-check",
          "phase-end:account-check",
          "phase-start:model-list",
          "phase-end:model-list",
          "phase-end:-",
        ],
      );
      const turn = prepared.startTurn(
        turnRequest({ text: CODEX_RECORDING_INPUT.completion }),
      );
      assert.equal((await turn.result()).kind, "completed");
      await prepared.close();
      await prepared.close();

      assert.deepEqual(settlements(facts), {
        "launch@-": ["ok"],
        "handshake@-": ["ok"],
        ...handshakeSteps,
        [`handshake@${SESSION}`]: ["ok"],
        "cleanup@-": ["ok"],
      });
      assertNoNativeDetail(
        facts,
        codexLaunchArgs(installed),
        CODEX_FRAME_MARKERS,
      );
    },
  );

  register(
    "[codex phases] each Prepared Harness reports only through its own prepare's observer",
    async () => {
      const installed = installCodexReplayer("completion");
      const adapter = codexAdapter(installed);
      const first = collector();
      const second = collector();
      const preparedFirst = await prepare(adapter, first.observer);
      const opened = settlements(first.facts);
      const preparedSecond = await prepare(adapter, second.observer);
      // Each prepare's own launch and handshake reach only its observer.
      assert.deepEqual(settlements(first.facts), opened);
      assert.deepEqual(settlements(second.facts), opened);

      const firstTurn = preparedFirst.startTurn(
        turnRequest({ text: CODEX_RECORDING_INPUT.completion }),
      );
      assert.equal((await firstTurn.result()).kind, "completed");
      await preparedFirst.close();
      const firstSettled = {
        ...opened,
        [`handshake@${SESSION}`]: ["ok"],
        "cleanup@-": ["ok"],
      };
      assert.deepEqual(settlements(first.facts), firstSettled);
      assert.deepEqual(settlements(second.facts), opened);

      const secondTurn = preparedSecond.startTurn(
        turnRequest({ text: CODEX_RECORDING_INPUT.completion }),
      );
      assert.equal((await secondTurn.result()).kind, "completed");
      await preparedSecond.close();
      assert.deepEqual(settlements(second.facts), firstSettled);
      assert.deepEqual(settlements(first.facts), firstSettled);
    },
  );

  register(
    "[codex phases] an account that needs a login fails the account-check step and the handshake, and no later step starts",
    async () => {
      const installed = installSyntheticCodexReplayer();
      installed.requireLogin();
      const { facts, observer } = collector();
      const result = await codexAdapter(installed).prepare({
        workspace: makeTempDir("secant-phase-ws-"),
        phases: observer,
      });
      assert.equal(result.ok, false);
      assert.deepEqual(settlements(facts), {
        "launch@-": ["ok"],
        "handshake/protocol-initialize@-": ["ok"],
        "handshake/account-check@-": ["failed:prepare/authentication"],
        "handshake@-": ["failed:prepare/authentication"],
      });
      assertNoNativeDetail(
        facts,
        codexLaunchArgs(installed),
        CODEX_FRAME_MARKERS,
      );
    },
  );

  register(
    "[codex phases] an unclean close fails the cleanup phase with its typed failure",
    async () => {
      const installed = installSyntheticCodexReplayer();
      installed.failCleanup(3);
      const { facts, observer } = collector();
      const prepared = await prepare(codexAdapter(installed), observer);
      const report = await prepared.close();
      assert.equal(report.clean, false);

      assert.deepEqual(settlements(facts)["cleanup@-"], [
        "failed:prepare/cleanup",
      ]);
      assertNoNativeDetail(
        facts,
        codexLaunchArgs(installed),
        CODEX_FRAME_MARKERS,
      );
    },
  );

  for (const [rpcError, expected] of [
    ["internal", "failed:control/control-refused"],
    ["stale", "abandoned"],
  ] as const) {
    register(
      `[codex phases] an interrupt refused with the ${rpcError} RPC error settles the control phase ${expected.split(":")[0]}`,
      async () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          interruptRpcError: rpcError,
        });
        const { facts, observer } = collector();
        const prepared = await prepare(codexAdapter(installed), observer);
        const turn = prepared.startTurn(turnRequest());
        await sessionOpen(turn);
        assert.equal((await turn.interrupt()).outcome, "rejected");
        const refused = facts.find(
          (fact) => fact.kind === "phase-end" && fact.phase === "control",
        );
        assert.ok(refused?.kind === "phase-end");
        assert.equal(
          refused.outcome === "failed"
            ? `failed:${refused.failure.phase}/${refused.failure.category}`
            : refused.outcome,
          expected,
        );
        if (refused.outcome === "failed") {
          // The RPC's own error code is the native code.
          assert.equal(refused.failure.nativeCode, "-32603");
        }
        await prepared.close();
        await turn.result();
        settlements(facts);
        assertNoNativeDetail(
          facts,
          codexLaunchArgs(installed),
          CODEX_FRAME_MARKERS,
        );
      },
    );
  }

  register(
    "[codex phases] an interrupt's acknowledgement is the control phase",
    async () => {
      const installed = installSyntheticCodexReplayer();
      installed.configureTurn({
        withholdTerminal: true,
        interruptTerminal: "interrupted",
      });
      const { facts, observer } = collector();
      const prepared = await prepare(codexAdapter(installed), observer);
      const turn = prepared.startTurn(turnRequest());
      await sessionOpen(turn);
      assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
      assert.equal((await turn.result()).kind, "interrupted");
      await prepared.close();

      assert.deepEqual(settlements(facts)[`control@${SESSION}`], ["ok"]);
      assertNoNativeDetail(
        facts,
        codexLaunchArgs(installed),
        CODEX_FRAME_MARKERS,
      );
    },
  );

  register(
    "[codex phases] a steer's acknowledgement is the control phase",
    async () => {
      const installed = installSyntheticCodexReplayer();
      installed.configureTurn({
        withholdTerminal: true,
        steerTerminal: "completed",
      });
      const { facts, observer } = collector();
      const prepared = await prepare(codexAdapter(installed), observer);
      const turn = prepared.startTurn(turnRequest());
      await sessionOpen(turn);
      assert.deepEqual(await turn.steer({ text: "finish now" }), {
        outcome: "accepted",
      });
      assert.equal((await turn.result()).kind, "completed");
      await prepared.close();

      assert.deepEqual(settlements(facts)[`control@${SESSION}`], ["ok"]);
      assertNoNativeDetail(
        facts,
        codexLaunchArgs(installed),
        CODEX_FRAME_MARKERS,
      );
    },
  );

  for (const acknowledged of [true, false]) {
    register(
      acknowledged
        ? "[codex phases] a resumed thread is the recovery phase"
        : "[codex phases] an unacknowledged thread resume fails the recovery phase with its typed failure",
      async () => {
        const installed = installSyntheticCodexReplayer();
        if (!acknowledged) {
          installed.configureRecovery({ threadId: "different-thread" });
        }
        const { facts, observer } = collector();
        const prepared = await prepare(codexAdapter(installed), observer);
        const turn = prepared.startTurn(
          turnRequest({ resume: { opaque: "thread-1" } }),
        );
        assert.equal(
          (await turn.result()).kind,
          acknowledged ? "completed" : "failed",
        );
        await prepared.close();

        const settled = settlements(facts);
        assert.deepEqual(settled[`recovery@${SESSION}`], [
          acknowledged ? "ok" : "failed:recovery/recovery-unacknowledged",
        ]);
        // A resumed Session opens no fresh thread.
        assert.equal(settled[`handshake@${SESSION}`], undefined);
        assertNoNativeDetail(facts, codexLaunchArgs(installed), [
          ...CODEX_FRAME_MARKERS,
          "different-thread",
        ]);
      },
    );
  }
}
