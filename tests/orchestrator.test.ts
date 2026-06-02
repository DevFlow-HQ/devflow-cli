import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import fs from "fs-extra";

import {
  createDevFlowState,
  DEVFLOW_GRILL_TRANSCRIPT_COMPLETE,
  type DevFlowState,
} from "../src/devflowState.js";
import { createBuiltInManagedSessionAdapter } from "../src/adapters/builtInManagedSessionAdapter.js";
import type {
  ManagedProviderSessionInput,
  ManagedProviderSessionResumeInput,
  ManagedProviderSessionEvent,
  ManagedProviderSessionResult,
  ManagedSessionAdapter,
} from "../src/adapters/managedSessionAdapter.js";
import {
  IncompleteProviderSessionError,
  InterruptedProviderSessionError,
  ProviderSessionCleanupError,
  ProviderSessionEventCaptureError,
  ProviderSessionLaunchError,
  ProviderSessionTranscriptCaptureError,
} from "../src/adapters/managedSessionAdapter.js";
import { getBuiltInProviderIdentity } from "../src/adapters/providers.js";
import { UnsupportedProviderError } from "../src/bootstrapProvider.js";
import {
  ExecutionLoopCapError,
  MissingProviderIdError,
  ProviderStageRetryExhaustedError,
  isRetryableProviderBackedStageFailure,
  renderExecutePrompt,
  runExecutionRequest,
  runProviderBackedStageWithRetry,
  StageArtifactValidationError,
  validateExecutionArtifact,
  validateIssueArtifacts,
  type PipelineStage,
} from "../src/orchestrator.js";

async function listRunDirectories(
  projectRoot: string,
): Promise<string[]> {
  const runsDirectory = join(projectRoot, ".devflow", "runs");

  if (!(await fs.pathExists(runsDirectory))) {
    return [];
  }

  return (await fs.readdir(runsDirectory)).sort();
}

function isGrillSessionInput(input: ManagedProviderSessionInput): boolean {
  return input.initialCompletionMarker.startsWith("DEVFLOW_GRILL_COMPLETE_");
}

function isPrdSessionInput(input: ManagedProviderSessionInput): boolean {
  return input.initialCompletionMarker.startsWith("DEVFLOW_PRD_COMPLETE_");
}

function isIssuesSessionInput(input: ManagedProviderSessionInput): boolean {
  return input.initialCompletionMarker.startsWith("DEVFLOW_ISSUES_COMPLETE_");
}

function isExecuteSessionInput(input: ManagedProviderSessionInput): boolean {
  return input.initialCompletionMarker.startsWith(
    "DEVFLOW_EXECUTION_ITERATION_COMPLETE_",
  );
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

function createStructuredProviderEvent(
  event: DistributiveOmit<
    ManagedProviderSessionEvent,
    "provider" | "source" | "structured"
  >,
  source: ManagedProviderSessionEvent["source"] = "hooks",
  provider = getBuiltInProviderIdentity("codex"),
): ManagedProviderSessionEvent {
  return {
    ...event,
    provider,
    source,
    structured: true,
  } as ManagedProviderSessionEvent;
}

function extractPrdArtifactPath(prompt: string): string {
  const match = prompt.match(/Canonical PRD artifact path:\n([^\n]+)/);

  assert.ok(match?.[1], "expected PRD prompt to include artifact path");
  return match[1];
}

function extractIssuesDirectory(prompt: string): string {
  const match = prompt.match(/Issues directory:\n([^\n]+)/);

  assert.ok(match?.[1], "expected issues prompt to include issues directory");
  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function completeIssuesSession(
  input: ManagedProviderSessionInput,
): Promise<ManagedProviderSessionResult> {
  assert.match(input.initialCompletionMarker, /^DEVFLOW_ISSUES_COMPLETE_[a-f0-9]{32}$/);
  assert.match(input.initialPrompt, /Decompose the accepted PRD/);
  assert.match(input.initialPrompt, /Canonical PRD artifact path:/);
  assert.match(input.initialPrompt, /Project context path:/);
  assert.match(input.initialPrompt, /Issues directory:/);
  assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);

  await fs.outputFile(
    join(extractIssuesDirectory(input.initialPrompt), "first-issue.md"),
    "# First issue\n",
  );
  await input.validate();

  return { repairUsed: false, exitCode: 0, signal: null };
}

async function completeExecuteSession(
  input: ManagedProviderSessionInput,
): Promise<ManagedProviderSessionResult> {
  assert.match(
    input.initialCompletionMarker,
    /^DEVFLOW_EXECUTION_ITERATION_COMPLETE_[a-f0-9]{32}$/,
  );
  assert.match(
    input.initialTerminalCompletionMarker ?? "",
    /^DEVFLOW_EXECUTION_NO_MORE_TASKS_[a-f0-9]{32}$/,
  );
  assert.match(input.initialPrompt, /running one DevFlow execution iteration/i);
  assert.match(input.initialPrompt, /Select and complete exactly one AFK issue/i);
  assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
  assert.equal(
    input.initialPrompt.includes(input.initialTerminalCompletionMarker ?? ""),
    true,
  );

  await input.validate();

  return {
    repairUsed: false,
    exitCode: 0,
    signal: null,
    matchedCompletionMarker: input.initialTerminalCompletionMarker,
  };
}

function assertIssuesPromptContract(input: ManagedProviderSessionInput): void {
  assert.match(input.initialCompletionMarker, /^DEVFLOW_ISSUES_COMPLETE_[a-f0-9]{32}$/);
  assert.match(input.initialPrompt, /Canonical PRD artifact path:\n.+prd\.md/);
  assert.match(input.initialPrompt, /Project context path:\n.+project-context\.md/);
  assert.match(input.initialPrompt, /Issues directory:\n.+\/issues/);
  assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
  assert.doesNotMatch(input.initialPrompt, /\{\{[A-Z_]+\}\}/);

  assert.match(input.initialPrompt, /write markdown files directly into the supplied issues directory/i);
  assert.match(input.initialPrompt, /vertical-slice/i);
  assert.match(input.initialPrompt, /demoable\/verifiable acceptance criteria/i);
  assert.match(input.initialPrompt, /blocked-by sibling slugs/i);
  assert.match(input.initialPrompt, /HITL\/AFK/i);
  assert.match(input.initialPrompt, /single headless self-critique/i);

  assert.doesNotMatch(input.initialPrompt, /\/setup-matt-pocock-skills/);
  assert.doesNotMatch(input.initialPrompt, /\bgh\b/);
  assert.doesNotMatch(input.initialPrompt, /issue-tracker publishing/i);
  assert.doesNotMatch(input.initialPrompt, /triage[- ]label instructions/i);
}

async function completeSessionContinuations(
  input: ManagedProviderSessionInput,
): Promise<void> {
  for (const continuation of input.continuations ?? []) {
    assert.ok(continuation.phase?.id, "expected continuation phase id");
    assert.equal(continuation.phase.kind, "prd");
    assert.match(continuation.completionMarker, /^DEVFLOW_PRD_COMPLETE_[a-f0-9]{32}$/);
    assert.match(continuation.prompt, /Synthesize the canonical PRD/);
    assert.match(continuation.prompt, /Do not interview the user/);
    assert.match(continuation.prompt, /just-completed live grill discussion/);
    assert.match(continuation.prompt, /Persisted grill transcript path:/);
    assert.match(continuation.prompt, /grill-transcript\.md/);
    assert.match(continuation.prompt, /Canonical PRD artifact path:/);
    assert.match(continuation.prompt, /prd\.md/);
    assert.equal(continuation.prompt.includes(continuation.completionMarker), true);

    await continuation.onStart?.();
    await fs.outputFile(extractPrdArtifactPath(continuation.prompt), "# PRD\n");
    await continuation.validate();
  }
}

async function completeGrillSession(
  input: ManagedProviderSessionInput,
): Promise<ManagedProviderSessionResult> {
  assert.match(input.initialCompletionMarker, /^DEVFLOW_GRILL_COMPLETE_[a-f0-9]{32}$/);
  assert.match(input.initialPrompt, /Run the interactive grill stage/);
  await input.onProviderEvent?.(
    createStructuredProviderEvent({
      type: "turn-completed",
      assistantMessage: `Ready ${input.initialCompletionMarker}`,
    }),
  );
  await input.validate();
  await completeSessionContinuations(input);

  return { repairUsed: false, exitCode: 0, signal: null };
}

async function completePrdSession(
  input: ManagedProviderSessionInput,
): Promise<ManagedProviderSessionResult> {
  assert.match(input.initialCompletionMarker, /^DEVFLOW_PRD_COMPLETE_[a-f0-9]{32}$/);
  assert.match(input.initialPrompt, /Synthesize the canonical PRD/);
  assert.match(input.initialPrompt, /No live provider discussion is available/);
  assert.match(input.initialPrompt, /Persisted grill transcript path:/);
  assert.doesNotMatch(input.initialPrompt, /Ask one question at a time/);

  await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD\n");
  await input.validate();

  return { repairUsed: false, exitCode: 0, signal: null };
}

async function createExecutableOnPath(
  t: test.TestContext,
  command: string,
): Promise<string> {
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const tempRoot = await fs.mkdtemp(
    join(tmpdir(), `devflow-orchestrator-${command}-`),
  );
  const binDir = join(tempRoot, "bin");
  const executablePath = join(binDir, command);

  await fs.ensureDir(binDir);
  await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(executablePath, 0o755);
  process.env.PATH = binDir;

  return executablePath;
}

test("validateIssueArtifacts accepts at least one non-empty markdown issue file", async () => {
  const issuesDirectory = fs.mkdtempSync(join(tmpdir(), "devflow-issues-"));
  await fs.writeFile(
    join(issuesDirectory, "Not a Provider Slug.md"),
    "plain issue body without required headings or blocked-by references\n",
  );

  await validateIssueArtifacts(issuesDirectory);
});

test("validateIssueArtifacts rejects a missing issues directory", async () => {
  const tempRoot = fs.mkdtempSync(join(tmpdir(), "devflow-issues-"));
  const issuesDirectory = join(tempRoot, "missing");

  await assert.rejects(
    validateIssueArtifacts(issuesDirectory),
    (error: unknown) => {
      assert.ok(error instanceof StageArtifactValidationError);
      assert.equal(error.stage, "issues");
      assert.equal(error.artifactPath, issuesDirectory);
      return true;
    },
  );
});

test("validateIssueArtifacts rejects directories with no markdown issue files", async () => {
  const issuesDirectory = fs.mkdtempSync(join(tmpdir(), "devflow-issues-"));
  await fs.writeFile(join(issuesDirectory, "notes.txt"), "not an issue\n");

  await assert.rejects(
    validateIssueArtifacts(issuesDirectory),
    (error: unknown) => {
      assert.ok(error instanceof StageArtifactValidationError);
      assert.equal(error.stage, "issues");
      assert.equal(error.artifactPath, issuesDirectory);
      assert.match(error.message, /at least one non-empty markdown file/);
      return true;
    },
  );
});

test("validateIssueArtifacts rejects directories where all markdown issue files are whitespace-only", async () => {
  const issuesDirectory = fs.mkdtempSync(join(tmpdir(), "devflow-issues-"));
  await fs.writeFile(join(issuesDirectory, "first.md"), " \n\t\n");
  await fs.writeFile(join(issuesDirectory, "second.md"), "\n\n");

  await assert.rejects(
    validateIssueArtifacts(issuesDirectory),
    (error: unknown) => {
      assert.ok(error instanceof StageArtifactValidationError);
      assert.equal(error.stage, "issues");
      assert.equal(error.artifactPath, issuesDirectory);
      assert.match(error.message, /at least one non-empty markdown file/);
      return true;
    },
  );
});

test("validateIssueArtifacts accepts a mixed issues directory when one markdown file is non-empty", async () => {
  const issuesDirectory = fs.mkdtempSync(join(tmpdir(), "devflow-issues-"));
  await fs.writeFile(join(issuesDirectory, "empty.md"), "\n");
  await fs.writeFile(join(issuesDirectory, "valid.md"), "# Issue\n");
  await fs.writeFile(join(issuesDirectory, "also-empty.md"), "   ");

  await validateIssueArtifacts(issuesDirectory);
});

test("validateExecutionArtifact rejects malformed JSON ledgers", async () => {
  const artifactPath = join(
    fs.mkdtempSync(join(tmpdir(), "devflow-execution-artifact-")),
    "execution.json",
  );
  await fs.writeFile(artifactPath, '{"stage":"execute"');

  await assert.rejects(
    validateExecutionArtifact(artifactPath),
    (error: unknown) =>
      error instanceof StageArtifactValidationError &&
      error.stage === "execute" &&
      error.artifactPath === artifactPath &&
      error.message.includes("execution.json"),
  );
});

test("validateExecutionArtifact accepts zero-iteration no-file ledgers", async () => {
  const artifactPath = join(
    fs.mkdtempSync(join(tmpdir(), "devflow-execution-artifact-")),
    "execution.json",
  );
  await fs.writeJson(artifactPath, {
    stage: "execute",
    iterations: [],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: [],
      remainingIssueFilenames: [],
    },
  });

  await validateExecutionArtifact(artifactPath);
});

