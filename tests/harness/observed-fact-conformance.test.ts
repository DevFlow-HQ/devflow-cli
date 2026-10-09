import test from "node:test";
import {
  createClaudeCodeAdapter,
  type ToolCall,
  type TurnEvent,
} from "../../src/harness/harness.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFake, fakeHarnessProfile } from "./fake-adapter.js";
import { runObservedFactCases } from "./conformance.js";
import { init, scriptedClaude, SESSION_ID } from "./scripted-claude.js";
import { scriptedCodexFacts } from "./scripted-codex-facts.js";

type FileChange = NonNullable<ToolCall["files"]>[number];

const pendingTerminal: readonly TurnEvent[] = [
  {
    kind: "tool-partial",
    call: {
      callId: "pending-command",
      tool: "command",
      input: "pending command",
      output: {
        text: "z".repeat(30_000),
        secantDropped: true,
        incomplete: true,
      },
      outcome: { kind: "running" },
    },
  },
  { kind: "turn-diff", diff: { content: "PENDING_DIFF", files: [] } },
  {
    kind: "assistant-content",
    messageId: "pending-message",
    content: "Pending answer",
    incomplete: true,
  },
  {
    kind: "thought",
    summaryId: "pending-thought",
    content: "Qualified summary",
    incomplete: true,
  },
];

function fakePendingFacts() {
  return createFake({
    profile: fakeHarnessProfile(),
    turns: [
      {
        events: [
          {
            kind: "message-preview",
            messageId: "message",
            content: "Pending answer",
          },
          {
            kind: "thought-preview",
            summaryId: "thought",
            content: "Qualified summary",
          },
          {
            kind: "turn-diff-preview",
            diff: { content: "PENDING_DIFF", files: [] },
          },
          {
            kind: "tool-preview",
            call: {
              callId: "command",
              tool: "command",
              input: "pending command",
              output: { text: "head" + "z".repeat(30_000) },
              outcome: { kind: "running" },
            },
          },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "",
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  });
}

function claudePendingFacts() {
  return () => {
    const scripted = scriptedClaude({
      answer: "confirm",
      userFrame: () => [
        init,
        {
          type: "stream_event",
          event: { type: "message_start", message: { id: "message" } },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Pending answer" },
          },
        },
        { type: "result", subtype: "success" },
      ],
    });
    const adapter = createClaudeCodeAdapter({
      env: {},
      sessionId: () => SESSION_ID,
    });
    return {
      prepare: (options: import("./test-adapters.js").TestPrepareOptions) =>
        adapter.prepare({ ...options, process: scripted.process }),
      close: (
        options?: import("../../src/harness/harness.js").PreparationCloseOptions,
      ) => adapter.close(options),
    };
  };
}

function codexPendingFacts() {
  return () =>
    scriptedCodexFacts(
      [
        {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: "pending-command",
              command: "pending command",
              status: "inProgress",
              aggregatedOutput: null,
              exitCode: null,
            },
          },
        },
        {
          method: "item/commandExecution/outputDelta",
          params: {
            itemId: "pending-command",
            delta: "head" + "z".repeat(30_000),
          },
        },
        {
          method: "turn/diff/updated",
          params: {
            threadId: "01a103a8-7606-7072-8fc9-57d05e854bd3",
            turnId: "01a103a8-76a7-7023-b718-c7d86e0e36a2",
            diff: "PENDING_DIFF",
          },
        },
        {
          method: "item/agentMessage/delta",
          params: { itemId: "pending-message", delta: "Pending answer" },
        },
      ],
      makeTempDir("secant-pending-conformance-"),
      { provider: "openai", model: "gpt-6.1-sol", complete: false },
    );
}

const output = "head" + "z".repeat(30_000);
const structuredFile: FileChange = {
  path: "observed.ts",
  patch: {
    kind: "structured",
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+FILE_PATCH"],
      },
    ],
  },
};
const unifiedFile: FileChange = {
  path: "observed.ts",
  kind: "update",
  patch: { kind: "unified", content: "FILE_PATCH" },
};
const command = {
  callId: "command",
  tool: "command",
  input: "printf conformance",
  outcome: { kind: "running" },
} as const;
const file = {
  callId: "file",
  tool: "file-change",
  input: "edit observed.ts",
  outcome: { kind: "running" },
} as const;
const events: TurnEvent[] = [
  { kind: "tool-call", call: command },
  { kind: "tool-call", call: command },
  {
    kind: "tool-call",
    call: {
      ...command,
      output: { text: output },
      outcome: { kind: "completed" },
    },
  },
  { kind: "tool-preview", call: { ...command, output: { text: "LATE" } } },
  { kind: "tool-call", call: file },
  {
    kind: "tool-call",
    call: { ...file, files: [unifiedFile], outcome: { kind: "completed" } },
  },
  { kind: "thought", summaryId: "blank", content: " \n " },
  {
    kind: "thought-preview",
    summaryId: "summary",
    content: "Qualified summary",
  },
  { kind: "thought", summaryId: "summary", content: "Qualified summary" },
  { kind: "thought", summaryId: "summary", content: "Qualified summary" },
  { kind: "thought-preview", summaryId: "summary", content: "LATE" },
];
runObservedFactCases(
  {
    label: "fake",
    pending: fakePendingFacts,
    terminal: pendingTerminal,
    commandOutput: "retained",
    file: unifiedFile,
    thought: true,
    facts: () =>
      createFake({
        profile: fakeHarnessProfile(),
        turns: [
          {
            events,
            result: {
              kind: "completed",
              detail: {
                finalContent: "done",
                effectiveModel: { known: false },
                session: { state: "open" },
              },
            },
          },
        ],
      }),
  },
  test,
);

