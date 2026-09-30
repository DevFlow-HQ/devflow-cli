# Headless Parity

What the Run Workbench (the TUI) offers that the headless `secant` commands do not. Headless is for scripts and CI, so it drives a Run to a resting
state without a human at the keyboard; anything that needs the human inside a live Turn is TUI-only. A gap listed here is deliberate unless its
decision says otherwise; closing one needs its own decision.

| TUI capability                                                        | Headless                                                                                         | Decided in                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Interactive agent steps                                               | `run launch` refuses a Bundle whose Routing reaches one ("Interactive agent Steps are TUI-only") | [#122](https://github.com/secantdev/secant/issues/122)                                          |
| **Interrupt** a live Turn, leaving the Run waiting on the human       | none; Ctrl+C is a signal that halts the Run (ADR 0019)                                           | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) |
| The follow-up message that continues an Agent step after an Interrupt | none, since headless cannot Interrupt                                                            | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) |
| **Steer**: a message sent while a Turn is working                     | none                                                                                             | [ADR 0035](./adr/0035-interrupt-ends-only-the-turn-and-a-mid-turn-message-is-a-native-steer.md) |

Typed **Slash commands** and the Ctrl+P palette are TUI presentation, not a gap: each App command maps to an Operation headless has or to a gap
above ([ADR 0039](./adr/0039-type-app-commands-in-the-compose-and-refuse-harness-reserved-words.md)).

Wider headless parity for the agent screen, including Turn history that grows during a Turn and its frozen `--json` shapes, is still open on
[Chart the fixes Secant needs before its public release](https://github.com/secantdev/secant/issues/235).
