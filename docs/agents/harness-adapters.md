# Harness Adapter Internals

Read before changing native Adapter internals. [Harness notes](../../src/harness/AGENTS.md) own shared Interface, terminal, recovery and test invariants.
Message/Thought identities and terminal partials follow [native qualification provenance](../../tests/harness/message-facts-provenance.md) (#411).
Tools and file facts follow [tool provenance](../../tests/harness/tool-facts-provenance.md) (#414, #416); preparation follows `preparation-owner.ts` and ADR 0022 (#407).

Before changing Claude Code internals, read [Claude Code Adapter](./claude-code-adapter.md).

Before changing Codex internals, read [Codex Adapter](./codex-adapter.md).

## Required and optional native facts

A fact is required when a Turn cannot run correctly without it: admission and terminal, the final agent message, tool calls, Harness Requests,
Steer, Interrupt, resume, the effective model, and the native shapes that place them in Session history. Codex's model-output item kinds that
prove Steer delivery remain required. Thought summaries, cumulative Turn diffs, context and usage, and live previews of messages, command output
and summaries are optional. Unconsumed facts belong in neither list.

Each Adapter classifies privately beside its check and evaluates every fact. A required failure makes the Harness not ready with a typed reason.
If an optional fact fails format qualification, disable only that fact before a Run; runtime never parses its notification or field. Malformed enabled optional
facts stay absent without failing the Turn. Only person-readable display limits cross the Harness Interface, apart from capabilities. Models or
settings that produce no summary add no limit. See [ADR 0022](../adr/0022-own-a-truthful-deep-harness-seam.md#amendment-2026-10-08-required-and-optional-native-facts).

## Native phases

Each Adapter reports the five phases through `phases.ts`, settling each start once with monotonic elapsed time (#322). Handshake exchanges nest
`HarnessPhaseStep` spans (#325) inside it; composition logs them only in detail mode.

- **Claude Code.** Per-Session `launch` spans bridge start and spawn; close winning abandons it. Fresh init is `handshake`; resumed init is `recovery`,
  including relaunches of Sessions that ran before. Settlement before init fails that phase with the Turn's failure, or abandons it on interruption.
  `control` covers stops, including internal stops after settlement. Native confirmation succeeds; a natural result abandons it, and fallback includes termination.
  Keyless `cleanup` covers close; Session-keyed cleanup covers process stops, admission, relaunch and Windows interrupt reaping. Version has no phase.
- **Codex.** Keyless `launch` spans app-server spawn and `handshake` spans initialize, account and model reads at prepare and replacement. Replacement also
  reports the triggering Session's `recovery` around identity checks, launch and handshake. Handshake steps are `protocol-initialize`, `account-check` and
  `model-list`; the open step shares the handshake outcome, so login refusal fails `account-check`. Turn models are checked before recovery, never at prepare.
  Defaults `config/read` and runtime `thread/read` have no phase. Per Session, `thread/start` is `handshake` and `thread/resume` is `recovery`.
  `control` spans Interrupt and Steer: acknowledgement is ok, except Windows Interrupt waits for terminal confirmation. An expected race abandons it;
  other failures report `control-refused` with the RPC code, `control-timeout`, `control-transport` or `protocol-corruption`. Keyless cleanup covers close,
  including bounded interruption; Session-keyed cleanup covers Windows interrupt reaping.
