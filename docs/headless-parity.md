# Headless Parity

What the Run Workbench (the TUI) offers that the headless `secant` commands do not. Headless is for scripts and CI, so it drives a Run to a resting
state without a human at the keyboard; anything that needs the human inside a live Turn is TUI-only. A gap listed here is deliberate unless its
decision says otherwise; closing one needs its own decision.

| TUI capability                                                                       | Headless                                                                                                          | Decided in                                                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Interactive agent steps                                                              | `run launch` refuses a Bundle whose Routing reaches one ("Interactive agent Steps are TUI-only")                  | [#122](https://github.com/secantdev/secant/issues/122)                                           |
| **Interrupt** a live Turn, leaving the Run waiting on the human                      | none; Ctrl+C is a signal that halts the Run (ADR 0019)                                                            | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| The follow-up message that continues an Agent step after an Interrupt                | none, since headless cannot Interrupt                                                                             | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| **Steer**: a message sent while a Turn is working                                    | none                                                                                                              | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| Per-Session history: identified streaming messages and in-flight rows as they change | none; `run show` and `run read --transcript` read stored rows only                                                | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Change the Model choice of a Run live in another process                             | `run model` refuses `run-live-elsewhere`; changes reach the next Turn of an open Run owned here or not owned live | [#339](https://github.com/secantdev/secant/issues/339)                                           |
| A waiting Steer before it is delivered                                               | none; only a delivered Steer appears in `run read --transcript`                                                   | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Identified Tool, Thought, Turn-diff, and Agent-call rows                             | none; the transcript carries human input, delivered Steers, and settled assistant messages                        | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Reported context, per-model capacity, and distinct total/last usage                  | none; live-only metadata outside conversation history; `run show --json` unchanged                                | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |

Typed **Slash commands** and the Ctrl+P palette are TUI presentation, not a gap: each App command maps to an Operation headless has or to a gap
above ([ADR 0040](./adr/0040-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md)).

The Workbench's headerless layout, its sidebar or prompt meta row, and its one bottom interaction (prompt, request, gate, checkpoint, or finished
outcome) are TUI presentation, not a gap: `run show` prints the same state, Steps, gate, and Model choice facts ([#419](https://github.com/secantdev/secant/issues/419)).

Bundle prompt rules apply to both clients. Build and install refuse authored prompts against all supported Harness rules, including Shipped Bundles.
Launch Preparation and headless launch report a selected-Harness finding with `harness` as its correction; installed Bundles remain usable on a compatible
Harness. Execution checks substituted prompts before Turn admission, failing an Agent Attempt or blocking an Interactive Entry. The missing resting
explanation remains M11's presentation work. Headless still has no compose or typed Slash commands.

Saved theme and dark/light Preferences have headless parity through `settings show` and `settings set` ([ADR 0037](./adr/0037-own-saved-presentation-preferences-in-catalog-and-apply-themes-independently.md)). The TUI Home launcher and app-wide Ctrl+P Themes picker preview all 25 palettes in Dark and Light. Escape restores the active pair on picker entry; a failed save keeps the confirmed appearance and offers retry. Preview and active appearance belong to the TUI; settings changes saved values for a later launch and leaves headless output plain.

The full retained Session transcript opens from focused Details (`Ctrl+G`, then Enter). Its reader alone loads older pages and exports the complete
conversation to the terminal clipboard on demand. `run read <run-id> --transcript [--session <name>]` retains its stored page/export envelopes;
presentation entry identities remain excluded from JSON. The Workbench never pages older history ([#421](https://github.com/secantdev/secant/issues/421)).

The paused Workbench viewport holds an opaque history row id and its displayed-line offset across complete-page replacement, preview settlement,
and the 200-row cutoff. Missing rows fall back by prior content order, nearest first and later on ties, at offset zero; empty and short pages stay
paused. Dividers contribute to row height, and the badge counts rows with any content below the viewport. Wheel or Alt+Up/Down scroll lines,
PageUp/Down half a viewport, Alt+Home oldest, and Alt+End latest. Native prompt editing and modal/details focus keep their keys. These are TUI
reading controls; headless keeps its stored page/export contracts ([#413](https://github.com/secantdev/secant/issues/413)).

Identified tool input, reported counts, and completed/failed/declined/unconfirmed outcomes belong to per-Session history (#414).
`run show --json` retains its generic `tool-activity` timeline mapping for new starts and observed settlements, and reads legacy rows unchanged.
The transcript still excludes tools and command output. Bounded command panels (#415) retain the last 30,000 characters,
with separate Secant/native omission markers and explicit ten-displayed-line expansion. Supplied final output replaces
previews; empty clears them, absent retains potentially incomplete tails. Orderly Turn endings store those tails through
an admitted partial event without adding a headless timeline row. Abrupt crashes keep stored starts/settlements only.
Turn success, Interrupt, loss, and Request answers never create a missing tool result.
Qualified Thought summaries (#417) grow in the TUI's Session history and persist
once at settlement, including known incomplete text. They have no transcript
position, so both headless transcript pages and exports exclude them. The frozen
`run show --json` shape is unchanged. Native qualification currently covers only
OpenAI `gpt-6.1-sol` via Codex; other provider/model pairs, Claude summaries and
native reasoning duration remain evidence gaps. See
[Thought qualification](../tests/harness/message-facts-provenance.md#thought-qualification-2026-10-06).

Observed file facts and supplied patches stay with their calls in Session history (#416). Unassociated cumulative diffs replace
one Turn row and persist once at orderly settlement. Both forms open complete inspection through Ctrl+O or click, without the
command-tail or artifact-line limits. Memory-only cumulative snapshots do not survive a crash. Neither form gains a transcript
position or changes `run show --json`; stored-only headless exclusions above remain in force. Native line totals are currently
unqualified and stay absent. See [file qualification](../tests/harness/tool-facts-provenance.md).
