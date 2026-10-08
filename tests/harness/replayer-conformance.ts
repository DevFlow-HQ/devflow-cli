// Drives the shared Harness conformance suite against the REAL replayers. These
// runs moved out of the Bun test runner into the standalone runtime-conformance
// runner (#184, M5): the semantic suite never spawns, so recorded-Harness traffic
// executes as an ordinary Bun process instead. The deterministic fake still runs
// this same suite under the test runner (tests/harness/conformance.test.ts), so
// running both keeps the fake honest to the Interface. This module is not a
// `.test.ts` file: it is imported and driven by tests/process/runtime-conformance.ts.

import assert from "node:assert/strict";
import { setEnvironmentForTest } from "../helpers/environment.js";
import { turnRequest } from "./scripted-claude.js";
import type { TurnEvent } from "../../src/harness/harness.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  type TestHarnessAdapterFactory,
} from "./test-adapters.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  runApprovalRequestCases,
  runExactThreadRecoveryCases,
  runInterruptRecoveryCases,
  runModelChangeCases,
  runModelDeclarationCases,
  runModelObservationCases,
  runNativeSteerCases,
  runPendingSteerCases,
  runPrepareProfileCases,
  runRequestedModelCases,
  runTurnLifecycleCases,
  runTurnProducerTraceCases,
  runWritableDirectoryGrantCases,
  type ApprovalRequestScenarios,
  type InterruptRecoveryScenarios,
  type PrepareProfileScenarios,
  type RegisterConformanceCase,
  type TurnLifecycleScenarios,
} from "./conformance.js";
import { installReplayer } from "./replayer.js";
import {
  installCodexReplayer,
  installSyntheticCodexReplayer,
} from "./codex-replayer.js";
import { CODEX_RECORDING_INPUT } from "./codex-recording-cases.js";

// A natively confirmed Claude Code interrupt settles `interrupted` on every OS
// (#346). Its process-stop fallback settles per OS: on Windows the stop is a
// forced kill and truthfully `lost` (ADR 0022). The recovery cases relaunch with
// `--resume`, which only the fallback leads to, so they replay an unanswered
// interrupt bounded by this short control timeout.
const CLAUDE_FALLBACK_OUTCOME =
  process.platform === "win32" ? "lost" : "interrupted";
const CLAUDE_FALLBACK_CONTROL_TIMEOUT_MS = 500;

// --- Claude Code over the real replayer --------------------------------------

const VERSION = "2.1.234 (Claude Code)";
const fixtureCase = (name: string) =>
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "fixtures",
    "claude-code",
    name,
  );
const COMPLETED_CASE = fixtureCase("completed");
const protocolCase = fixtureCase;

