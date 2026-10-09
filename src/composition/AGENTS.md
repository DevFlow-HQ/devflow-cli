# composition — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Cross-Module ownership and import direction are the policy table's.

## Invariants

- Application receives only normalized Harness registrations and never an Adapter object. `HarnessRegistry` is imported only inside composition, where it
  resolves the selected Harness id to the private Adapter before Run execution.
- The registry's static rule table serves runtime registrations and `supportedBundleInputRules` for Shipped-Bundle builds (#410), with Application
  owning aggregation. Each Run's `HarnessExecutionDeps` takes the selected entry's rules, independent of its prepared profile or transport.
- Composition alone constructs the real Process (`createProcessAdapter`): the invocation's instance serves Preflight, the Run group's default,
  discovery, and qualification; tests replace it through the wiring overrides, never by a second construction site.
- One Run scope per Run (#333, ADR 0031): `runScope` in `wiring.ts` binds a Process observer and the Harness phase, usage, and cleanup records to
  the Run's `runId`. Its Process goes to Command Steps, the Run's Harness prepare, and (via `processForRun`) the owner's Artifact Git; qualification
  stays unscoped. The Adapter is stateless but for its observer, so each `runScope` call builds an equivalent scope with its own Process rather than
  caching one per Run; an injected `process` instance is shared, so its children carry no `runId`.
- `withWiredApplication` owns partial construction and final disposal (#407). Close both Adapter admissions before Application drain, share one
  five-second initial-cleanup deadline, record reports before stores/log close, and suppress late reporting. Prepared Harness handoffs stay exclusive.
- Composition owns the qualify prepare-then-close pairing: a registration's catalog qualification prepares its private Adapter against the canonical
  launch Workspace, reads its defaults (`readDefaults`, #341), and immediately closes it. Only a clean close publishes the captured profile and
  defaults, and a throwing defaults read is a `prepare-exception` after the close; prepare or cleanup failure crosses as normalized
  unavailability, never an Adapter or prepared Harness (#188). Shutdown closes a held defaults read's Prepared Harness immediately,
  skips defaults after admissions close, and drains pairings within the shared deadline. At the bound, a held close records one unresolved cleanup
  observation before reporting closes; later receipts cannot replace it (#438).
- `wireApplication` runs the Shipped Bundle startup ensure for both roots, reading the `.wfb` files from the `builtin/` asset directory beside the entry
  module (`import.meta.dirname`, `/$bunfs/root` in the binary); no directory means zero built-ins. Its notices reach headless stderr through
  `HeadlessClients.startupNotices` and Home through the `workspace` Projection (#227).
- `prepareRunHarness` (`wiring.ts`) is the one prepare site for launch, resume, and the interactive reopen: it threads `writableDirectory: owner.workingArea().path`
  identically, and an unusable area is a typed `working-area-unavailable` prepare failure, so the Run halts before any Turn rather than writing planning
  files anywhere else (#214). Execution never passes the area itself. Routing and reopened human Turns forward the Run's cancel signal to this preparation (#437).
- Each Step handle composition mints (`interactiveStepDriver`) is registered in the private `heldHarnesses` map, so a `heldStep` the Application hands
  back to `makeRunExecution` (#354) resolves to its prepared Harness without the Application seeing one. The walk reuses it and returns the same handle
  on a `blocked` rest, or closes it; an unregistered handle is closed and a fresh Harness prepared.
- Composition owns the operational log (`operational-log.ts`, #318, #328): builtin JSONL serialization and synchronous `node:fs` writes
  on an owner-only file. Both client entries (and the runner entry below) run as one Secant invocation under
  `runSecantInvocation`, which starts the sink before `wireApplication` (for the TUI, before the no-TTY rejection) and synchronously writes the
  failure record (write-once; the TUI writes a render failure before draining live Runs) before a throw reaches the CLI host, whose catch names
  the file through `describeFatal`. A log failure is one stderr notice (held until the TUI's terminal is restored) that disables logging and
  changes no outcome, exit code, or stdout. Serialization failures use that same fallback; a failed or zero-progress write is never retried.
- Invocation start restricts the home to `0700` before opening the log (#496). A failed or ineffective restriction is one Application startup notice;
  Windows skips restriction. Creation modes never chmod existing files; SQLite owners pre-create new databases before opening them.
- `SECANT_HOME`, `SECANT_LOG_DIR`, and `SECANT_LOG_DETAIL` are read side by side in one function, `resolveHostContext` (`wiring.ts`), which each
  client invocation calls twice (`runSecantInvocation`, then `wireApplication`) against the same environment; nothing below composition reads them.
  Records hold only allowlisted semantic fields and causes from `translateCause`; the recursive named-field scrub is a second layer. Tests reach the
  sink through the `logSink` wiring override and never set the environment names. An injected sink defaults to the injected home's `logs`,
  bypassing `SECANT_LOG_DIR`, so an injected clock cannot prune the real process's shared log folder, and reads detail only from its own `detail`.
- `wireApplication`'s second argument is the Secant invocation's log, passed only by the two client entries; a direct caller logs no lifecycle.
  `runLifecycleObserver` pairs each start with its settlement on the host context's `logClock`, the one clock the sink also reads (#320).
  `applicationObserver` (`application-log.ts`, #319) maps the Application's events the same way: pre-Run events, tracked Operations with their
  `runId`, and each Application-owned `run-rest` as a `run-end` record (#331). It hands its `attempt-end` to that lifecycle observer, which holds the
  Attempt's start.
- `OperationalLog.record` maps each event to its level (`recordLevel`): a failed Harness phase, unclean cleanup, or not-ready qualification warns.
  Initial preparation failure, preparation-cleanup failure, and invocation-cleanup failure also warn (#407);
  `harness-preparation-cleanup` is info only when `closed`, otherwise warn.
  `harness-log.ts` (`prepareRecorded`) hands each prepare its scope's Process and phase observer and wraps the Prepared Harness so it records its
  `CleanupReport` on first close and each completed Turn's usage: one seam for the qualify, Run, and interactive close sites, a double included. A
  test Adapter reads both from the prepare options (#322, #333). The Process observer (`process-observer.ts`, #321) is built per scope, and
  `processFactory` receives the same options, so a double reports child facts too; a child that never ran, timed out, or was force-killed warns.
- Detail checkpoints (#325) map to `debug`: a Preflight check, a Run execution store write, and a phase record carrying a `step`. No observer
  learns whether detail is on; the sink drops detail-off records before serialization or reading the clock. They read no clock, so
  detail-off records, elapsed times included, are byte-identical to a build without them.
- `runRunnerInvocation` (`runner-log.ts`, #326) is the standalone runner programs' log: one `runner` Secant invocation whose `RunnerBreadcrumb`s become
  `runner-*` records (a failed scenario or stage warns) and whose Process options record child facts. The runner passes the folder: it reads
  `SECANT_LOG_DIR` itself, because the folder must outlive the temp root it removes. Runner tests pass a temporary home in the same wiring overrides.
- Startup prunes only matching regular log files strictly older than 30 days in the resolved folder (#323), before opening the active file:
  its real mtime can be stale against an injected future clock. Prune failures are silent; they never call the log-write failure fallback.

## Tests

- Retention uses real files and injected clocks. Locked-file stat/delete failures have no deterministic, spawn-free fixture across all three OSes:
  chmod is ineffective as root and on Windows; the suite covers the unreadable-folder fallback and preserves non-file entries instead.
- Short and zero-progress writes lack a deterministic regular-file fixture across the three OSes; review pins positive progress and immediate shutdown at zero.
  Mocking the syscall would couple the Interface tests to the writer. Linux's `/dev/full` covers write-error shutdown; all OSes cover failed open.
