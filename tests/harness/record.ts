// The opt-in Claude Code recorder (#115). It drives a named scenario against the
// installed `claude`, reproducing the exact launch contract Secant's Claude Code
// Adapter builds (src/harness/claude-code.ts `launch`) against the production
// permission bridge itself — composed through the Harness entry with a recording
// approval router (#127 D3) — so the bytes it captures on stdout are exactly what
// the Adapter's `consumeStdout` would read. Per case it
// writes the byte-faithful stdout stream(s), the stdin frame(s) it sent, the bridge
// calls and their ordering relative to stdout, a per-Turn Workspace patch (git diff
// of the scenario Workspace across the Turn), and the `recording.json` sidecar.
//
// It never runs in CI (the default suite is deterministic and Harness-free). Run it
// locally with the installed, logged-in Claude Code:
//
//   bun tests/harness/record.ts <case>        # one case
//   bun tests/harness/record.ts all           # every real case
//
// Cases: plain, test-repair, interrupt, resume, authentication, protocol-corruption,
// matt-front, steer-within, steer-boundary, steer-cancel, compaction.
// It records with `--restricted` (real login and model, but no personal hooks,
// CLAUDE.md, plugins, or settings) so fixtures are clean and reproducible. The
// authentication case uses a fresh, not-logged-in `CLAUDE_CONFIG_DIR`, so the real
// login is never disturbed. Every host secret is redacted, and the recording is
// refused if any credential pattern survives.

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { startPermissionBridge } from "../../src/harness/harness.js";
import {
  assertNoCredentials,
  envSecrets,
  redact,
  type KnownSecret,
  type Redaction,
} from "./redact.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "claude-code");
const HARNESS = "claude-code";

/** Canonical per-case session ids — the same ids the Adapter tests mint, so the
 *  recorded frames echo exactly what a test's `--session-id`/`--resume` carries. */
const SESSION_IDS = {
  plain: "11111111-1111-4111-8111-111111111111",
  "test-repair": "77777777-7777-4777-8777-777777777777",
  interrupt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  resume: "55555555-5555-4555-8555-555555555555",
  authentication: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "protocol-corruption": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "matt-front": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "steer-within": "57ee1111-1111-4111-8111-111111111111",
  "steer-boundary": "57ee2222-2222-4222-8222-222222222222",
  "steer-cancel": "57ee3333-3333-4333-8333-333333333333",
  compaction: "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0",
} as const;
/** Ticket planning opens its own Session before implementation Sessions (#295). */
const MATT_FRONT_TICKETS_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb0";
/** The matt-front implementation Sessions (#224): one fresh id per ticket. */
const MATT_FRONT_IMPLEMENT_SESSION_IDS = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
] as const;

// --- The launch contract (must mirror src/harness/claude-code.ts `launch`) ----

function launchArgs(
  sessionArgs: string[],
  bridge: RecorderBridge,
  /** The Run working area the Adapter forwards as `--add-dir` (#214). */
  writableDirectory?: string,
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Recorder-only: `--restricted` keeps the real login and model but drops this
    // host's CLAUDE.md, skills, plugins, hooks, and settings-file MCP, so the
    // recording is clean, reproducible, and free of personal config. It is NOT
    // part of the Adapter's launch contract (the Adapter is deliberately
    // user-compatible); a user-compatible launch merely adds hook/status frames
    // the Adapter treats as generic activity, so the protocol shape is the same.
    "--restricted",
    ...sessionArgs,
    ...(writableDirectory !== undefined
      ? ["--add-dir", writableDirectory]
      : []),
    ...bridge.launchArgs,
  ];
}

/** A user frame. The held-process recorders stamp a uuid exactly as the
 *  Adapter's `encodeUserMessage` does (#359); the single-Turn recorders predate
 *  it, and Claude Code then lists no uuid on that Turn's result. */
