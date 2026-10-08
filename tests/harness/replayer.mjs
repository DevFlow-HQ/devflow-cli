#!/usr/bin/env bun
// The `claude` replayer (#111/#112). It stands in for a real Claude Code
// executable so the Adapter's discovery, shim resolution, and spawning run for
// real in CI on all three OSes — never a fake in place of a spawn. A test drops
// it on a temporary PATH under the name `claude` (a chmod'd shebang script on
// POSIX; an npm-style `.cmd` shim naming the Bun runtime plus this script on
// Windows) and spawns it directly. It parses argv, answers `--version`, then for
// a Turn case waits for each stdin frame before emitting that Turn's recorded
// stdout/stderr bytes. The one dynamic protocol value is `session_id`: recorded
// frames echo the id supplied on this invocation, as real Claude Code does, so an
// installed binary can mint its production UUID while every other recorded byte
// remains unchanged. This preserves the real process and backpressure seam.
//
// It records argv, cwd, and each intact stdin line to the log named in its
// runtime configuration. From #115 the case directory is a real recorded fixture
// under tests/harness/fixtures/claude-code/<case>/, and a Turn may carry a
// `workspacePatch` — a git diff the replayer applies in its launch cwd as the
// Turn concludes, so a replayed Test Repair Turn leaves the Workspace fixed
// exactly as the real recording did. A `workingAreaPatch` is applied the same way
// in the directory named by `--add-dir` — the Run working area (#222).

import { backgroundTree } from "./background-tree.mjs";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const scriptDir = dirname(process.argv[1]);
const recording = JSON.parse(
  readFileSync(join(scriptDir, "recording.json"), "utf8"),
);
const args = process.argv.slice(2);
const invocationId = `${process.pid}-${Date.now()}`;

// SIGTERM ends the Turn and the process (exit 143), matching real `claude -p`. It
// is installed at startup so an interrupt — which only ever arrives after the Turn
// is live — never races the handler. A case may swap this for a swallow below to
// model a process that ignores SIGTERM and must be force-killed.
process.on("SIGTERM", () => process.exit(143));

if (recording.log) {
  appendFileSync(
    recording.log,
    JSON.stringify({
      type: "start",
      id: invocationId,
      args,
      cwd: process.cwd(),
    }) + "\n",
  );
}

if (args.includes("--version")) {
  process.stdout.write(recording.version + "\n");
  process.exit(0);
}

const probing = args.includes("--no-session-persistence");
const caseDirectory =
  recording.protocolCaseDirectory ??
  join(recording.settingsDirectory, "settings");
if (typeof caseDirectory !== "string") {
  process.stderr.write("secant replayer: no protocol case configured\n");
  process.exit(2);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

// Fresh production launches mint a UUID that cannot be present in a checked-in
// recording. Resume recordings deliberately preserve their captured Session id:
// some cases prove acknowledgement and others prove a mismatched acknowledgement.
const requestedSessionId = valueAfter("--session-id");

// Each `steer` step, and each Turn carrying `uuid`, maps the uuid the recorder
// stamped on that stdin message to the one the Adapter minted (#359), so every
// later recorded byte naming it (lifecycle frames, `user_message_uuids`)
// echoes the Adapter's, as `session_id` does.
const messageUuids = new Map();

/** Replay recorded bytes while echoing this invocation's supplied Session id
 *  and each Steer's minted uuid. Both are UUIDs in the recordings and at
 *  runtime, so replacement keeps frame boundaries and byte counts stable. */
function replayBytes(path) {
  const bytes = readFileSync(path);
  if (requestedSessionId === undefined && messageUuids.size === 0) return bytes;
  let text = bytes.toString("utf8");
  if (requestedSessionId !== undefined) {
    text = text.replace(
      /"session_id":"[^"]+"/g,
      `"session_id":${JSON.stringify(requestedSessionId)}`,
    );
  }
  for (const [recorded, minted] of messageUuids) {
    text = text.replaceAll(recorded, minted);
  }
  return Buffer.from(text);
}

