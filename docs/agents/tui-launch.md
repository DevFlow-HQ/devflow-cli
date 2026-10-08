# Start a Run presentation

Read before changing Start a Run fields, focus, launch assessment, or refusal routing.
The [presentation notes](../../src/tui/AGENTS.md) keep general layout and key rules.

- A focused `<textarea>` loses `up`/`down`/`return` to the keymap too, so Start a Run's text box (`launch-text-box.tsx`, #287) takes Up/Down through
  its `moveLine` handle (visual row is `scrollY + visualCursor.visualRow`). It fires `onContentChange` on mount, so it reports only changed values,
  and it owns its text after mount: never feed the draft back as `value`, or its paste placeholders (virtual extmarks) are wiped.
- Start a Run skips Harness/model for Command-only Bundles; Agent-bearing Bundles use the Harness catalog's worded rows, model declaration, and `preselection`. Review
  opens a
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
- `start-run-views.tsx` holds Start a Run's step components and leaves; the draft signal, step transitions, and refusal routing stay in `start-run.tsx` (A3).
  Each step owns its transient UI state and its own `useBindings`, and `ReviewStep` opens the `launch-preparation` Projection directly (#231 A16).
