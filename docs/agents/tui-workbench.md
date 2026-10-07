# Run Workbench Interaction

Read this before changing the Run Workbench's layout, bottom interaction, key routing, prompt, drafts, confirmations, dialogs, or details panel. It was
carved out of [the presentation Module's notes](../../src/tui/AGENTS.md), which keep the general OpenTUI layout invariants and the rule that the Workbench
alone takes its keys, size, and resize from the Renderer Port; the Application side of the controls it dispatches is in [run-control](./run-control.md).
[ADR 0036](../adr/0036-the-run-workbench-mirrors-the-agent.md) and [ADR 0040](../adr/0040-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md)
decide the screen and its routes.

## One bottom interaction

- `interaction` (`run-workbench.tsx`, H1 #419) resolves one closed value — `request`, `gate`, `checkpoint`, `finished`, or `prompt` — in that precedence: a
  Harness Request before a Human Gate or Review checkpoint, then the Run's authoritative terminal state from the snapshot, then the ordinary prompt. Bottom-row
  accounting (`interactionRows`), the render `<Switch>`, focus effects, the key dispatcher, the prompt's hints, and the App commands the Workbench registers
  all read it. Never re-derive precedence from Offers or flags beside it. The `prompt` variant also carries the Step endings on offer (none while a Turn
  works or an Operation is in flight), so keys, hints, and palette agree, and what a gate or checkpoint without a current Offer waits on.
  Dialogs are a separate layer above it, never a bottom variant.
- The request and gate controls keep their private state and key branches (`run-request-control.tsx`, `run-gate-control.tsx`); the interaction only decides
  that one holds the bottom. A free-text gate is `gateHeight()` rows, 5 with authored suggestions (#213), whose `up`/`down` its control takes. An authored
  approve-reject gate keeps its headless path and shows only as the prompt's note, as does a checkpoint whose answer Offer is not current.
- There is no header. Above 120 columns the 42-column `Sidebar` carries the Bundle, the state in words, the Steps by glyph, the current Step's Session (its
  plain name carries any Iteration), Harness, Model choice beside a differing observed model and any requested change still pending, and reported
  context. At 120 or less the prompt's meta row carries Step, Session, and Model choice, and the two #418 metadata slots sit above the bottom region.
  Notices (Problem, conflict, view freshness, Operation receipts and refusals, Model choice messages) lead the conversation column and are counted; one
  status row under it carries the paused badge.
- `PromptModel`/`promptHeight` (`run-workbench-views.tsx`) count exactly what `PromptControl` draws: a note, one field row per draft line up to four, the meta
  row, wrapped refusal and recovery notices, and the hint rows. An armed Step ending or Interrupt confirm wraps its whole captured consequence, so the count grows with it.

## Keys and native input

- The prompt and the free-text gate mount native OpenTUI fields (D9), not hand-rolled buffers. OpenTUI delivers a keypress to the global `keyInput`
  listeners **before** the focused renderable, and the production Renderer Port adapter (`renderer/renderer.ts`) is such a listener, so the Workbench
  dispatcher always runs first. It claims only command keys and lets every other key reach the field, which owns text, cursor motion, word deletion, paste,
  and punctuation. We do **not** call `stopPropagation` (the Port key carries no such method, A16): instead the field is blurred whenever a dialog, a
  confirmation or focused details holds the keys, so a confirming `y` never types. A pending send never blurs the ordinary prompt.
- The prompt is a `<textarea>` with Enter bound to `submit`, so only the dispatcher sends; Shift+Enter and Ctrl+J insert newlines. The Port key carries `shift`,
  so the dispatcher never treats Shift+Enter as Enter. The textarea owns its text after mount: write back only a changed draft (a clear, a restore).
- Keys (ADR 0036/0040): Enter sends at a Turn boundary and steers a working Turn; Esc Esc Interrupts; Ctrl+E is End Step only; Ctrl+N Continue; Ctrl+O
  expands the first visible detail; Ctrl+G details; Ctrl+P the palette; Ctrl+R reconnects a disconnected view, else retries a failed appearance save; Ctrl+C
  clears a nonempty draft, then requests guarded Quit. End Stage has no key. No bare letter is a Workbench command beside the prompt. Alt+arrows/Home/End and
  PageUp/Down scroll history; native arrows/Home/End edit. A focused checkpoint keeps navigation keys and the wheel; Esc at a Turn boundary leaves.
- Every key clears the two-press Interrupt arm on arrival; only the prompt's Esc reads the arm it found, so dismissing a dialog, details, or inspection, or
  answering a request or gate, never arms or dispatches it. A withdrawn or replaced Turn Offer, or any interaction but the prompt, clears it too, and the
  next Esc after such a clear is consumed, so an Esc pair straddling the Turn's end never leaves. Ctrl+C clears a nonempty draft whatever holds focus.
- The working scanner (`working-scanner.tsx`, #292) leads the prompt's hint only while a Turn works: `working · esc esc interrupt`, or `enter steer · esc esc
interrupt` while Steer is available. Its words carry the meaning, so the cells yield first on a narrow row; `reducedMotion` draws a static `[⋯]`. A refusal
  sits above the hint rather than replacing it. An applied Operation receipt leaves on the next key, which keeps its recipient.

## Drafts and restoration

- The draft belongs to a semantic input target: the current Step, plus the Attempt a follow-up names (never a parsed Turn id). A different Step, or a
  follow-up for another Attempt, resets only the departed draft; a follow-up first naming the steered Step's Attempt keeps it. Requests, unrelated updates,
  resize, and catch-ups keep the draft and focus. Each newly interrupted Turn's follow-up refocuses the prompt. After an Interrupt the prompt's note says
  the agent waits on the person: the follow-up's, or an interactive Step's until a later Turn settles.
- Enter captures and clears sent Turn, follow-up and Steer text immediately (#420); admission never clears newer typing. The field stays editable.
  A still-pending capture cannot be dispatched twice. A pending Steer holds a second Steer or boundary send back without freezing native editing.
  Step-ending confirmations own a separate receipt. An unavailable Steer shows its Offer's reason only at Enter.
- Refused receipts and Interrupt drops share one ordered restore before unsent text, separated by a single newline. Earlier pending captures hold later
  restores back. Restored captures keep their order across later restores while native edits preserve the restored prefix; edits to that prefix make it
  ordinary draft text. Every capture restores once, even if both a refusal and a drop are observed. Late Steer refusals say that text returned to the draft.
- Restoration is bound to the captured Step and known follow-up Attempt. Old-target text stays out of a replacement draft and remains saved behind a
  counted notice and Ctrl+P's `Recover unsent text`. Only that command moves it into the current draft. Distinct bottom controls instead offer
  `Copy unsent text` through the terminal clipboard; unavailable clipboard support leaves text saved. Automatic restores preserve details or dialog focus.
- Interrupt drops wait for the live Turn and pending receipts to leave (#356). Full text comes from `RunTimelineEvent.steer`, never its capped `detail`.
  Steer receipts carry their opaque Operation id to match durable `steerId`, including identical-text retries and different Attempts.
  Captured send order wins; uncaptured drops retain recorded order. Opening old history and repeated snapshots never restore twice. Restore only into an
  interactive Step's prompt or an Agent Step's follow-up (#354); a signal-halted Agent Step's same-target drops stay history.

## Confirmations, details, and dialogs

- One `arm` path serves keys, palette commands, and focused details. Every confirmation captures its Offer and dispatches it only after checking its
  semantic target against the current Offer (#389): Step endings compare Run and Step, Interrupt Run and Turn, resume its takeover owner and
  acknowledgement. Replacement or withdrawal clears the arm; reappearance needs a fresh arm; unchanged targets keep the original consequence. A request,
  gate, or checkpoint that takes the bottom clears every armed confirmation.
- Step endings (End Step, Continue, End Stage) confirm in the prompt's hint and leave with the prompt. Lifecycle actions confirm in the details panel and
  drop when it hides: resume dispatches at once unless its Offer carries a takeover (names the owner process) or an acknowledgement (#194 story 39); an
  unavailable resume shows its reason and `r` no-ops. `c`/`x` act only while the inline panel shows.
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
  History ids survive wrapping/settlement. Ctrl+O opens first visible detail; click opens its row. Output/Thoughts toggle; supplied diffs open uncapped inspection.
  History-only observer loss is visible and reconnectable; reopening issues fresh ids and resets the viewport. Workflow facts follow their Turn, including equal-time ties.

## Read next

- `run-inspection.tsx` owns bounded artifact/output inspection; `run-transcript.tsx` owns the details-opened retained Session reader (#421).
  Its Resource entry id anchors an offset relative to the role header; leading dividers have negative offsets, so newly attached dividers preserve content.
  Resize clamps only within the entry; read notices stay outside content. Only this reader pages older: `p` preserves position, including failed retries.
  Up at the top also loads older. Export (`e`) reads the complete Reference only on demand and queues text to the terminal clipboard, naming refusal.
  `run-workbench-views.tsx` holds the Workbench's pure presentational leaves and the prompt's row model; state, focus, the resolved interaction, and the key
  dispatcher stay in `run-workbench.tsx` (A12).
