# Harness Slash Text and File Mentions

Research date: 2026-09-30

Versions examined, on Linux (x64):

- Claude Code **2.1.285**, driven as Secant drives it: `claude -p --input-format stream-json --output-format stream-json --verbose`, user
  frames `{"type":"user","message":{"role":"user","content":<text>}}`, uuid-stamped for the Steer probes as
  [ADR 0035](../adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) intends, `--model haiku`, mostly
  `--no-session-persistence`.
- Codex **codex-cli 0.157.1** through `codex app-server`, driven as Secant drives it (`initialize` with `experimentalApi: false`, `thread/start`
  with `cwd`, `turn/start` with `input: [{type: "text", text}]`), model `gpt-6-luna` at low effort. Source cited at tag `rust-v0.157.1`.
- OpenCode at `228e909` and T3 Code at `de251fc` (local clones), read for `/` and `@` mechanics.
- `@opentui/core` **0.4.5** (the Run Workbench compose's native input).

Ticket: [Decide how typed commands work in the Run Workbench compose](https://github.com/secantdev/secant/issues/267). This note records facts
only; the decision is [ADR 0040](../adr/0040-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md).

## Claude Code runs a leading slash command from Secant's frames

A user frame whose text begins with a recognised `/name` runs as a Claude Code command, not as a model message. The session's `system/init`
lists 131 `slash_commands`, including built-ins, bundled skills, and the user's own skills (for example `tdd`). Recognition is exact: lowercase,
at the very first character, the name ending at a space or the end of the text. `/CLEAR`, `/Clear`, `/MODEL haiku`, `  /clear`, a `/clear` on a
second line, `/clear:x`, and `/model:haiku` all reached the model as text. With a leading space or newline the model twice _claimed_ it had
cleared the conversation although the session id, the absence of a reset event, and the growing context show it had not. `/tmp/x fails` and an
unknown `/nosuchcmd` reach the model as text.

| Text                                                                 | Effect                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/clear`, `/new`, `/reset`                                           | `conversation_reset`, then a `system/init` with a **new** `session_id`; the reset's `new_conversation_id` is neither that id nor on disk |
| `/model <name>`, `/effort <level>`                                   | The session's model or effort changes; a `num_turns: 0` result                                                                           |
| `/config model=sonnet`                                               | The live session switches model **and** the value is written to the user's global `~/.claude/settings.json`                              |
| `/config permissionMode=acceptEdits`                                 | Written to the global settings as `defaultMode`; the running session's permission mode is unchanged                                      |
| `/resume`, `/continue`, `/fork` (with or without arguments), `/fast` | "isn't available in this environment" / "not available in the Agent SDK"; nothing changes                                                |
| `/compact`                                                           | Same `session_id`; `compact_boundary`, a summary frame, and a `num_turns: 0` result with empty text and `local_command: "compact"`       |

`--disable-slash-commands` exists, and its help text is "Disable all skills".

### Commands sent while a Turn works

Claude Code queues a command frame (`command_lifecycle` `queued`) and runs it only after the running Turn's `result`, even during a tool round.
An ordinary uuid-stamped Steer behaves differently: during a tool round it starts after the current `tool_result` and joins the same Turn (one
`result` whose `user_message_uuids` lists both frames); during pure text streaming it runs as its own following exchange with its own `result`
and real reply text.

A mid-Turn `/compact` (three runs) let the Turn finish normally, then compacted for 12–18 s as a separate exchange: a second `system/init` with
the same `session_id`, `compact_boundary`, and a `result` with `num_turns: 0`, `result: ""`, `local_command: "compact"`, and the `/compact`
frame's uuid in `user_message_uuids`. The agent remembered the task afterwards. A mid-Turn `/clear` also waited for the Turn, then reset the
session.

Read against today's adapter (`src/harness/claude-code.ts`), a second same-id `init` passes the Session coordinate check and re-emits session
and model events; compaction frames parse as generic activity; the empty zero-turn `result` settles a Turn completed with empty final content;
`user_message_uuids` and `local_command` are not read. A new Turn started during the compaction window would be settled by the compaction's
empty `result`, and its own result dropped.

### Interrupting a compaction

An `interrupt` `control_request` (with and without `cancel_queued: true`) sent 10 ms, 6 s, or 10 s after `system/status compacting` was answered
`success` within about 20 ms. Compaction ended `compact_result: "failed"` ("Request was aborted") with no `compact_boundary`; a synthetic
"Compaction canceled." message and a `result` reporting `subtype: "success"`, `num_turns: 0`, empty text, zero usage followed. The `session_id`
never changed, and the next Turn's cache read covered the whole pre-compaction prompt, so nothing was compacted.

## Codex app-server treats slash text as plain text

`/compact`, `/model gpt-5-mini`, `/clear`, `/new`, and `/reset` sent as `turn/start` text each produced an ordinary `userMessage` item and a
model reply. The thread id never changed, no reset notification appeared, input tokens kept growing, and the agent quoted the thread's first
message afterwards. In one `/clear` run the model role-played a clear and claimed not to remember, with the history still sent.

Codex's `/clear` and `/new` are TUI commands: `tui/src/chatwidget/slash_dispatch.rs` sends `ClearUi` / `NewSession`, which start a fresh thread
with a new `thread/start` (`sessionStartSource: "clear"` maps to `InitialHistory::Cleared` in the app-server). Nothing in `app-server/src`,
`core/src`, or `protocol/src` parses a leading `/` in user text. Compaction has its own request, `thread/compact/start`.

## File mentions

- **Claude Code** expands `@path` itself in print mode: `@secret.txt` was answered with no tool call. `@dir/` gives a file listing only,
  `@notes.txt#L2-3` exactly those lines, `@"my file.txt"` works while `@my\ file.txt` does not, and `@sub/a.txt` also loads `sub/CLAUDE.md`.
- **Codex** does not inline `@path` text. A `{type: "mention", path}` input is accepted but resolves only `app://` and `plugin://` paths. The
  app-server's `fuzzyFileSearch` respects `.gitignore`, includes `.git/` internals, and caps results at 50 (`MATCH_LIMIT`).
- **OpenCode** opens `@` at the start or after whitespace, searches files, directories, agents, and MCP resources (files via `fff`, falling
  back to `rg --files`, gitignore respected), supports `@path#10-20`, and sends file content as a structured part.
- **T3 Code** opens `@` anywhere, searches paths only, inserts a markdown link, and sends the path text without content.
- **Secant** has no workspace file search today. The Workspace is the canonical launch directory and need not be a Git worktree.

## The compose input

`@opentui/core`'s textarea default bindings (`defaultTextareaKeyBindings`) give `ctrl+p` and `ctrl+n` nothing; `up`/`down` move the cursor and
`ctrl+e` moves to line end. Secant passes no custom bindings.

## Still unknown

- Whether a plain Steer written after a queued `/compact` joins the compaction's exchange or runs after it.
- What `cancelled` lists in an interrupt's response when a frame really is queued behind a command.
- Automatic (`trigger: "auto"`) compaction during a Turn; only manual `/compact` was probed.
- Trailing whitespace or tabs after a command name.
- Codex `@path` text or a file `Mention` under `experimentalApi: true` or other versions.
