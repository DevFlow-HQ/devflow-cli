# composition — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Cross-Module ownership and import direction are the policy table's.

## Invariants

- Application receives only normalized Harness registrations and never an Adapter object. `HarnessRegistry` is imported only inside composition, where it
  resolves the selected Harness id to the private Adapter before Run execution.
- Composition constructs the one real Process implementation (`createProcessAdapter`) and injects that instance into Run execution, the Run Store,
  Application's Preflight, and the Harness registry; tests replace it through the wiring overrides, never by a second construction site.
- Composition owns the qualify prepare-then-close pairing: a registration's catalog qualification prepares its private Adapter against the canonical
  launch Workspace and immediately closes it. Only a clean close publishes the captured profile; prepare or cleanup failure crosses as normalized
  unavailability, never an Adapter or prepared Harness (#188).
- `wireApplication` runs the Shipped Bundle startup ensure for both roots, reading the `.wfb` files from the `builtin/` asset directory beside the entry
  module (`import.meta.dirname`, `/$bunfs/root` in the binary); no directory means zero built-ins. Its notices reach headless stderr through
  `HeadlessClients.startupNotices` and Home through the `workspace` Projection (#227).
- `prepareRunHarness` (`wiring.ts`) is the one prepare site for launch, resume, and the interactive reopen: it threads `writableDirectory: owner.workingArea().path`
  and the stored `requestedModel` identically, and an unusable area is a typed `working-area-unavailable` prepare failure, so the Run halts before any Turn rather
  than writing planning files anywhere else (#214). Execution never passes the area itself.
- Composition owns the operational log (`operational-log.ts`, #318): Pino, fenced here by the import policy, writing through a synchronous
  destination on a file opened owner-only through `node:fs`, never a transport or worker. Both client entries run as one Secant invocation under
  `runSecantInvocation`, which starts the sink before `wireApplication` (for the TUI, before the no-TTY rejection) and writes and flushes the
  failure record (write-once; the TUI writes a render failure before draining live Runs) before a throw reaches the CLI host, whose catch names
  the file through `describeFatal`. A log failure is one stderr notice (held until the TUI's terminal is restored) that disables logging and
  changes no outcome, exit code, or stdout.
- `SECANT_HOME` and `SECANT_LOG_DIR` are read once, side by side, in `resolveHostContext` (`wiring.ts`); nothing below composition reads them.
  Records hold only allowlisted semantic fields and causes from `translateCause`; Pino's named-field redaction is a second layer. Tests reach the
  sink through the `logSink` wiring override and never set the environment names. An injected sink defaults to the injected home's `logs`,
  bypassing `SECANT_LOG_DIR`, so an injected clock cannot prune the real process's shared log folder.
- `wireApplication`'s second argument is the Secant invocation's log, passed only by the two client entries; a direct caller logs no lifecycle.
  `runLifecycleObserver` pairs each start with its settlement on the host context's `logClock`, the one clock the sink also reads (#320).
  `applicationObserver` (`application-log.ts`, #319) maps the Application's pre-Run events the same way and hands its `attempt-end` to that
  lifecycle observer, which holds the Attempt's start.
- `OperationalLog.record` maps each event to its level (`recordLevel`): a failed Harness phase, unclean cleanup, or not-ready qualification warns. `harness-log.ts` builds
  each Harness's phase observer and wraps its Adapter so every prepared Harness records its `CleanupReport` on first close and each completed
  Turn's usage: one seam for the qualify, Run, and interactive close sites, a double included. A test Adapter override may be a factory taking
  that observer (#322).
- Startup prunes only matching regular log files strictly older than 30 days in the resolved folder (#323), before opening the active file:
  its real mtime can be stale against an injected future clock. Prune failures are silent; they never call the log-write failure fallback.

## Tests

- Retention uses real files and injected clocks. Locked-file stat/delete failures have no deterministic, spawn-free fixture across all three OSes:
  chmod is ineffective as root and on Windows; the suite covers the unreadable-folder fallback and preserves non-file entries instead.
