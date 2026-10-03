// Drives the shared Harness conformance suite against the REAL replayers. These
// runs moved out of the Bun test runner into the standalone runtime-conformance
// runner (#184, M5): the semantic suite never spawns, so recorded-Harness traffic
// executes as an ordinary Bun process instead. The deterministic fake still runs
// this same suite under the test runner (tests/harness/conformance.test.ts), so
// running both keeps the fake honest to the Interface. This module is not a
// `.test.ts` file: it is imported and driven by tests/process/runtime-conformance.ts.

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
  runModelDeclarationCases,
  runNativeSteerCases,
  runPrepareProfileCases,
  runRequestedModelCases,
  runTurnLifecycleCases,
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

// The two interrupt-bearing cases settle per OS: on Windows a live Turn's
// interrupt is a forced kill and truthfully `lost` (ADR 0022).
const CLAUDE_INTERRUPT_OUTCOME =
  process.platform === "win32" ? "lost" : "interrupted";

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

  // Claude Code declares free-text model entry and forwards each Turn's requested
  // model as --model on the launch serving it; the effective model stays the
  // init/result observation.
  runModelDeclarationCases(
    {
      label: "claude-code",
      baseline: scenarios.baseline,
      expectedDeclaration: { kind: "free-text" },
    },
    register,
  );
  runRequestedModelCases(
    {
      label: "claude-code",
      requestedModel: "requested-conformance-model",
      requesting: () => {
        const replayer = installReplayer(VERSION, COMPLETED_CASE);
        return {
          factory: () =>
            createClaudeCodeAdapter({
              path: replayer.path,
              env: {},
              sessionId: () => "77777777-7777-4777-8777-777777777777",
            }),
          // Each Turn's launch: the model is the value after its --model.
          requests: () =>
            replayer
              .invocations()
              .filter((invocation) => invocation.args.includes("-p"))
              .map((invocation) => {
                const at = invocation.args.indexOf("--model");
                const model = invocation.args[at + 1];
                return at === -1 || model === undefined ? undefined : { model };
              }),
        };
      },
    },
    register,
  );

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
  runApprovalRequestCases(approvalScenarios, register, {
    interruptOutcome: CLAUDE_INTERRUPT_OUTCOME,
  });

  const caseScenario =
    (name: string, id: string) => (): TestHarnessAdapterFactory => {
      const replayer = installReplayer(VERSION, protocolCase(name));
      return () =>
        createClaudeCodeAdapter({
          path: replayer.path,
          env: {},
          sessionId: () => id,
        });
    };
  const interruptScenarios: InterruptRecoveryScenarios = {
    ...turnScenarios,
    blockingTurn: caseScenario(
      "interrupt",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ),
    unresponsiveInterrupt: caseScenario(
      "unresponsive",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ),
    lostCompletion: caseScenario(
      "lost-completion",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ),
    resumeAcknowledged: caseScenario(
      "resume",
      "55555555-5555-4555-8555-555555555555",
    ),
    resumeUnacknowledged: caseScenario(
      "resume-unacknowledged",
      "66666666-6666-4666-8666-666666666666",
    ),
  };
  runInterruptRecoveryCases(interruptScenarios, register, {
    interruptOutcome: CLAUDE_INTERRUPT_OUTCOME,
  });
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

  // Codex declares the supported-model list its qualification observed; each
  // Turn's requested model is applied natively on its turn/start, and one the list
  // rejects settles that Turn not-started. `gpt-6-astra` is the default recorded model; `gpt-5.6-sol` a
  // non-default one, distinct from the thread's observed effective model.
  runModelDeclarationCases(
    {
      label: "codex",
      baseline: () => () =>
        createCodexAdapter({ path: replayer.path, env: {} }),
      expectedDeclaration: { kind: "list", includes: ["gpt-6-astra"] },
    },
    register,
  );
  runRequestedModelCases(
    {
      label: "codex",
      inputText: CODEX_RECORDING_INPUT.completion,
      requestedModel: "gpt-5.6-sol",
      requesting: () => {
        const installed = installSyntheticCodexReplayer();
        return {
          factory: () => createCodexAdapter({ path: installed.path, env: {} }),
          // Each turn/start the app-server received: its model is the request.
          requests: () =>
            installed
              .invocations()
              .flatMap((invocation) => invocation.stdinLines)
              .map((line) => JSON.parse(line))
              .filter((frame) => frame.method === "turn/start")
              .map((frame) =>
                frame.params?.model === undefined
                  ? undefined
                  : { model: frame.params.model },
              ),
        };
      },
      unknownModel: "no-such-secant-model",
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
      resumeAcknowledged: () => () =>
        createCodexAdapter({
          path: installCodexReplayer("resume").path,
          env: {},
        }),
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