// Select each MCP endpoint by its configured server name. Permission steps retain
// their original shape; Agent-call steps name a server, tool and arguments.
const permissionTool = valueAfter("--permission-prompt-tool");
let mcpServers = {};
let attached = false;
const clients = new Map();
function connectServer(name) {
  if (!clients.has(name))
    clients.set(
      name,
      (async () => {
        const entry = mcpServers[name];
        if (!entry) throw new Error(`MCP server ${name} is not attached`);
        const { Client } = await import(recording.mcpClientModule);
        const { StreamableHTTPClientTransport } = await import(
          recording.mcpTransportModule
        );
        const client = new Client({
          name: "secant-replayer",
          version: "1.0.0",
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(entry.url), {
            requestInit: { headers: entry.headers ?? {} },
          }),
        );
        return client;
      })(),
    );
  return clients.get(name);
}
async function closeClients() {
  await Promise.allSettled(
    [...clients.values()].map(async (promise) => (await promise).close()),
  );
}
async function bridgeCall(spec) {
  const server = spec.server ?? "secant-permissions";
  const tool = spec.tool ?? permissionTool?.replace(`mcp__${server}__`, "");
  let payload;
  try {
    const client = await connectServer(server);
    const result = await client.callTool({
      name: tool,
      arguments: spec.arguments ?? {
        tool_name: spec.tool_name,
        input: spec.input,
      },
    });
    const text = result?.content?.[0]?.text;
    payload = spec.server
      ? { isError: result.isError ?? false, text }
      : text
        ? JSON.parse(text)
        : { behavior: "unknown" };
  } catch (error) {
    payload = { behavior: "error", message: String(error) };
  }
  if (spec.expect && JSON.stringify(payload) !== JSON.stringify(spec.expect))
    throw new Error(`MCP reply mismatch: ${JSON.stringify(payload)}`);
  if (recording.log)
    appendFileSync(
      recording.log,
      JSON.stringify({
        type: "bridge",
        id: invocationId,
        server,
        tool,
        tool_name: spec.tool_name,
        ...payload,
        message: payload.message ?? null,
        updatedInput: payload.updatedInput ?? null,
      }) + "\n",
    );
  return payload;
}

/** A deny "request expired" means Secant tore the Turn down under the call. */
function isExpired(payload) {
  return payload.behavior === "deny" && payload.message === "request expired";
}

const required = [
  ["--input-format", "stream-json"],
  ["--output-format", "stream-json"],
];
const valid =
  args.includes("-p") &&
  args.includes("--verbose") &&
  args.includes("--include-partial-messages") &&
  required.every(([flag, value]) => valueAfter(flag) === value) &&
  (probing
    ? valueAfter("--session-id") === undefined &&
      valueAfter("--resume") === undefined
    : (valueAfter("--session-id") !== undefined) !==
      (valueAfter("--resume") !== undefined));
if (!valid) {
  process.stderr.write("secant replayer: required stream-json flags missing\n");
  process.exit(2);
}

const protocolCase = JSON.parse(
  readFileSync(join(caseDirectory, "case.json"), "utf8"),
);

// The invocation log's entries, which this replayer wrote itself one JSON object
// per line. A line that will not parse means the log is corrupt: fail loudly
// rather than silently mis-count and replay the wrong process or Turn.
function logEntries() {
  if (!recording.log) return [];
  return readFileSync(recording.log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        process.stderr.write("secant replayer: invocation log is not JSON\n");
        process.exit(2);
      }
    });
}

/** The ids of earlier launches carrying `flag` (this process's own start is logged
 *  already, so it is excluded by id). */
function priorLaunches(entries, flag) {
  return new Set(
    entries
      .filter(
        (entry) =>
          entry.type === "start" &&
          entry.id !== invocationId &&
          Array.isArray(entry.args) &&
          entry.args.includes(flag),
      )
      .map((entry) => entry.id),
  );
}

// A launch with `--resume` reattaches a detached Session: replay the case's
// separately recorded resumed process (its init may or may not acknowledge the
// Session, exactly as recorded). A first launch uses the initial recording. A case
// may also record later fresh Sessions under `sessions` (#224): each iteration of a
// human-controlled Repeat opens its own conversation with `--session-id`, so the
// Nth fresh launch after the first plays `sessions[N-1]`. A case without
// `sessions` replays its initial recording for every fresh launch, as before.
const resuming = valueAfter("--resume") !== undefined;
const freshOrdinal =
  !resuming && Array.isArray(protocolCase.sessions)
    ? priorLaunches(logEntries(), "--session-id").size
    : 0;