test("validateExecutionArtifact accepts well-formed ledgers with a final block", async () => {
  const artifactPath = join(
    fs.mkdtempSync(join(tmpdir(), "devflow-execution-artifact-")),
    "execution.json",
  );
  await fs.writeJson(artifactPath, {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
        providerSessionId: "provider-session-1",
        gitHeadBefore: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitHeadAfter: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: ["001-first.md"],
      remainingIssueFilenames: ["002-hitl.md"],
    },
  });

  await validateExecutionArtifact(artifactPath);
});

test("renderExecutePrompt injects manual-flow issue and commit context with artifact path references", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-execute-prompt-"));
  const issuesDirectory = join(projectRoot, ".devflow", "runs", "run123", "issues");
  const prdArtifactPath = join(projectRoot, ".devflow", "runs", "run123", "prd.md");
  const projectContextPath = join(projectRoot, ".devflow", "project-context.md");
  const tddGuidePath = join(projectRoot, "prompts", "tdd.md");

  await fs.outputFile(
    join(issuesDirectory, "001-first-afk.md"),
    "## Type\n\nAFK\n\n## What to build\n\nImplement first slice.\n",
  );
  await fs.outputFile(
    join(issuesDirectory, "notes.txt"),
    "This is not an issue file.\n",
  );

  const prompt = await renderExecutePrompt({
    issuesDirectory,
    recentCommits:
      "b13431b Extend managed session completion markers\n8e95fc2 Enhance documentation",
    prdArtifactPath,
    projectContextPath,
    tddGuidePath,
    iterationMarker: "DEVFLOW_EXECUTION_ITERATION_COMPLETE_test",
    terminalMarker: "DEVFLOW_EXECUTION_NO_MORE_TASKS_test",
  });

  assert.match(prompt, /001-first-afk\.md/);
  assert.match(prompt, /Implement first slice/);
  assert.match(prompt, /b13431b Extend managed session completion markers/);
  assert.match(prompt, new RegExp(escapeRegExp(prdArtifactPath)));
  assert.match(prompt, new RegExp(escapeRegExp(projectContextPath)));
  assert.match(prompt, new RegExp(escapeRegExp(tddGuidePath)));
  assert.match(prompt, /DEVFLOW_EXECUTION_ITERATION_COMPLETE_test/);
  assert.match(prompt, /DEVFLOW_EXECUTION_NO_MORE_TASKS_test/);
  assert.doesNotMatch(prompt, /This is not an issue file/);
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  assert.match(prompt, /complete exactly one AFK issue/i);
  assert.match(prompt, /move the issue file to `issues\/done\/` before committing/i);
  assert.match(prompt, /leave HITL issues untouched/i);
  assert.match(prompt, /discover the project-owned test, typecheck, and build commands/i);
  assert.doesNotMatch(prompt, /npm run test/);
  assert.doesNotMatch(prompt, /npm run typecheck/);
});

test("orchestrator runs one fresh execute iteration with rendered context and records the session result", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await baseDevFlowState.projectContext.write("# Project context\n", {
    refreshReason: "manual",
  });
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    git: {
      async getCurrentHead() {
        return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async getRecentCommits() {
        return [
          "0247da877ae9c3d8a9831875c2048ae24422a260",
          "2026-06-02",
          "Add execution ledger state support",
        ].join("\n");
      },
    },
  };
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const resumeSessionInputs: ManagedProviderSessionResumeInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (isIssuesSessionInput(input)) {
        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "004-run-one.md"),
          "## Type\n\nAFK\n\n## What to build\n\nRun one execution iteration.\n",
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        assert.equal(input.workingDirectory, projectRoot);
        assert.equal(input.model, "gpt-5");
        assert.match(
          input.initialCompletionMarker,
          /^DEVFLOW_EXECUTION_ITERATION_COMPLETE_[a-f0-9]{32}$/,
        );
        assert.match(
          input.initialTerminalCompletionMarker ?? "",
          /^DEVFLOW_EXECUTION_NO_MORE_TASKS_[a-f0-9]{32}$/,
        );
        assert.equal(input.phase?.kind, "execute");
        assert.equal(input.phase?.attempt, 1);
        assert.match(input.initialPrompt, /004-run-one\.md/);
        assert.match(input.initialPrompt, /Run one execution iteration/);
        assert.match(input.initialPrompt, /Add execution ledger state support/);
        assert.match(input.initialPrompt, /prd\.md/);
        assert.match(input.initialPrompt, /project-context\.md/);
        assert.match(input.initialPrompt, /prompts\/tdd\.md/);
        assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
        assert.equal(
          input.initialPrompt.includes(input.initialTerminalCompletionMarker ?? ""),
          true,
        );

        await input.onProviderEvent?.(
          createStructuredProviderEvent({
            type: "session-start",
            providerSessionId: "execute-provider-session-1",
            phaseId: input.phase?.id,
          }),
        );
        await input.validate();
        return {
          repairUsed: false,
          exitCode: 0,
          signal: null,
          matchedCompletionMarker: input.initialTerminalCompletionMarker,
          providerSessionId: "execute-provider-session-1",
        };
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
    async resumeSession(input) {
      resumeSessionInputs.push(input);
      throw new Error("Execution must not resume provider sessions.");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionInputs.filter(isExecuteSessionInput).length, 1);
  assert.equal(resumeSessionInputs.length, 0);

  const [runId] = await listRunDirectories(projectRoot);
  const runDirectory = join(projectRoot, ".devflow", "runs", runId);
  const executionLedger = await fs.readJson(join(runDirectory, "execution.json"));
  assert.deepEqual(executionLedger, {
    stage: "execute",
    iterations: [
      {
        iteration: 1,
        marker: runSessionInputs.filter(isExecuteSessionInput)[0]
          .initialTerminalCompletionMarker,
        providerSessionId: "execute-provider-session-1",
        gitHeadBefore: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gitHeadAfter: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    final: {
      stopReason: "terminal",
      completedIssueFilenames: [],
      remainingIssueFilenames: ["004-run-one.md"],
    },
  });
  await validateExecutionArtifact(join(runDirectory, "execution.json"));

  const providerSessionState = await fs.readJson(
    join(runDirectory, "provider-session.json"),
  );
  assert.equal(providerSessionState.providerSessionId, "execute-provider-session-1");
  assert.equal(providerSessionState.phase.kind, "execute");
  assert.equal(providerSessionState.status, "active");
});

test("orchestrator stops execute with no-file before opening a provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const runSessionInputs: ManagedProviderSessionInput[] = [];

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);

      if (isIssuesSessionInput(input)) {
        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "001-first.md"),
          "# First issue\n",
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        throw new Error("Execute session should not start when no files remain.");
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      async onStageStart(stage) {
        if (stage !== "execute") {
          return;
        }

        const [runId] = await listRunDirectories(projectRoot);
        await fs.remove(
          join(projectRoot, ".devflow", "runs", runId, "issues", "001-first.md"),
        );
      },
    },
  );

  assert.equal(runSessionInputs.filter(isExecuteSessionInput).length, 0);
  const [runId] = await listRunDirectories(projectRoot);
  assert.deepEqual(
    await fs.readJson(join(projectRoot, ".devflow", "runs", runId, "execution.json")),
    {
      stage: "execute",
      iterations: [],
      final: {
        stopReason: "no-file",
        completedIssueFilenames: [],
        remainingIssueFilenames: [],
      },
    },
  );
});

test("orchestrator loops fresh execute sessions until active issues are gone", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const executeInputs: ManagedProviderSessionInput[] = [];

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        const issuesDirectory = extractIssuesDirectory(input.initialPrompt);
        await fs.outputFile(join(issuesDirectory, "001-first.md"), "# First\n");
        await fs.outputFile(join(issuesDirectory, "002-second.md"), "# Second\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        executeInputs.push(input);
        await input.onProviderEvent?.(
          createStructuredProviderEvent({
            type: "session-start",
            providerSessionId: `execute-${executeInputs.length}`,
            phaseId: input.phase?.id,
          }),
        );
        const runDirectory = join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
        );
        const issueFilename =
          executeInputs.length === 1 ? "001-first.md" : "002-second.md";
        await fs.move(
          join(runDirectory, "issues", issueFilename),
          join(runDirectory, "issues", "done", issueFilename),
        );
        await input.validate();
        return {
          repairUsed: false,
          exitCode: 0,
          signal: null,
          matchedCompletionMarker: input.initialCompletionMarker,
        };
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(executeInputs.length, 2);
  assert.notEqual(executeInputs[0].phase?.id, executeInputs[1].phase?.id);
  const [runId] = await listRunDirectories(projectRoot);
  assert.deepEqual(
    await fs.readJson(join(projectRoot, ".devflow", "runs", runId, "execution.json")),
    {
      stage: "execute",
      iterations: [
        {
          iteration: 1,
          marker: executeInputs[0].initialCompletionMarker,
          gitHeadBefore: null,
          gitHeadAfter: null,
        },
        {
          iteration: 2,
          marker: executeInputs[1].initialCompletionMarker,
          gitHeadBefore: null,
          gitHeadAfter: null,
        },
      ],
      final: {
        stopReason: "no-file",
        completedIssueFilenames: ["001-first.md", "002-second.md"],
        remainingIssueFilenames: [],
      },
    },
  );
});

test("orchestrator stops execute with cap failure and writes the cap ledger", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let executeCallCount = 0;

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "001-first.md"),
          "# First\n",
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        executeCallCount += 1;
        await input.validate();
        return {
          repairUsed: false,
          exitCode: 0,
          signal: null,
          matchedCompletionMarker: input.initialCompletionMarker,
        };
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ExecutionLoopCapError && error.maxIterations === 7,
  );

  assert.equal(executeCallCount, 7);
  const [runId] = await listRunDirectories(projectRoot);
  const ledger = await fs.readJson(
    join(projectRoot, ".devflow", "runs", runId, "execution.json"),
  );
  assert.equal(ledger.final.stopReason, "cap");
  assert.equal(ledger.iterations.length, 7);
  assert.deepEqual(ledger.final.completedIssueFilenames, []);
  assert.deepEqual(ledger.final.remainingIssueFilenames, ["001-first.md"]);
});

test("orchestrator writes an error ledger before surfacing incomplete execute sessions", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");

  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "001-first.md"),
          "# First\n",
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    IncompleteProviderSessionError,
  );

  const [runId] = await listRunDirectories(projectRoot);
  const ledger = await fs.readJson(
    join(projectRoot, ".devflow", "runs", runId, "execution.json"),
  );
  assert.equal(ledger.final.stopReason, "error");
  assert.equal(ledger.iterations.length, 1);
  assert.deepEqual(ledger.final.completedIssueFilenames, []);
  assert.deepEqual(ledger.final.remainingIssueFilenames, ["001-first.md"]);
});

test("orchestrator resolves the selected built-in provider through a managed-session adapter factory", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const resolvedProviderIds: string[] = [];
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionInputs.push(input);
      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        resolvedProviderIds.push(providerId);
        return adapter;
      },
    },
  );

  assert.deepEqual(resolvedProviderIds, ["codex"]);
  assert.equal(runSessionInputs.length, 2);
  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
});

test("orchestrator can complete the active intent stage through a built-in Codex hook adapter", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n", {
    refreshReason: "manual",
  });
  const executablePath = await createExecutableOnPath(t, "codex");
  const sessionCalls: Array<{
    executable: string;
    args: string[];
    input: ManagedProviderSessionInput;
  }> = [];

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        return createBuiltInManagedSessionAdapter(providerId, {
          async runCodexHookDrivenSession(command, input) {
            sessionCalls.push({
              executable: command.executable,
              args: command.args,
              input,
            });

            assert.equal(input.workingDirectory, projectRoot);
            assert.equal(input.model, "gpt-5.5/fast beta");
            assert.equal(command.provider.id, "codex");
            assert.ok(
              command.args.some((arg) =>
                arg.includes(input.initialCompletionMarker),
              ),
            );

            if (isGrillSessionInput(input)) {
              return completeGrillSession(input);
            }

            if (isIssuesSessionInput(input)) {
              return completeIssuesSession(input);
            }

            if (isExecuteSessionInput(input)) {
              return completeExecuteSession(input);
            }

            await fs.outputJson(
              join(
                projectRoot,
                ".devflow",
                "runs",
                (await listRunDirectories(projectRoot))[0],
                "intent.json",
              ),
              {
                classification: "feature",
                summary: "Resume the current workstream.",
                rawTask: "resume work",
                needsClarification: false,
              },
              { spaces: 2 },
            );
            await input.validate();

            return { repairUsed: false, exitCode: 0, signal: null };
          },
        });
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(result.parsedIntent, {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
  assert.equal(result.bootstrapProvenance, "reused");
  assert.equal(sessionCalls.length, 4);
  assert.equal(sessionCalls[0]?.executable, executablePath);
  assert.equal(sessionCalls[0]?.args[0], "--model");
  assert.equal(sessionCalls[0]?.args[1], "gpt-5.5/fast beta");

  const runIds = await listRunDirectories(projectRoot);
  assert.deepEqual(
    await fs.readJson(
      join(projectRoot, ".devflow", "runs", runIds[0], "intent.json"),
    ),
    {
      classification: "feature",
      summary: "Resume the current workstream.",
      rawTask: "resume work",
      needsClarification: false,
    },
  );
});