export function registerClaudeCodeReplayerConformance(
  register: RegisterConformanceCase,
): void {
  const conformanceReplayer = installReplayer(VERSION);
  const scenarios: PrepareProfileScenarios = {
    label: "claude-code",
    baseline: () => () =>
      createClaudeCodeAdapter({ path: conformanceReplayer.path, env: {} }),
    prepareFailure: () => () =>
      createClaudeCodeAdapter({
        path: makeTempDir("secant-claude-empty-"),
        env: {},
      }),
  };
  runPrepareProfileCases(scenarios, register);

  // Claude Code suggests its documented aliases with the five `--help` efforts,
  // admits any other name, and starts from its declared fallback until its
  // settings are read (#347); each Turn's requested model and effort are forwarded as --model and --effort on
  // the launch serving it.
  const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
  runModelDeclarationCases(
    {
      label: "claude-code",
      baseline: scenarios.baseline,
      expectedDeclaration: {
        kind: "suggested",
        includes: [
          { model: "opus", label: "Opus (latest)", efforts: claudeEfforts },
          { model: "default", label: "Default", efforts: claudeEfforts },
          { model: "opusplan", label: "Opus Plan", efforts: claudeEfforts },
          {
            model: "sonnet[1m]",
            label: "Sonnet (latest) with 1M context",
            efforts: claudeEfforts,
          },
        ],
        efforts: claudeEfforts,
      },
      expectedDefaults: {
        kind: "reported",
        choice: { model: "claude-opus-5-5", effort: "high" },
      },
    },
    register,
  );
  runRequestedModelCases(
    {
      label: "claude-code",
      requestedModel: "requested-conformance-model",
      requestedEffort: "high",
      requesting: () => {
        const replayer = installReplayer(VERSION, COMPLETED_CASE);
        return {
          factory: () =>
            createClaudeCodeAdapter({
              path: replayer.path,
              env: {},
              sessionId: () => "77777777-7777-4777-8777-777777777777",
            }),
          // Each Turn's launch: the model and effort are the values after its
          // --model and --effort.
          requests: () =>
            replayer
              .invocations()
              .filter((invocation) => invocation.args.includes("-p"))
              .map(({ args }) => {
                const at = args.indexOf("--model");
                const model = args[at + 1];
                const effort = args.includes("--effort")
                  ? args[args.indexOf("--effort") + 1]
                  : undefined;
                return at === -1 || model === undefined
                  ? undefined
                  : { model, ...(effort === undefined ? {} : { effort }) };
              }),
        };
      },
    },
    register,
  );

  for (const [name, level, expected] of [
    [
      "settings",
      undefined,
      {
        kind: "reported",
        choice: { model: "claude-opus-5-5", effort: "high" },
      },
    ],
    [
      "settings-locked",
      "xhigh",
      {
        kind: "reported",
        choice: { model: "claude-opus-5-5", effort: "xhigh" },
        effortLock: {
          effort: "xhigh",
          source: "CLAUDE_CODE_EFFORT_LEVEL=xhigh",
        },
      },
    ],
    [
      "settings-unanswered",
      undefined,
      {
        kind: "fallback",
        choice: { model: "opus", effort: "medium" },
        reason: "Claude Code's settings did not answer before launch.",
      },
    ],
    [
      "settings-no-effort",
      undefined,
      {
        kind: "fallback",
        choice: { model: "opus", effort: "medium" },
        reason: "Claude Code reported no selectable default effort.",
      },
    ],
  ] as const) {
    register(
      `claude-code defaults: ${name} reads once per prepare outside the profile cache`,
      async () => {
        const restore = setEnvironmentForTest(
          { after: () => {} },
          { CLAUDE_CODE_EFFORT_LEVEL: level },
        );
        try {
          const replayer = installReplayer(
            "2.1.289 (Claude Code)",
            fixtureCase(name),
          );
          const adapter = createClaudeCodeAdapter({
            path: replayer.path,
            env: {},
            controlTimeoutMs: name === "settings-unanswered" ? 500 : undefined,
          });
          const workspace = makeTempDir("secant-settings-ws-");
          for (let i = 0; i < 2; i++) {
            const prepared = await adapter.prepare({ workspace });
            assert.ok(prepared.ok);
            try {
              assert.equal(
                replayer
                  .invocations()
                  .filter((call) =>
                    call.args.includes("--no-session-persistence"),
                  ).length,
                i,
              );
              const first = prepared.harness.readDefaults();
              assert.equal(prepared.harness.readDefaults(), first);
              assert.deepEqual(await first, expected);
            } finally {
              assert.equal((await prepared.harness.close()).clean, true);
            }
          }
          const calls = replayer.invocations();
          assert.equal(
            calls.filter((call) => call.args.includes("--version")).length,
            1,
          );
          const probes = calls.filter((call) =>
            call.args.includes("--no-session-persistence"),
          );
          assert.equal(probes.length, 2);
          for (const probe of probes) {
            assert.equal(probe.stdinLines.length, 0);
            assert.equal(probe.controlLines.length, 1);
            assert.equal(
              JSON.parse(probe.controlLines[0]!).request.subtype,
              "get_settings",
            );
            assert.ok(
              !probe.args.includes("--session-id") &&
                !probe.args.includes("--resume"),
            );
          }
        } finally {
          restore();
        }
      },
    );
  }
  for (const level of [undefined, "xhigh"] as const) {
    register(
      `claude-code Turn observes recorded effective effort ${level ?? "high"}`,
      async () => {
        const restore = setEnvironmentForTest(
          { after: () => {} },
          { CLAUDE_CODE_EFFORT_LEVEL: level },
        );
        const replayer = installReplayer(
          "2.1.289 (Claude Code)",
          COMPLETED_CASE,
        );
        const prepared = await createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
        }).prepare({ workspace: makeTempDir("secant-settings-turn-") });
        assert.ok(prepared.ok);
        try {
          const turn = prepared.harness.startTurn({
            ...turnRequest("recorded effort"),
            modelChoice: { model: "requested-model", effort: "low" },
          });
          const events: TurnEvent[] = [];
          turn.subscribe((event) => events.push(event));
          const result = await turn.result();
          assert.ok(result.kind === "completed");
          assert.ok(result.detail.effectiveModel.known);
          assert.equal(result.detail.effectiveModel.effort, level ?? "high");
          assert.notEqual(
            result.detail.effectiveModel.model,
            "requested-model",
          );
          assert.ok(
            events.some(
              (event) =>
                event.kind === "model" &&
                event.observation.known &&
                event.observation.effort === (level ?? "high"),
            ),
          );
        } finally {
          await prepared.harness.close();
          restore();
        }
      },
    );
  }

  // #214: the Run working area reaches every launch as one `--add-dir`.
  runWritableDirectoryGrantCases(
    {
      label: "claude-code",
      directory: () => makeTempDir("secant-claude-writable-"),
      granting: () => {
        const replayer = installReplayer(VERSION, COMPLETED_CASE);
        return {
          factory: () =>
            createClaudeCodeAdapter({
              path: replayer.path,
              env: {},
              sessionId: () => "88888888-8888-4888-8888-888888888888",
            }),
          grants: () =>
            replayer
              .invocations()
              .filter((invocation) => invocation.args.includes("-p"))
              .map((invocation) => flagValues(invocation.args, "--add-dir")),
        };
      },
    },
    register,
  );

  const turnScenarios: TurnLifecycleScenarios = {
    ...scenarios,
    baseline: () => {
      const replayer = installReplayer(VERSION, COMPLETED_CASE);
      return () =>
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => "11111111-1111-4111-8111-111111111111",
        });
    },
    failedTurn: () => {
      const replayer = installReplayer(VERSION, protocolCase("failed"));
      return () =>
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => "22222222-2222-4222-8222-222222222222",
        });
    },
  };
  runTurnLifecycleCases(turnScenarios, register);
  runTurnProducerTraceCases(
    {
      label: "claude-code",
      streaming: turnScenarios.baseline,
      live: [
        {
          kind: "assistant-content",
          content: "hello",
          messageId: "minted-message-id",
          parentActivity: "minted-parent-call-id",
        },
      ],
      previews: [],
      mintedContentIdentity: true,
      content: {
        kind: "assistant-content",
        content: "hello",
        messageId: "minted-message-id",
        parentActivity: "minted-parent-call-id",
      },
    },
    register,
  );

  const APPROVAL_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CONCURRENT_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const OUTSTANDING_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const claudeApprovalAdapter = (session: string, caseName: string) => {
    const replayer = installReplayer(VERSION, protocolCase(caseName));
    return () =>
      createClaudeCodeAdapter({
        path: replayer.path,
        env: {},
        sessionId: () => session,
      });
  };
  const approvalScenarios: ApprovalRequestScenarios = {
    label: "claude-code",
    concurrentCount: 2,
    concurrentRequests: () =>
      claudeApprovalAdapter(CONCURRENT_SESSION, "approval-concurrent"),
    awaitedApproval: () => claudeApprovalAdapter(APPROVAL_SESSION, "approval"),
    interruptible: () =>
      claudeApprovalAdapter(OUTSTANDING_SESSION, "approval-outstanding"),
  };
  runApprovalRequestCases(approvalScenarios, register);

  const caseScenario =
    (name: string, id: string, controlTimeoutMs?: number) =>
    (): TestHarnessAdapterFactory => {
      const replayer = installReplayer(VERSION, protocolCase(name));
      return () =>
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => id,
          ...(controlTimeoutMs !== undefined ? { controlTimeoutMs } : {}),
        });
    };
  const interruptScenarios: InterruptRecoveryScenarios = {
    ...turnScenarios,
    blockingTurn: caseScenario(
      process.platform === "win32" ? "interrupt-recovery" : "interrupt",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    unresponsiveInterrupt: caseScenario(
      "unresponsive",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      CLAUDE_FALLBACK_CONTROL_TIMEOUT_MS,
    ),
    lostCompletion: caseScenario(
      "lost-completion",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ),
    resumeAcknowledged: caseScenario(
      "resume",
      "55555555-5555-4555-8555-555555555555",
      CLAUDE_FALLBACK_CONTROL_TIMEOUT_MS,
    ),
    resumeUnacknowledged: caseScenario(
      "resume-unacknowledged",
      "66666666-6666-4666-8666-666666666666",
      CLAUDE_FALLBACK_CONTROL_TIMEOUT_MS,
    ),
  };
  runInterruptRecoveryCases(interruptScenarios, register, {
    recoveryInterruptOutcome: CLAUDE_FALLBACK_OUTCOME,
  });

  // Native Steer (#359): a Steer written during a recorded tool round reaches the
  // model with its tool result, and two Steers queued in one are dropped by the
  // Interrupt's `cancel_queued`, or by the loss when the Harness closes.
  runNativeSteerCases(
    {
      label: "claude-code",
      guidanceText: "Also say the word MANGO at the end of your reply.",
      steerableTurn: caseScenario(
        "steer-within",
        "57ee1111-1111-4111-8111-111111111111",
      ),
    },
    register,
  );
  runPendingSteerCases(
    {
      label: "claude-code",
      pendingTurn: caseScenario(
        "steer-cancel",
        "57ee3333-3333-4333-8333-333333333333",
      ),
    },
    register,
  );

  // A live Model choice change (#348): the recorded Turn waits on its tool round
  // until the Adapter's set_model, apply_flag_settings, and read-back arrive.
  runModelChangeCases(
    {
      label: "claude-code",
      launchChoice: { model: "haiku", effort: "low" },
      change: { model: "sonnet", effort: "high" },
      applied: { known: true, model: "claude-sonnet-5-5", effort: "high" },
      changing: () => ({
        factory: caseScenario(
          "model-change",
          "30de1111-1111-4111-8111-111111111111",
        )(),
      }),
    },
    register,
  );
}