function userFrame(text: string, uuid?: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(uuid !== undefined ? { uuid } : {}),
  })}\n`;
}

// --- The permission bridge, composed with a recording router --------------------

interface BridgeCall {
  readonly tool_name: string;
  readonly input: unknown;
  // ponytail: stdout pipe events and the loopback HTTP bridge call are separate
  // event sources with no cross-ordering guarantee, so this offset can under-count
  // stdout still queued when the call fires and split a segment slightly early. It
  // is exact enough in practice (the segment boundary only affects when the replay
  // raises the approval, not the bytes), and a bad split fails the case's replay
  // test loudly. Upgrade to draining stdout on the call if a case ever mis-splits.
  /** Bytes of stdout seen when this call arrived, so stdout can be split around it. */
  readonly stdoutOffset: number;
}

interface RecorderBridge {
  /** The production bridge's launch flags, spliced into the launch argv. */
  readonly launchArgs: readonly string[];
  /** The bridge's bearer, listed as a known secret so the recording redacts it. */
  readonly token: string;
  readonly calls: BridgeCall[];
  close(): Promise<void>;
}

/** Start the production permission bridge with a recording router: every call is
 *  logged with the stdout byte count `offset` reports when it arrived, so calls
 *  can be ordered against stdout, then answered by `answer`. */
async function startBridge(
  answer: (call: { tool_name: string; input: unknown }) => {
    behavior: "allow" | "deny";
    message?: string;
  },
  offset: () => number,
): Promise<RecorderBridge> {
  const calls: BridgeCall[] = [];
  const bridge = await startPermissionBridge((_session, request) => {
    const input = toolInput(request.input);
    calls.push({ tool_name: request.tool, input, stdoutOffset: offset() });
    const verdict = answer({ tool_name: request.tool, input });
    return Promise.resolve(
      verdict.behavior === "allow"
        ? { decision: "allow" }
        : { decision: "deny", message: verdict.message ?? "denied" },
    );
  });
  return {
    launchArgs: bridge.session("recording").launchArgs,
    token: bridge.session("recording").bearer,
    calls,
    close: () => bridge.close(),
  };
}

/** The bridge hands its router the tool input serialized to the request shape
 *  (an object as JSON, a bare string as itself). The case needs the object back
 *  so the replayer can call the bridge with it; a bare string stays a string. */
function toolInput(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return serialized;
  }
}

// --- Spawning and capturing a real Turn ---------------------------------------

interface Capture {
  /** The raw stdout bytes, exactly as they arrived. */
  readonly stdout: Buffer;
  /** The raw stderr bytes. */
  readonly stderr: Buffer;
  readonly exitCode: number;
}

interface RunControl {
  /** Called with the child and the growing stdout buffer on each chunk, so a
   *  scenario can interrupt or force-kill at a chosen point. Resolves the returned
   *  promise to stop waiting for a natural exit (the child is left to the caller). */
  onChunk?: (
    child: ChildProcessWithoutNullStreams,
    stdout: Buffer,
    chunk: Buffer,
  ) => void;
}

/** Spawn `claude` with the given argv, write one user frame, and capture raw
 *  streams until the process exits (or a control stops it). */
function runTurn(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  control?: RunControl;
}): Promise<Capture> {
  const child = spawn("claude", options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    options.control?.onChunk?.(child, stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]);
  });
  child.stdin.write(options.input);
  // Close stdin after the one frame so `claude -p` finishes the single Turn and
  // exits (it otherwise blocks waiting for more stream-json frames). The current
  // Turn still runs to completion, so interrupt/corruption scenarios kill it
  // mid-flight before it settles.
  child.stdin.end();
  return new Promise<Capture>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (signal ? 128 + signalNumber(signal) : 0),
      });
    });
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === "SIGKILL" ? 9 : signal === "SIGTERM" ? 15 : 0;
}

// --- Writing a case directory -------------------------------------------------

function baseEnv(): NodeJS.ProcessEnv {
  // Keep the real config dir so the OS-keychain login applies (a copied or fresh
  // config dir is treated as a new install and is not logged in). Cleanliness
  // comes from `--restricted`, not config isolation. Drop any API key so OAuth is
  // used — except the authentication scenario, which sets a bad one deliberately.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // `--restricted` does not stop the account's claude.ai connectors loading
  // during a held-open process (#346's second Turn listed them in its init).
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  return env;
}

function hostSecrets(bridgeToken?: string): KnownSecret[] {
  const secrets: KnownSecret[] = [
    { value: homedir(), placeholder: "«HOME»", reason: "home directory" },
    { value: userInfo().username, placeholder: "«USER»", reason: "user name" },
    // Any secret-shaped environment variable on the recording host, so a value
    // the scenario never named is still redacted before the bytes are written.
    ...envSecrets(),
  ];
  // The per-user runtime directory names the recording host's uid in an init's
  // `messaging_socket_path`.
  if (process.env.XDG_RUNTIME_DIR !== undefined) {
    secrets.push({
      value: process.env.XDG_RUNTIME_DIR,
      placeholder: "«RUNTIME_DIR»",
      reason: "user runtime directory",
    });
  }
  if (bridgeToken !== undefined) {
    secrets.push({
      value: bridgeToken,
      placeholder: "«BRIDGE_TOKEN»",
      reason: "MCP permission bridge bearer token",
    });
  }
  return secrets;
}

interface WriteFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/** Drop `stream_event` frames carrying `input_json_delta` (streamed tool-input),
 *  preserving every other line's exact bytes. Unparseable lines (e.g. a truncated
 *  corruption frame) are kept as-is. */
function dropToolInputDeltas(text: string): {
  text: string;
  dropped: boolean;
} {
  let dropped = false;
  const kept = text.split("\n").filter((line) => {
    if (!line.trimStart().startsWith("{")) return true;
    try {
      const frame = JSON.parse(line) as {
        type?: unknown;
        event?: { delta?: { type?: unknown } };
      };
      if (
        frame.type === "stream_event" &&
        frame.event?.delta?.type === "input_json_delta"
      ) {
        dropped = true;
        return false;
      }
    } catch {
      // Keep a line that is not valid JSON (a deliberately truncated frame).
    }
    return true;
  });
  return { text: kept.join("\n"), dropped };
}

/** Every host-machine path form to redact: the temp directory and its realpath
 *  (macOS tmpdir is a `/var/folders` symlink to `/private/var/folders`, and the
 *  init frame's `cwd` reports the resolved form). */
function pathSecrets(
  path: string | undefined,
  placeholder: string,
  reason: string,
): KnownSecret[] {
  if (path === undefined) return [];
  const real = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  })();
  return [...new Set([path, real])].map((value) => ({
    value,
    placeholder,
    reason,
  }));
}

/** Redact every file's bytes AND `case.json` (a recorded bridge input can carry a
 *  path or, in a future scenario, a secret), refuse on a surviving credential, then
 *  write the case directory with the six-field `recording.json` sidecar. */
function writeCase(options: {
  name: string;
  files: WriteFile[];
  caseJson: unknown;
  secrets: KnownSecret[];
  executableVersion: string;
  protocolVersion: string;
  extraRedactions?: Redaction[];
  /** The scenario's temp Workspace, redacted from stdout and case.json. */
  workspace?: string;
  /** The scenario's temp config dir, redacted (the authentication case). */
  configDir?: string;
  /** The scenario's temp Run working area, redacted (the matt-front case). */
  workingArea?: string;
}): void {
  const dir = join(FIXTURES, options.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Machine paths are redacted from every artefact, so a committed fixture never
  // carries the recording host's directory layout.
  const secrets: KnownSecret[] = [
    ...pathSecrets(
      options.workspace,
      "«WORKSPACE»",
      "recording workspace path",
    ),
    ...pathSecrets(options.configDir, "«CONFIG»", "recording config directory"),
    ...pathSecrets(
      options.workingArea,
      "«WORKING_AREA»",
      "recording Run working area path",
    ),
    ...options.secrets,
  ];
  const applied: Redaction[] = [...(options.extraRedactions ?? [])];
  const mergeRedactions = (redactions: Redaction[]) => {
    for (const entry of redactions) {
      if (!applied.some((a) => a.placeholder === entry.placeholder))
        applied.push(entry);
    }
  };
  for (const file of options.files) {
    // Drop streamed tool-input JSON deltas first: the Adapter never consumes them
    // (only text deltas feed previews), and they stream a tool's input path
    // character by character, fragmenting it past any substring redaction.
    const filtered = dropToolInputDeltas(file.bytes.toString("utf8"));
    if (filtered.dropped) {
      mergeRedactions([
        {
          placeholder: "«TOOL-INPUT-DELTAS»",
          reason:
            "streamed tool-input JSON deltas removed (not consumed by the Adapter; they fragment host paths past substring redaction)",
        },
      ]);
    }
    const { text, redactions } = redact(filtered.text, secrets);
    assertNoCredentials(text);
    mergeRedactions(redactions);
    writeFileSync(join(dir, file.name), text);
  }
  const caseJson = redact(
    `${JSON.stringify(options.caseJson, null, 2)}\n`,
    secrets,
  );
  assertNoCredentials(caseJson.text);
  mergeRedactions(caseJson.redactions);
  writeFileSync(join(dir, "case.json"), caseJson.text);
  writeFileSync(
    join(dir, "recording.json"),
    `${JSON.stringify(
      {
        harness: HARNESS,
        executableVersion: options.executableVersion,
        protocolVersion: options.protocolVersion,
        recordedAt: new Date().toISOString(),
        redactions: applied,
        refreshCommand: `bun tests/harness/record.ts ${options.name}`,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `recorded ${options.name}: ${options.files.map((f) => f.name).join(", ")}`,
  );
}

function claudeVersion(): string {
  return execFileSync("claude", ["--version"]).toString().trim();
}

/** The `claude_code_version` reported in an init frame, or a fallback. */
function protocolVersionOf(stdout: Buffer): string {
  const match = stdout
    .toString("utf8")
    .match(/"claude_code_version":"([^"]+)"/);
  return match?.[1] ?? "unknown";
}

function tempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- Scenarios ----------------------------------------------------------------

async function recordPlain(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(["--session-id", SESSION_IDS.plain], bridge),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Reply with exactly the single word: hello. Do not use any tools.",
      ),
    });
    writeCase({
      name: "plain",
      files: [{ name: "turn-1.stdout", bytes: capture.stdout }],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ stdout: "turn-1.stdout" }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

async function recordTestRepair(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  // A minimal git Workspace with one failing test: sum() returns the wrong value.
  execFileSync("git", ["init", "-q"], { cwd: ws });
  execFileSync("git", ["config", "user.email", "rec@secant.test"], { cwd: ws });
  execFileSync("git", ["config", "user.name", "recorder"], { cwd: ws });
  writeFileSync(join(ws, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  writeFileSync(
    join(ws, "sum.test.mjs"),
    [
      "import assert from 'node:assert';",
      "import { sum } from './sum.mjs';",
      "assert.equal(sum(2, 3), 5);",
      "console.log('sum ok');",
    ].join("\n") + "\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: ws });
  execFileSync("git", ["commit", "-q", "-m", "failing baseline"], { cwd: ws });

  let stdoutLen = 0;
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => stdoutLen,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(["--session-id", SESSION_IDS["test-repair"]], bridge),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "The test in sum.test.mjs fails. Fix the bug in sum.mjs so `node sum.test.mjs` passes. Edit sum.mjs; do not edit the test.",
      ),
      control: { onChunk: (_child, stdout) => (stdoutLen = stdout.length) },
    });
    // The Workspace patch across the Turn.
    const patch = execFileSync("git", ["diff"], { cwd: ws }).toString();
    if (patch.trim().length === 0) {
      throw new Error("test-repair: no Workspace change was produced");
    }
    // Split the captured stdout around each bridge call so, on replay, the bytes
    // after a permission prompt emit only once the verdict is in.
    const files: WriteFile[] = [];
    const steps: unknown[] = [];
    let cursor = 0;
    bridge.calls.forEach((call, index) => {
      const segment = capture.stdout.subarray(cursor, call.stdoutOffset);
      const name = `stdout-${index}.stdout`;
      files.push({ name, bytes: segment });
      steps.push({ emit: name });
      steps.push({ bridge: { tool_name: call.tool_name, input: call.input } });
      cursor = call.stdoutOffset;
    });
    const tail = capture.stdout.subarray(cursor);
    files.push({ name: "stdout-final.stdout", bytes: tail });
    steps.push({ emit: "stdout-final.stdout" });

    writeCase({
      name: "test-repair",
      files: [
        ...files,
        { name: "workspace.patch", bytes: Buffer.from(patch, "utf8") },
      ],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ steps, workspacePatch: "workspace.patch" }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** The recorder's control-request id. The replayer echoes the Adapter-minted id
 *  in its place, the way it echoes `session_id`. */
const RECORDED_INTERRUPT_REQUEST_ID = "secant-recorded-interrupt";

/** The byte offset of the line boundary at or before `offset`: a stdin write
 *  lands between pipe chunks, not between lines, so a partial line seen before
 *  the write belongs to the bytes after it. */
function lineBoundary(stdout: Buffer, offset: number): number {
  const newline = stdout.lastIndexOf(0x0a, offset - 1);
  return newline < 0 ? 0 : newline + 1;
}

/** Record the native Interrupt (#346) on one held-open process: Turn 1 streams,
 *  receives a stdin `control_request` `interrupt` (with `cancel_queued`, as the
 *  Adapter sends it, #359), and settles with the aborted `result`; Turn 2 then
 *  runs on the same process with no relaunch. stdout is split at the line
 *  boundaries where each stdin frame was written. */
async function recordInterrupt(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  try {
    let interrupted = false;
    let results = 0;
    const recorded = await recordHeld({
      sessionId: SESSION_IDS.interrupt,
      workspace: ws,
      prompt:
        "Write a long slow essay about the number seven, at least 500 words, using no tools. Take your time.",
      onFrame: (frame, held) => {
        const delta = (
          frame.event as { delta?: { type?: unknown } } | undefined
        )?.delta;
        if (
          !interrupted &&
          frame.type === "stream_event" &&
          delta?.type === "text_delta"
        ) {
          interrupted = true;
          held.write(interruptFrame());
          return;
        }
        if (frame.type !== "result") return;
        results += 1;
        if (results === 1) {
          held.write(
            userFrame(
              "Never mind. Reply with exactly: continued. Use no tools.",
              RECORDED_PROMPT_UUIDS[1],
            ),
          );
        } else held.end();
      },
    });
    writeCase({
      name: "interrupt",
      files: splitAtMarks(recorded.stdout, recorded.marks, [
        "turn-1.stdout",
        "interrupted.stdout",
        "turn-2.stdout",
      ]),
      caseJson: {
        exitCode: recorded.exitCode,
        turns: [
          {
            uuid: RECORDED_PROMPT_UUIDS[0],
            steps: [
              { emit: "turn-1.stdout" },
              {
                control: {
                  subtype: "interrupt",
                  cancelQueued: true,
                  emit: "interrupted.stdout",
                },
              },
            ],
          },
          { uuid: RECORDED_PROMPT_UUIDS[1], stdout: "turn-2.stdout" },
        ],
      },
      workspace: ws,
      secrets: hostSecrets(recorded.bridgeToken),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(recorded.stdout),
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// --- Steer and compaction on one held-open process (#359) ---------------------

/** The uuids the recorder stamps on its Steer frames and on each Turn's
 *  prompt. The replayer echoes the Adapter-minted uuid in their place, the way
 *  it echoes `session_id`. */
const RECORDED_STEER_UUIDS = [
  "5eee0000-0000-4000-8000-000000000001",
  "5eee0000-0000-4000-8000-000000000002",
] as const;
const RECORDED_PROMPT_UUIDS = [
  "9a0e0000-0000-4000-8000-000000000001",
  "9a0e0000-0000-4000-8000-000000000002",
  "9a0e0000-0000-4000-8000-000000000003",
] as const;

/** The Adapter's Interrupt, which always cancels queued messages. */
function interruptFrame(): string {
  return `${JSON.stringify({
    type: "control_request",
    request_id: RECORDED_INTERRUPT_REQUEST_ID,
    request: { subtype: "interrupt", cancel_queued: true },
  })}\n`;
}

interface HeldProcess {
  /** Write one stdin frame, marking the stdout offset it was written at. */
  write(frame: string): void;
  /** Close stdin so the process exits after its current work. */
  end(): void;
  /** Resolves when the process has closed. */
  readonly closed: Promise<void>;
}

interface HeldRecording {
  readonly stdout: Buffer;
  /** The stdout offset at each `write`, in order. */
  readonly marks: number[];
  readonly exitCode: number;
  readonly bridgeToken: string;
}

/** Hold one process's stdin open, as the Adapter does: send `prompt` (stamped
 *  with the first recorded prompt uuid), hand every
 *  stdout frame to `onFrame`, and answer each permission prompt through
 *  `approve`, which may write further frames before it allows the tool. */
async function recordHeld(options: {
  readonly sessionId: string;
  readonly workspace: string;
  readonly prompt: string;
  readonly onFrame: (frame: Record<string, unknown>, held: HeldProcess) => void;
  readonly approve?: (held: HeldProcess) => Promise<void>;
}): Promise<HeldRecording> {
  let held!: HeldProcess;
  const bridge = await startPermissionBridge(async () => {
    await options.approve?.(held);
    return { decision: "allow" };
  });
  try {
    const child = spawn(
      "claude",
      launchArgs(["--session-id", options.sessionId], {
        launchArgs: bridge.session("recording").launchArgs,
        token: bridge.session("recording").bearer,
        calls: [],
        close: () => bridge.close(),
      }),
      {
        cwd: options.workspace,
        env: baseEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = Buffer.alloc(0);
    let pending = "";
    const marks: number[] = [];
    const exit = new Promise<number>((resolve) => {
      child.on("close", (code, signal) => {
        resolve(code ?? (signal ? 128 + signalNumber(signal) : 0));
      });
    });
    held = {
      write: (frame) => {
        if (child.stdin.writableEnded) return;
        marks.push(stdout.length);
        child.stdin.write(frame);
      },
      end: () => {
        if (!child.stdin.writableEnded) child.stdin.end();
      },
      closed: exit.then(() => undefined),
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        options.onFrame(JSON.parse(line) as Record<string, unknown>, held);
      }
    });
    child.stderr.resume();
    child.stdin.write(userFrame(options.prompt, RECORDED_PROMPT_UUIDS[0]));
    const exitCode = await exit;
    return {
      stdout,
      marks,
      exitCode,
      bridgeToken: bridge.session("recording").bearer,
    };
  } finally {
    await bridge.close();
  }
}

/** Split recorded stdout at the line boundary of each stdin write. */
function splitAtMarks(
  stdout: Buffer,
  marks: readonly number[],
  names: readonly string[],
): WriteFile[] {
  if (marks.length + 1 !== names.length) {
    throw new Error(
      `expected ${names.length - 1} stdin writes, recorded ${marks.length}`,
    );
  }
  const bounds = [0, ...marks.map((mark) => lineBoundary(stdout, mark))];
  return names.map((name, index) => ({
    name,
    bytes: stdout.subarray(bounds[index], bounds[index + 1] ?? stdout.length),
  }));
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The tool round a Steer can land in: a Write whose permission prompt the
 *  recorder holds while it writes the Steer. */
const WRITE_PROMPT =
  "Use the Write tool to create a file named note.txt containing the word hi. Then reply with exactly: PINEAPPLE.";

/** A Steer written while a tool round waits on its approval reaches the model
 *  with the round's tool result, inside the same exchange. The approval wait
 *  is the recorder's timing device only: replay emits the bytes around the
 *  Steer and raises no approval. */
async function recordSteerWithin(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  try {
    const [uuid] = RECORDED_STEER_UUIDS;
    const recorded = await recordHeld({
      sessionId: SESSION_IDS["steer-within"],
      workspace: ws,
      prompt: WRITE_PROMPT,
      approve: async (held) => {
        held.write(
          userFrame("Also say the word MANGO at the end of your reply.", uuid),
        );
        await delay(2_000);
      },
      onFrame: (frame, held) => {
        if (frame.type === "result") held.end();
      },
    });
    writeCase({
      name: "steer-within",
      files: splitAtMarks(recorded.stdout, recorded.marks, [
        "turn-1.stdout",
        "steered.stdout",
      ]),
      caseJson: {
        exitCode: recorded.exitCode,
        turns: [
          {
            uuid: RECORDED_PROMPT_UUIDS[0],
            steps: [
              { emit: "turn-1.stdout" },
              { steer: { uuid } },
              { emit: "steered.stdout" },
            ],
          },
        ],
      },
      workspace: ws,
      secrets: hostSecrets(recorded.bridgeToken),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(recorded.stdout),
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** A Steer written while text streams runs as the next native exchange, after a
 *  `result`, a repeated same-id init, and its own `result`. */
async function recordSteerBoundary(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  try {
    const [uuid] = RECORDED_STEER_UUIDS;
    let steered = false;
    let results = 0;
    const recorded = await recordHeld({
      sessionId: SESSION_IDS["steer-boundary"],
      workspace: ws,
      prompt: "Count from one to forty in words, one per line. Use no tools.",
      onFrame: (frame, held) => {
        const delta = (
          frame.event as { delta?: { type?: unknown } } | undefined
        )?.delta;
        if (
          !steered &&
          frame.type === "stream_event" &&
          delta?.type === "text_delta"
        ) {
          steered = true;
          held.write(userFrame("Now reply with the single word MANGO.", uuid));
        }
        // The prompt's exchange, then the Steer's own exchange.
        if (frame.type === "result" && ++results === 2) held.end();
      },
    });
    writeCase({
      name: "steer-boundary",
      files: splitAtMarks(recorded.stdout, recorded.marks, [
        "turn-1.stdout",
        "steered.stdout",
      ]),
      caseJson: {
        exitCode: recorded.exitCode,
        turns: [
          {
            uuid: RECORDED_PROMPT_UUIDS[0],
            steps: [
              { emit: "turn-1.stdout" },
              { steer: { uuid } },
              { emit: "steered.stdout" },
            ],
          },
        ],
      },
      workspace: ws,
      secrets: hostSecrets(recorded.bridgeToken),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(recorded.stdout),
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Two Steers queue during a tool round, then the Interrupt cancels them with
 *  `cancel_queued`: each gets a `cancelled` lifecycle frame and none runs. */
async function recordSteerCancel(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  try {
    const [first, second] = RECORDED_STEER_UUIDS;
    const recorded = await recordHeld({
      sessionId: SESSION_IDS["steer-cancel"],
      workspace: ws,
      prompt: WRITE_PROMPT,
      approve: async (held) => {
        held.write(
          userFrame("Queued message one: reply with the word MANGO.", first),
        );
        await delay(300);
        held.write(
          userFrame("Queued message two: reply with the word KIWI.", second),
        );
        await delay(700);
        held.write(interruptFrame());
        // Claude Code cancels this approval call on the Interrupt.
        await held.closed;
      },
      onFrame: (frame, held) => {
        if (frame.type === "result") held.end();
      },
    });
    writeCase({
      name: "steer-cancel",
      files: splitAtMarks(recorded.stdout, recorded.marks, [
        "turn-1.stdout",
        "queued-1.stdout",
        "queued-2.stdout",
        "cancelled.stdout",
      ]),
      caseJson: {
        exitCode: recorded.exitCode,
        turns: [
          {
            uuid: RECORDED_PROMPT_UUIDS[0],
            steps: [
              { emit: "turn-1.stdout" },
              { steer: { uuid: first } },
              { emit: "queued-1.stdout" },
              { steer: { uuid: second } },
              { emit: "queued-2.stdout" },
              {
                control: {
                  subtype: "interrupt",
                  cancelQueued: true,
                  emit: "cancelled.stdout",
                },
              },
            ],
          },
        ],
      },
      workspace: ws,
      secrets: hostSecrets(recorded.bridgeToken),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(recorded.stdout),
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** `/compact` sent as its own Turn: one interrupted mid-compaction (reported
 *  `compact_result: "failed"`, then a success result), then one that compacts.
 *  Each compaction's init arrives after it, mid-exchange. */
async function recordCompaction(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  try {
    let results = 0;
    let interrupted = false;
    const recorded = await recordHeld({
      sessionId: SESSION_IDS.compaction,
      workspace: ws,
      prompt: "Reply with exactly: hello. Use no tools.",
      onFrame: (frame, held) => {
        if (
          frame.type === "system" &&
          frame.subtype === "status" &&
          frame.status === "compacting" &&
          results === 1 &&
          !interrupted
        ) {
          interrupted = true;
          held.write(interruptFrame());
        }
        if (frame.type !== "result") return;
        results += 1;
        const next = RECORDED_PROMPT_UUIDS[results];
        if (results < 3 && next !== undefined) {
          held.write(userFrame("/compact", next));
        } else held.end();
      },
    });
    writeCase({
      name: "compaction",
      files: splitAtMarks(recorded.stdout, recorded.marks, [
        "turn-1.stdout",
        "compacting.stdout",
        "compact-cancelled.stdout",
        "compact.stdout",
      ]),
      caseJson: {
        exitCode: recorded.exitCode,
        turns: [
          { uuid: RECORDED_PROMPT_UUIDS[0], stdout: "turn-1.stdout" },
          {
            uuid: RECORDED_PROMPT_UUIDS[1],
            steps: [
              { emit: "compacting.stdout" },
              {
                control: {
                  subtype: "interrupt",
                  cancelQueued: true,
                  emit: "compact-cancelled.stdout",
                },
              },
            ],
          },
          { uuid: RECORDED_PROMPT_UUIDS[2], stdout: "compact.stdout" },
        ],
      },
      workspace: ws,
      secrets: hostSecrets(recorded.bridgeToken),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(recorded.stdout),
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record a detached Session resumed by id: interrupt turn 1, resume in turn 2. */
async function recordResume(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const first = await runTurn({
      args: launchArgs(["--session-id", SESSION_IDS.resume], bridge),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Write a long slow essay about the number nine, at least 500 words, using no tools.",
      ),
      control: {
        onChunk: (child, stdout) => {
          if (
            stdout.includes('"subtype":"init"') &&
            stdout.includes('"text_delta"') &&
            !child.killed
          ) {
            child.kill("SIGTERM");
          }
        },
      },
    });
    const second = await runTurn({
      args: launchArgs(["--resume", SESSION_IDS.resume], bridge),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Never mind. Reply with exactly: resumed. Use no tools.",
      ),
    });
    writeCase({
      name: "resume",
      files: [
        { name: "initial.stdout", bytes: first.stdout },
        { name: "resume.stdout", bytes: second.stdout },
      ],
      caseJson: {
        exitCode: first.exitCode,
        // The first Turn was stopped with SIGTERM, so its control step swallows
        // the Adapter's interrupt request: the replay models a Claude Code that
        // never confirms, and the Adapter falls back to that process stop (#346).
        turns: [
          {
            steps: [
              { emit: "initial.stdout" },
              { control: { subtype: "interrupt" } },
            ],
          },
        ],
        resume: {
          exitCode: second.exitCode,
          turns: [{ stdout: "resume.stdout" }],
        },
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(second.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record the real not-logged-in result. A fresh, empty `CLAUDE_CONFIG_DIR` is not
 *  logged in, so `claude -p` returns the remediation immediately — the real login in
 *  the OS keychain is never touched, and no credential is fed in (so nothing to leak).
 *  The recording pins the actual signal: the not-logged-in result arrives as
 *  `subtype:"success"` with `result:"Not logged in · Please run /login"`, not an error
 *  subtype — the fact this ticket exists to confirm. */
async function recordAuthentication(): Promise<void> {
  const config = tempWorkspace("secant-rec-cfg-");
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  const env = baseEnv();
  env.CLAUDE_CONFIG_DIR = config;
  try {
    const capture = await runTurn({
      args: launchArgs(["--session-id", SESSION_IDS.authentication], bridge),
      cwd: ws,
      env,
      input: userFrame("Reply with exactly: hello."),
    });
    writeCase({
      name: "authentication",
      files: [{ name: "turn-1.stdout", bytes: capture.stdout }],
      caseJson: {
        exitCode: capture.exitCode,
        turns: [{ stdout: "turn-1.stdout", exitAfter: true }],
      },
      workspace: ws,
      configDir: config,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(capture.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(config, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
}

/** Record a genuine truncated JSON frame: capture a real init, then force-kill the
 *  process while a later frame is mid-write, leaving a frame with no terminating
 *  newline — exactly the transport corruption the Adapter detects. */
async function recordProtocolCorruption(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => 0,
  );
  try {
    const capture = await runTurn({
      args: launchArgs(
        ["--session-id", SESSION_IDS["protocol-corruption"]],
        bridge,
      ),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(
        "Write a long slow essay about the number three, at least 500 words, using no tools.",
      ),
      control: {
        onChunk: (child, stdout) => {
          // SIGKILL once init and a few streaming frames have been captured, giving
          // real material to truncate. The OS delivers whole frames, so the mid-write
          // truncation itself is applied deterministically below rather than raced.
          const text = stdout.toString("utf8");
          if (
            text.includes('"subtype":"init"') &&
            (text.match(/\n/g)?.length ?? 0) >= 4 &&
            !child.killed
          ) {
            child.kill("SIGKILL");
          }
        },
      },
    });
    // Model the mid-write SIGKILL: keep every complete captured frame (all real
    // bytes, init included), then re-emit the last frame truncated to half its
    // length with no terminating newline — exactly the truncated JSON frame the
    // Adapter's end-of-stream check detects as protocol corruption.
    const raw = capture.stdout.toString("utf8");
    const complete = raw.split("\n").filter((line) => line.length > 0);
    if (complete.length < 2 || !raw.includes('"subtype":"init"')) {
      throw new Error(
        "protocol-corruption: captured too little to truncate; re-run",
      );
    }
    const keep = complete.slice(0, -1);
    const last = complete[complete.length - 1]!;
    const truncatedTail = last.slice(
      0,
      Math.max(1, Math.floor(last.length / 2)),
    );
    const bytes = Buffer.from(
      keep.map((line) => `${line}\n`).join("") + truncatedTail,
      "utf8",
    );
    writeCase({
      name: "protocol-corruption",
      files: [{ name: "turn-1.stdout", bytes }],
      caseJson: {
        exitCode: 0,
        turns: [{ stdout: "turn-1.stdout", exitAfter: true }],
      },
      workspace: ws,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(bytes),
      extraRedactions: [
        {
          placeholder: "«TRUNCATED»",
          reason:
            "trailing frame left incomplete by a mid-write SIGKILL (a real transport truncation)",
        },
      ],
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
  }
}

/** A git directory with an empty baseline commit, so each Turn's file writes are
 *  captured as a `git apply`-able patch. */
function gitBaseline(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "rec@secant.test"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "recorder"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "baseline"], {
    cwd: dir,
  });
}

/** The files a Turn created in `dir` as a new-file patch, then committed so the
 *  next Turn's patch holds only its own writes. */
function turnPatch(dir: string, what: string): Buffer {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const patch = execFileSync("git", ["diff", "--cached"], { cwd: dir });
  if (patch.toString().trim().length === 0) {
    throw new Error(`matt-front: the ${what} Turn wrote no file`);
  }
  execFileSync("git", ["commit", "-q", "-m", what], { cwd: dir });
  return patch;
}

/** Split a Turn's stdout around each bridge call, as test-repair does, so recorded
 *  bytes after a permission prompt emit only once the verdict is in. */
function splitAroundCalls(
  prefix: string,
  stdout: Buffer,
  calls: readonly BridgeCall[],
): { files: WriteFile[]; steps: unknown[] } {
  const files: WriteFile[] = [];
  const steps: unknown[] = [];
  let cursor = 0;
  calls.forEach((call, index) => {
    files.push({
      name: `${prefix}-${index}.stdout`,
      bytes: stdout.subarray(cursor, call.stdoutOffset),
    });
    steps.push({ emit: `${prefix}-${index}.stdout` });
    steps.push({ bridge: { tool_name: call.tool_name, input: call.input } });
    cursor = call.stdoutOffset;
  });
  files.push({
    name: `${prefix}-final.stdout`,
    bytes: stdout.subarray(cursor),
  });
  steps.push({ emit: `${prefix}-final.stdout` });
  return { files, steps };
}

/** Record the Matt front Bundle's Harness Turns (#123, #222, #224, #295): a
 *  two-Turn interactive grill and autonomous spec in one Session, a two-Turn
 *  ticket review and autonomous publish in a fresh tickets Session, then two
 *  implementation Sessions of their own. The first Turn in each Session mints
 *  it with `--session-id`; later Turns resume it with `--resume`. Every launch
 *  carries the Run working area as `--add-dir`, as the
 *  Adapter forwards it, and the Local spec and ticket files are written there —
 *  never in the Workspace (#220). Each writing Turn's files are its
 *  `workingAreaPatch`, which the replayer applies in its `--add-dir` directory. */
async function recordMattFront(): Promise<void> {
  const ws = tempWorkspace("secant-rec-ws-");
  const area = realpathSync(tempWorkspace("secant-rec-area-"));
  gitBaseline(area);

  const sid = SESSION_IDS["matt-front"];
  let stdoutLen = 0;
  const bridge = await startBridge(
    () => ({ behavior: "allow" }),
    () => stdoutLen,
  );
  const turn = (sessionArgs: string[], text: string, tracked = false) => {
    stdoutLen = 0;
    return runTurn({
      args: launchArgs(sessionArgs, bridge, area),
      cwd: ws,
      env: baseEnv(),
      input: userFrame(text),
      ...(tracked
        ? {
            control: {
              onChunk: (_child, stdout) => (stdoutLen = stdout.length),
            },
          }
        : {}),
    });
  };
  const resume = ["--resume", sid];
  try {
    // Grill Turn 1 mints the Session. Bounded replies keep the fixture small; this
    // frame stands in for the grill's Entry Turn (#212), which carries the launch
    // idea. The replayer does not match input, so the bounded frame is kept.
    const grill1 = await turn(
      ["--session-id", sid],
      "Let's design a feature together. I want to add a dark-mode toggle to " +
        "our web app's settings page. Interview me: ask exactly one short " +
        "question about it, under 40 words. Do not write any files.",
    );
    // Grill Turn 2 resumes the same Session and concludes the interview.
    const grill2 = await turn(
      resume,
      "The toggle should persist per-user in their profile and default to the " +
        "system setting. That is enough context. In under 30 words, confirm " +
        "you have what you need. Do not ask more questions or write files.",
    );

    // The spec Turn writes the one Local spec file into the working area.
    let callsBefore = bridge.calls.length;
    const spec = await turn(
      resume,
      "Now write the spec. Using the Write tool, create the file " +
        `${join(area, "spec.md")} containing a short (under 200 words) ` +
        "Markdown spec for the dark-mode toggle we discussed, with the line " +
        "`Status: ready-for-agent` near the top. Write only that one file. " +
        // A path echoed in streamed text fragments past substring redaction.
        "Then reply with only the word Done, without naming any path.",
      true,
    );
    const specPatch = turnPatch(area, "spec");
    const specSplit = splitAroundCalls(
      "spec",
      spec.stdout,
      bridge.calls.slice(callsBefore),
    );

    // Ticket review opens a fresh Session and reads the published spec file.
    // Its proposed breakdown and later revision write no files.
    const ticketsResume = ["--resume", MATT_FRONT_TICKETS_SESSION_ID];
    const tickets1 = await turn(
      ["--session-id", MATT_FRONT_TICKETS_SESSION_ID],
      `This is a fresh conversation. Read the published spec at ${join(area, "spec.md")}. ` +
        "Break it into tracer-bullet tickets. Propose exactly two as a " +
        "numbered list, each with its title, what blocks it, and one line on " +
        "what it delivers, in under 80 words. Do not write any files.",
    );
    const tickets2 = await turn(
      ticketsResume,
      "Rename ticket 2 to 'Theme toggle control' and show the revised list in " +
        "under 60 words. Do not write any files.",
    );

    // The publish Turn writes one Local file per approved ticket.
    callsBefore = bridge.calls.length;
    const publish = await turn(
      ticketsResume,
      "The breakdown is approved. Using the Write tool, create one file per " +
        `ticket in ${join(area, "issues")}, named 01-<slug>.md and ` +
        "02-<slug>.md. Each file has a `# <NN>: <title>` heading, a " +
        "`**Blocked by:**` line, a `**Status:** ready-for-agent` line, and one " +
        "acceptance-criterion checkbox. Write only those two files. Then reply " +
        "with only the word Done, without naming any path.",
      true,
    );
    const ticketsPatch = turnPatch(area, "tickets");
    const publishSplit = splitAroundCalls(
      "publish",
      publish.stdout,
      bridge.calls.slice(callsBefore),
    );

    // The implementation stage (#224): each ticket gets a fresh Session of its own,
    // minted with its own `--session-id`. The first reads the Local tracker, names
    // the ready ticket, and marks it done in its own file; a later question stays in
    // that Session. The next Session reads the tracker again, with no edit.
    const [implementSid, nextSid] = MATT_FRONT_IMPLEMENT_SESSION_IDS;
    const choose =
      `This is a fresh conversation. The Local tracker holds ticket files in ` +
      `${join(area, "issues")}. Read every file there. Choose the one ticket ` +
      "whose Status is ready-for-agent and whose Blocked by line names no " +
      "ticket that is still ready-for-agent. ";
    callsBefore = bridge.calls.length;
    const implement = await turn(
      ["--session-id", implementSid],
      choose +
        "Using the Edit tool, change that file's `**Status:** ready-for-agent` " +
        "line to `**Status:** done`. Edit nothing else. Then reply with only " +
        "the chosen file's name, without its directory.",
      true,
    );
    const implementPatch = turnPatch(area, "implement");
    const implementSplit = splitAroundCalls(
      "implement",
      implement.stdout,
      bridge.calls.slice(callsBefore),
    );
    const question = await turn(
      ["--resume", implementSid],
      "What is that ticket's Status line now? Answer in under 15 words and " +
        "use no tools.",
    );
    const next = await turn(
      ["--session-id", nextSid],
      choose +
        "Do not edit any file. Reply with only the chosen file's name, " +
        "without its directory.",
    );

    writeCase({
      name: "matt-front",
      files: [
        { name: "grill-1.stdout", bytes: grill1.stdout },
        { name: "grill-2.stdout", bytes: grill2.stdout },
        ...specSplit.files,
        { name: "spec.patch", bytes: specPatch },
        { name: "tickets-1.stdout", bytes: tickets1.stdout },
        { name: "tickets-2.stdout", bytes: tickets2.stdout },
        ...publishSplit.files,
        { name: "tickets.patch", bytes: ticketsPatch },
        ...implementSplit.files,
        { name: "implement.patch", bytes: implementPatch },
        { name: "question.stdout", bytes: question.stdout },
        { name: "next.stdout", bytes: next.stdout },
      ],
      // Interactive Turns share their Step's process. The spec and publish
      // Steps each resume their own Session in a fresh process; the replayer's
      // shared resume block follows those two launches in order.
      caseJson: {
        exitCode: grill1.exitCode,
        turns: [{ stdout: "grill-1.stdout" }, { stdout: "grill-2.stdout" }],
        resume: {
          exitCode: publish.exitCode,
          turns: [
            { steps: specSplit.steps, workingAreaPatch: "spec.patch" },
            { steps: publishSplit.steps, workingAreaPatch: "tickets.patch" },
          ],
        },
        // Ticket planning and each implementation ticket open fresh Sessions.
        sessions: [
          {
            exitCode: tickets2.exitCode,
            turns: [
              { stdout: "tickets-1.stdout" },
              { stdout: "tickets-2.stdout" },
            ],
          },
          {
            exitCode: question.exitCode,
            turns: [
              {
                steps: implementSplit.steps,
                workingAreaPatch: "implement.patch",
              },
              { stdout: "question.stdout" },
            ],
          },
          { exitCode: next.exitCode, turns: [{ stdout: "next.stdout" }] },
        ],
      },
      workspace: ws,
      workingArea: area,
      secrets: hostSecrets(bridge.token),
      executableVersion: claudeVersion(),
      protocolVersion: protocolVersionOf(grill1.stdout),
    });
  } finally {
    await bridge.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(area, { recursive: true, force: true });
  }
}

const RECORDERS: Record<string, () => Promise<void>> = {
  plain: recordPlain,
  "test-repair": recordTestRepair,
  interrupt: recordInterrupt,
  resume: recordResume,
  authentication: recordAuthentication,
  "protocol-corruption": recordProtocolCorruption,
  "matt-front": recordMattFront,
  "steer-within": recordSteerWithin,
  "steer-boundary": recordSteerBoundary,
  "steer-cancel": recordSteerCancel,
  compaction: recordCompaction,
};

async function main(): Promise<void> {
  const which = process.argv[2];
  if (which === undefined) {
    console.error(
      `usage: bun tests/harness/record.ts <${Object.keys(RECORDERS).join("|")}|all>`,
    );
    process.exit(2);
  }
  // Fail fast if Claude Code is not installed.
  if (spawnSync("claude", ["--version"]).status !== 0) {
    console.error(
      "record.ts needs an installed, logged-in Claude Code on PATH",
    );
    process.exit(2);
  }
  const names = which === "all" ? Object.keys(RECORDERS) : [which];
  for (const name of names) {
    const recorder = RECORDERS[name];
    if (recorder === undefined) {
      console.error(`unknown case '${name}'`);
      process.exit(2);
    }
    await recorder();
  }
}

await main();
