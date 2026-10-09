# Workbench history

Read before changing Workbench history rendering, scrolling, Ctrl+O, row inspection, or history content reads.
[Workbench interaction](./tui-workbench.md) owns the bottom interaction, command keys, confirmations, and dialogs; [the presentation Module's notes](../../src/tui/AGENTS.md)
keep history layout caching and reader roots.

## Rows and scrolling

- Workbench history (#412, #441) consumes keyed complete Session pages and complete preview values. `mapArray` retains only the current Session
  and a distinct live Turn's Session; ordinary Run updates never reopen them. Prior Turn starts/settlements remain Workflow facts, not older conversation.
  `run-content-anchor.ts` shares keyed content-relative offsets with the transcript; each reader keeps its own opaque ids.
  History ids survive wrapping/settlement. History-only observer loss is visible and reconnectable; reopening issues fresh ids and resets the viewport.
  Workflow facts follow their Turn, including equal-time ties.
  Alt+Up/Down scroll lines, PageUp/Down half a viewport, minimum one, Alt+Home oldest and Alt+End latest; native arrows/Home/End edit the prompt.
  Keys yield to modal/details focus; OpenTUI wheel events bubble with the same guards. The Renderer Adapter maps `meta` to the Port's `alt`.
  Passive changes stay paused. Up starts at the actual anchor, including blank space below short pages; only latest or deliberate Down resumes following.
  A removed anchor chooses the nearest prior survivor, ties later, at its first displayed line; a short or empty page stays paused. Dividers count toward their content row.
  Negative offsets name the leading divider lines.
- The retained transcript reader (`run-transcript.tsx`, #421) anchors Resource entry ids, independently of live history row ids. Its entry id anchors an
  offset relative to the role header; leading dividers have negative offsets, so newly attached dividers preserve content. Resize clamps only within the
  entry; its reserved notice line and read notices stay outside content. Only this reader pages older: `p` preserves position, including failed retries.
  Up at the top also loads older. Export (`e`) reads the complete Reference only on demand and queues text to the terminal clipboard, naming refusal.
- Transcript and timeline content wraps, never clips: `wrap.ts` breaks each row in display columns, and each line renders as its own `wrapMode="none"`
  `<text>`. Never let OpenTUI wrap counted content: its word wrap can break a line that exactly fills the width, so its count and ours drift.
- Agent completion reasons (#372) are sanitized and clipped to one display line. The agent-ended row omits the timestamp to leave room on narrow screens.
- Step and Session dividers (#289) are `wrapRows` rules leading the row that begins the Step or Session, never rows of their own, so the badge counts events
  and the anchor holds. Their words live in `run-timeline-rows.ts` for both views; they compare the Application's `step`/`session` and parse no name.

## Expansion and inspection

- Ctrl+O targets the bottom-most row with any line visible and detail hidden by its collapsed form; a click opens its row. Eligibility is cached with
  the drawn collapse (#503), and visibility includes counted prefixes and partial rows. It skips empty Thoughts/Entry prompts and output with no hidden
  lines or characters. It remembers an in-place opened row by its history id, never a modal inspection; the next press only closes it, even off-screen
  or after arrivals. A click closing it or window eviction clears the memory. Supplied patch inspection clears it, consumes Ctrl+O, and closes with Esc.
  Live readers follow the opened end; paused content keeps its anchor, as for a click. Expand-all stays rejected.
- Output/Thoughts toggle by row id. Call patches and Turn diffs inspect complete supplied content in bounded exact-version portions (#489).
  Output collapses before wrapping at ten logical lines or `10 * Math.max(20, width - 6)` code points, whichever comes first; the omission count names
  lines or characters truthfully and never auto-expands. Visible referenced messages/Steers and expanded output/Thoughts/Entry prompts show one portion
  (#490); scrolling past a visible edge reads the next, a followed live preview opens at its newest, and cut metadata previews inspect `detail`. Diff
  inspection has no content cap; Home/End read first/last portions, `r` retries, `f` toggles file metadata. Thought ticks change headings; modal/input keys stay.
- Turn-diff and file-change rows show the first ten structured file names in reported order, wrapped without shortening (#502). Append `N more files`
  after the title's status when names remain; live updates never expand the list. A file-change row with structured files omits its repeated input.
  Large visible names read bounded text on demand; clicking a wrapped name inspects the complete path.
  Ctrl+O/click still opens complete supplied diff or call detail through bounded reads. Clicking a command heading inspects its full metadata. Presentation
  never parses input text for names.
- History detail caches retain one portion per reader. Eight shared row-content readers serve the visible rows `rowContentReference` names — long messages
  and Steers always, output, Thoughts and Entry prompts only while expanded — and sixteen serve large paths, all in the current viewport (#490, #502).
  Collapse, eviction, overlay navigation, and disposal release reads. Version replacement cancels the old read; dismissed replies never update a row.