test("orchestrator leaves Codex event-source selection behind the managed-session adapter boundary", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const capabilitiesSeen: Array<string | undefined> = [];
  const sessionPhaseKinds: Array<string | undefined> = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      capabilitiesSeen.push(adapter.capabilities?.eventSource);
      sessionPhaseKinds.push(input.phase?.kind);

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        assert.equal(providerId, "codex");
        return adapter;
      },
    },
  );

  assert.deepEqual(capabilitiesSeen, ["jsonl", "jsonl"]);
  assert.deepEqual(sessionPhaseKinds, ["intent", "grill"]);
  assert.deepEqual(result.intent, {
    repairUsed: false,
    exitCode: 0,
    signal: null,
  });
});

test("orchestrator reports intent repair metadata from a built-in provider adapter", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  await createExecutableOnPath(t, "codex");
  const repairResults: ManagedProviderSessionResult[] = [];

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        return createBuiltInManagedSessionAdapter(providerId, {
          async runCodexHookDrivenSession(_command, input) {
            if (isGrillSessionInput(input)) {
              return completeGrillSession(input);
            }

            if (isIssuesSessionInput(input)) {
              return completeIssuesSession(input);
            }

            if (isExecuteSessionInput(input)) {
              return completeExecuteSession(input);
            }

            await assert.rejects(input.validate());
            assert.ok(input.repair);
            const repairPrompt = input.repair.renderPrompt(
              new Error("intent artifact missing"),
            );
            assert.match(repairPrompt, /Repair only the intent artifact/);

            await fs.outputJson(
              join(
                projectRoot,
                ".devflow",
                "runs",
                (await listRunDirectories(projectRoot))[0],
                "intent.json",
              ),
              {
                classification: "feature",
                summary: "Resume the current workstream.",
                rawTask: "resume work",
                needsClarification: false,
              },
              { spaces: 2 },
            );
            await input.validate();

            const sessionResult = {
              repairUsed: true,
              exitCode: 0,
              signal: null,
            };
            repairResults.push(sessionResult);
            return sessionResult;
          },
        });
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: true,
    exitCode: 0,
    signal: null,
  });
  assert.deepEqual(repairResults, [result.intent]);
});

test("orchestrator retries a retryable intent provider-session failure inside the same run", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const artifactPaths: string[] = [];
  const initialCompletionMarkers: string[] = [];
  const initialPrompts: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      initialCompletionMarkers.push(input.initialCompletionMarker);
      initialPrompts.push(input.initialPrompt);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          artifactPath,
          {
            classification: "feature",
            summary: "stale failed attempt",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal((await listRunDirectories(projectRoot)).length, 1);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.notEqual(initialCompletionMarkers[0], initialCompletionMarkers[1]);
  assert.match(initialPrompts[0], new RegExp(initialCompletionMarkers[0]));
  assert.match(initialPrompts[1], new RegExp(initialCompletionMarkers[1]));
  assert.deepEqual(
    stages.filter((stage) => stage === "intent"),
    ["intent"],
  );
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
});

test("orchestrator retries intent after failed in-session repair and accepts a valid retry repair", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const artifactPaths: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  const initialCompletionMarkers: string[] = [];
  const repairCompletionMarkers: string[] = [];
  const initialPrompts: string[] = [];
  const repairPrompts: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));
      initialCompletionMarkers.push(input.initialCompletionMarker);
      initialPrompts.push(input.initialPrompt);
      assert.ok(input.repair);
      repairCompletionMarkers.push(input.repair.completionMarker);

      await assert.rejects(input.validate());
      const repairPrompt = input.repair.renderPrompt(
        new Error(`attempt ${runSessionCallCount} invalid intent`),
      );
      repairPrompts.push(repairPrompt);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          artifactPath,
          {
            classification: "feature",
            summary: "",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );

        try {
          await input.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw input.repair.mapFailure(repairError);
        }
      }

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.deepEqual(result.intent, {
    repairUsed: true,
    exitCode: 0,
    signal: null,
  });
  assert.equal(runSessionCallCount, 2);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.notEqual(initialCompletionMarkers[0], initialCompletionMarkers[1]);
  assert.notEqual(repairCompletionMarkers[0], repairCompletionMarkers[1]);
  assert.match(initialPrompts[0], new RegExp(initialCompletionMarkers[0]));
  assert.match(initialPrompts[1], new RegExp(initialCompletionMarkers[1]));
  assert.match(repairPrompts[0], new RegExp(repairCompletionMarkers[0]));
  assert.match(repairPrompts[1], new RegExp(repairCompletionMarkers[1]));
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
});

test("orchestrator raises a typed retry-exhausted error and preserves the final failed intent artifact", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const artifactPaths: string[] = [];
  const artifactExistedAtAttemptStart: boolean[] = [];
  const finalFailureMessages: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const artifactPath = join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "intent.json",
      );

      artifactPaths.push(artifactPath);
      artifactExistedAtAttemptStart.push(await fs.pathExists(artifactPath));

      await fs.outputJson(
        artifactPath,
        {
          classification: "feature",
          summary:
            runSessionCallCount === 1
              ? "first failed attempt"
              : "final failed attempt",
          rawTask: "resume work",
          needsClarification: "no",
        },
        { spaces: 2 },
      );

      try {
        await input.validate();
      } catch (validationError) {
        assert.ok(validationError instanceof Error);
        const failure = input.repair?.mapFailure(validationError);
        assert.ok(failure instanceof StageArtifactValidationError);
        finalFailureMessages.push(failure.message);
        throw failure;
      }

      throw new Error("Invalid intent artifact unexpectedly passed validation.");
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.message === finalFailureMessages[1],
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(artifactPaths[0], artifactPaths[1]);
  assert.deepEqual(artifactExistedAtAttemptStart, [false, false]);
  assert.deepEqual(await fs.readJson(artifactPaths[1]), {
    classification: "feature",
    summary: "final failed attempt",
    rawTask: "resume work",
    needsClarification: "no",
  });
});

test("orchestrator passes intent and grill stage inputs to managed provider sessions", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runSessionInputs.push(input);
      assert.equal(input.workingDirectory, projectRoot);
      assert.equal(input.model, "gpt-5.5/fast beta");
      assert.equal("stage" in input, false);
      assert.equal("artifactPath" in input, false);
      assert.equal("context" in input, false);

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (input.initialCompletionMarker.startsWith("DEVFLOW_INTENT_COMPLETE_")) {
        assert.ok(input.phase?.id, "expected intent phase id");
        assert.equal(input.phase.kind, "intent");
        assert.equal(input.phase.attempt, 1);
        assert.match(input.initialCompletionMarker, /^DEVFLOW_INTENT_COMPLETE_[a-f0-9]{32}$/);
        assert.match(input.initialPrompt, /Classify only the raw task/);
        assert.match(input.initialPrompt, /Raw task:\nresume work/);
        assert.doesNotMatch(input.initialPrompt, /Project context/);
        assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
        assert.match(input.initialPrompt, /\/\.devflow\/runs\/[a-z0-9]{12}\/intent\.json/);

        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
      } else if (isIssuesSessionInput(input)) {
        assert.ok(input.phase?.id, "expected issues phase id");
        assert.equal(input.phase.kind, "issues");
        assert.equal(input.phase.attempt, 1);
        assertIssuesPromptContract(input);

        await fs.outputFile(
          join(runDirectory, "issues", "first-issue.md"),
          "# First issue\n",
        );
      } else if (isExecuteSessionInput(input)) {
        assert.ok(input.phase?.id, "expected execute phase id");
        assert.equal(input.phase.kind, "execute");
        assert.equal(input.phase.attempt, 1);
        return completeExecuteSession(input);
      } else {
        assert.ok(input.phase?.id, "expected grill phase id");
        assert.equal(input.phase.kind, "grill");
        assert.equal(input.phase.attempt, 1);
        assert.match(input.initialCompletionMarker, /^DEVFLOW_GRILL_COMPLETE_[a-f0-9]{32}$/);
        assert.match(input.initialPrompt, /Run the interactive grill stage/);
        assert.match(input.initialPrompt, /Raw task:\nresume work/);
        assert.match(input.initialPrompt, /Intent artifact:/);
        assert.match(input.initialPrompt, /"needsClarification": false/);
        assert.match(input.initialPrompt, /Project context path:/);
        assert.match(input.initialPrompt, /Ask one question at a time/);
        assert.match(input.initialPrompt, /recommended answers/);
        assert.match(input.initialPrompt, /Inspect the repository/);
        assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);
        assert.ok(input.transcript);

        await input.transcript.onProviderOutput?.("What tradeoff matters?\n");
        await input.transcript.onSubmittedUserMessage?.("Prefer simple contracts.\n");
      }

      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
      model: "gpt-5.5/fast beta",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  assert.equal(runSessionInputs.length, 4);

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
  const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

  assert.deepEqual(await fs.readJson(join(runDirectory, "intent.json")), {
    classification: "feature",
    summary: "Resume the current workstream.",
    rawTask: "resume work",
    needsClarification: false,
  });
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD\n");
  assert.equal(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    [
      "# Grill Transcript",
      "",
      "## Attempt 1",
      "",
      "## Provider",
      "",
      "What tradeoff matters?",
      "",
      "## User",
      "",
      "Prefer simple contracts.",
      "",
      DEVFLOW_GRILL_TRANSCRIPT_COMPLETE,
      "",
    ].join("\n"),
  );
  const grillCheckpoint = await fs.readJson(
    join(runDirectory, "grill-checkpoint.json"),
  );
  assert.deepEqual(
    {
      ...grillCheckpoint,
      completedAt: "<iso>",
    },
    {
      stage: "grill",
      status: "complete",
      completedAt: "<iso>",
      rawTask: "resume work",
      intentArtifactPath: join(runDirectory, "intent.json"),
      projectContextPath: join(projectRoot, ".devflow", "project-context.md"),
      grillTranscriptPath: join(runDirectory, "grill-transcript.md"),
      prdArtifactPath: join(runDirectory, "prd.md"),
    },
  );
  assert.match(grillCheckpoint.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    await fs.readFile(join(runDirectory, "issues", "first-issue.md"), "utf8"),
    "# First issue\n",
  );
  assert.equal(await fs.pathExists(join(runDirectory, "validation.json")), false);
});

test("orchestrator leaves provider-authored issues untouched after execute", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const issueAccessesAfterIssuesStage: string[] = [];
  let runDirectory = "";
  let issuesDirectory = "";
  let issueFilePath = "";
  let issueContentBeforeDownstream = "";
  let issueMtimeBeforeDownstream = 0;
  let issueDirectoryEntriesBeforeDownstream: string[] = [];
  let restoreIssuesAccessGuard = () => {};

  function isIssuePath(value: unknown): boolean {
    return (
      typeof value === "string" &&
      issuesDirectory.length > 0 &&
      (value === issuesDirectory || value.startsWith(`${issuesDirectory}/`))
    );
  }

  function installIssuesAccessGuard(): void {
    const guardedMethods = [
      "readdir",
      "readFile",
      "writeFile",
      "outputFile",
      "remove",
      "unlink",
      "move",
    ] as const;
    const originals = new Map<string, unknown>();

    for (const method of guardedMethods) {
      const original = fs[method];
      originals.set(method, original);
      (fs as Record<string, unknown>)[method] = async (
        pathOrSource: unknown,
        ...args: unknown[]
      ) => {
        if (isIssuePath(pathOrSource) || isIssuePath(args[0])) {
          issueAccessesAfterIssuesStage.push(`${method}:${String(pathOrSource)}`);
          throw new Error(
            `Downstream stages must not access issue artifacts after issues validation: ${method} ${String(pathOrSource)}`,
          );
        }

        return (original as (...methodArgs: unknown[]) => unknown)(
          pathOrSource,
          ...args,
        );
      };
    }

    restoreIssuesAccessGuard = () => {
      for (const [method, original] of originals) {
        (fs as Record<string, unknown>)[method] = original;
      }
    };
    t.after(restoreIssuesAccessGuard);
  }

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isIssuesSessionInput(input)) {
        issuesDirectory = extractIssuesDirectory(input.initialPrompt);
        issueFilePath = join(issuesDirectory, "provider-authored-dag.md");
        await fs.outputFile(
          issueFilePath,
          [
            "## Type",
            "",
            "HITL",
            "",
            "## Acceptance criteria",
            "",
            "- [ ] Do not mark this complete.",
            "",
            "## Blocked by",
            "",
            "- `missing-provider-authored-sibling`",
            "",
            "This intentionally contains unresolved HITL and blocked-by data.",
            "",
          ].join("\n"),
        );

        await input.validate();
        issueContentBeforeDownstream = await fs.readFile(issueFilePath, "utf8");
        issueMtimeBeforeDownstream = (await fs.stat(issueFilePath)).mtimeMs;
        issueDirectoryEntriesBeforeDownstream = (
          await fs.readdir(issuesDirectory)
        ).sort();

        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        assert.match(input.initialPrompt, /provider-authored-dag\.md/);
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Keep downstream issue consumers out of scope.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );
  restoreIssuesAccessGuard();

  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  assert.deepEqual(issueAccessesAfterIssuesStage, []);
  assert.deepEqual((await fs.readdir(issuesDirectory)).sort(), issueDirectoryEntriesBeforeDownstream);
  assert.equal(await fs.readFile(issueFilePath, "utf8"), issueContentBeforeDownstream);
  assert.equal((await fs.stat(issueFilePath)).mtimeMs, issueMtimeBeforeDownstream);
  assert.equal(await fs.pathExists(join(runDirectory, "validation.json")), false);
  assert.equal(await fs.pathExists(join(issuesDirectory, "done")), false);
});

