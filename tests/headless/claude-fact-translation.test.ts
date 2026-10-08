import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { wireApplication } from "../../src/composition/main.js";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import { runHeadless } from "../../src/headless/headless.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import {
  init,
  scriptedClaude,
  SESSION_ID,
} from "../harness/scripted-claude.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { writeAgentBundle } from "../helpers/agentBundle.js";

test("m10-audit-claude-fact-translation: unidentified scripted Claude reply reaches Workbench history and both transcript clients", async (t) => {
  const scripted = scriptedClaude({
    answer: "confirm",
    userFrame: () => [
      init,
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_parent", name: "Agent", input: {} },
            { type: "text", text: "An unidentified reply" },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: { content: [{ type: "text", text: "A helper reply" }] },
      },
      { type: "result", subtype: "success" },
    ],
  });
  const git = createFakeGitProcess();
  const workspace = realpathSync.native(makeTempDir("secant-claude-fact-ws-"));
  const wired = wireApplication({
    secantHome: makeTempDir("secant-claude-fact-home-"),
    launchCwd: workspace,
    process: {
      resolveExecutable: (options) =>
        scripted.process.resolveExecutable(options),
      spawnOwnedProcess: (options) =>
        scripted.process.spawnOwnedProcess(options),
      spawnCommand: (options) =>
        options.args.includes("--version")
          ? Promise.resolve({
              kind: "exited",
              status: 0,
              text: new TextEncoder().encode("2.1.288 (Claude Code)"),
            })
          : git.spawnCommand(options),
      spawnCommandSync: (options) => git.spawnCommandSync(options),
    },
    harnessAdapter: createClaudeCodeAdapter({
      env: {},
      sessionId: () => SESSION_ID,
    }),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "scripted Claude",
      },
    }),
    discoverCodex: () => ({ kind: "not-found", attempts: [] }),
  });
  t.after(() => wired.close());
  const bundle = writeAgentBundle({
    id: "dev.secant.claude-fact-translation",
    name: "Claude fact translation",
    description: "Exercise normalized replies",
    prompt: { path: "prompt.md", text: "Reply to the user" },
    routing: [
      {
        id: "reply",
        kind: "agent",
        session: "conversation",
        prompt: { asset: "prompt.md" },
        retry: 0,
      },
    ],
  });
  const built = wired.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog
    .listEntries()
    .find((entry) => entry.id === bundle.id);
  assert.ok(entry);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    cwd: () => workspace,
  };
  wired.catalog.approveWorkspace(workspace, new Date());
  const code = await runHeadless(
    wired,
    [
      "run",
      "launch",
      bundle.id,
      "--trust",
      entry.digest,
      "--harness",
      "claude-code",
    ],
    io,
  );
  assert.equal(code, 0, err.join("\n"));
  const runId = /^Run (\S+)$/m.exec(out.join("\n"))?.[1];
  assert.ok(runId);
  const history = wired.projectionPort.openProjection({
    family: "session-history",
    runId,
    session: "conversation",
  });
  t.after(() => history.close());
  assert.ok(history.snapshot.result.found);
  assert.deepEqual(
    history.snapshot.result.history.rows
      .filter(
        (row) => row.value.kind === "message" && row.value.role === "assistant",
      )
      .map((row) => (row.value.kind === "message" ? row.value.content : "")),
    ["An unidentified reply"],
  );
  const run = wired.projectionPort.openProjection({ family: "run", runId });
  t.after(() => run.close());
  assert.ok(run.snapshot.result.found);
  const session = run.snapshot.result.run.sessions?.find(
    (session) => session.session === "conversation",
  );
  assert.ok(session?.transcriptExport);
  const transcript = wired.projectionPort.readTranscript(
    session.transcriptExport,
  );
  assert.ok(transcript.found);
  assert.deepEqual(
    transcript.entries
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.content),
    ["An unidentified reply"],
  );
  out.length = 0;
  assert.equal(
    await runHeadless(
      wired,
      ["run", "read", runId, "--transcript", "--json"],
      io,
    ),
    0,
  );
  const exported = z
    .object({
      export: z.object({
        entries: z.array(z.object({ role: z.string(), content: z.string() })),
      }),
    })
    .parse(JSON.parse(out.join("\n")));
  assert.deepEqual(
    exported.export.entries
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.content),
    ["An unidentified reply"],
  );
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const facts = owner.turnEvents();
  assert.equal(JSON.stringify(facts).includes("toolu_"), false);
  const parent = facts.find((event) => event.kind === "tool-call");
  const child = facts
    .filter((event) => event.kind === "assistant-content")
    .at(-1);
  assert.ok(parent && child);
  const call = z
    .object({ callId: z.string() })
    .parse(JSON.parse(parent.payload));
  const reply = z
    .object({ parentActivity: z.string() })
    .parse(JSON.parse(child.payload));
  assert.equal(reply.parentActivity, call.callId);
});
