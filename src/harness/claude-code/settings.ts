import type { HarnessDefaults } from "../harness.js";
import type {
  OwnedProcessClose,
  ProcessAdapter,
} from "../../process/process.js";
import { ControlChannel } from "./control.js";
import { ClaudeEffort, parseFrame } from "./frames.js";
import { JsonlLineReader } from "../jsonl.js";

export async function readSettings(params: {
  readonly spawn: ProcessAdapter["spawnOwnedProcess"];
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}): Promise<{
  readonly defaults: HarnessDefaults;
  readonly cleanup?: OwnedProcessClose;
}> {
  const level = ClaudeEffort.safeParse(params.env.CLAUDE_CODE_EFFORT_LEVEL);
  const effortLock = level.success
    ? { effort: level.data, source: `CLAUDE_CODE_EFFORT_LEVEL=${level.data}` }
    : undefined;
  const fallback = (reason: string): HarnessDefaults => ({
    kind: "fallback",
    choice: { model: "opus", effort: effortLock?.effort ?? "medium" },
    reason,
    ...(effortLock === undefined ? {} : { effortLock }),
  });
  const launched = await params
    .spawn({
      role: "harness-runtime",
      executable: params.executable,
      args: [
        ...params.prefixArgs,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
      ],
      cwd: params.workspace,
      env: params.env,
      launchTimeoutMs: params.timeoutMs,
    })
    .catch(() => undefined);
  if (launched === undefined || !launched.ok) {
    return {
      defaults: fallback(
        "Claude Code's settings could not be read before launch.",
      ),
    };
  }
  const owned = launched.process;
  const channel = new ControlChannel(
    (bytes) => owned.writeStdin(bytes),
    params.timeoutMs,
  );
  const reading = (async () => {
    const reader = new JsonlLineReader(owned.stdout);
    for (;;) {
      const next = await reader.next();
      if (next.kind !== "line") break;
      const line = next.value.trim();
      if (!line.startsWith("{")) continue;
      const parsed = parseFrame(JSON.parse(line));
      if (parsed?.kind === "control-response") channel.accept(parsed.frame);
    }
    channel.close();
  })().catch(() => channel.close());
  const stderr = (async () => {
    for await (const _chunk of owned.stderr) {
      /* Drain without retaining personal settings. */
    }
  })().catch(() => channel.close());
  void owned.closed().then(() => channel.close());
  const outcome = await channel.request({ subtype: "get_settings" });
  const cleanup = await owned.closeStdin(params.timeoutMs);
  channel.close();
  // Process close is authoritative; inherited pipes need not reach EOF.
  void reading;
  void stderr;
  if (outcome.kind !== "success" || outcome.settings === undefined) {
    return {
      defaults: fallback(
        outcome.kind === "timeout"
          ? "Claude Code's settings did not answer before launch."
          : "Claude Code's settings could not be read before launch.",
      ),
      cleanup,
    };
  }
  const effort = effortLock?.effort ?? outcome.settings.effort;
  if (effort === null) {
    return {
      defaults: fallback("Claude Code reported no selectable default effort."),
      cleanup,
    };
  }
  return {
    defaults: {
      kind: "reported",
      choice: { model: outcome.settings.model, effort },
      ...(effortLock === undefined ? {} : { effortLock }),
    },
    cleanup,
  };
}