test("orchestrator repairs missing issue files inside the same issues managed session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let issuesRunSessionCount = 0;
  const repairPrompts: string[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        issuesRunSessionCount += 1;
        assert.ok(input.phase?.id, "expected issues phase id");
        assert.equal(input.phase.kind, "issues");
        assert.equal(input.phase.attempt, 1);
        await fs.ensureDir(extractIssuesDirectory(input.initialPrompt));

        const initialValidationError = await input.validate().then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(initialValidationError instanceof Error);
        assert.ok(input.repair);
        assert.ok(input.repair.phase?.id, "expected issues repair phase id");
        assert.equal(input.repair.phase.kind, "issues-repair");
        assert.equal(input.repair.phase.attempt, 1);
        assert.notEqual(input.repair.phase.id, input.phase.id);
        assert.match(
          input.repair.completionMarker,
          /^DEVFLOW_ISSUES_REPAIR_COMPLETE_[a-f0-9]{32}$/,
        );

        const repairPrompt = input.repair.renderPrompt(initialValidationError);
        repairPrompts.push(repairPrompt);
        assert.match(repairPrompt, /Repair only the issue decomposition artifacts/);
        assert.match(repairPrompt, /Issues directory:\n.+\/issues/);
        assert.match(repairPrompt, /at least one non-empty markdown file/i);
        assert.match(
          repairPrompt,
          /Write at least one non-empty issue markdown file directly to the issues directory\./,
        );
        assert.match(repairPrompt, new RegExp(input.repair.completionMarker));

        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "repaired-issue.md"),
          "# Repaired issue\n",
        );
        await input.validate();

        return { repairUsed: true, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );
      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(issuesRunSessionCount, 1);
  assert.equal(repairPrompts.length, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(
    await fs.readFile(join(runDirectory, "issues", "repaired-issue.md"), "utf8"),
    "# Repaired issue\n",
  );
});

test("orchestrator surfaces issues validation failure after failed in-session repair", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let issuesRunSessionCount = 0;
  const repairPrompts: string[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        issuesRunSessionCount += 1;
        await fs.ensureDir(extractIssuesDirectory(input.initialPrompt));
        const initialValidationError = await input.validate().then(
          () => undefined,
          (error: unknown) => error,
        );
        assert.ok(initialValidationError instanceof Error);
        assert.ok(input.repair);
        repairPrompts.push(input.repair.renderPrompt(initialValidationError));

        try {
          await input.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw input.repair.mapFailure(repairError);
        }
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );
      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "issues" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.artifactPath.endsWith("/issues") &&
      error.cause.message.includes("at least one non-empty markdown file"),
  );

  assert.equal(issuesRunSessionCount, 2);
  assert.equal(repairPrompts.length, 2);
});

test("orchestrator retries issues with a clean issues directory without repeating grill or PRD", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const stages: PipelineStage[] = [];
  const staleIssueExistedAtAttemptStart: boolean[] = [];
  let issuesRunSessionCount = 0;
  let grillRunSessionCount = 0;
  let prdContinuationCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        issuesRunSessionCount += 1;
        const issuesDirectory = extractIssuesDirectory(input.initialPrompt);

        assert.ok(input.phase?.id, "expected issues phase id");
        assert.equal(input.phase.kind, "issues");
        assert.equal(input.phase.attempt, issuesRunSessionCount);
        staleIssueExistedAtAttemptStart.push(
          await fs.pathExists(join(issuesDirectory, "stale-issue.md")),
        );

        if (issuesRunSessionCount === 1) {
          await fs.outputFile(
            join(issuesDirectory, "stale-issue.md"),
            "# Stale issue\n",
          );
          throw new IncompleteProviderSessionError({
            provider,
            completionMarker: input.initialCompletionMarker,
            exitCode: 1,
            signal: null,
          });
        }

        await fs.outputFile(
          join(issuesDirectory, "fresh-issue.md"),
          "# Fresh issue\n",
        );
        await input.validate();

        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        grillRunSessionCount += 1;
        const originalContinuations = input.continuations ?? [];
        return completeGrillSession({
          ...input,
          continuations: originalContinuations.map((continuation) => ({
            ...continuation,
            async validate() {
              prdContinuationCount += 1;
              await continuation.validate();
            },
          })),
        });
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );
      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(issuesRunSessionCount, 2);
  assert.deepEqual(staleIssueExistedAtAttemptStart, [false, false]);
  assert.equal(
    await fs.pathExists(join(runDirectory, "issues", "stale-issue.md")),
    false,
  );
  assert.equal(
    await fs.readFile(join(runDirectory, "issues", "fresh-issue.md"), "utf8"),
    "# Fresh issue\n",
  );
  assert.equal(grillRunSessionCount, 1);
  assert.equal(prdContinuationCount, 1);
  assert.deepEqual(
    stages.filter((stage) => stage === "grill" || stage === "prd"),
    ["grill", "prd"],
  );
});

test("orchestrator persists provider session metadata for the dedicated issues session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let issuesRunSessionCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        issuesRunSessionCount += 1;
        assert.ok(input.onProviderEvent);
        assert.ok(input.phase?.id, "expected issues phase id");
        assert.equal(input.phase.kind, "issues");
        assert.equal(input.phase.attempt, 1);
        assert.ok(input.repair?.phase?.id, "expected issues repair phase id");
        assert.equal(input.repair.phase.kind, "issues-repair");

        await input.onProviderEvent(
          createStructuredProviderEvent(
            {
              type: "session-start",
              phaseId: input.phase.id,
              providerSessionId: "codex-issues-session",
            },
            "hooks",
            provider,
          ),
        );
        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "provider-backed.md"),
          "# Provider-backed issue\n",
        );
        await input.validate();
        await input.onProviderEvent(
          createStructuredProviderEvent(
            {
              type: "session-completed",
              phaseId: input.phase.id,
              providerSessionId: "codex-issues-session",
              exitCode: 0,
              signal: null,
            },
            "hooks",
            provider,
          ),
        );

        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );
      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
    async resumeSession() {
      throw new Error("issues orchestration should not resume provider sessions");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const providerSessionState = await fs.readJson(
    join(runDirectory, "provider-session.json"),
  );

  assert.equal(issuesRunSessionCount, 1);
  assert.deepEqual(providerSessionState.provider, provider);
  assert.equal(providerSessionState.providerSessionId, "codex-issues-session");
  assert.equal(providerSessionState.phase.kind, "issues");
  assert.equal(providerSessionState.phase.attempt, 1);
  assert.equal(providerSessionState.status, "completed");
});

test("orchestrator retries issues in fresh sessions without resuming prior issues metadata", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const issuesPrompts: string[] = [];
  const issuesCompletionMarkers: string[] = [];
  let issuesRunSessionCount = 0;
  let resumeCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        issuesRunSessionCount += 1;
        issuesPrompts.push(input.initialPrompt);
        issuesCompletionMarkers.push(input.initialCompletionMarker);
        assert.ok(input.onProviderEvent);
        assert.ok(input.phase?.id, "expected issues phase id");
        assert.equal(input.phase.kind, "issues");
        assert.equal(input.phase.attempt, issuesRunSessionCount);
        assertIssuesPromptContract(input);
        assert.doesNotMatch(input.initialPrompt, /grill-transcript\.md/);
        assert.doesNotMatch(input.initialPrompt, /What tradeoff matters/);
        assert.doesNotMatch(input.initialPrompt, /Continue the interrupted/);

        if (issuesRunSessionCount === 1) {
          await input.onProviderEvent(
            createStructuredProviderEvent(
              {
                type: "session-start",
                phaseId: input.phase.id,
                providerSessionId: "stale-issues-session",
              },
              "hooks",
              provider,
            ),
          );
          throw new IncompleteProviderSessionError({
            provider,
            completionMarker: input.initialCompletionMarker,
            exitCode: 1,
            signal: null,
          });
        }

        await fs.outputFile(
          join(extractIssuesDirectory(input.initialPrompt), "fresh-session.md"),
          "# Fresh session issue\n",
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        await input.transcript?.onProviderOutput?.("What tradeoff matters?\n");
        return completeGrillSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );
      await fs.outputJson(
        join(runDirectory, "intent.json"),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
    async resumeSession() {
      resumeCallCount += 1;
      throw new Error("issues retry attempts must use runSession");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(issuesRunSessionCount, 2);
  assert.equal(resumeCallCount, 0);
  assert.equal(issuesCompletionMarkers.length, 2);
  assert.notEqual(issuesCompletionMarkers[0], issuesCompletionMarkers[1]);
  assert.equal(
    issuesPrompts[0].match(/Canonical PRD artifact path:\n([^\n]+)/)?.[1],
    issuesPrompts[1].match(/Canonical PRD artifact path:\n([^\n]+)/)?.[1],
  );
  assert.equal(
    issuesPrompts[0].match(/Project context path:\n([^\n]+)/)?.[1],
    issuesPrompts[1].match(/Project context path:\n([^\n]+)/)?.[1],
  );
});

test("structured-provider grill orchestration records normalized events instead of raw transcript callbacks", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.equal(input.transcript, undefined);
      assert.ok(input.onProviderEvent);

      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: [
            "What tradeoff matters?",
            input.initialCompletionMarker,
            "Provider protocol text that must not be persisted.",
          ].join("\n"),
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "submitted-user-message",
          message: "Prefer simple contracts.",
          origin: "human",
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "submitted-user-message",
          message: "managed PRD continuation prompt",
          origin: "managed",
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const transcript = await fs.readFile(
    join(runDirectory, "grill-transcript.md"),
    "utf8",
  );

  assert.match(transcript, /What tradeoff matters\?/);
  assert.match(transcript, /Prefer simple contracts\./);
  assert.doesNotMatch(transcript, /Provider protocol text/);
  assert.doesNotMatch(transcript, /managed PRD continuation prompt/);
  assert.match(transcript, new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`));
  assert.equal(await fs.pathExists(join(runDirectory, "grill-checkpoint.json")), true);
});

test("orchestrator persists reliable provider session ids from normalized session-start events", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "session-start",
          providerSessionId: "codex-session-123",
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Ready ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const state = await fs.readJson(join(runDirectory, "provider-session.json"));

  assert.deepEqual(
    {
      provider: state.provider,
      providerSessionId: state.providerSessionId,
      phase: state.phase,
      status: state.status,
    },
    {
      provider: getBuiltInProviderIdentity("codex"),
      providerSessionId: "codex-session-123",
      phase: {
        id: `${(await listRunDirectories(projectRoot))[0]}:grill:attempt-1`,
        kind: "grill",
        attempt: 1,
      },
      status: "active",
    },
  );
  assert.match(state.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("orchestrator refreshes provider session state from later normalized turn events", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let prdPhaseId = "";
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: input.phase?.id,
          assistantMessage: `Grill ready ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      assert.ok(continuation.phase?.id);
      prdPhaseId = continuation.phase.id;
      await continuation.onStart?.();
      await fs.outputFile(extractPrdArtifactPath(continuation.prompt), "# PRD\n");
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: continuation.phase.id,
          providerSessionId: "codex-session-late",
          assistantMessage: `PRD ready ${continuation.completionMarker}`,
        }),
      );
      await continuation.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const state = await fs.readJson(join(runDirectory, "provider-session.json"));

  assert.equal(state.providerSessionId, "codex-session-late");
  assert.deepEqual(state.phase, {
    id: prdPhaseId,
    kind: "prd",
    attempt: 1,
  });
  assert.equal(state.status, "active");
});

