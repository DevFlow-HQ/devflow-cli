# Workbench compose and drafts

Read before changing Workspace path completion, Slash discovery, prompt captures, or draft restoration.
[Workbench interaction](./tui-workbench.md) owns bottom precedence, keys, and confirmation targets.

## Workspace path completion

- `searchWorkspacePaths` filters ignores/dots/symlinks and returns ten paths; unavailable leaves text sendable. It reads no candidate content.
- `workspace-mentions.ts` keys replies by Run, draft and caret. Its stable token signal survives query edits; closing or replacing the token aborts it (#484).
  The latest query receives bounded progressive matches; stale progress and settled replies are discarded independently. Known Slash names suppress mentions.
- Selection requires visible rows. A one-row list puts the cap cue in its hint; with no list rows, the ordinary prompt hint and confirmations take priority (#484).
- Enter/Tab edits only the native token: quote whitespace, hashes and quotes, retain only trailing `#L<n>`/`#L<n>-<m>` file ranges,
  slash folders without ranges. Escape keeps text; arrows leave the cursor still.
- Requests/gates have no list. Rows share `PromptModel`; key capture and native-arrow ownership require drawn list rows, including after resize.
  A hidden list leaves Enter and Escape with the prompt and hides its insert hint. Acknowledge native replacements so remount cannot replay them.

## Slash discovery and dispatch

- The catalog retains registered command identities with availability; `entries()` hides unavailable entries, and `knownSlash` recognizes their first word
  and aliases even then. Names ignore leading whitespace and case, matching the Harness-input protection's breadth without copying Harness rules.
- Discovery requires first-character `/` and no whitespace. It uses shared catalog search and initially highlights only a name prefix. Up/Down selects,
  Enter/Tab resolves the current registered entry and runs its `run`. A withdrawn selection never silently chooses another command. Esc dismisses the list
  and keeps text before Interrupt or leave; Tab runs a highlighted entry before details focus. Paths without a highlight keep ordinary Enter send/Steer.
- The native textarea maps Up/Down to inert `submit` while discovery owns arrows. The Port alone moves the list; native delivery never moves the cursor.
  Known unavailable names and inline arguments show a refusal and keep text. Unknown words and paths use unchanged Application send/Steer admission.
- Successful invocation clears the command draft before its owner runs. The list joins `PromptModel` row accounting, clips by display columns, and bounds
  its visible window around the selection. Pending receipts keep discovery available. Requests, gates, checkpoints, dialogs, and confirmations suppress
  discovery; Ctrl+P retains its permitted scope.

## Drafts and restoration

- The draft belongs to a semantic input target: the current Step, plus the Attempt a follow-up names (never a parsed Turn id). A different Step, or a
  follow-up for another Attempt, resets only the departed draft; a follow-up first naming the steered Step's Attempt keeps it. Requests, unrelated updates,
  resize, and catch-ups keep the draft and focus. Each newly interrupted Turn's follow-up refocuses the prompt. After an Interrupt the prompt's note says
  the agent waits on the person: the follow-up's, or an interactive Step's until a later Turn settles.
- Enter captures and clears sent Turn, follow-up and Steer text immediately (#420); admission never clears newer typing. The field stays editable.
  A cleared capture cannot be dispatched twice; deliberately retyping identical text creates a new send. A pending Steer holds a second Steer
  or boundary send back without freezing native editing.
  Step-ending confirmations own a separate receipt. An unavailable Steer shows its Offer's reason only at Enter.
- Refused receipts and Interrupt drops share one ordered restore before unsent text, separated by a single newline. Earlier pending captures hold later
  restores back. Restored captures keep their order across later restores while native edits preserve the restored prefix; edits to that prefix make it
  ordinary draft text. Every capture restores once, even if both a refusal and a drop are observed. Late Steer refusals say that text returned to the draft.
- Restoration is bound to the captured Step and known follow-up Attempt. Old-target text stays out of a replacement draft and remains saved behind a
  counted notice and Ctrl+P's `Recover unsent text`. Only that command moves it into the current draft. Distinct bottom controls instead offer
  `Copy unsent text` through the terminal clipboard; unavailable clipboard support leaves text saved. Automatic restores preserve details or dialog focus.
- Interrupt drops wait for the live Turn and pending receipts to leave (#356). Full text comes from `RunTimelineEvent.steer`, never its capped `detail`.
  The private draft controller owns every clear and its restore note, and saves a finished Run's typed draft for Copy.
  Steer receipts require their opaque Operation id to match durable `steerId`, including identical-text retries and different Attempts.
  Captured send order wins; uncaptured drops retain recorded order. Opening old history and repeated snapshots never restore twice. Restore only into an
  interactive Step's prompt or an Agent Step's follow-up (#354); a signal-halted Agent Step's same-target drops stay history.
