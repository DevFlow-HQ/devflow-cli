import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { pathToFileURL } from "node:url";

const repo = process.env.SECANT_EVIDENCE_REPO ?? process.cwd();
const { redact, envSecrets, assertNoCredentials } = await import(
  pathToFileURL(repo + "/tests/harness/redact.ts").href
);

const reasoning = process.argv[2] === "reasoning";
const output =
  (process.env.SECANT_EVIDENCE_DIR ??
    "/tmp/secant-native-evidence-460/claude") + (reasoning ? "/reasoning" : "");
const workspace = output + "/workspace";
mkdirSync(workspace, { recursive: true });
writeFileSync(workspace + "/sample.txt", "red\ngreen\n");
const prompt = reasoning
  ? "Solve this constraint puzzle and report only the final ordered names. Six runners Ada, Bea, Cy, Dev, Eli and Fay occupy places 1 through 6. Ada is before Dev but after Cy. Bea is immediately after Eli. Fay is neither first nor last and is before Cy. Dev is last. Eli is first. Find every order satisfying these constraints. Return only the order or orders, without explaining the reasoning. Use no tools."
  : 'Perform only these local evidence tasks in order. Use Bash to run exactly: printf "native-stdout-ok\\n". Use Bash again to run exactly: printf "native-stderr-failure\\n" >&2; exit 7. The second command is intentionally failing; do not repair or repeat it. Read sample.txt. Use Edit on sample.txt to replace green with emerald followed by a new line containing blue, leaving red unchanged. Do not use Bash for the edit. Do not use any other tools. Finish with the one-word answer done.';
const input =
  JSON.stringify({
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  }) + "\n";
const args = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--safe-mode",
  "--strict-mcp-config",
  "--tools",
  "Bash,Read,Edit",
  "--allowedTools",
  "Bash",
  "Read",
  "Edit",
  "--permission-prompts",
  "none",
  "--no-session-persistence",
];
const start = new Date().toISOString();
const version = spawnSync("claude", ["--version"], {
  encoding: "utf8",
  timeout: 15000,
}).stdout.trim();
const result = spawnSync("claude", args, {
  cwd: workspace,
  input,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const secrets = [
  { value: workspace, placeholder: "«WORKSPACE»", reason: "probe workspace" },
  { value: homedir(), placeholder: "«HOME»", reason: "home directory" },
  { value: userInfo().username, placeholder: "«USER»", reason: "user name" },
  ...envSecrets(),
];
if (process.env.XDG_RUNTIME_DIR)
  secrets.push({
    value: process.env.XDG_RUNTIME_DIR,
    placeholder: "«RUNTIME_DIR»",
    reason: "per-user runtime path",
  });
if (process.getuid)
  secrets.push({
    value: "/run/user/" + process.getuid(),
    placeholder: "«RUNTIME_DIR»",
    reason: "per-user runtime path",
  });
const applied = [];
function safeWrite(name, content) {
  const clean = redact(content, secrets);
  assertNoCredentials(clean.text);
  for (const item of clean.redactions)
    if (!applied.some((x) => x.placeholder === item.placeholder))
      applied.push(item);
  writeFileSync(output + "/" + name, clean.text);
}
const omitted = {};
const kept = [];
const extracted = [];
const privateMetadata = [];
function omit(reason) {
  omitted[reason] = (omitted[reason] ?? 0) + 1;
}
function privatePayload(node) {
  if (!node || typeof node !== "object") return false;
  return Object.entries(node).some(
    ([key, value]) =>
      [
        "thinking",
        "signature",
        "encrypted_content",
        "encryptedContent",
        "redacted_thinking",
      ].includes(key) ||
      (key === "type" &&
        [
          "thinking",
          "thinking_delta",
          "signature_delta",
          "redacted_thinking",
        ].includes(value)) ||
      privatePayload(value),
  );
}
for (const line of (result.stdout ?? "").split("\n")) {
  if (!line.trim()) continue;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    omit("non-json-line");
    continue;
  }
  if (
    frame.type === "stream_event" &&
    frame.event?.delta?.type === "input_json_delta"
  ) {
    omit("streamed-tool-input");
    continue;
  }
  if (privatePayload(frame)) {
    privateMetadata.push({
      type: frame.type,
      eventType: frame.event?.type,
      blockType: frame.event?.content_block?.type,
      deltaType: frame.event?.delta?.type,
      thinking_display: frame.thinking_display,
      messageId: frame.message?.id ?? frame.event?.message?.id,
      index: frame.event?.index,
      blockTypes: frame.message?.content?.map((x) => x.type),
      suppliedThinkingDurationMs: frame.thinking_duration_ms,
    });
    for (const block of frame.message?.content ?? []) {
      if (block.type === "tool_use" && !privatePayload(block))
        extracted.push(
          JSON.stringify({
            nativeFrameType: frame.type,
            nativeMessageId: frame.message.id,
            nativeToolUse: block,
          }),
        );
    }
    omit("private-payload-frame");
    continue;
  }
  kept.push(line);
}
safeWrite("native-filtered.stdout", kept.join("\n") + "\n");
const selected = kept.filter((line) => {
  const frame = JSON.parse(line);
  return (
    Array.isArray(frame.message?.content) &&
    frame.message.content.some((block) =>
      ["tool_use", "tool_result"].includes(block.type),
    )
  );
});
safeWrite("selected-tool-frames.jsonl", selected.join("\n") + "\n");
safeWrite("native-tool-subtrees.jsonl", extracted.join("\n") + "\n");
safeWrite(
  "private-frame-metadata.json",
  JSON.stringify(privateMetadata, null, 2) + "\n",
);
if (omitted["streamed-tool-input"])
  applied.push({
    placeholder: "«TOOL-INPUT-DELTAS»",
    reason: "streamed tool-input JSON deltas removed before redaction",
  });
if (omitted["private-payload-frame"])
  applied.push({
    placeholder: "«PRIVATE-PAYLOAD-FRAMES»",
    reason:
      "whole frames containing thinking, signatures, or encrypted payload excluded; allowlisted metadata inventoried separately",
  });
safeWrite("stdin.jsonl", input);
safeWrite("stderr.txt", result.stderr ?? "");
safeWrite(
  "capture.json",
  JSON.stringify(
    {
      executableVersion: version,
      startedAt: start,
      finishedAt: new Date().toISOString(),
      args,
      processExitCode: result.status,
      signal: result.signal,
      spawnError: result.error?.message,
      omitted,
      settingsPolicy:
        "No model, effort, thinking, reasoning-summary, or settings override. Safe mode disables customizations; authentication and model selection remain inherited. No session persistence. Native credentials are not read.",
      redactions: applied,
    },
    null,
    2,
  ) + "\n",
);
safeWrite(
  "recording.json",
  JSON.stringify(
    {
      harness: "claude-code",
      executableVersion: version,
      protocolVersion: version.split(" ")[0],
      recordedAt: start,
      redactions: applied,
      refreshCommand:
        "timeout -k 10s 180s bun docs/research/native-observed-facts-captures/claude/probe.mjs" +
        (reasoning ? " reasoning" : ""),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    processExitCode: result.status,
    signal: result.signal,
    retainedLines: kept.length,
    omitted,
    nativeToolSubtrees: extracted.length,
  }),
);
