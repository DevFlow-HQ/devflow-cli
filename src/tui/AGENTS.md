# tui — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Before changing Start a Run fields, focus, launch assessment, or refusal routing, read [launch presentation](../../docs/agents/tui-launch.md).
- OpenTUI `<text>` lays out multiple children as separate inline spans, which garbles a line (fragments drop or overlap). Give every `<text>` a single
  concatenated string child, not a mix of literals and `{expr}` siblings.
- A flex column with a fixed `height` shrinks overflowing children to fit, corrupting their content rather than clipping. When a screen's content can
  exceed the terminal height, set `overflow="hidden"` on the container and `flexShrink={0}` on the rows/sections so each keeps its full height. A screen
  that owns a bounded `<scrollbox>` still keeps full-height content rows inside it; scroll does not replace the guard.
- A focused OpenTUI `<input>` and the `@opentui/keymap` layer divide keys by binding: any key the keymap binds fires its command even while an input is focused; only
  unbound printable keys and backspace reach the input. So never bind a bare letter key (e.g. `q` to quit) on a text-entry screen, and gate `left`/`right` with a reactive
  `enabled` so choice/verdict fields cycle without stealing a text field's cursor. Native `<input>`/`<select>`/`<textarea>` exist — no need to hand-roll a caret.
- The Run Workbench (`run-workbench.tsx`) is the one screen that takes its keys, size, and resize from the injected Renderer Port (`size`/`onKey`/`onResize`,
  A13) instead of `@opentui/keymap` + `useTerminalDimensions`: a single raw-key pipeline drives every control, so its input and layout are driven by a fake
  renderer in tests. Every other screen keeps the keymap/`useTerminalDimensions` path. Drawing still goes through OpenTUI elements — the Port never carries it.
- History layouts (#441) retain row/value/width/expansion work, release evicted rows, and window visible lines; transcript prepends re-layout only new entries
  and changed divider junctions. `App.observeLayout` measures actual cache misses through the Renderer fixture; height-only resize must reuse the layout.
- Before changing history rendering, scrolling, or row inspection, read [Workbench history](../../docs/agents/tui-workbench.md#history).
- Workbench Step-ending Offers expose Run and Step ids, not an Attempt id. Resume evidence is ownerPid and acknowledgement; Interrupt exposes turnId
  (#389). Confirmation lifecycle rules live in [Workbench interaction](../../docs/agents/tui-workbench.md).
- `follow.ts` alone owns Projection observer health and reconnect ordering. A terminal update preserves last-known state as `disconnected`; explicit reconnect
  crosses `loading` and `catching-up` before `current`. Workbench Operation controls read only current offers, while timeline live-edge remains a separate scroll fact.
- Exactly one screen mounts at a time (`app.tsx`), so a screen's key bindings exist only while it is active and cannot conflict with another's. And
  `useBindings({ enabled })` must be gated off while a dialog overlays a screen (the approval dialog over Home, `home.tsx`), or the overlaid screen's
  bindings fire under the dialog.
- `paddingLeft` on a `<text>` does not indent it; wrap the text in a `paddingLeft` `<box>`, which also keeps its wrapped lines indented (#285).
- `clip()` (`clip.ts`) is the ellipsis affordance, not an overflow guard: call it only on a row that should _advertise_ its cut with a trailing `…` (a
  name, path, or status that can exceed the inner width). It measures **display columns** per whole grapheme (`string-width` over `Intl.Segmenter`, D5),
  and its budget is exact: a `<text>` wraps even a one-column overrun onto a second line, ellipsis and all, despite `overflow="hidden"` (#307).
- A launch resolves at **admission** (`run-launch-view.tsx`): the Run id is known and the Run is observable `running` at once (#98 A7), so the flow reaches
  the Workbench before the Run rests and the Workbench follows the live `run` Projection. Every _other_ write (answer, resume, cancel, delete) follows the
  Application-owned `ProjectionPort.settledOperation` through `submit-and-settle.ts` (#448), because Run settlement can be asynchronous (#98).
  Captured command output is stripped of ANSI escapes with `strip-ansi` and split on `/\r?\n/` in the inspection read path (D4).
- Sanctioned Seam leak (A29): `createProductionRenderer` (`renderer/renderer.ts`) returns an `@opentui/core` `CliRenderer` that composition
  (`composition/tui-runtime.ts`) binds and hands to `mountTui`, so an inferred `@opentui/core` type crosses into composition where the boundary suite —
  which reads only import specifiers — cannot see it. Deliberate and ADR 0018-sanctioned: Solid's `render(node, renderer)` mounts onto that object while
  the Renderer Port keeps lifecycle. Recorded here because the check is blind to it.
- The quit confirmation (`app.tsx` `GuardedExitProvider`/`QuitConfirmation`) lives on the vendored dialog stack, not a bare `<Show>` overlay: every screen's bindings are
  gated `dialog.stack.length === 0`, so being on the stack is what makes it modal (else `q`/`return` fire the underlying screen too). Escape/Ctrl+C dismissal comes from
  the
  dialog primitive. Route's approval-clear effect is a one-shot guarded on an `approvalOpen` signal so it never clears the quit dialog, and the approval dialog's
  `onClose`
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

- Use `resizeWorkbench` to resize both the captured terminal and injected Renderer Port; other screens resize the captured terminal directly.
- Exercise screens in-memory over fake Projection snapshots with `mountRenderer` (`tests/tui/renderer-fixture.ts`), backed by `@opentui/solid` `testRender`.
  Its shared after-test cleanup owns renderer destruction. Assert content, key dispatch, and small-width/resize relayout without overflow.
  A lone Escape is held briefly by OpenTUI key disambiguation: poll in real time, not by frame count.
- The working scanner's drawing leaf (`working-scanner.tsx`) is unexported (topology's fenced-package rule, #308); only its plain frame model is.
  Its colours are asserted in `run-workbench-appearance.test.tsx` against the Workbench's own `captureSpans` colours, which couples them to the prompt bar's
  accent and the meta row's muted role.

## Read next

- `app-commands.tsx` retains known names and aliases even when unavailable; its `entries()` exposes available commands to Home, Ctrl+P, and Slash.
- `ShellCommands` disables its keymap bindings while `portDriven` or a dialog is open. Workbench shell keys use its Renderer Port dispatcher;
  dialogs take Port keys and geometry. Other screens keep keymap bindings. Picker cancellation restores entry appearance; confirmation applies before saving.
  `preferences-view.ts` generates a fresh Operation id on every save or retry.
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
  (`submitAndSettle`) maps admission and the Port's settled receipt to reactive outcomes (#448).
  The Previous Runs seam (`run-list-view.tsx`) reopens an `observer-lagged` page in place, keeping older loaded pages (#306).
- Application ends pending settlement waits at shutdown with `operation-observation-ended` and unknown effects; TUI presents the returned Problem (#448).
- Read [tui-workbench](../../docs/agents/tui-workbench.md) before changing the Run Workbench's layout, bottom interaction, key routing, prompt, drafts,
  confirmations, dialogs, or details panel.
- `previous-runs.tsx` is the Previous Runs screen reached from Home.
- `clip.ts` is the ellipsis affordance above, `wrap.ts` its wrapping counterpart, and `bundle-format.ts` holds the Bundle-catalog status wording — keep
  it matching `headless/render.ts` so the TUI and headless surfaces say the same thing about the same fact.
