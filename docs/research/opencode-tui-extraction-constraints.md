# OpenCode TUI Extraction And Maintenance Constraints

## Answer

An OpenCode-derived Crucible TUI is feasible only as a maintained extraction,
not as a package dependency or a skin over DevFlow's current state. The renderer,
Solid composition, themes, keymaps, dialogs, transcript/tool presentation, and
test renderer are reusable. The application shell, state projections, commands,
and many ostensibly presentational components are coupled directly to OpenCode's
SDK types, event vocabulary, operations, globals, and Bun runtime.

The lowest-risk direction is a pinned vendor/fork with an explicit Crucible-owned
state/command port and a Bun packaging decision made up front. Do not reproduce
the OpenCode SDK merely to avoid changing components unless Crucible intentionally
adopts OpenCode's Session, Message, Part, Provider, Agent, Permission, Question,
Project, Location, and Workspace semantics. Do not begin a production extraction
until a narrow prototype proves lifecycle cleanup and native-asset packaging on
Windows, macOS, and Linux. This research does not build that prototype.

## Evidence Boundary

OpenCode facts below are pinned to local checkout commit
[`38e10eb1408feb700021b8e8766fb0ab41bf84e2`](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2)
(`origin/dev`, committed 2026-08-08). Only the extraction specification, TUI
package, its state and lifecycle seams, both hosts, focused tests, build/release
metadata, and license metadata were inspected.

Evidence labels have precise meanings:

- **Current fact**: observed in the pinned OpenCode checkout or a named first-party
  dependency source.
- **Historical intent**: a stated OpenCode extraction goal; it is not treated as
  proof of current conformance.
- **Inference**: a downstream conclusion from current facts.
- **Unknown**: not established by the inspected sources and requiring a prototype,
  legal review, or release validation.

