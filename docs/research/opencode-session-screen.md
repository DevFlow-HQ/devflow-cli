# How OpenCode's Session Screen Presents an Agent Conversation

Research date: 2026-09-27

Upstream source snapshot: OpenCode commit
[`228e9095ba3988a02664c3816cb51f98584e86c2`](https://github.com/anomalyco/opencode/commit/228e9095ba3988a02664c3816cb51f98584e86c2)
(`dev`, committed 2026-09-14), read from a local checkout. That commit pins OpenTUI `0.4.5`, the same version Secant ships.[^catalog]
Secant facts are pinned to [`9388dec`](https://github.com/secantdev/secant/tree/9388dec6dd33119005cdb0e1881007ef720cd14d).

Ticket: [#236](https://github.com/secantdev/secant/issues/236)

## Answer

OpenCode's session screen is a chat transcript, not an event log. It has no header bar. A bottom-sticky scroll box renders each message as a
sequence of **parts**, and only three part types are drawn at all: assistant text (streamed, rendered as markdown), reasoning, and tool calls.
Every other part type, every status change, and every timestamp stays off the transcript.[^layout][^part-map] Parts are appended in order and
grow in place. Nothing ever replaces an earlier row.

- **Show, collapse, hide.** Reasoning collapses to one `Thought: … · 3.2s` line by default, and a click expands it.[^reasoning] Most tools are
  one-line rows with an icon, such as `→ Read src/x.ts` or `✱ Grep "foo" (3 matches)`. Shell output, edit diffs, written files, todos, and
  answered questions become panels.[^inline-tool][^block-tool][^shell][^edit] Generic tool output is hidden by default. A "Hide tool details"
  toggle removes completed tools entirely.[^defaults][^tool-part]
- **Truncation.** Only tool output is truncated. Shell output stops at 10 lines and generic output at 3, with a "Click to expand" affordance.
  A failed tool's error text stays hidden until the user clicks the red row. User text, assistant text, diffs, and agent questions are never
  truncated: they wrap.[^collapse][^shell][^generic-tool][^question]
- **Emphasis.** Emphasis comes from markdown and a small set of theme roles. Muted text marks settled work, the text colour marks live work,
  `warning` marks reasoning and permissions, `error` marks failures, and the agent colour marks your messages and the working indicator. Bold
  appears almost only through markdown.[^text-part][^syntax-rules]
- **Working indicator.** A left-to-right "Knight Rider" block scanner under the prompt runs whenever the session is not `idle`, next to
  `esc interrupt`. The scanner looks the same for thinking and for tool work. Thinking and tool work are told apart inside the transcript
  instead: a `Thinking` spinner on the reasoning row, and spinners or `~ Preparing…` text on tool rows.[^spinner][^status-row]
- **Prompt.** The prompt is an always-editable multi-line textarea. Enter submits. Shift+Enter, Ctrl+Enter, Alt+Enter, or Ctrl+J insert a
  newline. A long paste collapses to `[Pasted ~N lines]`. Submitting clears the draft at once, without waiting for the server, so there is
  never a "sending" state.[^keys][^submit][^paste]
- **Identifiers.** A session id appears only in the exit epilogue (`Continue  opencode -s <id>`), and in the sidebar of non-release
  builds.[^epilogue][^sidebar-id]

On "which of its rules should Secant inherit", this study stops at what the rules are and what data each one reads. It does not design
Secant's screen. Some rules are pure presentation over data Secant's Harness seam already carries: the append-only transcript, streamed
markdown, the busy scanner, instant-clear submit, and no timestamps. Others read data the seam deliberately omits or flattens, and cannot be
reproduced without a seam change. These include reasoning rows, per-call tool rows that change state in place, typed tool rows, command
output, diffs, structured questions, and typed permission bodies (see [Data the rules need](#data-the-rules-need)).[^s-events][^s-adr22]

## Evidence Vocabulary

- **Source-observed.** Present in OpenCode source at the pinned commit, cited by file and line.
- **Documented.** Stated in OpenTUI's documentation, fetched through Context7 from `anomalyco/opentui`.
- **Secant-observed.** Present in Secant source at `9388dec`.
- **Inferred.** A conclusion drawn from the facts above. Such claims are labelled in the text.

Nothing here was observed by running OpenCode. All behaviour is read from source.

## Screen Anatomy

The route renders one row. Its main column holds a transcript scroll box that grows to fill the space, then a bottom region that does not
shrink, then a toast layer. A sidebar sits on the right.[^layout]

- **Transcript.** A `<scrollbox>` with `stickyScroll` and `stickyStart="bottom"`. The scrollbar is hidden by default.[^scroll] OpenTUI
  documents that sticky scrolling keeps the view at the bottom as content arrives, and pauses when the user scrolls away until they scroll back
  to the edge.[^sticky-doc] Submitting, or opening a session, also scrolls to the bottom explicitly.[^scroll]
- **Bottom region.** Exactly one control holds it, in fixed precedence.[^bottom]
  1. The first pending permission, as `PermissionPrompt`.
  2. The first pending question, as `QuestionPrompt`.
  3. A `SubagentFooter` when viewing a child session.
  4. The `Prompt`, rendered only when the session is not a child and no permission or question is pending.

  While a permission or question is up, the prompt is not merely disabled: it is gone.

- **No header.** The route renders no title bar, run id, or status header. The session title appears only in the sidebar, in bold.[^layout][^sidebar-id]
- **Sidebar.** It is 42 columns wide and appears automatically when the terminal is wider than 120 columns. It can be toggled, and on narrow
  terminals it overlays the transcript. Its contents come from plugin slots: context tokens, cost, modified files, LSP, MCP, and todos.[^sidebar]
  The file `routes/session/footer.tsx`, which shows LSP, MCP, and permission counts, is imported nowhere at this commit, so it is not part of
  the screen (source-observed by search).

## What Each Element Shows, Collapses, and Hides

### Messages and parts

| Element               | What is shown                                                                                                                                                                                                                                                                                                | Collapsed or hidden                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User message          | A panel with a left `┃` bar in the agent's colour, on `backgroundPanel`, holding the full text. Attachments appear as `File` / `Directory` badges. A `QUEUED` badge appears while an earlier assistant reply is still pending. Clicking opens "Message Actions": Revert, Copy, Fork.[^user-msg][^msg-dialog] | Synthetic text parts (context the TUI injected) are hidden. The timestamp is hidden unless `/timestamps` is on.[^user-msg]                                                                                                                                                                                                  |
| Assistant text        | Each non-empty text part is its own block, indented 3 columns and rendered by OpenTUI `<markdown>` with `streaming`, theme syntax styles, grid tables, and marker concealment.[^text-part]                                                                                                                   | Nothing is truncated.                                                                                                                                                                                                                                                                                                       |
| Reasoning             | While streaming: a spinner with `Thinking` or `Thinking: <title>`, where the title is the leading `**bold**` line reasoning models emit. When done: `+ Thought: <title> · 3.2s`.[^reasoning]                                                                                                                 | By default (`thinking_mode = "hide"`) only that header line shows. A click toggles the body, rendered as muted markdown. `/thinking` switches every block between expanded and collapsed. Encrypted reasoning shows `Thought · <duration>` and cannot expand. `[REDACTED]` placeholders are dropped.[^reasoning][^defaults] |
| Assistant footer line | `▣ Build · <model> · 12.3s`: the square in the agent's colour, the mode name, the model, and the duration from the user message to completion. An aborted reply appends `· interrupted` and the square turns muted.[^footer-line]                                                                            | The footer appears only on the last assistant message, on a final one (finish reason other than `tool-calls` or `unknown`), or on an aborted one. Intermediate tool-call steps get no footer.[^footer-line]                                                                                                                 |
| Assistant error       | A panel with a left bar in the `error` colour, holding the error message in muted text.[^msg-error]                                                                                                                                                                                                          | An abort is not drawn as an error. It shows only as `· interrupted`.[^msg-error][^footer-line]                                                                                                                                                                                                                              |
| Other part types      | None.                                                                                                                                                                                                                                                                                                        | `PART_MAPPING` has only `text`, `tool`, and `reasoning`. The SDK's `subtask`, `file`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`, and `compaction` parts are not drawn in assistant messages. A compaction on a user message draws a centred `Compaction` rule.[^part-map][^user-msg]               |
| Revert                | The reverted tail is replaced by one block: `N message reverted`, `<key> or /redo to restore`, and changed files with `+adds -dels`. Clicking it confirms a redo.[^revert]                                                                                                                                   | The reverted messages themselves are hidden.[^revert]                                                                                                                                                                                                                                                                       |

### Tool calls

`ToolPart` routes 14 known tool names to dedicated renderers. Anything else goes to `GenericTool`.[^tool-part] Each renderer draws one of two
shapes.

- **`InlineTool`: one indented row.** A two-column icon, then a label. Before the tool's input exists, the row reads `~ <pending text>`, for
  example `~ Preparing edit…`. Some tools swap the icon for a spinner while running. The row turns `warning` while it waits for a permission and
  `error` when it failed. A denial is struck through; it is detected by matching the error string against `QuestionRejectedError`,
  `rejected permission`, `specified a rule`, or `user dismissed`. Clicking a failed row reveals the full error text under it.[^inline-tool]
  Consecutive one-line rows stack with no gap between them. A blank line appears only after a taller or explicitly separated element, so a
  burst of tool calls reads as a compact list.[^layout-margin]
- **`BlockTool`: a panel.** It sits on `backgroundPanel` with a muted title line and optional click-to-toggle, and prints any tool error in the
  `error` colour at the bottom.[^block-tool]

An inline row's colour tracks its `complete` prop, not its status. Most renderers pass the tool's primary input as `complete`, such as
`filePath` or `pattern`. So once the input is known, a running `Edit` row and a finished one are both muted. Only rows given `spinner` (Read,
Task, execute) show that they are still running.[^inline-tool][^simple-tools] This is source-observed. That it leaves the session-level scanner
as the only "still working" cue for those tools is inferred.

| Tool                             | Rendering                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash` (shell)                   | Inline `$ <command>` until output metadata exists. Then a block: an optional `# Running in <dir>` title when the working directory is not `.`, then `$ <command>` (with a spinner while running), then the output with ANSI stripped, collapsed to 10 lines.[^shell]                                                                               |
| `read`                           | Inline `→ Read <path> [offset=…, limit=…]` with a spinner while running, plus one muted `↳ Loaded <path>` line for each extra file loaded.[^simple-tools]                                                                                                                                                                                          |
| `glob`, `grep`                   | Inline `✱ Glob "<pattern>" in <path> (N matches)`.[^simple-tools]                                                                                                                                                                                                                                                                                  |
| `webfetch`, `websearch`, `skill` | Inline `% WebFetch <url>`, `◈ <provider> "<query>" (N results)`, and `→ Skill "<name>"`.[^simple-tools]                                                                                                                                                                                                                                            |
| `edit`                           | Once a diff exists: a block titled `← Edit <path>`, holding an OpenTUI `<diff>` (split view when the width exceeds 120 columns, unified otherwise; configurable) with syntax highlighting, line numbers, and word wrap. Below it, up to 3 error-severity diagnostics as `Error [line:col] message`. Before then, an inline `← Edit <path>`.[^edit] |
| `write`                          | Once diagnostics metadata exists: a block titled `# Wrote <path>` holding the full written content, syntax-highlighted with line numbers, plus diagnostics. Before then, an inline `← Write <path>`.[^edit]                                                                                                                                        |
| `apply_patch`                    | One block per file, titled `← Patched`, `# Created`, `# Moved a → b`, or `# Deleted`. Each holds a diff. A deleted file shows `-N lines` in `diffRemoved`.[^edit]                                                                                                                                                                                  |
| `task` (subagent)                | A separated inline row: `│` (`✓` when done), then `<Agent> Task — <description>`. Below it, `↳ <Tool> <title>` for the child's current tool, `↳ Retrying (attempt n) · <msg>`, or `↳ N toolcalls · 1m 3s` when done. There is a spinner while running. Clicking opens the child session. The message adds a `<key> view subagents` hint.[^task]    |
| `todowrite`                      | A block titled `# Todos` with one `TodoItem` per entry, or inline `⚙ Updating todos…` before then.[^todo-question-tool]                                                                                                                                                                                                                            |
| `question`                       | After answers arrive: a block titled `# Questions` listing each question (muted) and its answer, with `(no answer)` for blanks. Before then: inline `→ Asked N questions`.[^todo-question-tool]                                                                                                                                                    |
| `execute`                        | Inline `execute` with a `↳ tool args` line per child call and `(failed)` marks. On a runtime error, a 4-line preview of the output in the error colour.[^execute]                                                                                                                                                                                  |
| Any other tool                   | Inline `⚙ <tool> [key=value, …]`, listing primitive inputs only. When "Show generic tool output" is on and output exists, a block titled `# <tool> [..]` with the output collapsed to 3 lines.[^generic-tool]                                                                                                                                      |

**Shell mode.** A `!` typed at the start of the prompt switches it to shell mode.[^shell-mode] The server records the command as a synthetic
user text part plus a running `bash` tool part. Because synthetic user text is hidden, a shell command appears only as a shell block, with no
user bubble.[^shell-mode][^user-msg]

### Agent questions and permissions

- **Questions** (`QuestionPrompt`) replace the prompt in the bottom region.[^question]
  - Layout: a panel on `backgroundPanel` with an `accent` left bar. Several questions become header tabs plus a `Confirm` tab.
  - Content: the question text in full, with ` (select all that apply)` for multi-select. Then numbered options, each a label with a muted
    description beneath, then `Type your own answer`, which opens an inline textarea up to 6 rows high.
  - Selection: an active option is drawn in `secondary`, and a picked one gets a `success` `✓`. The Confirm tab reviews every answer and shows
    `(not answered)` in `error`.
  - Keys: `↑↓`/`jk` move, `1`–`9` pick, Enter selects, `⇆`/Tab/`hl` switch tabs, Esc dismisses. The exit key rejects the question rather than
    quitting.
  - Nothing in the panel is truncated or height-capped. Text wraps (OpenTUI text defaults to `wrapMode: "word"`).[^question][^wrap]
- **Permissions** (`PermissionPrompt`) are a panel with a `warning` left bar.[^permission]
  - Header: `△ Permission required`, then `<icon> <title>`.
  - Body, typed by permission kind: a scrollable diff for `edit`, `$ <command>` for `bash`, patterns for an external directory, a path for
    `read`, and so on.
  - Choices: `Allow once` / `Allow always` / `Reject` buttons, chosen with ←→/`hl` and Enter. "Allow always" leads to a confirmation that
    lists the patterns it covers. Reject in a child session asks "Tell OpenCode what to do differently".
  - Height: the panel is capped at 15 rows. Ctrl+F toggles fullscreen through a portal.[^permission]

## Truncation: What, When, and How to Reach It

| What                             | Rule                                                                                                                            | How the user reaches the rest                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell output                     | More than 10 lines, or more than `10 × (width − 6)` characters: keep the first 10 lines and end with `…`.[^shell][^collapse]    | Click anywhere on the block. The line reads `Click to expand` / `Click to collapse`.[^shell]                                                                                    |
| Generic tool output              | Hidden unless the toggle is on. When on, the same rule at 3 lines.[^generic-tool]                                               | The "Show generic tool output" palette command, then a click on the block.[^generic-tool][^toggles]                                                                             |
| `execute` error output           | A 4-line preview.[^execute]                                                                                                     | No in-place expansion.[^execute]                                                                                                                                                |
| Failed inline tool               | Only the label shows, in `error`. The error text is hidden.[^inline-tool]                                                       | Click the row to show or hide the full error.[^inline-tool]                                                                                                                     |
| Reasoning                        | Collapsed to its header line by default.[^reasoning][^defaults]                                                                 | Click the header, or run `/thinking` to expand every block.[^reasoning][^toggles]                                                                                               |
| Completed tools                  | Removed entirely when "Hide tool details" is on. The default is to show them.[^tool-part][^defaults]                            | The "Show tool details" palette command.[^toggles]                                                                                                                              |
| Retry status (prompt status row) | Messages over 80 characters are cut to 80 and end with `…`. `(click to expand)` is added only past 120 characters.[^status-row] | Click opens a "Retry Error" alert, but only past 120 characters. A message of 81–120 characters is cut with no way to expand it on that row (source-observed gap).[^status-row] |
| Subagent retry line              | `Locale.truncate(message, 80)`.[^task][^locale]                                                                                 | Clicking the task row opens the child session and a "Retry Error" alert with the full message.[^task]                                                                           |
| Diagnostics                      | At most 3 error-severity diagnostics per file.[^edit]                                                                           | None on this screen.                                                                                                                                                            |
| Permission panel                 | `maxHeight` 15 rows. The edit diff scrolls inside.[^permission]                                                                 | Ctrl+F toggles fullscreen.[^permission][^keys]                                                                                                                                  |
| Prompt textarea                  | Height is `prompt.max_height`, or `max(6, rows ÷ 3)`. The content scrolls inside.[^prompt-box]                                  | Scrolling within the textarea, or `/editor` (`<leader>e`) to open `$EDITOR`.[^prompt-box][^keys]                                                                                |
| Pasted text                      | Three or more lines, or more than 150 characters: inserted as a `[Pasted ~N lines]` token. The full text is still sent.[^paste] | `/editor` shows the expanded text. The summary can be switched off.[^paste]                                                                                                     |
| Transcript depth                 | The TUI loads the last 100 messages and drops the oldest when a live session passes 100.[^sync-cap]                             | None in the TUI. Copy and export also read the same in-memory list (inferred from `messages()` in the export command).[^sync-cap][^export]                                      |
| Titles                           | The session title is cut to 50 characters in the epilogue and 40 in the terminal title.[^epilogue][^title]                      | The sidebar shows the full title.[^sidebar-id]                                                                                                                                  |

Never truncated: user message text, assistant markdown, question text and options, edit and patch diffs, and written file content.[^user-msg][^text-part][^question][^edit]

Every in-place expansion (tool output, a failed row's error, a reasoning block) is a mouse `onMouseUp` handler. The keyboard route is the
global palette toggles, transcript copy (`/copy`), or export to `$EDITOR` (`/export`, `<leader>x`). With tool details on, an export writes
every tool's full input as JSON and its full output or error.[^inline-tool][^shell][^toggles][^export]

## Colour, Bold, Markdown, and Syntax Highlighting

All colour comes from the `Theme` token set, which is loaded from the same theme JSON files Secant vendors.[^theme-type] The roles on the
session screen are:

| Token                                                                             | Where the session screen uses it                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                                                                            | User message text, live tool rows, pending `~ …` rows, shell command and output, key names in hints (`esc`, `enter`).[^user-msg][^inline-tool][^status-row]                                                                                                   |
| `textMuted`                                                                       | Settled tool rows, block titles, hint descriptions (`interrupt`, `commands`), the model and duration in the footer line, reasoning bodies, error-panel text, the idle directory line.[^inline-tool][^block-tool][^footer-line][^status-row]                   |
| `markdownText` and `markdown*`                                                    | Assistant text. Headings are bold (H1 is also underlined). `**strong**` is bold, `*emph*` italic, links underlined, quotes italic; inline code and lists have their own tokens.[^text-part][^syntax-rules]                                                    |
| `syntax*`                                                                         | Code blocks, diffs, and written files, highlighted through tree-sitter parsers registered at route load and a filetype lookup.[^syntax-rules][^edit][^layout]                                                                                                 |
| `warning`                                                                         | The reasoning header (at `thinkingOpacity`, default 0.6 alpha, while expanded), tool rows awaiting permission, the permission panel bar and selected button, the model variant name (bold).[^reasoning][^inline-tool][^permission][^prompt-box]               |
| `error`                                                                           | Failed tool rows and their error text, the assistant error-panel bar, diagnostics, retry messages, unanswered questions.[^inline-tool][^msg-error][^edit][^status-row][^question]                                                                             |
| `accent`, `secondary`, `success`                                                  | The question panel bar and active tab (`accent`), the active option (`secondary`), picked answers (`success`).[^question]                                                                                                                                     |
| Agent colour                                                                      | The user-message bar, the `▣` footer square, the prompt's left bar, the agent name, and the scanner. It is picked per agent from `secondary, accent, success, warning, primary, error, info`, or configured.[^agent-color][^user-msg][^footer-line][^spinner] |
| `diffAdded*`, `diffRemoved*`, `diffContextBg`, `diffLineNumber`, `diffHighlight*` | Edit and patch diffs, and revert file counts.[^edit][^revert]                                                                                                                                                                                                 |
| `background`, `backgroundPanel`, `backgroundElement`, `backgroundMenu`            | The page, message and tool panels, the prompt box and hover states, and the hovered block tool.[^user-msg][^block-tool][^prompt-box]                                                                                                                          |

- **Bold outside markdown** is rare: the `QUEUED` badge, the model variant, prompt extmarks such as `[Pasted …]` and `@file`, the sidebar
  title, and the subagent footer label.[^user-msg][^prompt-box][^syntax-rules][^sidebar-id]
- **Structure comes from shape.** Left `┃` bars and panel backgrounds do the work of headings. The only glyph-level status marks are `▣`, the
  tool icons, `✓`, `△`, and strikethrough for denials.[^user-msg][^block-tool][^inline-tool][^permission]
- **Marker concealment.** `conceal` is on by default, so OpenTUI hides markdown markers such as backticks and emphasis asterisks. `<leader>h`
  toggles it.[^defaults][^md-doc][^keys]
- **Subtle reasoning.** The reasoning body uses a syntax style whose every foreground is re-alphaed to `thinkingOpacity`.[^reasoning][^syntax-rules]

## Working Indicator: Thinking, Tool Work, and Idle

Two layers carry "working".

1. **Session layer, under the prompt.** OpenCode tracks `SessionStatus` as `idle`, `busy`, or `retry {attempt, message, next}`, pushed by the
   server as `session.status` events.[^status-type] Whenever it is not `idle`, the status row under the prompt shows the scanner.[^spinner][^status-row]
   - The scanner is an 8-cell animation that runs left to right and back, drawing `■` on active cells and `⬝` on inactive ones. It uses the
     agent's colour with a fading trail and advances every 40 ms.
   - Beside it sits `esc interrupt`. After one Esc it turns `primary` and reads `esc again to interrupt`. A second Esc within 5 s aborts.[^interrupt]
   - Under `retry`, the row adds the retry message in `error` with `[retrying in 12s attempt #2]`, counting down each second.[^status-row]
   - With animations off, the scanner becomes a static `[⋯]`.[^status-row]
2. **Part layer, in the transcript.** This is where the kind of work shows.[^reasoning][^inline-tool][^shell][^task]

| State                      | What the transcript shows                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thinking                   | A braille spinner (`⠋⠙⠹…`, 80 ms) in `warning` with `Thinking[: title]` on the reasoning row, until the reasoning part's `time.end` is set.[^reasoning][^spinner]                                  |
| Tool input still streaming | `~ Writing command…`, `~ Preparing edit…`, `~ Reading file…`, and so on, in `text`, with no spinner.[^inline-tool][^simple-tools]                                                                  |
| Tool running               | A spinner replaces the icon for Read, Task, and execute. A running shell block shows a spinner beside its command. Other tools show their muted final row.[^simple-tools][^shell][^task][^execute] |
| Text streaming             | Markdown grows in place. There is no separate cue.[^text-part][^sync-delta]                                                                                                                        |
| Waiting on the human       | The tool row turns `warning`, and a permission or question panel replaces the prompt.[^inline-tool][^bottom]                                                                                       |
| Idle                       | No scanner. The status row shows the working directory. The last reply carries its `▣ … · duration` footer line.[^status-row][^footer-line]                                                        |

The scanner does not distinguish thinking from tool work. That distinction lives only in the part rows (source-observed).

## Prompt

- **Multi-line entry.** The prompt is an OpenTUI `<textarea>`, 1 row high to start, growing to `max_height` and scrolling after that. It sits
  on `backgroundElement` with a left bar in the agent colour.[^prompt-box] Below it, a meta row shows the agent name, `auto` when permissions
  are auto-approved, `· <model> <provider>`, and the variant.[^prompt-box]
- **Submit and newline keys.** Defaults are `input_submit = return` and `input_newline = shift+return, ctrl+return, alt+return, ctrl+j`.
  They are bound through a managed textarea layer while a textarea has focus.[^keys] The renderer enables the kitty keyboard protocol, which
  is what lets modified Enter reach the app. Ctrl+J is the plain-control fallback (inferred).[^kitty]
- **Other keys.**[^history][^keys][^shell-mode]
  - Up/Down step through prompt history only at the start or end of the buffer.
  - Ctrl+C clears a non-empty draft. On an empty one it falls through to exit.
  - `!` at offset 0 enters shell mode.
  - `/` at the start opens command autocomplete, and `@` opens file and agent mentions.[^autocomplete]
  - Ctrl+V pastes from the clipboard, images included.
  - Submit is deferred twice so an IME's last character lands first.[^prompt-box]
- **Paste.** Bracketed paste is normalised from CRLF/CR to LF.[^paste]
  - A pasted local file path becomes an attachment: `[Image N]`, `[PDF N]`, or `[SVG: name]`.
  - Three or more lines, or more than 150 characters, become a styled `[Pasted ~N lines]` virtual token. On submit, and in `$EDITOR`, it
    expands back to the full text. A setting disables this.
  - An empty bracketed paste, which older Windows Terminal sends for an image-only clipboard, falls back to reading the clipboard.
- **Between submit and first output.** The sequence runs as follows.[^submit][^scroll][^sync-delta][^status-row][^footer-line]
  1. Guards run: disabled, autocomplete open, empty draft, `exit`/`quit`/`:q` (which quit), no model selected.
  2. `session.prompt` (or `session.shell` / `session.command`) is called **without `await`**. A failure later surfaces only as a
     `Failed to send prompt` error toast.
  3. History is appended, and the draft and its extmarks are cleared in the same call. `onSubmit` scrolls the transcript to the bottom
     after 50 ms. The user therefore sees the draft vanish at once, with no "sending" state.
  4. The user message appears when the server's `message.updated` event reaches the sync store. The prompt component inserts nothing
     itself (source-observed; no optimistic insert was found in `sync.tsx`, inferred).
  5. `session.status: busy` starts the scanner.
  6. The new last assistant message shows its `▣ Build · <model>` footer line even before it has parts, because the footer is always drawn on
     the last assistant message. Parts then stream in beneath the user message: reasoning spinner, `~` tool rows, growing markdown.
- **Starting from Home.** `session.create` is awaited first, then the route navigates after 50 ms.[^submit]
- **Busy sessions stay editable.** The prompt is disabled only while a permission or question is pending, and then it is not rendered at all.[^bottom]
  A message submitted during a busy session is queued by the server and marked `QUEUED` until the pending reply completes.[^queued]

## Identifiers: When Shown, When Hidden

| Identifier                       | Where it appears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session id                       | **On exit.** While the session route is mounted it sets an epilogue. After the renderer is destroyed, the app prints any exit error to stderr, then the epilogue to stdout: the wordmark, `Session  <title>`, and `Continue  opencode -s <id>`. Leaving the route clears it, so exiting from Home prints nothing.[^epilogue] **Otherwise:** in the sidebar only when the build channel is not `latest` (the channel defaults to `local`). Elsewhere it is used only for the default export filename `session-<first 8>.md` and a `Session not found: <id>` toast.[^sidebar-id][^export][^load-fail] |
| Session title                    | The sidebar, in bold; the terminal title as `OC \| <title>` (hidden while the title is still the default); the epilogue.[^sidebar-id][^title][^epilogue]                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Message, part, and tool-call ids | Never shown. Message ids serve as renderable ids for jump-to-message scrolling.[^user-msg][^timeline]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Timestamps                       | Hidden by default. `/timestamps` adds today's time (or date and time) to user messages. The "Jump to message" dialog (`<leader>g`) shows times as row footers.[^user-msg][^defaults][^timeline]                                                                                                                                                                                                                                                                                                                                                                                                     |
| Durations                        | Shown: the reply footer line, `Thought · 3.2s`, subagent `N toolcalls · 1m 3s`.[^footer-line][^reasoning][^task]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Model and provider               | The reply footer line and the prompt meta row.[^footer-line][^prompt-box]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tokens and cost                  | The right side of the prompt status row (`45,210 (22%) · $0.31`, replacing the `tab agents` hint once usage exists) and the sidebar Context block.[^usage][^sidebar]                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Working directory                | The prompt status row while idle.[^status-row]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Exit handling.**[^exit-keys][^question][^permission]

- `app_exit` is bound to Ctrl+C, Ctrl+D, and `<leader>q`; the leader key is Ctrl+X.
- Typing `exit`, `quit`, or `:q` as a prompt also exits.
- While a question or permission panel is up, the exit binding is re-bound to reject or cancel that request instead of quitting.

## Report 5 Complaints Against OpenCode's Source

Each complaint in [Report 5](https://github.com/secantdev/secant/issues/235#issuecomment-5854322539), next to what OpenCode's source does.
This section describes OpenCode only.

| Report 5 complaint                               | OpenCode at `228e909`                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literal timeline with a UTC timestamp per action | No per-event rows. Only text, reasoning, and tool parts render. Status, usage, and step parts never reach the transcript. Timestamps are hidden by default.[^part-map][^defaults]                             |
| The question is truncated                        | Question text and options wrap in full, with no height cap. Only the permission panel is capped (15 rows), and it offers fullscreen.[^question][^permission]                                                  |
| Same size, no bold, no colour                    | Markdown rendering with bold headings and strong text, left-bar panels, a muted versus text contrast between settled and live work, and a small set of role colours.[^text-part][^syntax-rules][^inline-tool] |
| "Your Turn" shown while the agent works          | The prompt carries no turn-ownership label. It stays editable. Busy shows as the scanner plus `esc interrupt`, and extra submissions are marked `QUEUED`.[^status-row][^queued]                               |
| "sending…" lingers after Enter                   | Submit is fire-and-forget. The draft clears in the same call, and errors arrive later as a toast.[^submit]                                                                                                    |
| No cue that the agent is working                 | The agent-coloured block scanner under the prompt runs while the status is not idle.[^spinner][^status-row]                                                                                                   |
| The preview line is replaced, not appended       | Every part is its own row in message order. Text grows in place through deltas. A row changes only when its own part's state updates.[^part-map][^sync-delta]                                                 |
| Run id and process metrics in the header         | There is no header. The session id shows only in the exit epilogue, and in the sidebar of non-release builds.[^layout][^epilogue][^sidebar-id]                                                                |

## Data the Rules Need

This section does not design Secant's screen. It records, for each OpenCode behaviour, the data that behaviour reads and whether Secant's
Harness seam carries it.

The seam is a closed `TurnEvent` union: `session`, `assistant-content`, `tool-activity`, `request-raised`, `request-answered`,
`request-expired`, `preview`, `context`, `usage`, `activity`, and `model`.[^s-events] A `ToolActivity` is
`{tool, phase: "started" | "completed", summary, parentActivity?}`.[^s-events] A Harness Request is either an approval
`{tool, input, decisions: allow | deny}` or a clarification `{prompt}`.[^s-requests] ADR 0022 keeps raw frames and private reasoning out, and
makes previews the only replaceable events.[^s-adr22]

| OpenCode behaviour                                                                        | Data it reads                                                                               | Secant seam at `9388dec` (Secant-observed)                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only transcript, with streamed markdown text                                       | Text parts plus deltas[^sync-delta]                                                         | **Carried.** `preview` is the accumulated streaming text in one replaceable slot. `assistant-content` is each final message (Claude: each text block; Codex: each completed `agentMessage`). The preview slot is dropped when final content arrives.[^s-events][^s-claude][^s-codex]                                                          |
| Reasoning row: `Thinking…` then `Thought: title · 3.2s`, expandable                       | Reasoning text, `time.start`/`time.end`[^reasoning]                                         | **Not carried, by design.** No reasoning event kind exists. The Claude Adapter forwards only `text` and `tool_use` blocks and `text_delta` deltas. The Codex Adapter drops `reasoning` items.[^s-events][^s-adr22][^s-claude][^s-codex]                                                                                                       |
| One row per call that changes state in place (pending, running, completed, error, denied) | `callID`, `state.status` including `error`, the error text[^inline-tool][^tool-states]      | **Partly carried.** Phases are `started` and `completed` only. There is no call id to pair the two events, no failed phase, and no error text. Codex parses a command's `failed`/`declined` status but does not carry it. A denial is a `request-answered` keyed by request id, not linked to a tool event.[^s-events][^s-codex][^s-requests] |
| Typed tool rows (`Read <path>`, `Grep "p" (N matches)`, `Glob … in …`)                    | Structured `input` plus `metadata` (count, matches, loaded)[^simple-tools]                  | **Flattened.** `summary` is a string. Claude sends `JSON.stringify` of the tool input on start and of the result content on completion. Codex sends the command, `N file changes`, a status, a query, or a path.[^s-claude][^s-codex]                                                                                                         |
| Shell block with live, collapsible output                                                 | Streaming `metadata.output`, `input.workdir`[^shell]                                        | **Not carried for Codex.** `commandExecution/outputDelta` is in the required schema but is mapped to no event. The completed summary is the command. Claude's completed summary is the `tool_result` content string.[^s-codex][^s-claude]                                                                                                     |
| Edit and patch diffs, written content, diagnostics                                        | `metadata.diff`, `files[].patch`, `input.content`, `metadata.diagnostics`[^edit]            | **Not carried as data.** Codex sends `N file changes`, with paths only in an approval's input string. Claude's old and new strings exist only inside the JSON summary string.[^s-codex][^s-claude]                                                                                                                                            |
| Question panel: tabs, options with descriptions, multi-select, custom answer              | `questions[]{header, question, options[{label, description}], multiple, custom}`[^question] | **Not carried.** A clarification is `{prompt}` only, answered with free text.[^s-requests]                                                                                                                                                                                                                                                    |
| Typed permission body and Allow once / always / Reject                                    | The permission kind, `metadata.diff`, `patterns`, `always`[^permission]                     | **Flattened.** An approval is `{tool, input: string, decisions}`, and the decisions are `allow` and `deny` only ("Claude Code offers no always").[^s-requests]                                                                                                                                                                                |
| Busy scanner, and idle once the reply completes                                           | `SessionStatus` busy or idle[^status-type]                                                  | **Derivable above the seam.** A Turn is active from `startTurn` until its single result settles.[^s-results]                                                                                                                                                                                                                                  |
| Retry line with attempt and countdown                                                     | `retry{attempt, message, next}`[^status-type]                                               | **Not carried as a kind.** ADR 0022 lists retry among preserved facts, but the union has no retry event, so a retry could arrive only as generic `activity` text.[^s-events][^s-adr22]                                                                                                                                                        |
| Submitting while busy shows `QUEUED`                                                      | A server-side prompt queue[^queued]                                                         | **Not a seam fact.** One active Turn per Prepared Harness. Same-Turn input is `steer`, declared per profile: Codex available, Claude Code unavailable.[^s-results][^s-steer]                                                                                                                                                                  |
| Reply footer line: mode · model · duration · interrupted                                  | `agent`/`mode`, `modelID`, message times, `MessageAbortedError`[^footer-line]               | **Mostly carried.** The model comes from a `model` event and the result's `effectiveModel`, and interruption from the `interrupted` result. Events carry no timestamps, so a duration needs Secant's own clock. There is no agent or mode concept below the seam.[^s-events][^s-results]                                                      |
| Tokens (percent) and cost                                                                 | Message tokens, the model's context limit, session cost[^usage]                             | **Carried in part.** `context` holds `usedTokens`/`limitTokens` when observed. `usage` is an estimate summary string.[^s-events]                                                                                                                                                                                                              |
| Subagent task row and child-session navigation                                            | A `task` tool plus the child session's messages[^task]                                      | **Grouping only.** A `parentActivity` id on `tool-activity` and `assistant-content` (Claude's `parent_tool_use_id`). Codex `collabAgentToolCall` carries only a status. There is no child conversation to navigate to.[^s-events][^s-claude][^s-codex]                                                                                        |
| Todo block                                                                                | `todowrite` input[^todo-question-tool]                                                      | **Not typed.** Claude's TodoWrite arrives as a generic tool summary.[^s-claude]                                                                                                                                                                                                                                                               |
| `Continue  opencode -s <id>` on exit                                                      | The session id[^epilogue]                                                                   | **Out of scope for the seam.** The native conversation id is an opaque recovery coordinate by design. A resumable handle for the user would be a Secant fact above the seam.[^s-adr22]                                                                                                                                                        |

## Relation to Earlier Secant Work

The [`UPSTREAM`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/UPSTREAM) record already notes what Secant
took from this route, at an older commit (`1ead9e3d7f`).[^s-upstream]

- The live-edge-following timeline shape, rebuilt as a hand-rolled reducer rather than `stickyScroll`.
- The single bottom region whose control follows Run state.
- The permission prompt's shape.
- The two-press `esc interrupt` cue.

The [extraction research](./opencode-tui-extraction-constraints.md) studied structure. ADR 0018 allows presentation to be vendored, but
state-coupled components must be rebuilt after studying their OpenCode counterpart.[^s-adr18] None of this study's behaviour, including part
rendering, the tool renderers, the scanner, prompt submit, paste summaries, and the epilogue, is recorded as taken at `9388dec`.[^s-upstream]

## Limits

- Nothing was run, so this study makes no rendering or timing claim beyond what the source states. Terminal-dependent key delivery (modified
  Enter) is inferred from the kitty-keyboard flag.
- Defaults read from `kv.signal` apply only until the user toggles them. The toggles persist per user.[^defaults]
- Plugins can replace the prompt and add sidebar content through slots. This study describes the built-in plugins only.[^bottom][^sidebar]

[^catalog]: OpenCode root [`package.json` lines 43-59](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/package.json#L43-L59) (`@opentui/*` `0.4.5`, `opentui-spinner` `0.0.7`).

[^layout]: OpenCode [`routes/session/index.tsx` lines 1157-1361](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1157-L1361), route layout; parser registration at [line 85](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L85).

[^scroll]: OpenCode `index.tsx` [lines 1180-1197](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1180-L1197) (`stickyScroll`, `stickyStart="bottom"`, scrollbar visibility), [lines 423-428](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L423-L428) (`toBottom`), [line 314](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L314) and [lines 1154-1155](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1154-L1155) (snap on open), [lines 1326-1328](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1326-L1328) (snap on submit).

[^sticky-doc]: OpenTUI documentation, [ScrollBox: sticky scroll](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/scrollbox.mdx), fetched through Context7 (`/anomalyco/opentui`).

[^bottom]: OpenCode `index.tsx` [lines 232-241](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L232-L241) (`visible`/`disabled`) and [lines 1296-1334](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1296-L1334) (bottom region and the `session_prompt` plugin slot).

[^sidebar]: OpenCode `index.tsx` [lines 270-278](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L270-L278) and [1338-1357](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1338-L1357); [`routes/session/sidebar.tsx` lines 26-100](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/sidebar.tsx#L26-L100); [`feature-plugins/sidebar/context.tsx` lines 13-47](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/feature-plugins/sidebar/context.tsx#L13-L47).

[^defaults]: OpenCode `index.tsx` [lines 255-279](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L255-L279) (conceal `true`, timestamps `hide`, tool details `true`, scrollbar `false`, generic tool output `false`); [`context/thinking.ts` lines 29-61](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/thinking.ts#L29-L61) (thinking mode default `hide`).

[^user-msg]: OpenCode `index.tsx` [lines 1364-1467](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1364-L1467) (`UserMessage`).

[^msg-dialog]: OpenCode `index.tsx` [lines 1267-1284](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1267-L1284); [`routes/session/dialog-message.tsx` lines 23-80](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/dialog-message.tsx#L23-L80).

[^footer-line]: OpenCode `index.tsx` [lines 1477-1487](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1477-L1487) (final and duration) and [lines 1548-1573](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1548-L1573) (footer line).

[^msg-error]: OpenCode `index.tsx` [lines 1533-1547](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1533-L1547).

[^part-map]: OpenCode `index.tsx` [lines 1494-1508](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1494-L1508) and [lines 1578-1582](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1578-L1582) (`PART_MAPPING`); SDK [`types.gen.ts` lines 627-639](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/sdk/js/src/v2/gen/types.gen.ts#L627-L639) (the `Part` union).

[^text-part]: OpenCode `index.tsx` [lines 1686-1705](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1686-L1705) (`TextPart`).

[^md-doc]: OpenTUI documentation, [Markdown: concealment, streaming, and top-level block mode](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/components/markdown.mdx), fetched through Context7.

[^wrap]: OpenTUI documentation, [Text and cells: wrap text](https://github.com/anomalyco/opentui/blob/main/packages/web/src/content/docs/core-concepts/text-and-cells.mdx) ("The default is `word`"), fetched through Context7. Confirmed in the installed `@opentui/core` `0.4.5` build, where `TextBufferRenderable` sets `wrapMode: "word"` in its defaults.

[^reasoning]: OpenCode `index.tsx` [lines 1586-1684](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1586-L1684) (`ReasoningPart`, `ReasoningHeader`); [`context/thinking.ts` lines 8-27](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/thinking.ts#L8-L27) (`reasoningSummary`, mode cycle).

[^tool-part]: OpenCode `index.tsx` [lines 1709-1789](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1709-L1789) (dispatch and `shouldHide`) and [lines 2626-2645](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2626-L2645) (known tool names).

[^tool-states]: SDK [`types.gen.ts` lines 477-532](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/sdk/js/src/v2/gen/types.gen.ts#L477-L532) (`pending`, `running`, `completed`, `error` tool states).

[^inline-tool]: OpenCode `index.tsx` [lines 1836-1992](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1836-L1992) (`InlineTool`, `InlineToolRow`: permission, failed, and denied colouring, the `~` pending row, click to reveal the error).

[^layout-margin]: OpenCode `index.tsx` [lines 1934-1947](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1934-L1947); [`util/layout.ts` lines 8-18](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/layout.ts#L8-L18).

[^block-tool]: OpenCode `index.tsx` [lines 1994-2044](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1994-L2044) (`BlockTool`).

[^generic-tool]: OpenCode `index.tsx` [lines 1798-1834](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1798-L1834) (`GenericTool`, 3-line collapse) and [lines 2609-2616](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2609-L2616) (`[key=value]` input summary).

[^shell]: OpenCode `index.tsx` [lines 2046-2103](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2046-L2103) (`Shell`: `maxLines = 10`, `stripAnsi`, click to expand).

[^shell-mode]: OpenCode [`component/prompt/index.tsx` lines 816-841](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L816-L841) and [lines 1059-1070](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1059-L1070); server [`session/prompt.ts` lines 479-515](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/opencode/src/session/prompt.ts#L479-L515) (synthetic user text and the running `bash` tool part).

[^collapse]: OpenCode [`util/collapse-tool-output.ts` lines 1-19](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/collapse-tool-output.ts#L1-L19).

[^edit]: OpenCode `index.tsx` [lines 2105-2135](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2105-L2135) (`Write`), [lines 2390-2517](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2390-L2517) (`Edit`, `ApplyPatch`; split view above 120 columns), [lines 2583-2607](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2583-L2607) and [lines 2692-2706](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2692-L2706) (diagnostics, severity 1, at most 3).

[^simple-tools]: OpenCode `index.tsx` [lines 2137-2213](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2137-L2213) (`Glob`, `Read`, `Grep`, `WebFetch`, `WebSearch`) and [lines 2575-2581](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2575-L2581) (`Skill`).

[^task]: OpenCode `index.tsx` [lines 2215-2328](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2215-L2328) (`Task` and its formatters) and [lines 1509-1532](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1509-L1532) (the "view subagents" hint).

[^execute]: OpenCode `index.tsx` [lines 2343-2388](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2343-L2388).

[^todo-question-tool]: OpenCode `index.tsx` [lines 2519-2573](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L2519-L2573) (`TodoWrite`, `Question`).

[^question]: OpenCode [`routes/session/question.tsx` lines 14-515](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/question.tsx#L14-L515) (keys at lines 209-286, render at lines 288-513, exit rebound to reject at lines 217-226).

[^permission]: OpenCode [`routes/session/permission.tsx` lines 111-441](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/permission.tsx#L111-L441) (typed bodies and options) and [lines 525-719](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/permission.tsx#L525-L719) (`maxHeight: 15`, fullscreen portal, exit rebound to reject).

[^revert]: OpenCode `index.tsx` [lines 1202-1266](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1202-L1266).

[^status-row]: OpenCode [`component/prompt/index.tsx` lines 1513-1690](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1513-L1690) (busy scanner, retry text with the 80- and 120-character thresholds at lines 1535-1565, idle directory, right-side hints).

[^sync-cap]: OpenCode [`context/sync.tsx` lines 321-358](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/sync.tsx#L321-L358) (drop the oldest past 100) and [lines 594-606](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/sync.tsx#L594-L606) (`limit: 100` on load).

[^sync-delta]: OpenCode `context/sync.tsx` [lines 316-318](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/sync.tsx#L316-L318) (status), [lines 376-414](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/sync.tsx#L376-L414) (part upsert and delta append).

[^status-type]: SDK [`types.gen.ts` lines 673-693](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/sdk/js/src/v2/gen/types.gen.ts#L673-L693) (`SessionStatus`); `context/sync.tsx` [lines 316-318](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/sync.tsx#L316-L318).

[^spinner]: OpenCode [`component/prompt/index.tsx` lines 1322-1344](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1322-L1344) and [lines 1522-1527](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1522-L1527) (`blocks` style, agent colour, 40 ms); [`ui/spinner.ts` lines 272-329](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/ui/spinner.ts#L272-L329) (8-wide bidirectional `■`/`⬝` frames); [`component/spinner.tsx` lines 10-26](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/spinner.tsx#L10-L26) (braille spinner, 80 ms, `⋯` fallback).

[^interrupt]: OpenCode [`component/prompt/index.tsx` lines 392-422](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L392-L422) and [lines 1587-1592](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1587-L1592).

[^prompt-box]: OpenCode [`component/prompt/index.tsx` lines 1288-1486](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1288-L1486) (border colour, `maxHeight` at line 1345, textarea with IME double-defer at lines 1391-1395, meta row).

[^keys]: OpenCode [`config/keybind.ts` lines 41-200](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/config/keybind.ts#L41-L200) (`input_submit` and `input_newline` at lines 163-164, `app_exit` at line 48, `messages_toggle_conceal` at line 149, `permission.prompt.fullscreen` at line 219) and [`keymap.tsx` lines 136-173 and 229-232](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/keymap.tsx#L136-L232) (managed textarea layer).

[^kitty]: OpenCode [`app.tsx` lines 191-205](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L191-L205) (`useKittyKeyboard: {}`).

[^history]: OpenCode [`component/prompt/index.tsx` lines 800-928](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L800-L928) (paste, clear, shell mode, and history bindings).

[^autocomplete]: OpenCode [`component/prompt/autocomplete.tsx` lines 691-707](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/autocomplete.tsx#L691-L707).

[^submit]: OpenCode [`component/prompt/index.tsx` lines 930-1147](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L930-L1147) (guard, exit words at lines 963-967, the un-awaited `session.prompt` at lines 1092-1121, clear at lines 1122-1146).

[^paste]: OpenCode [`component/prompt/index.tsx` lines 1149-1270](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1149-L1270) (summary threshold at lines 1206-1213), [lines 1396-1420](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1396-L1420) (bracketed paste), [lines 370-391](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L370-L391) (clipboard paste), [lines 423-514](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L423-L514) (`/editor` expands paste parts).

[^queued]: OpenCode `index.tsx` [lines 243-249](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L243-L249) (`pending`) and [lines 1387-1452](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L1387-L1452) (`QUEUED` badge).

[^usage]: OpenCode [`component/prompt/index.tsx` lines 264-282](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L264-L282) and [lines 1655-1689](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L1655-L1689).

[^epilogue]: OpenCode `index.tsx` [lines 201-205](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L201-L205) (set on mount, 50-character title, cleared on cleanup); [`util/presentation.ts` lines 29-38](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/presentation.ts#L29-L38); [`app.tsx` lines 186-194, 247-254, 357-362](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L186-L362) (exit and epilogue providers; stderr, then stdout, after the renderer is destroyed).

[^exit-keys]: OpenCode `config/keybind.ts` [lines 41-48](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/config/keybind.ts#L41-L48); [`app.tsx` lines 826-833 and 982](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L826-L982); `component/prompt/index.tsx` [lines 963-967](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/component/prompt/index.tsx#L963-L967).

[^title]: OpenCode [`app.tsx` lines 452-476](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/app.tsx#L452-L476).

[^sidebar-id]: OpenCode `routes/session/sidebar.tsx` [lines 56-62](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/sidebar.tsx#L56-L62) (bold title; session id only when `InstallationChannel !== "latest"`); [`core/src/installation/version.ts` line 7](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/core/src/installation/version.ts#L7) (channel defaults to `local`).

[^load-fail]: OpenCode `index.tsx` [lines 286-324](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L286-L324).

[^export]: OpenCode `index.tsx` [lines 876-1020](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L876-L1020) (copy last message, copy transcript, export to `$EDITOR`, `session-<id8>.md` at line 959); [`util/transcript.ts` lines 85-114](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/transcript.ts#L85-L114).

[^timeline]: OpenCode `index.tsx` [lines 517-538](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L517-L538); [`routes/session/dialog-timeline.tsx` lines 10-46](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/dialog-timeline.tsx#L10-L46).

[^toggles]: OpenCode `index.tsx` [lines 685-750](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/routes/session/index.tsx#L685-L750) (conceal, `/timestamps`, `/thinking`, tool details, scrollbar, generic tool output).

[^locale]: OpenCode [`util/locale.ts` lines 39-64](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/util/locale.ts#L39-L64) (`duration`, `truncate`).

[^theme-type]: OpenCode [`theme/index.ts` lines 36-91](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/theme/index.ts#L36-L91) (the `Theme` tokens) and [lines 291-297](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/theme/index.ts#L291-L297) (`thinkingOpacity` default 0.6).

[^syntax-rules]: OpenCode `theme/index.ts` [lines 556-990](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/theme/index.ts#L556-L990) (`generateSubtleSyntax`, extmark styles at lines 601-620, markup rules at lines 795-929); [`context/theme.tsx` lines 271-287](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/theme.tsx#L271-L287).

[^agent-color]: OpenCode [`context/local.tsx` lines 83-131](https://github.com/anomalyco/opencode/blob/228e9095ba3988a02664c3816cb51f98584e86c2/packages/tui/src/context/local.tsx#L83-L131).

[^s-events]: Secant [`src/harness/harness.ts` lines 303-393](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L303-L393) (`ToolActivity`, `ContextObservation`, `UsageObservation`, and the closed `TurnEvent` union; no timestamp fields).

[^s-requests]: Secant [`src/harness/harness.ts` lines 250-298](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L250-L298) (`ApprovalDecision`, `RequestShape`, `RequestAnswer`).

[^s-results]: Secant [`src/harness/harness.ts` lines 466-530](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/harness.ts#L466-L530) (Turn results).

[^s-adr22]: Secant [ADR 0022](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0022-own-a-truthful-deep-harness-seam.md), fourth and sixth paragraphs (events preserve user-meaningful facts including retry; raw frames and private reasoning stay private; native ids are opaque recovery coordinates).

[^s-claude]: Secant [`src/harness/claude-code.ts` lines 1256-1316](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1256-L1316) (text and `tool_use` only, `tool_result` summaries, `text_delta` previews) and [lines 1431-1439](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1431-L1439) (`summarize` = `JSON.stringify`).

[^s-codex]: Secant [`src/harness/codex/runtime-protocol.ts` lines 335-338](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L335-L338) (command status parsed), [line 552](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L552) (reasoning dropped), [lines 581-703](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/runtime-protocol.ts#L581-L703) (item-to-`tool-activity` summaries); [`required-schema.ts` lines 105-106](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex/required-schema.ts#L105-L106) (`outputDelta` required but unmapped).

[^s-steer]: Secant [`src/harness/claude-code.ts` lines 1559-1563](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/claude-code.ts#L1559-L1563) and [`src/harness/codex.ts` lines 1817-1821](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/src/harness/codex.ts#L1817-L1821).

[^s-upstream]: Secant [`UPSTREAM`](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/UPSTREAM), sections "Added 2026-09-14", "Added 2026-09-18", and "Added 2026-09-23 for the M6 live Interactive interrupt".

[^s-adr18]: Secant [ADR 0018](https://github.com/secantdev/secant/blob/9388dec6dd33119005cdb0e1881007ef720cd14d/docs/adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md), including its 2026-09-07 rebuild-tiebreak amendment.
