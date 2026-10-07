# tui — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- OpenTUI `<text>` lays out multiple children as separate inline spans, which garbles a line (fragments drop or overlap). Give every `<text>` a single
  concatenated string child, not a mix of literals and `{expr}` siblings.
- A flex column with a fixed `height` shrinks overflowing children to fit, corrupting their content rather than clipping. When a screen's content can
  exceed the terminal height, set `overflow="hidden"` on the container and `flexShrink={0}` on the rows/sections so each keeps its full height. A screen
  that owns a bounded `<scrollbox>` still keeps full-height content rows inside it; scroll does not replace the guard.
- A focused OpenTUI `<input>` and the `@opentui/keymap` layer divide keys by binding: any key the keymap binds fires its command even while an input is focused; only
  unbound printable keys and backspace reach the input. So never bind a bare letter key (e.g. `q` to quit) on a text-entry screen, and gate `left`/`right` with a reactive
  `enabled` so choice/verdict fields cycle without stealing a text field's cursor. Native `<input>`/`<select>`/`<textarea>` exist — no need to hand-roll a caret.
- A focused `<textarea>` loses `up`/`down`/`return` to the keymap too, so Start a Run's text box (`launch-text-box.tsx`, #287) takes Up/Down through
  its `moveLine` handle (visual row is `scrollY + visualCursor.visualRow`). It fires `onContentChange` on mount, so it reports only changed values,
  and it owns its text after mount: never feed the draft back as `value`, or its paste placeholders (virtual extmarks) are wiped.
- The Run Workbench (`run-workbench.tsx`) is the one screen that takes its keys, size, and resize from the injected Renderer Port (`size`/`onKey`/`onResize`,
  A13) instead of `@opentui/keymap` + `useTerminalDimensions`: a single raw-key pipeline drives every control, so its input and layout are driven by a fake
  renderer in tests. Every other screen keeps the keymap/`useTerminalDimensions` path. Drawing still goes through OpenTUI elements — the Port never carries it.