test("interrupted incomplete grill recovery resumes a reliable provider session before partial-transcript fallback", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const resumeSessionInputs: ManagedProviderSessionResumeInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionInputs.push(input);
      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "session-start",
          providerSessionId: "codex-grill-session-1",
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: "What decision remains?",
        }),
      );

      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: input.initialCompletionMarker,
        exitCode: 1,
        signal: null,
      });
    },
    async resumeSession(input) {
      resumeSessionInputs.push(input);
      assert.equal(input.providerSessionId, "codex-grill-session-1");
      assert.match(input.initialPrompt, /Continue the interrupted grill/);
      assert.match(input.initialPrompt, /Ask the next unresolved question one at a time/);
      assert.match(input.initialPrompt, /print only/);
      assert.doesNotMatch(input.initialPrompt, /Partial grill transcript path/);
      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          providerSessionId: "codex-grill-session-1",
          assistantMessage: `Resolved ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionInputs.filter(isGrillSessionInput).length, 1);
  assert.equal(resumeSessionInputs.length, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    /Resolved/,
  );
  assert.equal(await fs.pathExists(join(runDirectory, "grill-checkpoint.json")), true);
});

test("failed grill resume falls back once to a fresh partial-transcript grill attempt", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const grillPrompts: string[] = [];
  let resumeCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillPrompts.push(input.initialPrompt);

      if (grillPrompts.length === 1) {
        assert.ok(input.onProviderEvent);
        await input.onProviderEvent(
          createStructuredProviderEvent({
            type: "session-start",
            providerSessionId: "codex-grill-session-2",
          }),
        );
        await input.onProviderEvent(
          createStructuredProviderEvent({
            type: "turn-completed",
            assistantMessage: "Partial question",
          }),
        );
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      assert.match(input.initialPrompt, /Partial grill transcript path/);
      assert.doesNotMatch(input.initialPrompt, /Continue the interrupted grill/);
      await input.onProviderEvent?.(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Fallback complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
    async resumeSession(input) {
      resumeCallCount += 1;
      throw new ProviderSessionLaunchError(provider, new Error(input.providerSessionId));
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 1);
  assert.equal(grillPrompts.length, 2);
});

test("unsupported grill resume keeps the partial-transcript new attempt path", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const grillPrompts: string[] = [];
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillPrompts.push(input.initialPrompt);

      if (grillPrompts.length === 1) {
        assert.ok(input.onProviderEvent);
        await input.onProviderEvent(
          createStructuredProviderEvent({
            type: "session-start",
            providerSessionId: "codex-grill-session-3",
          }),
        );
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      assert.match(input.initialPrompt, /Partial grill transcript path/);
      await input.onProviderEvent?.(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Fallback complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(grillPrompts.length, 2);
});

test("grill resume does not accept session-completed without marker observation", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let resumeCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (resumeCallCount === 0) {
        await input.onProviderEvent?.(
          createStructuredProviderEvent({
            type: "session-start",
            providerSessionId: "codex-grill-session-4",
          }),
        );
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      await input.onProviderEvent?.(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Fallback complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);
      return { repairUsed: false, exitCode: 0, signal: null };
    },
    async resumeSession(input) {
      resumeCallCount += 1;
      await input.onProviderEvent?.(
        createStructuredProviderEvent({
          type: "session-completed",
          providerSessionId: "codex-grill-session-4",
          exitCode: 0,
          signal: null,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    /Fallback complete/,
  );
});

test("orchestrator leaves fallback providers without reliable session ids on existing transcript behavior", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("claude"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "pty",
      supportsProviderSessionId: false,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: false,
    },
    async detect() {
      return { isAvailable: true, executable: "claude" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.transcript);
      await input.onProviderEvent?.(
        {
          type: "session-start",
          provider: getBuiltInProviderIdentity("claude"),
          source: "pty",
          structured: false,
          providerSessionId: "unreliable-pty-id",
        },
      );
      await input.transcript.onProviderOutput?.("Fallback transcript content.\n");
      await input.transcript.onSubmittedUserMessage?.("Fallback user reply.\n");
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "claude",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );

  assert.equal(
    await fs.pathExists(join(runDirectory, "provider-session.json")),
    false,
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    /Fallback transcript content\./,
  );
});

test("structured Codex JSONL grill orchestration records transcripts from normalized events", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "jsonl",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.equal(input.transcript, undefined);
      assert.ok(input.onProviderEvent);

      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "turn-completed",
            assistantMessage: [
              "What should JSONL preserve?",
              input.initialCompletionMarker,
              "Codex protocol text that must not be persisted.",
            ].join("\n"),
          },
          "jsonl",
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "submitted-user-message",
            message: "Only reliable human replies.",
            origin: "human",
          },
          "jsonl",
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "submitted-user-message",
            message: "managed JSONL continuation prompt",
            origin: "managed",
          },
          "jsonl",
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "submitted-user-message",
            message: "unknown JSONL echo",
            origin: "unknown",
          },
          "jsonl",
        ),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const transcript = await fs.readFile(
    join(runDirectory, "grill-transcript.md"),
    "utf8",
  );

  assert.match(transcript, /What should JSONL preserve\?/);
  assert.match(transcript, /Only reliable human replies\./);
  assert.doesNotMatch(transcript, /Codex protocol text/);
  assert.doesNotMatch(transcript, /managed JSONL continuation prompt/);
  assert.doesNotMatch(transcript, /unknown JSONL echo/);
  assert.match(transcript, new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`));
  assert.equal(await fs.pathExists(join(runDirectory, "grill-checkpoint.json")), true);
});

test("structured Claude hook grill orchestration records normalized events and provider session ids", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("claude");
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "claude" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await input.onProviderEvent?.(
          createStructuredProviderEvent(
            {
              type: "session-start",
              providerSessionId: "claude-intent-session",
            },
            "hooks",
            provider,
          ),
        );
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.equal(input.transcript, undefined);
      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "session-start",
            providerSessionId: "claude-grill-session",
          },
          "hooks",
          provider,
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "submitted-user-message",
            message: "Start",
            origin: "managed",
            providerSessionId: "claude-grill-session",
          },
          "hooks",
          provider,
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "turn-completed",
            assistantMessage: "Claude question from normalized assistant content.",
            providerSessionId: "claude-grill-session",
          },
          "hooks",
          provider,
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "submitted-user-message",
            message: "Use normalized Claude hook events.",
            origin: "human",
            providerSessionId: "claude-grill-session",
          },
          "hooks",
          provider,
        ),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent(
          {
            type: "turn-completed",
            assistantMessage: [
              "Accepted Claude hook answer.",
              input.initialCompletionMarker,
              "Claude hook protocol tail that must not be persisted.",
            ].join("\n"),
            providerSessionId: "claude-grill-session",
          },
          "hooks",
          provider,
        ),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "claude",
    },
    {
      devFlowState,
      createManagedSessionAdapter(providerId) {
        assert.equal(providerId, "claude");
        return adapter;
      },
    },
  );

  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const transcript = await fs.readFile(
    join(runDirectory, "grill-transcript.md"),
    "utf8",
  );
  const providerSessionState = await fs.readJson(
    join(runDirectory, "provider-session.json"),
  );

  assert.match(transcript, /Use normalized Claude hook events\./);
  assert.match(transcript, /Claude question from normalized assistant content\./);
  assert.match(transcript, /Accepted Claude hook answer\./);
  assert.doesNotMatch(transcript, /Start/);
  assert.doesNotMatch(transcript, /hook_event_name/);
  assert.doesNotMatch(transcript, /session_id/);
  assert.doesNotMatch(transcript, /Claude hook protocol tail/);
  assert.deepEqual(providerSessionState.provider, provider);
  assert.equal(providerSessionState.providerSessionId, "claude-grill-session");
  assert.equal(providerSessionState.phase.kind, "grill");
  assert.equal(providerSessionState.status, "active");
});

test("structured-provider grill orchestration keeps repair discussion before accepted completion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Initial completion ${input.initialCompletionMarker} protocol`,
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "submitted-user-message",
          message: "Repair the decision before accepting completion.",
          origin: "human",
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Revised accepted completion ${input.initialCompletionMarker} protocol`,
        }),
      );
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  const transcript = await fs.readFile(
    join(
      projectRoot,
      ".devflow",
      "runs",
      (await listRunDirectories(projectRoot))[0],
      "grill-transcript.md",
    ),
    "utf8",
  );

  assert.match(transcript, /Initial completion/);
  assert.match(transcript, /Repair the decision before accepting completion\./);
  assert.match(transcript, /Revised accepted completion/);
  assert.doesNotMatch(transcript, / protocol/);
});

test("structured-provider grill transcript persistence failures retry without writing a checkpoint", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await baseDevFlowState.projectContext.write("# Project context\n");
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    async createRun() {
      const run = await baseDevFlowState.createRun();

      return {
        ...run,
        async completeGrillTranscript() {
          throw new Error("transcript write failed");
        },
      };
    },
  };
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: false,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          assistantMessage: `Ready ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "grill" &&
      error.cause instanceof ProviderSessionTranscriptCaptureError &&
      error.cause.message.includes("transcript write failed"),
  );

  assert.equal(grillCallCount, 2);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.pathExists(join(runDirectory, "grill-checkpoint.json")), false);
});

test("orchestrator retries a partial grill attempt from the same transcript", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const grillPrompts: string[] = [];
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        return completePrdSession(input);
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      grillPrompts.push(input.initialPrompt);

      if (grillCallCount === 1) {
        await input.transcript?.onProviderOutput?.("Which state should survive?\n");
        await input.transcript?.onSubmittedUserMessage?.("Keep answered decisions.\n");
        throw new IncompleteProviderSessionError({
          provider,
          completionMarker: input.initialCompletionMarker,
          exitCode: 1,
          signal: null,
        });
      }

      assert.match(input.initialPrompt, /Partial grill transcript path:/);
      assert.match(input.initialPrompt, /grill-transcript\.md/);
      assert.match(
        input.initialPrompt,
        /Do not repeat resolved questions unless necessary/,
      );
      await input.transcript?.onProviderOutput?.("Any retry constraint?\n");
      await input.transcript?.onSubmittedUserMessage?.("Use the same transcript.\n");
      await input.validate();
      await completeSessionContinuations(input);

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(grillCallCount, 2);
  assert.doesNotMatch(grillPrompts[0], /Partial grill transcript path:/);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const transcript = await fs.readFile(
    join(runDirectory, "grill-transcript.md"),
    "utf8",
  );

  assert.match(transcript, /## Attempt 1/);
  assert.match(transcript, /Which state should survive\?/);
  assert.match(transcript, /Keep answered decisions\./);
  assert.match(
    transcript,
    /Attempt failed before completion:\nProvider session for "codex" ended before completion marker/,
  );
  assert.match(transcript, /## Attempt 2/);
  assert.match(transcript, /Any retry constraint\?/);
  assert.match(transcript, /Use the same transcript\./);
  assert.match(transcript, new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`));
  assert.ok(
    transcript.indexOf("Which state should survive?") <
      transcript.indexOf("Any retry constraint?"),
  );
});

test("orchestrator exhausts grill retries after two pre-completion attempts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      await input.transcript?.onProviderOutput?.(`Attempt ${grillCallCount} question\n`);
      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: input.initialCompletionMarker,
        exitCode: 1,
        signal: null,
      });
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "grill" &&
      error.attempts === 2 &&
      error.cause instanceof IncompleteProviderSessionError,
  );

  assert.equal(grillCallCount, 2);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  const transcript = await fs.readFile(
    join(runDirectory, "grill-transcript.md"),
    "utf8",
  );

  assert.match(transcript, /## Attempt 1/);
  assert.match(transcript, /Attempt 1 question/);
  assert.match(transcript, /## Attempt 2/);
  assert.match(transcript, /Attempt 2 question/);
  assert.doesNotMatch(transcript, new RegExp(DEVFLOW_GRILL_TRANSCRIPT_COMPLETE));
});

test("orchestrator does not retry interactive grill after transcript completion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      await input.transcript?.onProviderOutput?.("Ready for PRD synthesis.\n");
      await input.validate();
      throw new ProviderSessionTranscriptCaptureError(
        provider,
        new Error("late transcript callback failed"),
      );
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderSessionTranscriptCaptureError &&
      error.message.includes("late transcript callback failed"),
  );

  assert.equal(grillCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`),
  );
  assert.equal(await fs.pathExists(join(runDirectory, "grill-checkpoint.json")), true);
});