// Synthetic overlays reuse qualified shapes. Claude's raw thinking stays absent;
// Codex's summary is qualified for the recorded OpenAI model, never inferred.
runObservedFactCases(
  {
    label: "Claude Code",
    pending: claudePendingFacts,
    terminal: [
      {
        kind: "assistant-content",
        messageId: "pending-message",
        content: "Pending answer",
        incomplete: true,
      },
    ],
    commandOutput: "retained",
    commandInput: "printf conformance",
    file: structuredFile,
    thought: false,
    facts: () => () => {
      const use = (id: string, name: string, input: object) => ({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name, input }] },
      });
      const result = (id: string, tool_use_result: object) => ({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
        },
        tool_use_result,
      });
      const scripted = scriptedClaude({
        answer: "confirm",
        userFrame: () => [
          init,
          use("command", "Bash", { command: "printf conformance" }),
          use("command", "Bash", { command: "printf conformance" }),
          result("command", { stdout: output, stderr: "", interrupted: false }),
          result("command", { stdout: "LATE", stderr: "", interrupted: false }),
          use("file", "Edit", {
            file_path: "requested.ts",
            old_string: "old",
            new_string: "new",
          }),
          result("file", {
            filePath: "observed.ts",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: ["+FILE_PATCH"],
              },
            ],
          }),
          {
            type: "stream_event",
            event: { delta: { type: "thinking_delta", thinking: "private" } },
          },
          { type: "result", subtype: "success" },
        ],
      });
      const adapter = createClaudeCodeAdapter({
        env: {},
        sessionId: () => SESSION_ID,
      });
      return {
        prepare: (options) =>
          adapter.prepare({ ...options, process: scripted.process }),
        close: (options) => adapter.close(options),
      };
    },
  },
  test,
);

runObservedFactCases(
  {
    label: "Codex",
    runningFiles: [{ path: "requested.ts" }],
    pending: codexPendingFacts,
    terminal: pendingTerminal,
    commandOutput: "retained",
    file: unifiedFile,
    thought: true,
    facts: () => () => {
      const item = {
        type: "commandExecution",
        id: "command-conformance",
        command: "printf conformance",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      };
      const changed = {
        type: "fileChange",
        id: "file-conformance",
        status: "inProgress",
        changes: [{ path: "requested.ts", diff: "REQUESTED_PATCH" }],
      };
      return scriptedCodexFacts(
        [
          { method: "item/started", params: { item } },
          { method: "item/started", params: { item } },
          {
            method: "item/completed",
            params: {
              item: {
                ...item,
                status: "completed",
                aggregatedOutput: output,
                exitCode: 0,
              },
            },
          },
          {
            method: "item/commandExecution/outputDelta",
            params: { itemId: item.id, delta: "LATE" },
          },
          { method: "item/started", params: { item: changed } },
          {
            method: "item/completed",
            params: {
              item: {
                ...changed,
                status: "completed",
                changes: [
                  {
                    path: "observed.ts",
                    kind: { type: "update", move_path: null },
                    diff: "FILE_PATCH",
                  },
                ],
              },
            },
          },
        ],
        makeTempDir("secant-observed-conformance-"),
        {
          provider: "openai",
          model: "gpt-6.1-sol",
          afterSummary: ({ threadId, turnId, summaryId }) => [
            {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: {
                  id: summaryId,
                  type: "reasoning",
                  summary: ["Qualified summary"],
                },
              },
            },
            {
              method: "item/completed",
              params: {
                threadId,
                turnId,
                item: { id: "blank", type: "reasoning", summary: [" \n "] },
              },
            },
            {
              method: "item/reasoning/summaryTextDelta",
              params: {
                threadId,
                turnId,
                itemId: summaryId,
                summaryIndex: 0,
                delta: "LATE",
              },
            },
          ],
        },
      );
    },
  },
  test,
);