- Workbench Step-ending Offers expose Run and Step ids, not an Attempt id. Resume evidence is ownerPid and acknowledgement; Interrupt exposes turnId
  (#389). Confirmation lifecycle rules live in [Workbench interaction](../../docs/agents/tui-workbench.md).
- `follow.ts` alone owns Projection observer health and reconnect ordering. A terminal update preserves last-known state as `disconnected`; explicit reconnect
  crosses `loading` and `catching-up` before `current`. Workbench Operation controls read only current offers, while timeline live-edge remains a separate scroll fact.
- Workbench history (#412) consumes keyed complete Session pages and complete preview values. `mapArray` retains subscriptions by semantic Session;
  ordinary Run updates never reopen them. `run-history-scroll.ts` stores opaque row ids and displayed-line offsets, and uses ordinals only for layout.
  Alt+Up/Down scroll lines, PageUp/Down half a viewport, minimum one, Alt+Home oldest and Alt+End latest; native arrows/Home/End edit the prompt.
  Keys yield to modal/details focus; OpenTUI wheel events bubble with the same guards. The Renderer Adapter maps `meta` to the Port's `alt`.
  Passive changes stay paused. Up starts at the actual anchor, including blank space below short pages; only latest or deliberate Down resumes following.
  A removed anchor chooses the nearest prior survivor, ties later, at offset zero; a short or empty page stays paused. Dividers count toward their content row.
- Ctrl+O/click opens a history detail: output and Thoughts toggle by row id; call patches and Turn diffs open complete supplied content (#415–#417).
  Output collapses at ten wrapped lines, never auto-expands; diff inspection stays uncapped. Thought ticks change headings; modal/input key ownership stays unchanged.
- The retained transcript reader anchors Resource entry ids, independently of live history row ids. Its reserved notice line never moves content.
- Transcript and timeline content wraps, never clips: `wrap.ts` breaks each row in display columns, and each line renders as its own `wrapMode="none"`
  `<text>`. Never let OpenTUI wrap counted content: its word wrap can break a line that exactly fills the width, so its count and ours drift.
- Agent completion reasons (#372) are sanitized and clipped to one display line. The agent-ended row omits the timestamp to leave room on narrow screens.
- Step and Session dividers (#289) are `wrapRows` rules leading the row that begins the Step or Session, never rows of their own, so the badge counts events
  and the anchor holds. Their words live in `run-timeline-rows.ts` for both views; they compare the Application's `step`/`session` and parse no name.
- Exactly one screen mounts at a time (`app.tsx`), so a screen's key bindings exist only while it is active and cannot conflict with another's. And
  `useBindings({ enabled })` must be gated off while a dialog overlays a screen (the approval dialog over Home, `home.tsx`), or the overlaid screen's
  bindings fire under the dialog.
- Start a Run skips Harness/model for Command-only Bundles; Agent-bearing Bundles use the Harness catalog's worded rows, model declaration, and `preselection`. Review opens a
  fresh `launch-preparation` Projection for the complete draft, offers Start only while ready, and submits that Projection's exact `launch-run` draft (#191/#192).
  The shared picker (`model-choice-picker.tsx`) takes navigation from its host; native Other input owns text editing. Unchanged preselection leaves both
  request fields unset to retain its source. The host keeps the choice and effort-reset reason across stages and Review.
- Review's Tab stops are Harness, Model, Effort, and Start; Effort is skipped while `effortControl` (the picker's lock/declaration fact) or the assessed lock
  says it cannot change. Enter on a field visits only that step and returns to Review on it; Tab from the guided model stage visits the Harness and
  returns there (`returnTo` in `StartRun`). Start is pinned below Review's paged body.
- A focus that reads `not-checked` is a check in flight (the Port always settles it), so `StartRun` alone holds Harness Continue while `isCheckingModels`. The chosen
  row reads `harnessFocusStatus` from that focus, because the list snapshot is re-pushed only after the focus settles (#286).
- A refused launch routes only by `correction`, clears only the invalidated draft field, preserves every other choice, and keeps its inline finding after the dismissible
  `Run not started` notice leaves. A typed preparation failure after admission still rides the Run Projection into the Workbench (#146).
- `paddingLeft` on a `<text>` does not indent it; wrap the text in a `paddingLeft` `<box>`, which also keeps its wrapped lines indented (#285).
- `clip()` (`clip.ts`) is the ellipsis affordance, not an overflow guard: call it only on a row that should _advertise_ its cut with a trailing `…` (a
  name, path, or status that can exceed the inner width). It measures **display columns** per whole grapheme (`string-width` over `Intl.Segmenter`, D5),
  and its budget is exact: a `<text>` wraps even a one-column overrun onto a second line, ellipsis and all, despite `overflow="hidden"` (#307).
- A launch resolves at **admission** (`run-launch-view.tsx`): the Run id is known and the Run is observable `running` at once (#98 A7), so the flow reaches
  the Workbench before the Run rests and the Workbench follows the live `run` Projection. Every _other_ write (answer, resume, cancel, delete) follows the
  operation stream to settlement through `submit-and-settle.ts`, because a Run — and a cancel-as-abort of a live Run — settles asynchronously now (#98).
  Captured command output is stripped of ANSI escapes with `strip-ansi` and split on `/\r?\n/` in the inspection read path (D4).
- Sanctioned Seam leak (A29): `createProductionRenderer` (`renderer/renderer.ts`) returns an `@opentui/core` `CliRenderer` that composition
  (`composition/tui-runtime.ts`) binds and hands to `mountTui`, so an inferred `@opentui/core` type crosses into composition where the boundary suite —
  which reads only import specifiers — cannot see it. Deliberate and ADR 0018-sanctioned: Solid's `render(node, renderer)` mounts onto that object while
  the Renderer Port keeps lifecycle. Recorded here because the check is blind to it.
- The quit confirmation (`app.tsx` `GuardedExitProvider`/`QuitConfirmation`) lives on the vendored dialog stack, not a bare `<Show>` overlay: every screen's bindings are
  gated `dialog.stack.length === 0`, so being on the stack is what makes it modal (else `q`/`return` fire the underlying screen too). Escape/Ctrl+C dismissal comes from the
  dialog primitive. Route's approval-clear effect is a one-shot guarded on an `approvalOpen` signal so it never clears the quit dialog, and the approval dialog's `onClose`
  declines only while still unapproved — a programmatic clear once approved is not a decline. Its count, like Home's total, is the followed `workspace` snapshot's
  `runSummary` (#396), never Previous Runs paging; an `unavailable` owned count still opens the dialog, never quits at once.
- The legacy-conhost notice (`renderer/conhost-notice.ts`, #70) gates the TUI at the `runTuiApp` seam before any renderer exists; `WT_SESSION` short-circuits the
  probe. `createStdinKeypress` reads one raw key and must hand stdin back paused, cooked, and listener-free **without destroying it** — the teardown's
  `createProcessStdinRelease` does destroy it, and OpenTUI takes stdin next. Ctrl+C at the wait exits 130. Its `bun:ffi` import is allowlisted per file,
  allowlisted in `tests/architecture/check-vendor-provenance.ts`.

- Agent-bearing Runs reserve two metadata lines outside the timeline (#418). Context/usage replacement cannot change history rows,
  viewport height, or the activity badge; empty reports leave blank slots. Metadata uses reported meanings and clips to the available width.

- Native prompt caret offsets map logical columns through graphemes, never `cursorCharacterOffset`; completion edits native selection and acknowledges it once (#423).
- Prompt receipts are independent per dispatch (#420). A native textarea `setText` moves its cursor to the start; prompt write-back calls
  `gotoBufferEnd` after clear or restore so continued typing extends the restored draft. Ordinary updates never write text back.
- Workbench Steer receipts carry the Operation id as `steerId` for exact settlement matching; equal text never identifies a production capture.

## Tests

- Workbench resize evidence resizes both `testRender` and the injected Renderer Port: changing only the Port leaves the captured terminal at its original width.
- Screens are exercised in-memory over fake Projection snapshots with `@opentui/solid` `testRender` (`tests/tui/*.test.tsx`): assert content, key
  dispatch, and small-width/resize relayout without overflow. A lone Escape is held briefly by OpenTUI key disambiguation — poll in real time, not by
  frame count.
- The working scanner's drawing leaf (`working-scanner.tsx`) is unexported (topology's fenced-package rule, #308); only its plain frame model is.
  Its colours are asserted in `run-workbench.test.tsx` against the Workbench's own `captureSpans` colours, which couples them to the prompt bar's
  accent and the meta row's muted role.

## Read next

- `app-commands.tsx` retains known names and aliases even when unavailable; its `entries()` exposes available commands to Home, Ctrl+P, and Slash.
- `shell-commands.tsx` owns picker entry restoration and apply-before-save. `preferences-view.ts` generates a fresh Operation id on every save or retry.
- Each screen reads the Projection Port through a per-screen view seam (`workspace-view.tsx`, `bundle-view.tsx`, `run-view.tsx` — the reactive `run` read +
  reference resolution the Workbench uses, plus its Step-interaction writes; `run-list-view.tsx` — the Previous Runs read seam that pages older rows by cursor
  and appends them, the only seam that re-opens its Projection to grow a page); other writes go through a per-screen submit seam (`run-actions-view.tsx` —
  resume/cancel/delete/interrupt/Model-choice changes, mirroring `run-launch-view.tsx`). The Renderer Port (`renderer/renderer.ts`) carries lifecycle plus the Workbench's
  `size`/`onKey`/`onResize`, and declares its key value (`{ name?, ctrl?, alt?, shift? }`, A16) so the Workbench needs no cast.
- `catalog-navigation.tsx` (A4) owns both catalogs' search pane, pane focus, selection (empty on arrival from Home), bindings, and row/empty
  shells, on the vendored `vendor/panels.tsx` and bounded `vendor/scroll.ts` primitives (see `UPSTREAM`); filters, focus, and inspectors stay
  per screen. Its `CatalogRow` also draws Start a Run's Bundle and Harness choice rows, always `focused` there (#286).
  `bundle-catalog.tsx` renders `bundle-view.tsx` via pure `bundle-catalog-inspector.tsx`; neither adds an Action Offer or Projection selector.
- `harness-catalog.tsx` opens exact focus for the selected row and rehydrates only rows the list already marks checked, retaining those accessors for search;
  `harness-view.tsx` keeps list opening spawn-free, `harness-format.ts` owns shared wording, and the inspector renders normalized facts with no Actions.
  The row reads `harnessRowStatus` (Start a Run's words) and `harnessModelLine`; discovery evidence lives in the inspector (#285).
- Two private helpers back those seams: `follow.ts` (`followProjection`) owns the read seams' follow, health, and reconnect loop (A22); `submit-and-settle.ts`
  (`submitAndSettle`) owns submit-then-follow and reopens a lost pending Operation receipt (A23).
  The Previous Runs seam (`run-list-view.tsx`) reopens an `observer-lagged` page in place, keeping older loaded pages (#306).
- `submitAndSettle` recovers lag and temporary disconnection, but shutdown/subject loss ends a pending receipt with unknown effects (#310), never a reopen or success.
- Read [tui-workbench](../../docs/agents/tui-workbench.md) before changing the Run Workbench's layout, bottom interaction, key routing, prompt, drafts,
  confirmations, dialogs, or details panel.
- `start-run-views.tsx` holds Start a Run's step components and leaves; the draft signal, step transitions, and refusal routing stay in `start-run.tsx` (A3).
  Each step owns its transient UI state and its own `useBindings`, and `ReviewStep` opens the `launch-preparation` Projection directly (#231 A16).
- `previous-runs.tsx` is the Previous Runs screen reached from Home.
- `clip.ts` is the ellipsis affordance above, `wrap.ts` its wrapping counterpart, and `bundle-format.ts` holds the Bundle-catalog status wording — keep
  it matching `headless/render.ts` so the TUI and headless surfaces say the same thing about the same fact.