const playback = probing
  ? protocolCase
  : resuming
    ? protocolCase.resume
    : freshOrdinal === 0
      ? protocolCase
      : protocolCase.sessions[freshOrdinal - 1];
if (!playback) {
  process.stderr.write(
    "secant replayer: no recorded process for this launch\n",
  );
  process.exit(2);
}

// A Session can be resumed by more than one successive process — an interactive
// grill sends each human Turn as its own resumed launch, and a following Agent
// Step resumes the same Session again (#123). Each launch is a fresh process that
// restarts `turnIndex` at 0, so the process alone cannot tell where in the resume
// block it starts. Recover that from the invocation log: the number of Turns
// (stdin `user` frames) that prior `--resume` launches already consumed is this
// launch's offset into the resume block. Counting frames (not launches) stays
// correct even if a resumed launch is held open across several Turns. Turns are
// strictly sequential (the Run rests between them), so no concurrent write races
// this count; a single resumed process sees offset 0, unchanged.
let resumeOffset = 0;
if (resuming && recording.log) {
  const entries = logEntries();
  const priorResumeIds = priorLaunches(entries, "--resume");
  resumeOffset = entries.filter(
    (entry) => entry.type === "stdin" && priorResumeIds.has(entry.id),
  ).length;
}

// A case can model a process that ignores SIGTERM: swallow it so only SIGKILL
// (a group force-kill) stops the process, driving the Adapter's escalation path.
if (playback.ignoreSigterm) {
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {});
}

const write = (stream, bytes) =>
  new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });

// stdin is read for the whole process, not only between Turns: a Turn's steps
// may still be emitting, or blocked on a bridge call, when the Adapter writes a
// `control_request` (#346). User Turn frames queue for the main loop; control
// frames queue for the Turn's `control` steps. A control frame that arrives once
// the current Turn has no `control` step left to take it is a replay failure.
const userFrames = [];
const controlFrames = [];
const elicitationReplies = [];
let frameWaiter;
let stdinEnded = false;
let awaitingTurn = false;
// How many `get_settings` control steps the open window (a Turn's steps, or the
// next Turn's `before`) has yet to take (#348): such a read is a recorded
// read-back, while every other `get_settings` takes the sticky settings reply.
let settingsSteps = 0;
const countSettings = (specs) =>
  specs.filter((spec) => spec?.subtype === "get_settings").length;
const wake = () => {
  const waiter = frameWaiter;
  frameWaiter = undefined;
  waiter?.();
};
const unexpectedControl = () => {
  process.stderr.write(
    "secant replayer: a control request arrived with no control step to take it\n",
  );
  process.exit(2);
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.length === 0) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write("secant replayer: stdin was not JSON\n");
    process.exit(2);
  }
  if (frame.type === "control_response") {
    if (recording.log)
      appendFileSync(
        recording.log,
        JSON.stringify({ type: "elicitation-reply", id: invocationId, line }) +
          "\n",
      );
    elicitationReplies.push(frame);
    wake();
    return;
  }
  if (frame.type === "control_request") {
    if (recording.log) {
      appendFileSync(
        recording.log,
        JSON.stringify({ type: "control", id: invocationId, line }) + "\n",
      );
    }
    if (frame.request?.subtype === "mcp_set_servers") {
      if (attached || userFrames.length > 0) unexpectedControl();
      mcpServers = frame.request.servers;
      const responseFile = existsSync(join(caseDirectory, "set-servers.stdout"))
        ? join(caseDirectory, "set-servers.stdout")
        : join(
            recording.settingsDirectory,
            "mcp-servers",
            "set-servers.stdout",
          );
      const reply = readFileSync(responseFile, "utf8").replace(
        /"request_id":"[^"]+"/g,
        `"request_id":${JSON.stringify(frame.request_id)}`,
      );
      process.stdout.write(reply);
      attached = true;
      return;
    }
    if (frame.request?.subtype === "get_settings" && settingsSteps > 0) {
      settingsSteps -= 1;
      controlFrames.push(frame);
      wake();
      return;
    }
    if (frame.request?.subtype === "get_settings") {
      const settingsCase = protocolCase.settings;
      if (settingsCase?.unanswered) return;
      const directory =
        settingsCase === undefined
          ? join(
              recording.settingsDirectory,
              process.env.CLAUDE_CODE_EFFORT_LEVEL === "xhigh"
                ? "settings-locked"
                : "settings",
            )
          : caseDirectory;
      const file = settingsCase?.stdout ?? "settings.stdout";
      const reply = readFileSync(join(directory, file), "utf8").replace(
        /"request_id":"[^"]+"/g,
        `"request_id":${JSON.stringify(frame.request_id)}`,
      );
      process.stdout.write(reply);
      return;
    }
    if (awaitingTurn) unexpectedControl();
    controlFrames.push(frame);
    wake();
    return;
  }
  if (frame.type !== "user" || frame.message?.role !== "user") {
    process.stderr.write("secant replayer: stdin was not a user Turn\n");
    process.exit(2);
  }
  if (!attached) unexpectedControl();
  userFrames.push(line);
  wake();
});
lines.on("close", () => {
  stdinEnded = true;
  wake();
});

