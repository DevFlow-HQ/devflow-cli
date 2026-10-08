# Harness Turn control

Read before changing Interrupt, recovery, or Turn cleanup at the Harness Seam.
Native mechanics live in [Harness adapters](./harness-adapters.md).

## Interrupt, recovery, and cleanup

- Codex control timeouts and native RPC errors refuse the call while native terminal truth owns the Turn; unexpected refusals emit a live activity diagnostic.
  A timed-out Interrupt stays sent: retries and Steer are refused, and later connection loss leaves interruption unknown. A native RPC error resets it to idle.
  Refusal alone preserves attachment; malformed responses and transport failures still lose and detach the Turn.
- A Turn settles `interrupted` only on confirmed interruption: a matching native terminal is `active-turn` (Codex; Claude Code since #346), a graceful
  process stop `process-only`. A force-kill, lost connection, or unconfirmed termination settles it `lost` with `interruption-unknown`. Windows has no
  graceful stage ([process notes](../../src/process/AGENTS.md)), so a process stop of a live child there truthfully settles `lost`. The profile's interruption
  evidence states each Harness's stop and its per-OS fallback; the conformance `interruptOutcome` and `recoveryInterruptOutcome` options pin them.
  Windows launch evidence selects confirm-then-reap: close the producer, reap, then settle `interrupted`. EOF cannot erase native truth. Cleanup has its
  own Session-keyed phase; an incomplete reap retains ownership and prevents a duplicate native process.
- Recovery is caller- and history-driven: a relaunch of a Session that already ran, or any Turn carrying `resume`, resumes that exact native conversation.
  A resume the native side does not acknowledge is a `recovery`-phase failure that marks the Session `unusable`; recovery never silently starts a fresh
  conversation. Codex app-server replacement failures leave Sessions detached; only an unacknowledged thread resume makes its Session unusable.
  Each Adapter's resume mechanics are in [harness-adapters](harness-adapters.md).
