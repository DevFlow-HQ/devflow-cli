import { join } from "node:path";
const repo = process.env.SECANT_EVIDENCE_REPO ?? process.cwd();
const { createCodexAdapter } = await import(
  join(repo, "tests/harness/test-adapters.ts")
);
const { redact, assertNoCredentials, envSecrets } = await import(
  join(repo, "tests/harness/redact.ts")
);
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
const root =
  process.env.SECANT_EVIDENCE_DIR ?? "/tmp/secant-native-evidence-460/codex";
mkdirSync(root, { recursive: true });
const scenario = process.argv[2] || "normal";
const workspace = `${root}/workspace-${scenario}`;
mkdirSync(workspace, { recursive: true });
if (scenario === "normal")
  writeFileSync(`${workspace}/sample.txt`, "first\nsecond\nthird\n");
const capture = [];
const methods = {};
const redactions = [];
const omitted = [];
let pending = "";
let harness;
let schemaVersion;
let executableVersion;
let closed;
function safe(text) {
  const r = redact(text, [
    { value: homedir(), placeholder: "«HOME»", reason: "host home directory" },
    ...envSecrets(),
  ]);
  assertNoCredentials(r.text);
  redactions.push(...r.redactions);
  return r.text;
}
function processFrame(line, direction) {
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    return;
  }
  const m = f.method;
  if (direction === "stdout" && typeof m === "string")
    methods[m] = (methods[m] || 0) + 1;
  const item = f.params?.item;
  // Never access or save reasoning body/summary content. Keep only its field names for absence investigation.
  if (direction === "stdout" && item?.type === "reasoning") {
    omitted.push({ method: m, itemType: item.type, keys: Object.keys(item) });
    return;
  }
  const allowed =
    direction === "stdout" &&
    ((["item/started", "item/completed"].includes(m) &&
      ["commandExecution", "fileChange"].includes(item?.type)) ||
      [
        "item/commandExecution/outputDelta",
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "serverRequest/resolved",
        "turn/diff/updated",
        "thread/tokenUsage/updated",
      ].includes(m));
  const sent =
    direction === "stdin" &&
    (["thread/start", "turn/start", "turn/interrupt"].includes(m) ||
      ("id" in f && f.result?.decision));
  if (allowed || sent) capture.push({ direction, line: safe(line) });
  if (direction === "stdout" && m === "turn/completed") {
    const t = f.params?.turn;
    capture.push({
      direction: "stdout-projection",
      line: JSON.stringify({
        method: m,
        params: {
          threadId: f.params?.threadId,
          turn: {
            id: t?.id,
            status: t?.status,
            keys: Object.keys(t || {}),
            durationMs: t?.durationMs,
          },
        },
      }),
    });
  }
}
const observer = {
  version(v) {
    executableVersion = v;
  },
  schema(s, r) {
    schemaVersion = r;
    writeFileSync(`${root}/schema-${scenario}.json`, s);
  },
  stdout(bytes) {
    pending += new TextDecoder().decode(bytes);
    let pos;
    while ((pos = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, pos);
      pending = pending.slice(pos + 1);
      processFrame(line, "stdout");
    }
  },
  stdin(bytes) {
    for (const line of new TextDecoder().decode(bytes).split("\n"))
      if (line) processFrame(line, "stdin");
  },
  stderr() {},
  closed(k, s) {
    closed = { kind: k, status: s };
  },
};
let ended = false;
async function shutdown() {
  if (ended) return;
  ended = true;
  if (harness) await harness.close();
}
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(124));
});
const timer = setTimeout(() => {
  shutdown().finally(() => process.exit(124));
}, 110000);
let result;
const receipts = [];
let cleanup;
try {
  const prepared = await createCodexAdapter({
    recordingObserver: observer,
    handshakeTimeoutMs: 20000,
    controlTimeoutMs: 20000,
  }).prepare({ workspace });
  if (!prepared.ok) {
    result = {
      kind: "prepare-failed",
      category: prepared.failure.category,
      reason: prepared.failure.reason,
    };
  } else {
    harness = prepared.harness;
    const prompt =
      scenario === "normal"
        ? 'Use apply_patch to change sample.txt from first, second, third lines to first, replacement, third, fourth lines. Then run `printf "recorded command output\\n"`. Do not read any other files or call any other tools. Reply done.'
        : "For an opt-in native approval recording, request escalated approval explicitly by setting sandbox_permissions=require_escalated to run `touch /tmp/secant-native-evidence-460-declined-marker`. This request will be denied by the recording client. Do not retry or run any fallback command after denial. Reply recorded decline.";
    const turn = harness.startTurn({
      session: `evidence-${scenario}`,
      origin: "managed",
      correlationKey: { opaque: `evidence-${scenario}` },
      input: { text: prompt },
      recorder: {
        admit: () => Promise.resolve({ recorded: true }),
        checkpoint: () => Promise.resolve({ recorded: true }),
      },
    });
    const answers = [];
    turn.subscribe((e) => {
      if (e.kind === "request-raised" && e.request.shape.kind === "approval")
        answers.push(
          turn
            .answerRequest({
              requestId: e.request.requestId,
              kind: "approval",
              decision: scenario === "decline" ? "deny" : "allow",
            })
            .then((r) => {
              receipts.push({
                outcome: r.outcome,
                ...("reason" in r ? { reason: r.reason } : {}),
              });
            }),
        );
    });
    const r = await turn.result();
    await Promise.all(answers);
    result = { kind: r.kind };
    cleanup = await harness.close();
    ended = true;
  }
} catch (e) {
  result = {
    kind: "probe-error",
    name: e?.name,
    message: safe(String(e?.message)),
  };
  await shutdown();
} finally {
  clearTimeout(timer);
  writeFileSync(
    `${root}/${scenario}.json`,
    JSON.stringify(
      {
        capture,
        omittedReasoningFieldNames: omitted,
        methods,
        result,
        receipts,
        cleanupClean: cleanup?.clean,
        closed,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    `${root}/recording-${scenario}.json`,
    JSON.stringify(
      {
        harness: "codex",
        executableVersion,
        protocolVersion: schemaVersion,
        recordedAt: new Date().toISOString(),
        redactions: [
          ...new Map(redactions.map((r) => [r.placeholder, r])).values(),
        ],
        refreshCommand: `timeout -k 10s 150s bun docs/research/native-observed-facts-captures/codex/probe.mjs ${scenario}`,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      scenario,
      result,
      receipts,
      cleanupClean: cleanup?.clean,
      closed,
      executableVersion,
      protocolVersion: schemaVersion,
      capturedFrames: capture.length,
      methods,
    }),
  );
}