/** The next queued frame from `queue`, or undefined once stdin has ended. */
async function nextFrame(queue) {
  while (queue.length === 0) {
    if (stdinEnded) return undefined;
    await new Promise((resolve) => {
      frameWaiter = resolve;
    });
  }
  return queue.shift();
}

/** Perform one `steer` step (#359): take the next stdin `user` frame written
 *  while the Turn runs, which must carry a uuid, and echo that uuid wherever the
 *  recording names `spec.uuid`. stdin closing first ends the process. */
async function steerStep(spec) {
  const line = await nextFrame(userFrames);
  if (line === undefined) process.exit(playback.exitCode ?? 0);
  if (recording.log) {
    appendFileSync(
      recording.log,
      JSON.stringify({ type: "steer", id: invocationId, line }) + "\n",
    );
  }
  const uuid = JSON.parse(line).uuid;
  if (typeof uuid !== "string" || uuid.length === 0) {
    process.stderr.write("secant replayer: a Steer frame carried no uuid\n");
    process.exit(2);
  }
  messageUuids.set(spec.uuid, uuid);
}

/** Perform one `control` step: take the next control request, which must carry
 *  the step's subtype (and `cancel_queued` when the step names it), then emit
 *  the step's recorded bytes (if any) with the recorded `request_id` replaced by
 *  the one the Adapter minted, the way `session_id` is echoed. A step without
 *  `emit` swallows the request: it models a Claude Code that never confirms.
 *  stdin closing first ends the process. */
async function controlStep(spec) {
  const frame = await nextFrame(controlFrames);
  if (frame === undefined) process.exit(playback.exitCode ?? 0);
  if (frame.request?.subtype !== spec.subtype) {
    process.stderr.write(
      `secant replayer: expected a ${spec.subtype} control request\n`,
    );
    process.exit(2);
  }
  if (spec.cancelQueued === true && frame.request?.cancel_queued !== true) {
    process.stderr.write(
      `secant replayer: expected the ${spec.subtype} to cancel queued messages\n`,
    );
    process.exit(2);
  }
  if (typeof spec.emit !== "string") return;
  const bytes = replayBytes(join(caseDirectory, spec.emit))
    .toString("utf8")
    .replace(/"request_id":"[^"]+"/g, (match) =>
      spec.requestId === undefined ||
      match === `"request_id":${JSON.stringify(spec.requestId)}`
        ? `"request_id":${JSON.stringify(frame.request_id)}`
        : match,
    );
  await write(process.stdout, Buffer.from(bytes));
}