// --- Codex over the real replayer --------------------------------------------

export function registerCodexReplayerConformance(
  register: RegisterConformanceCase,
): void {
  const replayer = installSyntheticCodexReplayer();

  runPrepareProfileCases(
    {
      label: "codex",
      baseline: () => () =>
        createCodexAdapter({ path: replayer.path, env: {} }),
      prepareFailure: () => () =>
        createCodexAdapter({
          path: makeTempDir("secant-codex-empty-"),
          env: {},
        }),
    },
    register,
  );

  // Codex declares the models its recorded `model/list` observed, each with its
  // efforts and default effort, and reads its defaults from the recorded
  // `config/read`: one Codex home names gpt-5.5 at high, the other names no
  // model, so the `model/list` default stands in at its own default effort. Each
  // Turn's requested model rides its turn/start; one the list rejects settles
  // that Turn not-started.
  const gpt55 = {
    model: "gpt-5.5",
    label: "GPT-5.5",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  };
  const gpt61Sol = {
    model: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "low",
  };
  const configured = installCodexReplayer("codex-qualification");
  runModelDeclarationCases(
    {
      label: "codex",
      baseline: () => () =>
        createCodexAdapter({ path: configured.path, env: {} }),
      expectedDeclaration: { kind: "list", includes: [gpt55, gpt61Sol] },
      expectedDefaults: {
        kind: "reported",
        choice: { model: "gpt-5.5", effort: "high" },
      },
    },
    register,
  );
  const unconfigured = installCodexReplayer("codex-qualification-unconfigured");
  runModelDeclarationCases(
    {
      label: "codex unconfigured",
      baseline: () => () =>
        createCodexAdapter({ path: unconfigured.path, env: {} }),
      expectedDeclaration: { kind: "list", includes: [gpt55, gpt61Sol] },
      expectedDefaults: {
        kind: "fallback",
        choice: { model: "gpt-6.1-sol", effort: "low" },
        reason:
          "Codex's configuration names no model. Starting from Codex's default model at its default effort.",
      },
    },
    register,
  );
  runRequestedModelCases(
    {
      label: "codex",
      inputText: CODEX_RECORDING_INPUT.completion,
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "high",
      requesting: () => {
        const installed = installSyntheticCodexReplayer();
        // Codex reports a configured model other than the request, so an
        // effective model equal to the request would be a copy.
        installed.configureThreadRead({ model: "gpt-6-astra", effort: "low" });
        return {
          factory: () => createCodexAdapter({ path: installed.path, env: {} }),
          // Each turn/start the app-server received: its model and effort are
          // the request.
          requests: () =>
            installed
              .invocations()
              .flatMap((invocation) => invocation.stdinLines)
              .map((line) => JSON.parse(line))
              .filter((frame) => frame.method === "turn/start")
              .map((frame) =>
                frame.params?.model === undefined
                  ? undefined
                  : {
                      model: frame.params.model,
                      ...(frame.params.effort === undefined
                        ? {}
                        : { effort: frame.params.effort }),
                    },
              ),
        };
      },
      unknownModel: "no-such-secant-model",
    },
    register,
  );
  // Codex's effective values (#345): thread/read after the Turn starts reports
  // the model and effort, and a model/rerouted for the Turn replaces the model.
  // The synthetic `model-rerouted` case stands in for a reroute a recording
  // cannot induce.
  runModelObservationCases(
    {
      label: "codex model-rerouted",
      inputText: CODEX_RECORDING_INPUT.completion,
      modelChoice: { model: "gpt-5.6-sol", effort: "medium" },
      observations: [
        { known: true, model: "gpt-6.1-sol", effort: "high" },
        { known: true, model: "gpt-5.5", effort: "high" },
      ],
      observing: () => {
        const installed = installCodexReplayer("model-rerouted");
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
    },
    register,
  );

  // #214: the Run working area reaches every thread start and resume as the
  // workspace-write roots override, and a sandbox that drops it refuses typed.
  const codexGrant = (
    installed = installSyntheticCodexReplayer(),
  ): {
    factory: TestHarnessAdapterFactory;
    grants: () => string[][];
  } => {
    return {
      factory: () => createCodexAdapter({ path: installed.path, env: {} }),
      grants: () =>
        installed
          .invocations()
          .flatMap((invocation) => invocation.stdinLines)
          .map((line) => JSON.parse(line))
          .filter(
            (frame) =>
              frame.method === "thread/start" ||
              frame.method === "thread/resume",
          )
          .map(
            (frame) =>
              frame.params?.config?.[
                "sandbox_workspace_write.writable_roots"
              ] ?? [],
          ),
    };
  };
  runWritableDirectoryGrantCases(
    {
      label: "codex",
      inputText: CODEX_RECORDING_INPUT.completion,
      directory: () => makeTempDir("secant-codex-writable-"),
      granting: () => codexGrant(),
      resumeCoordinate: { opaque: "thread-1" },
      refusing: () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({ ignoreWritableRoots: true });
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
    },
    register,
  );

  // The strict recording acknowledges a read-only sandbox with on-request
  // approvals: the grant still reaches the thread and the Turn is not refused.
  runWritableDirectoryGrantCases(
    {
      label: "codex-recorded-read-only",
      inputText: CODEX_RECORDING_INPUT.completion,
      directory: () => makeTempDir("secant-codex-writable-"),
      granting: () => codexGrant(installCodexReplayer("completion")),
    },
    register,
  );

  runTurnLifecycleCases(
    {
      label: "codex-turn-lifecycle",
      inputText: CODEX_RECORDING_INPUT.completion,
      baseline: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("completion").path,
          env: {},
        }),
      prepareFailure: () => () =>
        createCodexAdapter({
          path: makeTempDir("secant-codex-empty-"),
          env: {},
        }),
      failedTurn: () => () =>
        createCodexAdapter({ path: failedTurnReplayer().path, env: {} }),
    },
    register,
  );

  runPendingSteerCases(
    {
      label: "codex-live-controls",
      pendingTurn: (stop) => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          interruptTerminal: stop === "interrupt" ? "interrupted" : "exit",
        });
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
    },
    register,
  );

  runTurnProducerTraceCases(
    {
      label: "codex",
      inputText: CODEX_RECORDING_INPUT.completion,
      streaming: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("completion").path,
          env: {},
        }),
      live: [
        {
          kind: "message-preview",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "record",
        },
        {
          kind: "message-preview",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "recorded",
        },
        {
          kind: "message-preview",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "recorded completion",
        },
        {
          kind: "message-preview",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "recorded completion.",
        },
        {
          kind: "assistant-content",
          messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
          content: "recorded completion.",
        },
      ],
      previews: [
        "record",
        "recorded",
        "recorded completion",
        "recorded completion.",
      ],
      content: {
        kind: "assistant-content",
        messageId: "msg_0214542d048c1195016ac157d3445887d080ed80b75390354f",
        content: "recorded completion.",
      },
    },
    register,
  );

  // Codex declares next-turn reach: a live change is rejected while the Turn runs.
  runModelChangeCases(
    {
      label: "codex-live-controls",
      launchChoice: { model: "gpt-5.6-sol", effort: "low" },
      change: { model: "gpt-5.6-sol", effort: "high" },
      changing: () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          interruptTerminal: "interrupted",
        });
        return {
          factory: () => createCodexAdapter({ path: installed.path, env: {} }),
          finish: (turn) => void turn.interrupt(),
        };
      },
    },
    register,
  );

  runNativeSteerCases(
    {
      label: "codex-recorded-conformance",
      inputText: CODEX_RECORDING_INPUT.steer,
      guidanceText: CODEX_RECORDING_INPUT.steerGuidance,
      steerableTurn: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("steer").path,
          env: {},
        }),
    },
    register,
  );

  runInterruptRecoveryCases(
    {
      label: "codex-recorded-conformance",
      inputText: CODEX_RECORDING_INPUT.completion,
      interruptInputText: CODEX_RECORDING_INPUT.sleep,
      resumeInputText: CODEX_RECORDING_INPUT.resume,
      baseline: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("completion").path,
          env: {},
        }),
      prepareFailure: () => () =>
        createCodexAdapter({
          path: makeTempDir("secant-codex-empty-"),
          env: {},
        }),
      failedTurn: () => () =>
        createCodexAdapter({ path: failedTurnReplayer().path, env: {} }),
      blockingTurn: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("interrupt").path,
          env: {},
        }),
      unresponsiveInterrupt: () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          stallInterruptResponse: true,
        });
        return () =>
          createCodexAdapter({
            path: installed.path,
            env: {},
            controlTimeoutMs: 500,
            cleanupTimeoutMs: 20,
          });
      },
      lostCompletion: () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({ stopAfter: "accepted" });
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
      resumeAcknowledged: () => {
        if (process.platform !== "win32")
          return () =>
            createCodexAdapter({
              path: installCodexReplayer("resume").path,
              env: {},
            });
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          interruptTerminal: "interrupted",
          completeAfterResume: true,
        });
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
      resumeUnacknowledged: () => {
        const installed = installSyntheticCodexReplayer();
        installed.configureTurn({
          withholdTerminal: true,
          interruptTerminal: "interrupted",
        });
        installed.configureRecovery({ threadId: "different-thread" });
        return () => createCodexAdapter({ path: installed.path, env: {} });
      },
    },
    register,
  );

  runExactThreadRecoveryCases(
    {
      label: "codex-exact-thread-recovery",
      resumeAcknowledged: () => exactRecoveryReplayer("thread-1"),
      resumeUnacknowledged: () => exactRecoveryReplayer("different-thread"),
    },
    register,
  );

  const codexApprovalScenarios: ApprovalRequestScenarios = {
    label: "codex-approval-contract",
    concurrentCount: 2,
    awaitedInputText: CODEX_RECORDING_INPUT.approval,
    concurrentRequests: () => () =>
      createCodexAdapter({
        path: installCodexReplayer("codex-approval-contract").path,
        env: {},
      }),
    awaitedApproval: () => () =>
      createCodexAdapter({
        path: installCodexReplayer("approval").path,
        env: {},
      }),
    interruptible: () => {
      const installed = installSyntheticCodexReplayer();
      installed.configureTurn({
        approvals: [
          {
            id: "interrupt-command",
            kind: "command",
            itemId: "interrupt-command-1",
            command: "bun test",
          },
        ],
        interruptTerminal: "interrupted",
      });
      return () => createCodexAdapter({ path: installed.path, env: {} });
    },
  };
  runApprovalRequestCases(codexApprovalScenarios, register);
}

/** Every value following `flag` in an argv. */
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) =>
    arg === flag && index + 1 < args.length ? [args[index + 1]] : [],
  );
}

function failedTurnReplayer() {
  const installed = installSyntheticCodexReplayer();
  installed.failTurn("scripted terminal failure");
  return installed;
}

function exactRecoveryReplayer(threadId: string) {
  const installed = installSyntheticCodexReplayer();
  installed.configureTurn({ stallFirstTurn: true });
  installed.configureRecovery({ threadId });
  return () =>
    createCodexAdapter({
      path: installed.path,
      env: {},
      controlTimeoutMs: 500,
    });
}
