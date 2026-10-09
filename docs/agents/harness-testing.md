# Harness conformance and replayers

Read before changing Harness doubles, shared conformance, native replayers, or recording scripts.
[Testing](./testing.md) owns evidence layers and fixture policy.

## Tests

- A late acquisition after the preparation deadline has zero cleanup budget. A failed drain receipt cannot prove native death; runtime cases observe it independently.
- Synthetic background workers observe replayer stdin EOF; POSIX cannot reap a descendant after its root and inherited pipes have already closed.

- `tests/harness` owns the fake, shared conformance and native replayers; fixtures retain `recording.json` provenance and opt-in recorders.
- Prepare/lifecycle cases run all Adapters; Codex replay covers exact-thread recovery, approvals, native Steer, and leftover re-delivery, and
  Claude replay covers native and pending Steer. Other control groups stay capability-specific.
  Structured clarifications, after-acceptance checkpoint, load-with-replay, and caller-contract violations remain fake-only. The fake performs load-with-replay:
  resumed Turn re-emits the Session's retained history (`assistant-content`, `tool-call`, `tool-partial`, `thought`), drops a scripted entry that repeats
  a replayed one, then emits `REPLAY_BARRIER` (a Session availability fact) before any live event — history is historical by position, inside the closed vocabulary.
- Native Adapter and replayer conformance that launches real children runs only in standalone runtime conformance (#198); scripted Process failure
  cases through the Claude Code Seam run in the semantic suite (#332). The layer rules are in [testing](testing.md).
- **Leftover recording race:** a leftover Steer lands only in the few milliseconds after a native turn's Stop hook completes, so its recorder
  steers from the stdout observer and retries; a line-buffered pass-through shim missed 40 of 40, so any recorder shim forwards raw bytes (#357).
- **Replayer startup-signal race:** a Bun child's `process.on("SIGTERM")` handler is only honoured once installed — a SIGTERM delivered before the
  child's top-level code runs hits the default disposition and kills it (this is a startup race, not a `bun test` limitation; plain `bun` shows the same
  window). So the replayer installs its SIGTERM handler at startup, and interrupt/close cases wait for the `session` event (init observed) before
  interrupting. Never signal a freshly spawned child before it has announced readiness.
- Claude replay attaches live MCP endpoints from the startup stdin control, answered with the #494 native response before the first Turn.
  The `mcp-servers` first Turn replays Agent calls and permissions with the live bearer and port, never recorded credentials.
- The replayer's `case.json` vocabulary (`tests/harness/fixtures/README.md` is the reference): a `control` step (#346: take the next stdin
  `control_request` and emit recorded bytes echoing its `request_id`, or swallow it to model an unconfirmed stop; stdin is read while steps run;
  `cancelQueued` requires `cancel_queued`), a `steer` step and a Turn's `uuid` (#359: echo the message's minted uuid in later bytes),
  `ignoreSigterm` (swallow SIGTERM → force-kill path; moot on Windows, where every live child is force-killed regardless), per-turn `exitAfter`
  (exit without a result → lost/corruption) and `workingAreaPatch` (applied in the launch's `--add-dir` directory), a `resume` section replayed when
  the launch has `--resume`, and `sessions[]` (#224: the Nth fresh `--session-id` launch after the first plays `sessions[N-1]`, one conversation per
  human-controlled Repeat iteration).