let turnIndex = 0;
for (;;) {
  // A Turn's `before` steps (#348) take the control requests the Adapter sends
  // between Turns, such as a Model choice change to a reused child, ahead of
  // that Turn's prompt.
  const upcoming = playback.turns[resumeOffset + turnIndex];
  const before = Array.isArray(upcoming?.before)
    ? upcoming.before.filter((spec) => spec.subtype !== "mcp_set_servers")
    : [];
  settingsSteps = countSettings(before);
  for (const spec of before) await controlStep(spec);
  settingsSteps = 0;
  awaitingTurn = true;
  if (controlFrames.length > 0) unexpectedControl();
  const line = await nextFrame(userFrames);
  awaitingTurn = false;
  if (line === undefined) break;
  if (recording.log) {
    appendFileSync(
      recording.log,
      JSON.stringify({ type: "stdin", id: invocationId, line }) + "\n",
    );
  }
  const turn = playback.turns[resumeOffset + turnIndex++];
  if (!turn) {
    process.stderr.write(
      "secant replayer: received more Turns than recorded\n",
    );
    process.exit(2);
  }
  if (typeof turn.uuid === "string") {
    const uuid = JSON.parse(line).uuid;
    if (typeof uuid !== "string" || uuid.length === 0) {
      process.stderr.write("secant replayer: a Turn frame carried no uuid\n");
      process.exit(2);
    }
    messageUuids.set(turn.uuid, uuid);
  }
  await backgroundTree(turn.backgroundTree);
  let workspacePatchApplied = false;
  const applyWorkspacePatch = () => {
    if (workspacePatchApplied) return;
    workspacePatchApplied = true;
    for (const [patch, cwd] of [
      [turn.workspacePatch, process.cwd()],
      [turn.workingAreaPatch, valueAfter("--add-dir")],
    ]) {
      if (typeof patch !== "string") continue;
      if (cwd === undefined) {
        process.stderr.write(
          `secant replayer: ${patch} needs a --add-dir directory\n`,
        );
        process.exit(3);
      }
      try {
        execFileSync(
          "git",
          ["apply", "--whitespace=nowarn", join(caseDirectory, patch)],
          { cwd },
        );
      } catch (error) {
        process.stderr.write(
          `secant replayer: git apply ${patch} failed: ${
            error?.message ?? error
          }\n`,
        );
        process.exit(3);
      }
    }
  };
  if (Array.isArray(turn.steps)) {
    settingsSteps = countSettings(
      turn.steps.flatMap((step) => (step.control ? [step.control] : [])),
    );
    // Ordered mix of stdout emissions and permission-bridge calls. A bridge step
    // blocks until Secant answers it, so the recorded stdout after it emits only
    // once the permission verdict is in — the "recorded point in the Turn".
    // A `control` step blocks until the Adapter's control request arrives, and a
    // `steer` step until the Adapter writes a Steer's `user` frame mid-Turn.
    // A bridge call answered "request expired" skips ahead to the Turn's next
    // `control` step (Claude Code still answers an Interrupt) or, with none,
    // ends the process as Claude Code would when its permission call is refused.
    let expired = false;
    for (const step of turn.steps) {
      if (expired && !step.control) continue;
      if (step.elicitationReply) {
        const frame = await nextFrame(elicitationReplies);
        if (
          frame?.response?.request_id !== step.elicitationReply.requestId ||
          frame?.response?.response?.action !== "decline"
        )
          throw new Error("elicitation decline did not match its request");
      } else if (step.control) {
        await controlStep(step.control);
      } else if (step.steer) {
        await steerStep(step.steer);
      } else if (step.emit) {
        const bytes = replayBytes(join(caseDirectory, step.emit));
        // A recorded Workspace patch is the effect the Harness completed during
        // this Turn. Make it visible before the terminal result frame can advance
        // the Run to its next Step; applying it after writing that frame races the
        // consumer and can let the next Command observe stale Workspace bytes.
        if (bytes.includes(Buffer.from('"type":"result"'))) {
          applyWorkspacePatch();
        }
        await write(process.stdout, bytes);
      } else if (step.bridge) {
        expired = isExpired(await bridgeCall(step.bridge));
      } else if (Array.isArray(step.bridgeAll)) {
        expired = (await Promise.all(step.bridgeAll.map(bridgeCall))).some(
          isExpired,
        );
      }
    }
    if (expired && !turn.steps.some((step) => step.control)) {
      await closeClients();
      process.exit(0);
    }
  } else {
    await write(process.stdout, replayBytes(join(caseDirectory, turn.stdout)));
    if (turn.stderr) {
      await write(
        process.stderr,
        replayBytes(join(caseDirectory, turn.stderr)),
      );
    }
  }
  // Legacy/simple cases without an explicit terminal result emission still apply
  // their patch before the replayer waits for another Turn.
  applyWorkspacePatch();
  // A Turn that models "process exits without a result" (a lost or corrupt case)
  // ends the process right after its bytes instead of awaiting more stdin.
  if (turn.exitAfter) process.exit(playback.exitCode ?? 0);
}

await closeClients();
process.exitCode = playback.exitCode;