test("orchestrator recreates a missing checkpoint from a completed grill transcript without repeating grill", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  const stages: PipelineStage[] = [];
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        return completePrdSession(input);
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      await input.transcript?.onProviderOutput?.("Ready for PRD synthesis.\n");
      await input.validate();
      await fs.remove(join(runDirectory, "grill-checkpoint.json"));
      throw new ProviderSessionTranscriptCaptureError(
        provider,
        new Error("checkpoint vanished after completion"),
      );
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(grillCallCount, 1);
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`),
  );
  assert.deepEqual(
    {
      ...(await fs.readJson(join(runDirectory, "grill-checkpoint.json"))),
      completedAt: "<iso>",
    },
    {
      stage: "grill",
      status: "complete",
      completedAt: "<iso>",
      rawTask: "resume work",
      intentArtifactPath: join(runDirectory, "intent.json"),
      projectContextPath: join(projectRoot, ".devflow", "project-context.md"),
      grillTranscriptPath: join(runDirectory, "grill-transcript.md"),
      prdArtifactPath: join(runDirectory, "prd.md"),
    },
  );
});

test("orchestrator replaces a corrupt checkpoint from a completed grill transcript without repeating grill", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let grillCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        return completePrdSession(input);
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      await input.validate();
      await fs.writeFile(join(runDirectory, "grill-checkpoint.json"), "{broken", "utf8");
      throw new ProviderSessionTranscriptCaptureError(
        provider,
        new Error("checkpoint corrupt after completion"),
      );
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(grillCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(
    (await fs.readJson(join(runDirectory, "grill-checkpoint.json"))).status,
    "complete",
  );
});

test("orchestrator repairs a missing PRD artifact inside the completed grill session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const repairPrompts: string[] = [];
  const repairMarkers: string[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      await input.validate();

      for (const continuation of input.continuations ?? []) {
        await continuation.onStart?.();
        await assert.rejects(continuation.validate());
        assert.ok(continuation.repair);
        assert.notEqual(
          continuation.repair.completionMarker,
          continuation.completionMarker,
        );
        assert.match(
          continuation.repair.completionMarker,
          /^DEVFLOW_PRD_REPAIR_COMPLETE_[a-f0-9]{32}$/,
        );
        const repairPrompt = continuation.repair.renderPrompt(
          new Error("prd artifact missing"),
        );
        repairPrompts.push(repairPrompt);
        repairMarkers.push(continuation.repair.completionMarker);
        assert.match(repairPrompt, /Repair only the canonical PRD artifact/);
        assert.match(repairPrompt, /prd artifact missing/);
        assert.match(repairPrompt, new RegExp(continuation.repair.completionMarker));

        await fs.outputFile(extractPrdArtifactPath(continuation.prompt), "# Repaired PRD\n");
        await continuation.validate();
      }

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(repairPrompts.length, 1);
  assert.equal(repairMarkers.length, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(
    await fs.readFile(join(runDirectory, "prd.md"), "utf8"),
    "# Repaired PRD\n",
  );
});

test("orchestrator repairs an empty PRD artifact with the same non-empty validation", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const repairFailures: string[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      await input.validate();

      for (const continuation of input.continuations ?? []) {
        await continuation.onStart?.();
        const prdPath = extractPrdArtifactPath(continuation.prompt);
        await fs.outputFile(prdPath, "   \n");

        await assert.rejects(
          continuation.validate(),
          (error: unknown) => {
            assert.ok(error instanceof StageArtifactValidationError);
            repairFailures.push(error.message);
            return error.message.includes("non-whitespace content");
          },
        );
        assert.ok(continuation.repair);

        await fs.outputFile(prdPath, "# Repaired PRD\n");
        await continuation.validate();
      }

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.deepEqual(repairFailures, [
    'Invalid artifact for stage "prd" at ' +
      join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
        "prd.md",
      ) +
      ". PRD artifact must contain non-whitespace content.",
  ]);
});

test("orchestrator retries only PRD synthesis from transcript after completed-grill PRD repair fails", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let grillCallCount = 0;
  let prdOnlyCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        assert.match(input.initialPrompt, /No live provider discussion is available/);
        assert.match(input.initialPrompt, /Persisted grill transcript path:/);
        assert.doesNotMatch(input.initialPrompt, /Ask one question at a time/);
        assert.ok(input.repair);

        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD retry\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      grillCallCount += 1;
      await input.transcript?.onProviderOutput?.("Ready for PRD synthesis.\n");
      await input.validate();

      for (const continuation of input.continuations ?? []) {
        await continuation.onStart?.();
        await assert.rejects(continuation.validate());
        assert.ok(continuation.repair);
        await fs.outputFile(extractPrdArtifactPath(continuation.prompt), "\n");

        try {
          await continuation.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw continuation.repair.mapFailure(repairError);
        }
      }

      throw new Error("Invalid PRD unexpectedly passed validation.");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(grillCallCount, 1);
  assert.equal(prdOnlyCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.match(
    await fs.readFile(join(runDirectory, "grill-transcript.md"), "utf8"),
    new RegExp(`${DEVFLOW_GRILL_TRANSCRIPT_COMPLETE}\n$`),
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD retry\n");
});

test("interrupted PRD synthesis resumes the completed grill provider session before transcript fallback", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let prdOnlyCallCount = 0;
  const resumeSessionInputs: ManagedProviderSessionResumeInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD fallback\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "session-start",
          phaseId: input.phase?.id,
          providerSessionId: "codex-live-session-prd",
        }),
      );
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: input.phase?.id,
          providerSessionId: "codex-live-session-prd",
          assistantMessage: `Grill complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      await continuation.onStart?.();
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: continuation.phase?.id,
          providerSessionId: "codex-live-session-prd",
          assistantMessage: "Writing PRD now.",
        }),
      );

      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: continuation.completionMarker,
        exitCode: 1,
        signal: null,
      });
    },
    async resumeSession(input) {
      resumeSessionInputs.push(input);
      assert.equal(input.providerSessionId, "codex-live-session-prd");
      assert.match(input.initialPrompt, /Continue the interrupted PRD synthesis/);
      assert.match(input.initialPrompt, /Canonical PRD artifact path:/);
      assert.match(input.initialPrompt, /prd\.md/);
      assert.match(input.initialPrompt, /Do not interview the user/);
      assert.doesNotMatch(input.initialPrompt, /Run the interactive grill stage/);

      await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD resumed\n");
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeSessionInputs.length, 1);
  assert.equal(prdOnlyCallCount, 0);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD resumed\n");
});

