# Claude JSONL Launch And Locate Ordering Inverts Codex

Codex writes its rollout at process launch, so the Codex JSONL runner snapshots, spawns
**bare**, **locates** the new rollout, then **injects** the prompt via PTY — locating
before any turn content exists. Claude writes **no transcript until the first prompt is
submitted** (verified: a bare `claude` under a scoped `CLAUDE_CONFIG_DIR` creates no
`projects/` file), so that ordering would deadlock. The Claude JSONL runner therefore
inverts it: pass the initial prompt as **argv** (matching the existing Claude hook runner),
let Claude create the transcript, **then** locate the new `*.jsonl` under the run-scoped
`CLAUDE_CONFIG_DIR` and tail it **from offset 0** (a from-start tail replays every record,
so attaching after the turn began loses nothing).

## Considered Options

- **argv prompt + locate-after (chosen).** Simplest, consistent with hook mode, no
  TUI-readiness detection.
- **Codex-style bare launch + PTY-inject the initial prompt.** Rejected: the
  locate-before-content ordering guarantee it buys is unattainable for Claude anyway, and
  it adds PTY-readiness timing fragility for no benefit. (Continuations and repairs still
  inject via PTY, since there is no argv for them.)

## Consequences

- **Resume diverges from fresh launch.** `claude --resume <id>` appends to the existing
  `<id>.jsonl` (verified — no fork, id preserved). So resume skips snapshot-diff entirely:
  it globs `projects/**/<providerSessionId>.jsonl` under the scoped config dir and tails
  from the file's **current end offset** (not 0), to avoid replaying stale `end_turn`
  records. `jsonlTailEventSource` gains an optional `startOffset` for this.
- The Codex JSONL runner still assumes resume yields a *new* file (snapshot-diff); if Codex
  also appends on resume, that path is buggy for same-run recovery — tracked in
  `.agent/follow_up.md`.
