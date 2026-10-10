# Run Workbench Interaction

Read this before changing the Run Workbench's layout, bottom interaction, key routing, prompt, drafts, confirmations, dialogs, or details panel.
[The presentation Module's notes](../../src/tui/AGENTS.md) keep the general OpenTUI layout invariants and the Renderer Port rule; the Application side of
the controls it dispatches is in [run-control](./run-control.md). [ADR 0036](../adr/0036-the-run-workbench-mirrors-the-agent.md) and
[ADR 0040](../adr/0040-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md) decide the screen and its routes.

## One bottom interaction

- `interaction` (`run-workbench.tsx`, H1 #419) resolves one closed value — `request`, `gate`, `checkpoint`, `resting`, or `prompt` — in that precedence: a
  Harness Request before a Human Gate or Review checkpoint, then the Run's authoritative resting state from the snapshot, then the ordinary prompt. Bottom-row
  accounting (`interactionRows`), the render `<Switch>`, focus effects, the key dispatcher, the prompt's hints, and the App commands the Workbench registers
  all read it. Never re-derive precedence from Offers or flags beside it. The `prompt` variant also carries the Step endings on offer (none while a Turn
  works or an Operation is in flight), so keys, hints, palette, and Slash agree, and what a gate or checkpoint without a current Offer waits on.
  Dialogs are a separate layer above it, never a bottom variant.
- `resting` holds every Run at `succeeded`, `failed`, `cancelled`, or `halted` (#528). `restingLines` (`run-workbench-views.tsx`) wraps, never clips, the
  state word with why the Run rests and, for `halted` or `failed`, the Resting cause's next step, then the Run id and keys; the Workbench reserves exactly
  those rows. The words are the Projection's `restingCause` (ADR 0041); a Materialization conflict keeps its own reason. It mounts no field, so typed text
  is never captured, and resume and delete stay in details. A halted Run keeps the Model and Effort commands for its resume; an ended one does not.
- The request and gate controls keep their private state and key branches (`run-request-control.tsx`, `run-gate-control.tsx`); the interaction only decides
  that one holds the bottom. A free-text gate is `gateHeight()` rows, 5 with authored suggestions (#213), whose `up`/`down` its control takes. An authored
  approve-reject gate keeps its headless path and shows only as the prompt's note, as does a checkpoint whose answer Offer is not current.
- There is no header. Above 120 columns the 42-column `Sidebar` carries the Bundle, the state in words, the Steps by glyph, the current Step's Session (its
  plain name carries any Iteration), Harness, Model choice beside a differing observed model and any requested change still pending, and reported
  context and usage in two fixed slots outside history (#418). At 120 or less the prompt's meta row carries
  Step, Session, and Model choice, and the two #418 metadata slots sit above the bottom region.
  Notices (Problem, conflict, view freshness, Operation receipts and refusals, Model choice messages) lead the conversation column and are counted; a
  Problem shows its explanation and remediation, its code only in details' Failure section (#528). One
  status row under it carries the paused badge.
- `PromptModel`/`promptHeight` (`run-workbench-views.tsx`) count exactly what `PromptControl` draws: a note, one field row per draft line up to four, the meta
  row, bounded Slash or Workspace path list rows, wrapped refusal and recovery notices, and the hint rows. An armed Step ending or Interrupt confirm wraps its whole
  captured consequence, so the count grows with it.

## Keys and native input

- The prompt and the free-text gate mount native OpenTUI fields (D9), not hand-rolled buffers. OpenTUI delivers a keypress to the global `keyInput`
  listeners **before** the focused renderable, and the production Renderer Port adapter (`renderer/renderer.ts`) is such a listener, so the Workbench
  dispatcher always runs first. It claims only command keys and lets every other key reach the field, which owns text, cursor motion, word deletion, paste,
  and punctuation. We do **not** call `stopPropagation` (the Port key carries no such method, A16): instead the field is blurred whenever a dialog, a
  confirmation or focused details holds the keys, so a confirming `y` never types. A pending send never blurs the ordinary prompt.
- The prompt is a `<textarea>` with Enter bound to `submit`, so only the dispatcher sends; Shift+Enter and Ctrl+J insert newlines. The Port key carries `shift`,
  so the dispatcher never treats Shift+Enter as Enter. The textarea owns its text after mount: write back only a changed draft (a clear, a restore).
- Keys (ADR 0036/0040): Enter sends at a Turn boundary and steers a working Turn; Esc Esc Interrupts; Ctrl+E is End Step only; Ctrl+N Continue; Ctrl+O
  toggles the bottom-most qualifying visible detail; Ctrl+G details; Ctrl+P the palette; Ctrl+R reconnects a disconnected view, else retries a failed appearance save; Ctrl+C
  clears a nonempty draft, then requests guarded Quit. End Stage has no key. No bare letter is a Workbench command beside the prompt. Alt+arrows/Home/End and
  PageUp/Down scroll history; native arrows/Home/End edit. Checkpoints keep Left/Right choices while modified navigation and the wheel scroll history;
  Esc at a Turn boundary leaves after dismissing an open Slash list.
- Every key clears the two-press Interrupt arm on arrival; only the prompt's Esc reads the arm it found, so dismissing a dialog, details, or inspection, or
  answering a request or gate, never arms or dispatches it. A withdrawn or replaced Turn Offer, or any interaction but the prompt, clears it too, and the
  next Esc after such a clear is consumed, so an Esc pair straddling the Turn's end never leaves. Ctrl+C clears a nonempty draft while drawn;
  compact details and readers request guarded Quit and preserve hidden text.
- The working scanner (`working-scanner.tsx`, #292) leads the prompt hint only while a Turn works.
  The hint reads `working · esc esc interrupt`, or `enter steer · esc esc interrupt` while Steer is available.
  Its words carry the meaning, so the cells yield first on a narrow row; `reducedMotion` draws a static `[⋯]`.
  A refusal sits above the hint. An applied Operation receipt leaves on the next key, which keeps its recipient.

Before changing completion, Slash discovery, drafts, prompt captures, or restoration, read [Workbench compose](./tui-compose.md).

## Confirmations, details, and dialogs

- One `arm` path serves keys, palette commands, Slash commands, and focused details. Every confirmation captures its Offer and dispatches it only after checking its
  semantic target against the current Offer (#389): Step endings compare Run and Step, Interrupt Run and Turn, resume its takeover owner and
  acknowledgement. Replacement or withdrawal clears the arm; reappearance needs a fresh arm; unchanged targets keep the original consequence. A request,
  gate, or checkpoint that takes the bottom clears every armed confirmation.
- Step endings (End Step, Continue, End Stage) confirm in the prompt's hint and leave with the prompt. Lifecycle actions confirm in the details panel and
  drop when it hides: resume dispatches at once unless its Offer carries a takeover (names the owner process) or an acknowledgement (#194 story 39); an
  unavailable resume shows its reason and `r` no-ops. `c`/`x` act only while the inline panel shows.
- Ctrl+G details and Ctrl+O expansion stay reachable during Requests and free-text Gates. Focused details own input and blur the Gate field.
- Ctrl+G opens and focuses details; focused details own `up`/`down`, Enter/`o`, and `r`/`c`/`x`; Esc or Tab returns focus to the bottom control and Ctrl+G
  closes the panel. Below the panel breakpoints a focused resource list replaces the screen. `buildDetailsRows` builds the panel once and the container
  reserves exactly its rows. The Run id and owner process live there; the id shows on screen again only once the Run leaves an active state.
- A dialog with `onKey` takes every key from the Workbench's Port before screen dispatch (#351); the dialog primitive disables its Escape/Ctrl+C keymap layer
  for that entry. Ctrl+P takes the Port path before inspection, requests, and gates. A new request, gate, or checkpoint target closes the palette and the
  Model choice picker, restoring an unconfirmed appearance; a deliberate Ctrl+P may reopen its permitted commands over it, and dismissing returns its keys.
- Model and Effort open the shared picker only from their App commands (the details `m` key is retired), against the `change-model-choice` Offer. Reach comes
  from the Offer while requested and from the Operation receipt once applied; a live change stays pending until observed.
- After shell shortcuts, output inspection and the details-opened Session reader own every key but Ctrl+C. Esc returns to the selected details resource;
  `q` enters guarded Exit (#392). Keep Running preserves the content, scroll, and focus.
- Immediate durable Turn settlement clears the Run control overlay (`reduceRunUpdate`, `run-view.tsx`); a trailing `settling` observation cannot restore it (#412).

Before changing history rendering, scrolling, Ctrl+O, or row inspection, read [Workbench history](./tui-history.md).

## Read next

- `run-inspection.tsx` owns bounded artifact/output inspection; `run-transcript.tsx` owns the details-opened retained Session reader (#421), whose
  anchoring and paging are in [Workbench history](./tui-history.md#rows-and-scrolling).
  `run-workbench-views.tsx` holds the presentational leaves and prompt row model; focus, interaction, precedence and key dispatch stay in
  `run-workbench.tsx` (A12), which asks its private controllers: drafts (`run-draft-control.ts`), history (`run-history-viewport.ts`), and both
  prompt completion lists' state, keys, rows and hint (`run-prompt-completion.ts`).
  History geometry is in [Workbench history](./tui-history.md#rows-and-scrolling).