test("failed PRD resume falls back once to PRD-only synthesis from the completed grill transcript", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let resumeCallCount = 0;
  let prdOnlyCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        assert.match(input.initialPrompt, /No live provider discussion is available/);
        assert.match(input.initialPrompt, /Persisted grill transcript path:/);
        assert.match(input.initialPrompt, /grill-transcript\.md/);
        assert.doesNotMatch(input.initialPrompt, /Continue the interrupted PRD synthesis/);

        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD fallback\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: input.phase?.id,
          providerSessionId: "codex-prd-resume-reject",
          assistantMessage: `Grill complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      await continuation.onStart?.();
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: continuation.phase?.id,
          providerSessionId: "codex-prd-resume-reject",
          assistantMessage: "PRD interrupted.",
        }),
      );

      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: continuation.completionMarker,
        exitCode: 1,
        signal: null,
      });
    },
    async resumeSession(input) {
      resumeCallCount += 1;
      assert.equal(input.providerSessionId, "codex-prd-resume-reject");
      throw new ProviderSessionLaunchError(provider, new Error("resume rejected"));
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 1);
  assert.equal(prdOnlyCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD fallback\n");
});

test("completed PRD artifact prevents PRD resume or fallback from running again", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let resumeCallCount = 0;
  let prdOnlyCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "hooks",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: true,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD fallback\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      assert.ok(input.onProviderEvent);
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: input.phase?.id,
          providerSessionId: "codex-stale-prd-session",
          assistantMessage: `Grill complete ${input.initialCompletionMarker}`,
        }),
      );
      await input.validate();

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      await continuation.onStart?.();
      await input.onProviderEvent(
        createStructuredProviderEvent({
          type: "turn-completed",
          phaseId: continuation.phase?.id,
          providerSessionId: "codex-stale-prd-session",
          assistantMessage: "PRD is complete but the provider exits before marker.",
        }),
      );
      await fs.outputFile(extractPrdArtifactPath(continuation.prompt), "# PRD complete\n");

      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: continuation.completionMarker,
        exitCode: 1,
        signal: null,
      });
    },
    async resumeSession() {
      resumeCallCount += 1;
      throw new Error("resume should not run after a completed PRD artifact");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 0);
  assert.equal(prdOnlyCallCount, 0);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD complete\n");
});

test("malformed provider state degrades to PRD-only recovery from completed grill artifacts", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let prdOnlyCallCount = 0;
  let resumeCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "pty",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: false,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD fallback\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      await input.validate();
      await fs.writeFile(join(runDirectory, "provider-session.json"), "{broken", "utf8");

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      await continuation.onStart?.();

      throw new IncompleteProviderSessionError({
        provider,
        completionMarker: continuation.completionMarker,
        exitCode: 1,
        signal: null,
      });
    },
    async resumeSession() {
      resumeCallCount += 1;
      throw new Error("resume should not run with malformed provider state");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 0);
  assert.equal(prdOnlyCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD fallback\n");
});

test("completed grill checkpoint overrides stale active grill provider state during recovery", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  const provider = getBuiltInProviderIdentity("codex");
  let prdOnlyCallCount = 0;
  let resumeCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider,
    capabilities: {
      controlTransport: "pty",
      eventSource: "pty",
      supportsProviderSessionId: true,
      supportsResume: true,
      classifiesSubmittedUserMessageOrigin: false,
    },
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      const runDirectory = join(
        projectRoot,
        ".devflow",
        "runs",
        (await listRunDirectories(projectRoot))[0],
      );

      if (isPrdSessionInput(input)) {
        prdOnlyCallCount += 1;
        await fs.outputFile(extractPrdArtifactPath(input.initialPrompt), "# PRD fallback\n");
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (!isGrillSessionInput(input)) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      await input.validate();
      const now = new Date().toISOString();
      await fs.writeJson(
        join(runDirectory, "provider-session.json"),
        {
          provider,
          providerSessionId: "stale-active-grill-session",
          phase: {
            id: input.phase?.id,
            kind: "grill",
            attempt: 1,
          },
          status: "active",
          startedAt: now,
          updatedAt: now,
        },
        { spaces: 2 },
      );

      const continuation = input.continuations?.[0];
      assert.ok(continuation);
      await continuation.onStart?.();

      throw new StageArtifactValidationError({
        stage: "prd",
        artifactPath: join(runDirectory, "prd.md"),
        details: "PRD was not written before interruption.",
      });
    },
    async resumeSession() {
      resumeCallCount += 1;
      throw new Error("stale active grill provider state should not resume");
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(resumeCallCount, 0);
  assert.equal(prdOnlyCallCount, 1);
  const runDirectory = join(
    projectRoot,
    ".devflow",
    "runs",
    (await listRunDirectories(projectRoot))[0],
  );
  assert.equal(await fs.readFile(join(runDirectory, "prd.md"), "utf8"), "# PRD fallback\n");
});

test("orchestrator surfaces pre-completion grill transcript persistence failures as retryable grill-stage failures", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await baseDevFlowState.projectContext.write("# Project context\n");
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    async createRun() {
      const run = await baseDevFlowState.createRun();

      return {
        ...run,
        async initializeGrillTranscript() {
          throw new Error("disk full");
        },
      };
    },
  };
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "grill" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.stage === "grill" &&
      error.cause.message.includes("disk full") &&
      isRetryableProviderBackedStageFailure(error.cause),
  );
});

test("orchestrator reuses fresh project context during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await baseDevFlowState.projectContext.write("# Project context\n", {
    refreshReason: "manual",
  });
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  const metadataBefore = await fs.readFile(metadataPath, "utf8");
  const stages: PipelineStage[] = [];
  let checkFreshnessCallCount = 0;
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async checkFreshness() {
        checkFreshnessCallCount += 1;
        return baseDevFlowState.projectContext.checkFreshness();
      },
    },
  };
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionInputs.push(input);

      if (isGrillSessionInput(input)) {
        assert.equal(stages.at(-1), "grill");
        return completeGrillSession(input);
      }

      assert.equal(stages.at(-1), "intent");
      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionInputs.length, 2);
  assert.equal(result.bootstrapProvenance, "reused");
  assert.equal(checkFreshnessCallCount, 1);
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
  assert.equal(await fs.readFile(metadataPath, "utf8"), metadataBefore);
});

test("orchestrator repairs missing project-context metadata during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const existingContext = "# Project context\n\nKeep this exact text.\n";
  await baseDevFlowState.projectContext.write(existingContext);
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  const stages: PipelineStage[] = [];
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionCallCount += 1;
      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
      onStageStart(stage) {
        stages.push(stage);
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(result.bootstrapProvenance, "metadata-updated");
  assert.deepEqual(projectContextWrites, [
    {
      content: existingContext,
      refreshReason: "missing-metadata",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), existingContext);
  assert.equal(
    (await fs.readJson(metadataPath)).refreshReason,
    "missing-metadata",
  );
  assert.deepEqual(stages, [
    "intent",
    "bootstrap",
    "grill",
    "prd",
    "issues",
    "execute",
    "validate",
  ]);
});

test("orchestrator repairs invalid project-context metadata during bootstrap without provider work", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const existingContext = "# Project context\n\nPreserve invalid metadata content.\n";
  const metadataPath = join(projectRoot, ".devflow", "project-context.meta.json");
  await fs.outputFile(
    join(projectRoot, ".devflow", "project-context.md"),
    existingContext,
  );
  await fs.outputJson(metadataPath, { generatedAt: "not-a-date" }, { spaces: 2 });
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionCallCount += 1;
      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(result.bootstrapProvenance, "metadata-updated");
  assert.deepEqual(projectContextWrites, [
    {
      content: existingContext,
      refreshReason: "metadata-invalid",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), existingContext);
  assert.equal(
    (await fs.readJson(metadataPath)).refreshReason,
    "metadata-invalid",
  );
});

test("orchestrator generates missing project context through the managed provider during bootstrap", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const projectContextWrites: Array<{
    content: string;
    refreshReason: string | undefined;
  }> = [];
  const devFlowState: DevFlowState = {
    ...baseDevFlowState,
    projectContext: {
      ...baseDevFlowState.projectContext,
      async write(content, metadataOrOptions) {
        projectContextWrites.push({
          content,
          refreshReason:
            metadataOrOptions && "refreshReason" in metadataOrOptions
              ? metadataOrOptions.refreshReason
              : undefined,
        });
        return baseDevFlowState.projectContext.write(content, metadataOrOptions);
      },
    },
  };
  const runSessionInputs: ManagedProviderSessionInput[] = [];
  const generatedContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "The orchestrator creates runs and delegates durable state to DevFlowState.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "- src/devflowState.ts",
    "",
    "## Commands",
    "- npm run test",
    "- npm run typecheck",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionInputs.push(input);
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionInputs.length === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      assert.equal(input.workingDirectory, projectRoot);
      assert.match(
        input.initialCompletionMarker,
        /^DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_COMPLETE_[a-f0-9]{32}$/,
      );
      assert.match(input.initialPrompt, /bounded repository orientation/i);
      assert.match(input.initialPrompt, /ecosystem-neutral inspection/i);
      assert.match(input.initialPrompt, /purpose/i);
      assert.match(input.initialPrompt, /architecture/i);
      assert.match(input.initialPrompt, /key paths/i);
      assert.match(input.initialPrompt, /commands/i);
      assert.match(input.initialPrompt, /conventions/i);
      assert.match(
        input.initialPrompt,
        /project-context\.candidate\.md/,
      );
      assert.equal(input.initialPrompt.includes(input.initialCompletionMarker), true);

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      await fs.outputFile(candidatePath, generatedContext);
      await input.validate();

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  const result = await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionInputs.length, 3);
  assert.equal(result.bootstrapProvenance, "generated");
  assert.deepEqual(projectContextWrites, [
    {
      content: generatedContext,
      refreshReason: "missing-context",
    },
  ]);
  assert.equal(await baseDevFlowState.projectContext.read(), generatedContext);
  assert.equal(
    (await baseDevFlowState.projectContext.readMetadata())?.refreshReason,
    "missing-context",
  );

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(
    await fs.pathExists(
      join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "project-context.candidate.md",
      ),
    ),
    false,
  );
});

test("orchestrator refreshes semantically stale project context through the managed provider during bootstrap", async () => {
  for (const refreshReason of [
    "context-version-changed",
    "max-age-exceeded",
    "baseline-unavailable",
    "relevant-changes",
  ] as const) {
    const projectRoot = fs.mkdtempSync(
      join(tmpdir(), `devflow-orchestrator-${refreshReason}-`),
    );
    const baseDevFlowState: DevFlowState = createDevFlowState({ projectRoot });
    const priorContext = "# Project Context\n\nExisting orientation.\n";
    await baseDevFlowState.projectContext.write(priorContext, {
      refreshReason: "manual",
    });
    const refreshedContext = [
      "# Project Context",
      "",
      "## Purpose",
      "DevFlow coordinates provider-backed development workflows.",
      "",
      "## Architecture",
      "The orchestrator refreshes stale shared project context.",
      "",
      "## Key Paths",
      "- src/orchestrator.ts",
      "- src/devflowState.ts",
      "",
      "## Commands",
      "- npm run test",
      "- npm run typecheck",
      "",
      "## Conventions",
      "Tests exercise public orchestration behavior.",
      "",
    ].join("\n");
    const candidateContext =
      refreshReason === "max-age-exceeded" ? priorContext : refreshedContext;
    const projectContextWrites: Array<{
      content: string;
      refreshReason: string | undefined;
    }> = [];
    const devFlowState: DevFlowState = {
      ...baseDevFlowState,
      projectContext: {
        ...baseDevFlowState.projectContext,
        async checkFreshness() {
          return {
            status: "stale",
            refreshReason,
            context: priorContext,
            changedPaths:
              refreshReason === "relevant-changes"
                ? [
                    { path: "src/orchestrator.ts", status: "modified" },
                    {
                      path: "docs/context.md",
                      previousPath: "docs/old-context.md",
                      status: "renamed",
                    },
                    { path: "src/obsolete.ts", status: "deleted" },
                  ]
                : undefined,
          };
        },
        async write(content, metadataOrOptions) {
          projectContextWrites.push({
            content,
            refreshReason:
              metadataOrOptions && "refreshReason" in metadataOrOptions
                ? metadataOrOptions.refreshReason
                : undefined,
          });
          return baseDevFlowState.projectContext.write(content, metadataOrOptions);
        },
      },
    };
    const prompts: string[] = [];
    let runSessionCallCount = 0;
    const adapter: ManagedSessionAdapter = {
      provider: getBuiltInProviderIdentity("codex"),
      async detect() {
        return { isAvailable: true, executable: "codex" };
      },
      async runSession(input) {
        if (isIssuesSessionInput(input)) {
          return completeIssuesSession(input);
        }

        if (isExecuteSessionInput(input)) {
          return completeExecuteSession(input);
        }

        if (isGrillSessionInput(input)) {
          return completeGrillSession(input);
        }

        runSessionCallCount += 1;
        const runIds = await listRunDirectories(projectRoot);
        const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

        if (runSessionCallCount === 1) {
          await fs.outputJson(
            join(runDirectory, "intent.json"),
            {
              classification: "feature",
              summary: "Refresh context from raw task details.",
              rawTask: "SECRET RAW TASK",
              needsClarification: true,
            },
            { spaces: 2 },
          );
          await input.validate();
          return { repairUsed: false, exitCode: 0, signal: null };
        }

        prompts.push(input.initialPrompt);
        assert.equal(input.workingDirectory, projectRoot);
        assert.match(
          input.initialCompletionMarker,
          /^DEVFLOW_BOOTSTRAP_PROJECT_CONTEXT_COMPLETE_[a-f0-9]{32}$/,
        );
        assert.match(input.initialPrompt, /Refresh reason:/);
        assert.match(input.initialPrompt, new RegExp(refreshReason));
        assert.match(input.initialPrompt, /Existing project context:/);
        assert.match(input.initialPrompt, /Existing orientation/);
        assert.match(input.initialPrompt, /focused inspection/i);
        assert.match(input.initialPrompt, /changed, renamed, new, deleted-related, nearby, or referenced files/i);
        assert.doesNotMatch(input.initialPrompt, /whole-repo rescan/i);
        assert.doesNotMatch(input.initialPrompt, /SECRET RAW TASK/);
        assert.doesNotMatch(input.initialPrompt, /Refresh context from raw task details/);
        assert.doesNotMatch(input.initialPrompt, /needsClarification/);
        assert.doesNotMatch(input.initialPrompt, /classification/);

        if (refreshReason === "relevant-changes") {
          assert.match(input.initialPrompt, /src\/orchestrator\.ts \(modified\)/);
          assert.match(
            input.initialPrompt,
            /docs\/context\.md \(renamed from docs\/old-context\.md\)/,
          );
          assert.match(input.initialPrompt, /src\/obsolete\.ts \(deleted\)/);
        }

        const candidatePath = join(runDirectory, "project-context.candidate.md");
        await fs.outputFile(candidatePath, candidateContext);
        await input.validate();

        return { repairUsed: false, exitCode: 0, signal: null };
      },
    };

    const result = await runExecutionRequest(
      {
        projectRoot,
        rawTask: "SECRET RAW TASK",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    );

    assert.equal(runSessionCallCount, 2);
    assert.equal(result.bootstrapProvenance, "refreshed");
    assert.equal(prompts.length, 1);
    assert.deepEqual(projectContextWrites, [
      {
        content: candidateContext,
        refreshReason,
      },
    ]);
    assert.equal(await baseDevFlowState.projectContext.read(), candidateContext);
    assert.equal(
      (await baseDevFlowState.projectContext.readMetadata())?.refreshReason,
      refreshReason,
    );
  }
});

test("orchestrator rejects invalid generated project-context candidates during bootstrap", async () => {
  for (const [name, invalidCandidate, expectedMessage] of [
    ["empty", " \n\t", /Project context content must be non-empty/],
    [
      "too-long",
      Array.from({ length: 151 }, (_value, index) => `line ${index + 1}`).join(
        "\n",
      ),
      /Project context content must be no more than 150 lines/,
    ],
  ] as const) {
    const projectRoot = fs.mkdtempSync(
      join(tmpdir(), `devflow-orchestrator-${name}-`),
    );
    const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
    let runSessionCallCount = 0;
    const adapter: ManagedSessionAdapter = {
      provider: getBuiltInProviderIdentity("codex"),
      async detect() {
        return { isAvailable: true, executable: "codex" };
      },
      async runSession(input) {
        if (isIssuesSessionInput(input)) {
          return completeIssuesSession(input);
        }

        runSessionCallCount += 1;
        const runIds = await listRunDirectories(projectRoot);
        const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

        if (runSessionCallCount === 1) {
          await fs.outputJson(
            join(runDirectory, "intent.json"),
            {
              classification: "feature",
              summary: "Resume the current workstream.",
              rawTask: "resume work",
              needsClarification: false,
            },
            { spaces: 2 },
          );
          await input.validate();
          return { repairUsed: false, exitCode: 0, signal: null };
        }

        await fs.outputFile(
          join(runDirectory, "project-context.candidate.md"),
          invalidCandidate,
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      },
    };

    await assert.rejects(
      runExecutionRequest(
        {
          projectRoot,
          rawTask: "resume work",
          providerId: "codex",
        },
        {
          devFlowState,
          createManagedSessionAdapter() {
            return adapter;
          },
        },
      ),
      expectedMessage,
    );

    assert.equal(runSessionCallCount, 3);
    assert.equal(await devFlowState.projectContext.read(), undefined);
    assert.equal(await devFlowState.projectContext.readMetadata(), undefined);
  }
});

test("orchestrator supplies bootstrap validation and one in-session repair attempt to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const repairedContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "The bootstrap stage repairs invalid project-context candidates in-session.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  const repairPrompts: string[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      await fs.outputFile(candidatePath, " \n\t");
      const validationError = await input.validate().then(
        () => undefined,
        (error: Error) => error,
      );
      assert.ok(validationError);
      assert.ok(input.repair);
      assert.ok(input.phase?.id, "expected bootstrap phase id");
      assert.equal(input.phase.kind, "bootstrap");
      assert.equal(input.phase.attempt, 1);
      assert.ok(input.repair.phase?.id, "expected bootstrap repair phase id");
      assert.equal(input.repair.phase.kind, "bootstrap-repair");
      assert.equal(input.repair.phase.attempt, 1);
      assert.notEqual(input.repair.phase.id, input.phase.id);
      const repairPrompt = input.repair.renderPrompt(validationError);
      repairPrompts.push(repairPrompt);
      assert.match(repairPrompt, /Repair only the project-context candidate artifact/);
      assert.match(repairPrompt, /project-context\.candidate\.md/);
      assert.doesNotMatch(repairPrompt, /resume work/);
      assert.doesNotMatch(repairPrompt, /classification/);

      await fs.outputFile(candidatePath, repairedContext);
      await input.validate();

      return { repairUsed: true, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 2);
  assert.equal(repairPrompts.length, 1);
  assert.equal(await devFlowState.projectContext.read(), repairedContext);
});

test("orchestrator retries bootstrap after repair failure and removes the failed candidate before retry", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const validContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "Bootstrap retries the whole stage after repair failure.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  const candidateExistedAtBootstrapAttemptStart: boolean[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);
      const candidatePath = join(runDirectory, "project-context.candidate.md");

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      candidateExistedAtBootstrapAttemptStart.push(
        await fs.pathExists(candidatePath),
      );

      if (candidateExistedAtBootstrapAttemptStart.length === 1) {
        await fs.outputFile(candidatePath, " \n\t");
        const validationError = await input.validate().then(
          () => undefined,
          (error: Error) => error,
        );
        assert.ok(validationError);
        assert.ok(input.repair);
        throw input.repair.mapFailure(validationError);
      }

      await fs.outputFile(candidatePath, validContext);
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.deepEqual(candidateExistedAtBootstrapAttemptStart, [false, false]);
  assert.equal(runSessionCallCount, 3);
  assert.equal(await devFlowState.projectContext.read(), validContext);
});

test("orchestrator preserves the final failed bootstrap candidate after retry exhaustion", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      const candidatePath = join(runDirectory, "project-context.candidate.md");
      const failedCandidate = [
        `failed bootstrap candidate ${runSessionCallCount}`,
        ...Array.from(
          { length: 151 },
          (_value, index) => `overflow line ${index + 1}`,
        ),
      ].join("\n");
      await fs.outputFile(candidatePath, failedCandidate);
      const validationError = await input.validate().then(
        () => undefined,
        (error: Error) => error,
      );
      assert.ok(validationError);
      assert.ok(input.repair);
      throw input.repair.mapFailure(validationError);
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: Error) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "bootstrap" &&
      error.attempts === 2,
  );

  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runSessionCallCount, 3);
  assert.equal(
    await fs.readFile(
      join(
        projectRoot,
        ".devflow",
        "runs",
        runIds[0],
        "project-context.candidate.md",
      ),
      "utf8",
    ),
    [
      "failed bootstrap candidate 3",
      ...Array.from(
        { length: 151 },
        (_value, index) => `overflow line ${index + 1}`,
      ),
    ].join("\n"),
  );
  assert.equal(await devFlowState.projectContext.read(), undefined);
});

test("orchestrator treats bootstrap candidate cleanup failure after persistence as non-fatal", async (t) => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const validContext = [
    "# Project Context",
    "",
    "## Purpose",
    "DevFlow coordinates provider-backed development workflows.",
    "",
    "## Architecture",
    "Successful bootstrap persistence is not undone by candidate cleanup failure.",
    "",
    "## Key Paths",
    "- src/orchestrator.ts",
    "",
    "## Commands",
    "- npm run test",
    "",
    "## Conventions",
    "Tests exercise public orchestration behavior.",
    "",
  ].join("\n");
  let runSessionCallCount = 0;
  const originalRemove = fs.remove;
  t.after(() => {
    fs.remove = originalRemove;
  });

  fs.remove = async (path: string) => {
    if (path.endsWith("project-context.candidate.md")) {
      throw new Error("simulated candidate cleanup failure");
    }

    return originalRemove(path);
  };

  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      runSessionCallCount += 1;
      const runIds = await listRunDirectories(projectRoot);
      const runDirectory = join(projectRoot, ".devflow", "runs", runIds[0]);

      if (runSessionCallCount === 1) {
        await fs.outputJson(
          join(runDirectory, "intent.json"),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();
        return { repairUsed: false, exitCode: 0, signal: null };
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      await fs.outputFile(
        join(runDirectory, "project-context.candidate.md"),
        validContext,
      );
      await input.validate();
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(runSessionCallCount, 3);
  assert.equal(await devFlowState.projectContext.read(), validContext);
});

test("orchestrator validates parsed intent before starting bootstrap", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "do the thing",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.artifactPath.endsWith("/intent.json"),
  );

  assert.equal(runSessionCallCount, 2);
  assert.deepEqual(stages, ["intent"]);
  const runIds = await listRunDirectories(projectRoot);
  assert.equal(runIds.length, 1);
  assert.equal(
    await fs.pathExists(
      join(projectRoot, ".devflow", "runs", runIds[0], "intent.json"),
    ),
    false,
  );
});

test("orchestrator supplies intent validation and one in-session repair attempt to the managed provider session", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  await devFlowState.projectContext.write("# Project context\n");
  let repairedCompletion: { repairUsed: boolean } | undefined;
  const repairPrompts: string[] = [];
  const validationFailures: Error[] = [];
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      if (isGrillSessionInput(input)) {
        return completeGrillSession(input);
      }

      try {
        await input.validate();
      } catch (error) {
        assert.ok(error instanceof Error);
        validationFailures.push(error);
        assert.ok(input.repair);
        assert.ok(input.phase?.id, "expected intent phase id");
        assert.equal(input.phase.kind, "intent");
        assert.equal(input.phase.attempt, 1);
        assert.ok(input.repair.phase?.id, "expected intent repair phase id");
        assert.equal(input.repair.phase.kind, "intent-repair");
        assert.equal(input.repair.phase.attempt, 1);
        assert.notEqual(input.repair.phase.id, input.phase.id);
        assert.match(
          input.repair.completionMarker,
          /^DEVFLOW_INTENT_REPAIR_COMPLETE_[a-f0-9]{32}$/,
        );
        const repairPrompt = input.repair.renderPrompt(error);
        repairPrompts.push(repairPrompt);
        assert.match(repairPrompt, /Repair only the intent artifact/);
        assert.match(repairPrompt, /no such file or directory|ENOENT/);
        assert.match(repairPrompt, /\/\.devflow\/runs\/[a-z0-9]{12}\/intent\.json/);

        await fs.outputJson(
          join(
            projectRoot,
            ".devflow",
            "runs",
            (await listRunDirectories(projectRoot))[0],
            "intent.json",
          ),
          {
            classification: "feature",
            summary: "Resume the current workstream.",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );
        await input.validate();

        repairedCompletion = { repairUsed: true };
        return { repairUsed: true, exitCode: 0, signal: null };
      }

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await runExecutionRequest(
    {
      projectRoot,
      rawTask: "resume work",
      providerId: "codex",
    },
    {
      devFlowState,
      createManagedSessionAdapter() {
        return adapter;
      },
    },
  );

  assert.equal(validationFailures.length, 1);
  assert.equal(repairPrompts.length, 1);
  assert.deepEqual(repairedCompletion, { repairUsed: true });
});

test("orchestrator preserves the final failed repair validation error as the retry-exhausted cause", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let repairPromptCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      try {
        await input.validate();
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(input.repair);
        input.repair.renderPrompt(error);
        repairPromptCount += 1;

        await fs.outputJson(
          join(
            projectRoot,
            ".devflow",
            "runs",
            (await listRunDirectories(projectRoot))[0],
            "intent.json",
          ),
          {
            classification: "feature",
            summary: "",
            rawTask: "resume work",
            needsClarification: false,
          },
          { spaces: 2 },
        );

        try {
          await input.validate();
        } catch (repairError) {
          assert.ok(repairError instanceof Error);
          throw input.repair.mapFailure(repairError);
        }
      }

      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof ProviderStageRetryExhaustedError &&
      error.stage === "intent" &&
      error.attempts === 2 &&
      error.cause instanceof StageArtifactValidationError &&
      error.cause.artifactPath.endsWith("/intent.json") &&
      error.cause.message.includes("Must be a non-empty string"),
  );

  assert.equal(repairPromptCount, 2);
});

test("provider-backed stage retry helper surfaces the original failure for a single configured attempt", async () => {
  const originalFailure = new StageArtifactValidationError({
    stage: "intent",
    artifactPath: "/tmp/intent.json",
    details: "invalid json",
  });
  let cleanupCallCount = 0;

  await assert.rejects(
    runProviderBackedStageWithRetry({
      stage: "intent",
      totalAttempts: 1,
      async runAttempt() {
        throw originalFailure;
      },
      async cleanupBeforeRetry() {
        cleanupCallCount += 1;
      },
    }),
    (error: unknown) => error === originalFailure,
  );

  assert.equal(cleanupCallCount, 0);
});

test("provider-backed stage retry classification keeps lifecycle failures non-retryable", () => {
  const provider = getBuiltInProviderIdentity("codex");

  assert.equal(
    isRetryableProviderBackedStageFailure(
      new IncompleteProviderSessionError({
        provider,
        completionMarker: "DEVFLOW_INTENT_COMPLETE",
        exitCode: 1,
        signal: null,
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new StageArtifactValidationError({
        stage: "intent",
        artifactPath: "/tmp/intent.json",
        details: "invalid",
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new ProviderSessionTranscriptCaptureError(
        provider,
        new Error("transcript write failed"),
      ),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new ProviderSessionEventCaptureError(
        provider,
        new Error("event callback failed"),
      ),
    ),
    true,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new InterruptedProviderSessionError({
        provider,
        exitCode: null,
        signal: "SIGINT",
      }),
    ),
    false,
  );
  assert.equal(
    isRetryableProviderBackedStageFailure(
      new ProviderSessionCleanupError(provider, new Error("cleanup failed")),
    ),
    false,
  );
  assert.equal(isRetryableProviderBackedStageFailure(new Error("setup failed")), false);
});

test("resume-aware orchestration keeps provider-native event and CLI details out of core recovery", async () => {
  const source = await fs.readFile(
    join(process.cwd(), "src", "orchestrator.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\bSessionStart\b/);
  assert.doesNotMatch(source, /\bUserPromptSubmit\b/);
  assert.doesNotMatch(source, /\bStop\b/);
  assert.doesNotMatch(source, /\bsession_meta\b/);
  assert.doesNotMatch(source, /\bevent_msg\b/);
  assert.doesNotMatch(source, /\btask_complete\b/);
  assert.doesNotMatch(source, /\bresponse_item\b/);
  assert.doesNotMatch(source, /\blast_agent_message\b/);
  assert.doesNotMatch(source, /\bcodex\s+resume\b/);
});

test("orchestrator surfaces interrupted provider sessions without retrying the intent stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const interrupted = new InterruptedProviderSessionError({
    provider,
    exitCode: null,
    signal: "SIGINT",
  });
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      throw interrupted;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === interrupted,
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator surfaces provider cleanup failures without retrying the intent stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const provider = getBuiltInProviderIdentity("codex");
  const cleanup = new ProviderSessionCleanupError(
    provider,
    new Error("cleanup command failed"),
  );
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      throw cleanup;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === cleanup,
  );

  assert.equal(runSessionCallCount, 1);
  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator stops after cleanup failure even when the intent artifact is valid", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  const provider = getBuiltInProviderIdentity("codex");
  const cleanup = new ProviderSessionCleanupError(
    provider,
    new Error("cleanup command failed"),
  );
  const adapter: ManagedSessionAdapter = {
    provider,
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession(input) {
      if (isIssuesSessionInput(input)) {
        return completeIssuesSession(input);
      }

      if (isExecuteSessionInput(input)) {
        return completeExecuteSession(input);
      }

      await fs.outputJson(
        join(
          projectRoot,
          ".devflow",
          "runs",
          (await listRunDirectories(projectRoot))[0],
          "intent.json",
        ),
        {
          classification: "feature",
          summary: "Resume the current workstream.",
          rawTask: "resume work",
          needsClarification: false,
        },
        { spaces: 2 },
      );
      await input.validate();
      throw cleanup;
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === cleanup,
  );

  assert.deepEqual(stages, ["intent"]);
});

test("orchestrator rejects provider-backed execution before creating a run when provider id is missing", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let runnerCallCount = 0;
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runnerCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
      },
    ),
    (error: unknown) =>
      error instanceof MissingProviderIdError &&
      error.message.includes("Provider-backed orchestration requires a provider id"),
  );

  assert.equal(runnerCallCount, 0);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator rejects unsupported provider ids before creating a run", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  let adapterFactoryCallCount = 0;

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "not-real",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          adapterFactoryCallCount += 1;
          return {
            provider: getBuiltInProviderIdentity("codex"),
            async detect() {
              return { isAvailable: true, executable: "codex" };
            },
            async runSession() {
              return { repairUsed: false, exitCode: 0, signal: null };
            },
          };
        },
      },
    ),
    (error: unknown) =>
      error instanceof UnsupportedProviderError &&
      error.message.includes("Unsupported provider: not-real"),
  );

  assert.equal(adapterFactoryCallCount, 0);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator surfaces adapter factory failures before creating a run or starting a stage", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const devFlowState: DevFlowState = createDevFlowState({ projectRoot });
  const stages: PipelineStage[] = [];
  const adapterFailure = new Error("adapter resolution failed");

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          throw adapterFailure;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === adapterFailure,
  );

  assert.deepEqual(stages, []);
  assert.deepEqual(await listRunDirectories(projectRoot), []);
});

test("orchestrator surfaces run creation failures before starting a stage or provider attempt", async () => {
  const projectRoot = fs.mkdtempSync(join(tmpdir(), "devflow-orchestrator-"));
  const runCreationFailure = new Error("run creation failed");
  const stages: PipelineStage[] = [];
  let runSessionCallCount = 0;
  const devFlowState: DevFlowState = {
    config: {
      async load() {
        return undefined;
      },
      async save() {},
    },
    projectContext: {
      async read() {
        return undefined;
      },
      async write() {},
      async readMetadata() {
        return undefined;
      },
      async checkFreshness() {
        return {
          status: "stale",
          refreshReason: "missing-context",
        };
      },
    },
    git: {
      async getCurrentHead() {
        return null;
      },
      async getRecentCommits() {
        return "No commits found.";
      },
    },
    async createRun() {
      throw runCreationFailure;
    },
  };
  const adapter: ManagedSessionAdapter = {
    provider: getBuiltInProviderIdentity("codex"),
    async detect() {
      return { isAvailable: true, executable: "codex" };
    },
    async runSession() {
      runSessionCallCount += 1;
      return { repairUsed: false, exitCode: 0, signal: null };
    },
  };

  await assert.rejects(
    runExecutionRequest(
      {
        projectRoot,
        rawTask: "resume work",
        providerId: "codex",
      },
      {
        devFlowState,
        createManagedSessionAdapter() {
          return adapter;
        },
        onStageStart(stage) {
          stages.push(stage);
        },
      },
    ),
    (error: unknown) => error === runCreationFailure,
  );

  assert.equal(runSessionCallCount, 0);
  assert.deepEqual(stages, []);
});