OpenTUI package facts are pinned where possible to the source commit for its
`v0.4.5` tag,
[`0c8c4f7cff2927e3df63a9757a45eff9a343611c`](https://github.com/anomalyco/opentui/tree/0c8c4f7cff2927e3df63a9757a45eff9a343611c).
Current first-party documentation is identified as such where it describes a
newer or evolving runtime path.

## Package And Ownership Reality

### Historical intent

OpenCode's completed extraction specification describes one canonical package,
an SDK-only OpenCode domain boundary, no dependency on `@opencode-ai/core`, thin
CLI adapters, package-owned renderer lifecycle, and cleanup on normal exit,
interruption, startup failure, and destruction. It also assigns server startup,
signals, build wiring, worker embedding, and upgrade/install metadata to hosts.
See the pinned
[`specs/tui-package.md`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/tui-package.md#L16-L31),
[ownership boundary](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/tui-package.md#L54-L90),
[lifecycle section](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/tui-package.md#L430-L476),
and [invariants](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/tui-package.md#L561-L578).

### Current facts

- `@opencode-ai/tui` is `private: true`. It exports TypeScript/TSX source, not a
  compiled distribution. Its internal dependencies use `workspace:*` and its
  third-party versions use the root-only `catalog:` protocol. It is therefore not
  an independently consumable npm artifact. See
  [`packages/tui/package.json`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/package.json#L1-L72).
- Contrary to the completed-state specification, the manifest directly depends
  on `@opencode-ai/core`. Current TUI source imports Core for globals, flags,
  installation version/channel, globbing, executable discovery, and file locking.
  Examples include
  [`app.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/app.tsx#L1-L8),
  [`context/sdk.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/sdk.tsx#L1-L5),
  [`context/theme.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/theme.tsx#L27-L28),
  and [`context/kv.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/kv.tsx#L1-L6).
- The package root exposes only `run` and `TuiInput`, but the manifest exposes many
  additional state, runtime, plugin, and UI subpaths used by OpenCode hosts. This
  is a narrow root API atop a broad source-level package surface, not a stable
  downstream compatibility promise. See
  [`src/index.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/index.tsx)
  and the [exports map](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/package.json#L12-L49).

### Inference

Crucible cannot safely add `@opencode-ai/tui` to `package.json`. It must either
vendor a pinned source snapshot, maintain a fork, or extract selected modules into
a Crucible-owned package. Any of these options owns dependency resolution, build
transforms, assets, API adaptation, and upstream merge work.

## Renderer Lifecycle And Terminal Cleanup

### Current facts

`Tui.run` is an Effect scope with the following lifecycle:

1. It acquires `createCliRenderer(...)` and registers `destroyRenderer(renderer)`
   as the release action.
2. It disables Windows processed input, installs and scopes the OpenTUI keymap,
   and registers plugin and audio finalizers.
3. It installs a scoped `SIGHUP` listener that destroys the renderer.
4. The renderer's one-shot `destroy` event completes a deferred shutdown signal.
5. Application exit also destroys the renderer. Once destruction is observed,
   the Effect scope closes, then Windows input is flushed and any error or
   epilogue is printed.

The implementation is in
[`app.tsx` lines 186-363](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/app.tsx#L186-L363).
`destroyRenderer` clears the terminal title before an idempotency check and
destruction; focused unit tests cover both live and already-destroyed renderers.
See
[`util/renderer.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/util/renderer.ts)
and
[`util/renderer.test.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/test/util/renderer.test.ts).

The lifecycle integration test proves that `SIGHUP` clears the title, destroys
the renderer, disposes the plugin host once, and removes its added listener. A
second test proves that app exit prints the session epilogue after scoped cleanup.
It does not cover every required exit path. See
[`app-lifecycle.test.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/test/app-lifecycle.test.tsx).

OpenTUI's current first-party lifecycle documentation states that the application
must call `renderer.destroy()`, preferably in the same `try/finally` control flow
as startup. Destruction removes listeners and loops, destroys renderables,
restores raw mode and terminal state, flushes output, and frees native resources.
It also warns that `process.exit` and unhandled errors do not automatically clean
up. See [OpenTUI lifecycle and cleanup](https://opentui.com/docs/core-concepts/lifecycle).
Solid cleanup functions run when their owning reactive scope is disposed; see
Solid's first-party [`onCleanup` reference](https://docs.solidjs.com/reference/lifecycle/on-cleanup).

Windows has additional, split ownership. The TUI's statically imported
[`terminal-win32.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/terminal-win32.ts)
uses `bun:ffi` to clear and flush console input. The legacy host additionally
installs a polling/raw-mode guard, restores the original console mode in `finally`,
and stops its worker in an inner `finally`; see
[`packages/opencode/src/cli/cmd/tui.ts` lines 189-305](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/cli/cmd/tui.ts#L189-L305).
The newer host calls the same TUI but does not install that guard; see
[`packages/cli/src/tui.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/cli/src/tui.ts).

### Unknowns the prototype must resolve

- Cleanup on Ctrl-C, `SIGTERM`, startup rejection, render rejection, thrown plugin
  startup, transport failure, and an unhandled exception.
- Whether repeated mount/exit cycles leave signal listeners, timers, raw mode,
  mouse mode, title, cursor state, alternate-screen state, or native resources.
- Whether Crucible needs the legacy Windows Ctrl-C guard and whether its initial
  console mode is restored after every failure path.
- Cleanup behavior in real terminals and PTYs, not only the in-memory renderer.

Failure of any cleanup check is a release blocker. A broken terminal after exit is
not an acceptable degradable behavior.

## Domain, State, And Transport Coupling

### The useful seam

`TuiInput` accepts `url`, optional `directory`, custom `fetch`, headers, and an
optional event source. `SDKProvider` constructs the OpenCode client around those
inputs, or consumes the injected event source instead of opening its own global
SSE stream. It aborts transport, timers, and handlers on Solid cleanup. See
[`TuiInput`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/app.tsx#L142-L152)
and
[`context/sdk.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/sdk.tsx).

This is a real transport seam. It permits an in-process worker, HTTP server,
authenticated daemon, deterministic test transport, or an OpenCode-compatible
service without changing the renderer.

### The non-generic state seam

The provider tree mounts `SDKProvider`, `ProjectProvider`, legacy `SyncProvider`,
V2 `DataProvider`, and OpenCode-specific Permission, Location, and Local providers
inside the application root. See
[`app.tsx` lines 296-335](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/app.tsx#L296-L335).

- `SyncProvider` stores and bootstraps OpenCode providers, agents, config,
  sessions, messages, parts, tools, permissions, questions, LSP, MCP, formatter,
  VCS, workspace, and console state. It projects legacy event names directly and
  performs OpenCode SDK operations during event handling and bootstrap. See
  [`context/sync.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/sync.tsx).
- `DataProvider` is a second, V2-specific projection over `SessionV2Info`,
  `SessionMessage`, location catalogs, and fine-grained prompt, step, text,
  reasoning, shell, and tool events. See
  [`context/data.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/data.tsx).
- `ProjectProvider` resolves OpenCode project paths and directories and models an
  experimental OpenCode Workspace with status, placement, and sync operations.
  It is not a generic harness selector. See
  [`context/project.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/context/project.tsx).

Presentation and operations are not cleanly separated. Session routes directly
invoke fork, abort, revert, summarize, background-session, permission, and
question SDK methods; prompt and dialog components invoke session, filesystem,
workspace, provider-auth, VCS, and project-copy operations. Representative
examples are
[`routes/session/index.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/routes/session/index.tsx),
[`routes/session/permission.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/routes/session/permission.tsx),
and
[`component/prompt/index.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/component/prompt/index.tsx).

### Reuse classification

**Reusable with low-to-moderate adaptation:** OpenTUI renderer configuration,
Solid component composition, layout/UI primitives, keymap mechanics, dialogs,
themes after provenance review, generic error/presentation utilities, generic
tool fallback rendering, transcript layout, and the in-memory behavior-test
approach.

**Reusable only behind a Crucible port:** session transcript components, prompt
submission, model/agent selection, tool status, permissions/questions, session
navigation, local persistence, editor/clipboard behavior, plugin slots, and
attention handling. These combine valuable UX with OpenCode state or runtime
assumptions.

**Replace rather than emulate:** `SDKProvider`, `SyncProvider`, `DataProvider`,
`ProjectProvider`, OpenCode routes/commands, provider authentication, MCP/LSP/VCS
status, upgrade UI, Workspace management, and OpenCode plugin installation.

### Inference

The correct generic seam sits above the state/provider tree. A selected Crucible
harness should supply a normalized snapshot/event/command port and remount its
session subtree when selection changes. The port should expose only concepts
Crucible actually owns. It should not label an OpenCode Workspace as a harness or
mirror every OpenCode SDK method.

## Bun, Node, OpenTUI, And Solid Constraints

### Current OpenCode facts

- OpenCode pins Bun `1.3.14`; the TUI extends the Bun TypeScript config, tests with
  `bun test`, and preloads `@opentui/solid/preload`. OpenTUI/Solid TSX therefore
  depends on a nonstandard transform step. See the root
  [`package.json`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/package.json#L1-L8),
  TUI [`tsconfig.json`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/tsconfig.json),
  and [`bunfig.toml`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/bunfig.toml).
- Production TUI source uses `Bun.file`, `Bun.write`, and `Bun.stringWidth`; it
  statically imports `bun:ffi` for Windows and `bun:sqlite` for Zed integration.
  Examples are
  [`util/persistence.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/util/persistence.ts),
  [`prompt/display.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/prompt/display.ts),
  [`terminal-win32.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/terminal-win32.ts),
  and
  [`editor-zed.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/src/editor-zed.ts#L1-L7).
- DevFlow currently publishes a Node CLI with `node >=18` and builds through
  `tsup`; see DevFlow's `package.json`. The current TUI cannot be imported into
  that runtime unchanged.

### OpenTUI/Solid facts

- OpenCode pins OpenTUI core/keymap/Solid `0.4.5` and `solid-js` `1.9.10`; see its
  [root catalog](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/package.json#L33-L45)
  and [Solid pin](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/package.json#L88-L95).
- OpenTUI `0.4.5` is a native Zig renderer with TypeScript bindings. Its core
  manifest declares `bun >=1.3.0`, source entrypoints, and optional native
  packages for Linux glibc/musl, Windows, and macOS on x64/arm64. See the pinned
  [`@opentui/core` manifest](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/package.json).
- The published `@opentui/solid@0.4.5` metadata requires `solid-js 1.9.12`, while
  OpenCode's catalog pins and patches `1.9.10`. Treat OpenCode's lockfile and patch
  as part of the tested combination; do not independently float these versions.
- OpenTUI's current official docs describe a Node path, but it is not a drop-in
  alternative: Node `26.4.0`, experimental FFI, permissions, compiled Solid TSX,
  and runtime-specific imports are required. Bun-only preload, build-plugin, and
  runtime-plugin entrypoints do not work in Node. See
  [OpenTUI getting started](https://opentui.com/docs/getting-started),
  [Solid runtime support](https://opentui.com/docs/bindings/solid), and
  [package entrypoints](https://opentui.com/docs/reference/package-entrypoints).
  The pinned `0.4.5` source also runs its Node tests through a Node 26 requirement
  and experimental FFI; see
  [`packages/core/scripts/test-node.ts`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/scripts/test-node.ts)
  and
  [`packages/solid/scripts/test-node.ts`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/solid/scripts/test-node.ts).

### Decision constraint

Crucible must choose one of two real projects:

1. Ship the extracted TUI in a Bun runtime or Bun-compiled executable, preserving
   OpenCode's proven transform and native-asset path while deciding how that
   executable composes with the existing Node CLI.
2. Port the extracted source to Node, replace all Bun APIs and Bun-only entrypoints,
   raise the runtime to the OpenTUI-supported Node line, own experimental FFI and
   asset extraction, and create a Node build/test matrix.

"Keep Node 18 and import the package" is not an available option. A Node port is
larger than a state-adapter prototype and should not be hidden inside it.

## Platforms And Packaging

### Evidence of support

OpenCode's two Bun build scripts enumerate Linux x64/arm64 glibc and musl,
macOS x64/arm64, and Windows x64/arm64, including baseline x64 variants. They
install target OpenTUI native packages before cross-compilation and apply the
OpenTUI Solid transform. The legacy build additionally embeds the parser worker
and defines its Bun filesystem path. See
[`packages/opencode/script/build.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/script/build.ts#L19-L202)
and
[`packages/cli/script/build.ts`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/cli/script/build.ts#L17-L94).

The release workflow uploads macOS/Linux artifacts, signs Windows x64/arm64
artifacts, and publishes the preview CLI artifacts. Unit CI runs on Linux and
Windows, but not macOS; it runs package tests under Bun rather than a matrix of
real terminal emulators. See the pinned
[`test.yml`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/.github/workflows/test.yml#L23-L70)
and
[`publish.yml`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/.github/workflows/publish.yml#L71-L218).

OpenTUI `0.4.5` CI cross-builds native libraries and tests Bun on macOS arm64,
Linux x64, and Windows x64; its Node tests run only on Linux. See the pinned
[`build-core.yml`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/.github/workflows/build-core.yml).
Current OpenTUI docs explain Bun standalone embedding, Linux libc selection, and
Node SEA's explicit native/parser/grammar extraction obligations; see
[standalone executables](https://opentui.com/docs/reference/standalone-executables).
Bun officially supports cross-compiled standalone targets for the same three OS
families and architectures, with Linux libc and x64 baseline distinctions; see
[Bun single-file executables](https://bun.com/docs/bundler/executables).

### What this does not prove

- It does not prove Crucible's artifact works in Windows Terminal, legacy console,
  PowerShell/CMD shells, macOS Terminal/iTerm, Linux VTs, SSH, tmux, screen, WSL,
  or every locale and width implementation.
- It does not prove macOS TUI behavior in OpenCode's unit suite, Node behavior on
  Windows/macOS, or Windows arm64 renderer behavior under an interactive test.
- It does not prove parser workers, grammars, themes, audio, native libraries,
  dynamic plugins, and local persistence survive Crucible's chosen packager.
- It does not establish acceptable binary size, cold start, signing/notarization,
  antivirus behavior, or upgrade behavior.

These remain prototype/release-matrix obligations, not inferred support claims.

## Behavior-Test Seams

The current tests provide a strong starting seam:

- `SDKProvider` accepts deterministic `fetch` and events.
- Sync and Data tests mount real Solid providers, feed typed events, and assert
  reactive projections without a real OpenCode server. See
  [`data.test.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/test/cli/tui/data.test.tsx)
  and
  [`sync.test.tsx`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/tui/test/cli/cmd/tui/sync.test.tsx).
- OpenTUI's in-memory renderer supports frames and deterministic keyboard, mouse,
  clock, and capability inputs without touching the host terminal. See the
  current first-party [OpenTUI testing guide](https://opentui.com/docs/core-concepts/testing).
- OpenCode has focused renderer cleanup and app lifecycle tests, but its package
  test command and fixtures are Bun-specific.

Crucible should preserve behavior at three layers: pure presentation tests over
normalized view models, adapter contract tests over snapshots/events/commands,
and renderer interaction tests over frames and input. Add a fourth, small real-PTY
suite for cleanup and packaged artifacts. Snapshot tests alone are insufficient
for state ordering, command dispatch, and terminal restoration.

## Licensing And Attribution

### Current facts

OpenCode is MIT licensed. The license permits copying and modification provided
the copyright and permission notice are included in all copies or substantial
portions. See the pinned
[`LICENSE`](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/LICENSE).
The TUI, CLI hosts, and plugin manifests also declare MIT. OpenTUI core, Solid,
keymap, and native package metadata declare MIT. Among the TUI's directly named
third-party runtime dependencies, inspected package metadata declares MIT except
`diff@8.0.2`, which declares BSD-3-Clause.

### Required handling

- Preserve OpenCode's MIT notice in a distributed third-party notices file and
  retain source-level provenance for copied substantial portions.
- Record the exact upstream commit, copied paths, local modifications, and update
  date. Do not imply that Crucible is an official OpenCode package.
- Preserve the BSD-3-Clause notice for `diff` if it remains in the distributed
  dependency or bundled output.
- Before release, generate a locked transitive dependency/license inventory for
  the actual artifact, including OpenTUI native packages and embedded assets.
- Separately verify provenance and license terms for copied theme JSON, sounds,
  grammars/queries, fixtures, icons, and any code copied from plugin packages.
  The inspected package-level MIT declarations do not prove each third-party
  themed or generated asset's provenance.

This is an engineering constraint, not legal advice. Final attribution wording
and asset inclusion require the project's normal legal/release review.

## Vendoring, Forking, And Updates

### Options

| Option                                 | Advantages                                                                   | Costs and constraints                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Consume `@opencode-ai/tui`             | Hypothetically least code ownership                                          | Rejected today: private, source-exported, workspace/catalog dependencies, Core coupling, no stable external contract           |
| Compatibility facade over OpenCode SDK | Retains the most upstream code                                               | Requires Crucible to emulate a large OpenCode domain and operation surface; appropriate only for OpenCode-compatible harnesses |
| Vendor a pinned extraction             | Smallest controllable product surface; easy to delete OpenCode-only features | Crucible owns provenance, patches, dependency updates, and manual upstream comparisons                                         |
| Maintain a fork with upstream remote   | Preserves history and makes merges/cherry-picks auditable                    | Larger repository surface and recurring conflict resolution around rapidly changing state/event code                           |
| Rebuild presentation from patterns     | Lowest long-term OpenCode domain coupling                                    | Highest initial UI work and weakest direct upstream update path                                                                |

### Recommendation

Prototype a **pinned, reduced vendor/fork**, not the full SDK facade. Keep an
`UPSTREAM` record with OpenCode commit and path inventory, preserve license
notices, and isolate local changes as a small patch series around a
Crucible-owned port. Pin Bun, OpenTUI, Solid, Effect, and native packages as one
tested set. Review upstream by commit range on a scheduled cadence; selectively
port renderer, accessibility, terminal, and presentation fixes rather than
blindly merging OpenCode domain changes.

Track at least these maintenance signals per update: changed upstream TUI paths,
port contract conflicts, OpenTUI/Solid/runtime version changes, native asset/build
changes, lifecycle changes, behavior-test deltas, license inventory deltas, and
platform smoke results. If update work routinely requires understanding or
merging OpenCode backend semantics, the extraction seam is too shallow.

## Crucible Prototype Contract

The later prototype must answer these questions exactly:

1. **Runtime:** Is Crucible willing to ship Bun/a Bun-compiled artifact alongside
   or instead of its Node CLI? If not, what explicit budget and runtime baseline
   authorize replacing every Bun API and adopting OpenTUI's Node 26 experimental
   FFI/compiled-TSX path?
2. **Port depth:** Can Home, one Session transcript, prompt submission, one generic
   tool call, one approval/question, and cancellation render and behave using a
   small Crucible snapshot/event/command port with no `@opencode-ai/core`,
   `@opencode-ai/sdk`, OpenCode event names, or direct backend client calls?
3. **Semantic fit:** Which Crucible concepts map truthfully to Session, Message,
   Tool Call, Agent/Model, Permission, and Question, and which must be redesigned?
   Is harness selection above the remounted session/state tree?
4. **Lifecycle:** On normal exit, Ctrl-C, `SIGTERM`/available platform equivalent,
   startup failure, render failure, transport loss, and repeated start/stop, are
   title, cursor, screen, mouse, raw mode, Windows console mode, listeners, timers,
   plugins, workers, and native resources restored exactly once?
5. **Packaging:** Does the chosen artifact include the Solid transform output,
   matching OpenTUI native package, parser worker, grammars/queries, themes, audio,
   and other assets without runtime access to the OpenCode monorepo?
6. **Platform matrix:** Does that packaged artifact pass automated renderer tests
   and interactive smoke checks on supported Windows, macOS, and Linux
   architecture/libc targets and representative terminals/multiplexers?
7. **Behavior tests:** Can deterministic fake snapshots/events and input drive the
   port, presentation, ordering, command, resize, and cleanup cases without an
   OpenCode server? Which minimal real-PTY tests close the remaining gap?
8. **Distribution:** What are artifact size, startup time, signing/notarization,
   installation, upgrade, and antivirus implications relative to DevFlow's
   current npm/Node distribution?
9. **Attribution:** Does the actual artifact's source/asset/dependency inventory
   produce complete MIT/BSD notices and trace every copied theme, sound, grammar,
   and native artifact?
10. **Updateability:** Can a second pinned OpenCode commit be reviewed and ported
    while keeping the Crucible port stable, with effort low enough to sustain at
    the chosen cadence?

## Rejection Criteria

Reject full OpenCode-derived TUI adoption, or reduce it to isolated presentation
ideas, if any of these conditions holds:

- The smallest truthful adapter must emulate broad OpenCode SDK endpoints or
  OpenCode's legacy plus V2 event projections rather than Crucible's own model.
- Core user flows still call OpenCode clients or import OpenCode domain types after
  the prototype seam is introduced.
- The chosen distribution requires an unapproved second runtime, an unapproved
  Node 26/experimental-FFI migration, or unavailable target native packages.
- Any supported platform leaves the terminal or Windows console corrupted on an
  exercised exit/failure path.
- The packaged artifact cannot locate all native/parser/grammar/assets without the
  upstream workspace, or cannot be signed/notarized and installed acceptably.
- Deterministic behavior tests cannot exercise state ordering, commands, input,
  resize, and cleanup independently of an OpenCode server.
- Required notices or asset provenance cannot be established for the shipped
  subset.
- A trial upstream update breaks the port broadly enough that maintenance cost is
  comparable to repeatedly re-extracting the TUI.
- Binary size, startup latency, or release-matrix cost exceeds Crucible's accepted
  product budget.

## Residual Fog

- Crucible's authoritative normalized state and command vocabulary has not yet
  been designed, so exact component reuse percentage is unknown.
- The product has not decided whether Bun distribution or a major Node runtime
  migration is acceptable.
- Real-terminal cleanup, macOS behavior, Windows arm64 behavior, and Node behavior
  outside Linux remain unproved for the extracted artifact.
- The provenance of individual bundled themes, sounds, and generated/native
  assets needs an artifact-level audit.
- No acceptable update cadence or maintenance budget has been set.

These are deliberate inputs to the prototype/Crucible decision, not reasons to
expand this research into implementation.
