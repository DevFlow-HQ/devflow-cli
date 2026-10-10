# Run Store conversation records

Read before changing Turn admission, settlement, event payloads, or transcript migration and reads.
The [Run Store notes](../../src/run/store/AGENTS.md) keep ownership and fencing rules.

- Harness Turn records (#116): `admitTurn` writes the `turn` row **before** the stdin frame is sent (the durable admission the Adapter awaits) — it upserts the
  named Session `open` and a first conversation row referencing the exact Turn input in one transaction. A fenced owner refuses it, proving `not-started` before stdin.
- `settleTurn` is immutable: it no-ops once the `turn` row's `result_kind` is set, so a second settle rewrites neither the result nor the Session availability.
  Its optional Failure evidence and diagnostic share that guarded transaction, including the immutable no-op (#532).
  `turn_event`s append only. The Attempt's `effective_model` is set through `publishAttempt` (the `attempt` row is written after the Turn settles), never through `settleTurn`.
- Turn `kind` (#126): `admitTurn` records the Secant Step kind that produced the Turn — `agent` or `interactive-agent` — in the nullable `turn.kind` column, Secant-owned
  durable truth independent of `origin` (`managed`/`human`). The column is nullable so a row admitted before it existed reads its kind back **null** (undefined in
  `TurnRecord`) — a legacy row whose kind is genuinely unknown, never fabricated to a guess.
- Turn request (ADR 0034): `admitTurn` writes the requested Model choice into the nullable, free-text `turn.requested_model`/`requested_effort`, null for
  no request and on older rows; `TurnRecord.modelChoice` is present only when a model is stored, and settlement never touches them.
- Conversation ordering (#411): nullable unique `turn_event.transcript_seq` keeps old transcript positions and allocates later ones under the owner fence.
  This is eligibility and retained identity, not first appearance. `transcriptCutoff` reads its current maximum; bounded pages filter by Session,
  cutoff and an exclusive typed order boundary, returning at most `limit` entries plus `hasOlder` from one extra row. Application owns cursors and snapshots.
  Order evidence is Turn sequence, input first, then persisted `historyOrder`, or authoritative migrated transcript position for legacy conversation.
  Unstamped historical facts retain event append-order evidence, counted per row under `coalesce` so reads never scan every `turn_event`;
  Application stamps `historyOrder` on every Turn event it writes except `model` and `agent-call-expired`, which keep append-order evidence (#504).
  Later appends never renumber retained rows; legacy first appearances are never reconstructed.
  `turn-input` stores admitted input with `role: "user"` and `kind: "entry-prompt"` for every `managed` origin, including Agent-step retries and re-sends.
  Human Turn inputs store `kind: "message"`. Earlier stored kinds remain unchanged in transcript pages and exports; Session history derives attribution from origin.
  `legacy-message` retains migrated conversation without invented Turn metadata. Both are excluded from `turnEvents()`.
  Migration validates every old row before transactional drop; orphans fail and rollback preserves old rows/journal. `settleTurn` adds no final copy.
- Turn ordering (#116): `turn.sequence` is `count(turn)` taken under the admit transaction, so it numbers every Turn in the Run regardless of Session.
  Two Sessions' Turns interleave in one numbering.
- The Store owns the shape of every recorded Turn fact (ADR 0023). The schemas in `turn-facts.ts` stay private; the entry exports only the `TurnFact`
  type. Stored `tool-call`, `tool-partial` and `turn-diff` reuse the Harness live types, and a type check in `turn-facts.ts` holds each, less
  `historyOrder`, equal to its live type. Give a stored shape its own type and a translation only when the two must differ.
- `appendTurnEvent` takes a typed `TurnFact`. The Store checks every kind, with its stamped `historyOrder`, against `turnFactSchemas` before writing and
  refuses a malformed fact or unknown kind as `unrecordable`, never a throw. `readTurnFact` is one keyed lookup over the same checks; its map is typed
  so a schema kind without an entry fails type-checking. Previous-release rows read through it unchanged.
- `turn_event.payload` stores the checked value: complete patches, Thoughts, Turn diffs and Steers, preserving first `historyOrder`; output keeps 30,000 characters.
  `tool-partial` retains incomplete running tails. Duplicate starts/partials/terminals/Thoughts/Turn diffs are ignored; only conversation entries
  get transcript positions.
