# Headless Parity

What the Run Workbench (the TUI) offers that the headless `secant` commands do not. Headless is for scripts and CI, so it drives a Run to a resting
state without a human at the keyboard; anything that needs the human inside a live Turn is TUI-only. A gap listed here is deliberate unless its
decision says otherwise; closing one needs its own decision.

| TUI capability                                                                            | Headless                                                                                                          | Decided in                                                                                       |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Interactive agent steps                                                                   | `run launch` refuses a Bundle whose Routing reaches one ("Interactive agent Steps are TUI-only")                  | [#122](https://github.com/secantdev/secant/issues/122)                                           |
| **Interrupt** a live Turn, leaving the Run waiting on the human                           | none; Ctrl+C is a signal that halts the Run (ADR 0019)                                                            | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| The follow-up message that continues an Agent step after an Interrupt                     | none, since headless cannot Interrupt                                                                             | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| **Steer**: a message sent while a Turn is working                                         | none                                                                                                              | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md)  |
| Live Turn history: streaming text, live command output, and in-flight rows as they change | none; `run show` and `run read --transcript` read stored rows only                                                | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Change the Model choice of a Run live in another process                                  | `run model` refuses `run-live-elsewhere`; changes reach the next Turn of an open Run owned here or not owned live | [#339](https://github.com/secantdev/secant/issues/339)                                           |
| A waiting Steer before it is delivered                                                    | none; only a delivered Steer appears in `run read --transcript`                                                   | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Tool, Thought, Turn-diff, and Agent-call rows                                             | none; the transcript carries human input, delivered Steers, and settled assistant messages                        | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |
| Reported context, per-model capacity, and distinct total/last usage                       | none; live-only metadata outside conversation history; `run show --json` unchanged                                | [ADR 0039](./adr/0039-grow-a-turns-history-in-place-through-a-per-session-history-projection.md) |

Typed **Slash commands** and the Ctrl+P palette are TUI presentation, not a gap: each App command maps to an Operation headless has or to a gap
above ([ADR 0040](./adr/0040-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md)).

Bundle prompt rules apply to both clients. Build and install refuse authored prompts against all supported Harness rules, including Shipped Bundles.
Launch Preparation and headless launch report a selected-Harness finding with `harness` as its correction; installed Bundles remain usable on a compatible
Harness. Execution checks substituted prompts before Turn admission, failing an Agent Attempt or blocking an Interactive Entry. The missing resting
explanation remains M11's presentation work. Headless still has no compose or typed Slash commands.

Saved theme and dark/light Preferences have headless parity through `settings show` and `settings set` ([ADR 0037](./adr/0037-own-saved-presentation-preferences-in-catalog-and-apply-themes-independently.md)). The TUI Home launcher and app-wide Ctrl+P Themes picker preview all 25 palettes in Dark and Light. Escape restores the active pair on picker entry; a failed save keeps the confirmed appearance and offers retry. Preview and active appearance belong to the TUI; settings changes saved values for a later launch and leaves headless output plain.

The full retained Session transcript opens from focused Details (`Ctrl+G`, then Enter). Its reader alone loads older pages and exports the complete
conversation to the terminal clipboard on demand. `run read <run-id> --transcript [--session <name>]` retains its stored page/export envelopes;
presentation entry identities remain excluded from JSON. The Workbench never pages older history ([#421](https://github.com/secantdev/secant/issues/421)).
