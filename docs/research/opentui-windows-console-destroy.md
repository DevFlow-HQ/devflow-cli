# Why OpenTUI's renderer.destroy() Destroys The Legacy Windows Console

> **SUPERSEDED IN PART — read [Corrected By Measurement](#corrected-by-measurement) first.**
>
> [#33](https://github.com/DevFlow-HQ/devflow-cli/issues/33) ran the deciding
> experiment this document specifies, plus eighteen further controls. **Both
> surviving mechanisms below — M1, the console output code page, and M2, the
> shutdown VT blob — are refuted by measurement.** The console dies from a
> lifecycle defect on the JavaScript side that source reading could not reach:
> `destroy()` leaves the `process.stdin` handle that `createCliRenderer` created
> registered on the event loop, and the console is destroyed only when the loop
> is allowed to service it.
>
> **[Corrected By Measurement](#corrected-by-measurement) is itself corrected in
> part by [The Actor](#the-actor-processstdin)**, which identifies the handle,
> exonerates the timer, and replaces the synchronous-teardown workaround with a
> narrower one. Read both, in order.
>
> Everything in this document that is **source read** or **upstream report**
> still stands and is still useful — the import-table refutations, the OpenCode
> prevalence evidence, and the upstream commit history. What does not stand is
> the inference that the mechanism must be M1 or M2, and the options table that
> was priced against that choice.

## Answer

`renderer.destroy()` does not detach, close, or free the console. The shipped
OpenTUI 0.4.5 native library never calls `FreeConsole`, `AllocConsole`,
`AttachConsole`, `GetStdHandle`, or `SetStdHandle`; it never opens `CONOUT$` or
`CONIN$`; and it never reads stdin. Every hypothesis in that family — including
the `FreeConsole` theory that dominates OpenCode's own issue tracker — is
**refuted at the import table**, not merely unsupported.

What destroy actually does to the console reduces to exactly two acts, both
inside the Zig `CliRenderer.destroy()`:

1. it writes a shutdown VT blob to the inherited stdout handle with `WriteFile`,
   and
2. it restores the console **output code page** with `SetConsoleOutputCP`,
   undoing the switch to UTF-8 (65001) that the renderer performed at creation.

The code page pair is the only console-*host* state the 0.4.5 native library
mutates anywhere. Upstream deleted it in
[`a597e88f`](https://github.com/anomalyco/opentui/commit/a597e88fb0a9a3704c0d487fbcc9e1cde3c64377)
([PR #1272](https://github.com/anomalyco/opentui/pull/1272)), first shipped in
**v0.5.0**, replacing byte writes under a shared code page with `WriteConsoleW`.
The 0.5.4 binary imports no console-mutating call at all. So if the code page is
the trigger, upstream is already fixed — incidentally, and without ever claiming
to fix a console-death bug.

This is **not** a Crucible-only or prototype-only defect. OpenCode pins the same
`@opentui/core@0.4.5`, and OpenCode's tracker carries at least eight independent
reports of the identical symptom — parent shell or terminal window killed on TUI
exit on Windows — including a user bisect that lands the regression squarely on
an `@opentui/core` version bump. None is fixed; most were closed by the
staleness bot.

Which of the two acts is fatal is **not established**, and cannot be settled by
reading. Two cheap real-console controls separate them decisively; both are
specified in [The Deciding Experiment](#the-deciding-experiment) with exact
commands. Run those before costing anything, because they select between a
roughly ten-line Crucible workaround and a much more expensive path.

## Evidence Boundary

OpenTUI source facts are pinned to the source commit for the `v0.4.5` tag,
[`0c8c4f7cff2927e3df63a9757a45eff9a343611c`](https://github.com/anomalyco/opentui/tree/0c8c4f7cff2927e3df63a9757a45eff9a343611c),
the same commit `docs/research/opencode-tui-extraction-constraints.md` pins.
Upstream comparison is against `anomalyco/opentui` `main` at
[`8cae8edd`](https://github.com/anomalyco/opentui/commit/8cae8edd) (fetched
2026-08-19) and the published tag `v0.5.4`.

Binary facts come from parsing the PE import directory of the two shipped
artifacts: `@opentui/core-win32-x64@0.4.5` (the copy installed under
`prototypes/opencode-shell/node_modules/`) and `@opentui/core-win32-x64@0.5.4`
(fetched from npm). These are the actual DLLs, not a rebuild.

OpenCode facts come from `anomalyco/opencode` `dev` (read 2026-08-19) and its
public issue tracker.

Evidence labels have precise meanings:

- **Source read**: observed in the pinned OpenTUI source or the shipped binary.
- **Measured in #6**: established by the prototype on real Windows 11 hardware,
  recorded in the
  [#6 resolution comment](https://github.com/DevFlow-HQ/devflow-cli/issues/6#issuecomment-5331753472).
  Not re-derived here.
- **Upstream report**: a claim made in an OpenCode or OpenTUI issue by a user or
  maintainer. Treated as a signal of prevalence, not as verified mechanism.
- **Inference**: a downstream conclusion from the above.
- **Not established**: no inspected source settles it.

This research did not run the reproduction. Per the ticket, reproduction needs a
real console and cannot be driven from an agent harness or a pty.

## What destroy() Actually Does

### The JavaScript path — source read

`CliRenderer.destroy()` is synchronous and idempotent. It sets `_isDestroyed`,
and either defers through `prepareDestroyDuringRender()` or goes straight to
`finalizeDestroy()`. `cleanupBeforeDestroy()` removes `SIGWINCH`, error and exit
listeners, clears timers, sets `_useMouse = false`, detaches the stdin `data`
listener, calls `stdin.setRawMode(false)` and `stdin.pause()`.
`finalizeDestroy()` then destroys renderables, the stdin parser and the captured
console, restores `stdout.write`, drains the native span feed, and calls
`this.lib.destroyRenderer(this.rendererPtr)` across the FFI boundary.

Verified in the installed bundle at
`prototypes/opencode-shell/node_modules/@opentui/core/chunk-node-51kpf0mz.js`:
`destroy()` at line 9411, `cleanupBeforeDestroy()` at 9421, `finalizeDestroy()`
at 9487, and the FFI call at 9535.

**The TypeScript side of OpenTUI 0.4.5 contains zero Windows console API
references.** A grep for `SetConsoleMode`, `GetConsoleMode`, `GetStdHandle`,
`FreeConsole`, `SetConsoleOutputCP`, `chcp`, and `kernel32` across
`packages/core/src/**/*.ts{,x}` at v0.4.5 returns nothing. Whatever touches the
console host is native.

### The native path — source read

`destroyRenderer` in
[`lib.zig:641`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/lib.zig#L641)
invalidates the handle and calls `CliRenderer.destroy()`, which does exactly
this, in this order
([`renderer.zig:355`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/renderer.zig#L355)):

| # | Step | Console contact |
| --- | --- | --- |
| 1 | `performShutdownSequence()` | builds a VT reset blob and writes it with `WriteFile` |
| 2 | `backend.deinit()` | joins the render thread; frees buffers; **`StdoutOutput.deinit()` → `SetConsoleOutputCP(original)`** |
| 3 | `terminal.deinit()` | frees an env map only |
| 4 | buffer/allocator teardown | none |

The code page pair lives in
[`renderer-output.zig`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/renderer-output.zig#L52-L79).
`StdoutOutput.init()` probes with `GetConsoleMode`, and if stdout is a console
whose output code page is neither `0` nor `65001`, it calls
`SetConsoleOutputCP(65001)` and records the old value. `deinit()` puts the old
value back. This is the **only** console-host state the whole native library
mutates: a grep for `kernel32.` across every `.zig` file at v0.4.5 returns
`GetConsoleMode`, `GetConsoleOutputCP`, and `SetConsoleOutputCP` and nothing
else.

The shutdown blob itself is assembled by `Terminal.resetState()`
([`terminal.zig:218`](https://github.com/anomalyco/opentui/blob/0c8c4f7cff2927e3df63a9757a45eff9a343611c/packages/core/src/zig/terminal.zig#L218))
plus the tail of `performShutdownSequence()`. Sequences it emits that are
**only** sent at shutdown, and that the legacy console host does not implement:

```
ESC ] 22 ;  BEL         reset mouse pointer shape  (OSC 22, empty payload)
ESC ] 112   BEL         reset cursor colour        (OSC 112, no separator)
ESC ] 12 ; default BEL  cursor colour fallback     (OSC 12)
CSI < u                 kitty keyboard pop
CSI > 4 ; 0 m           modifyOtherKeys off
CSI ? 2031 l            colour-scheme updates off
ESC [ 0 SP q            default cursor style
ESC ] 0/2 ;  BEL        empty terminal title
```

OSC 111 is present in `ansi.zig` but the call site is commented out, with a note
that sending it poisons later OSC 11 reporting in Ghostty.

### What the native library provably does not do — source read

Parsing the PE import directory of the shipped `@opentui/core-win32-x64@0.4.5`
`opentui.dll` (3,786,120 bytes), its `KERNEL32.dll` imports number 67. Console-
adjacent entries present: `GetConsoleMode`, `GetConsoleOutputCP`,
`SetConsoleOutputCP`, `GetConsoleScreenBufferInfo`, `SetConsoleMode`,
`SetConsoleTextAttribute`, `CloseHandle`, `CreateFileA`, `CreateFileW`,
`ReadFile`, `WriteFile`.

Absent entirely — no import, therefore no possible call:

- `FreeConsole`, `AllocConsole`, `AttachConsole`
- `GetStdHandle`, `SetStdHandle`
- `SetConsoleCtrlHandler`, `GenerateConsoleCtrlEvent`
- `GetConsoleWindow`, `CreateConsoleScreenBuffer`, `SetConsoleActiveScreenBuffer`
- `WriteConsoleW`, `ReadConsoleW`

The strings `CONOUT$` and `CONIN$` do not occur in the binary in either ASCII or
UTF-16, and do not occur anywhere in `packages/core/src` at v0.4.5. The native
core has no stdin path at all: no `.zig` file at v0.4.5 mentions stdin, and the
only console handle it ever touches is `std.fs.File.stdout()`, the inherited
process handle from the PEB, on which it never calls `close()`.

This retires, individually, every mechanism the ticket listed as a candidate:

| Candidate from #32 | Verdict | Basis |
| --- | --- | --- |
| `FreeConsole` | **Ruled out** | not imported; string absent from binary |
| `CloseHandle` on `CONOUT$`/`CONIN$`/std handles | **Ruled out** | device names absent; handles never opened; `GetStdHandle` not imported; stdout never closed |
| Virtual-terminal mode restore (`SetConsoleMode`) | **Ruled out as OpenTUI code** | imported, but not called from any OpenTUI `.zig` source — see caveat below |
| Native mouse/input reader closing a handle it does not own | **Ruled out** | no native stdin path exists in 0.4.5 |
| Thread/reader shutdown | **Ruled out as console contact** | `BufferedBackend.deinit()` joins the render thread before touching the output; no console handle involved |
| Console output code page mutation | **Survives** | see below |
| Shutdown VT blob | **Survives** | see below |

Caveat, labelled honestly: `SetConsoleMode`, `SetConsoleTextAttribute`, and
`GetConsoleScreenBufferInfo` are imported by the 0.4.5 DLL but are not called
from OpenTUI's own Zig. They arrive through the linked Zig standard library
(panic, tty-detection and progress paths are the obvious candidates). **Which
std path can reach them at runtime is not established here.** They are gone from
the 0.5.4 binary, which is consistent with a std-version difference rather than
a deliberate removal.

## The Two Surviving Mechanisms

### M1 — the console output code page

**Source read.** At `createCliRenderer` the renderer flips the console output
code page to UTF-8 (65001); at `destroy()` it flips it back. Every byte the
renderer writes in between goes through `WriteFile`, which decodes against that
shared code page. Upstream's own words for why this was wrong, in the commit
that removed it: *"WriteFile decodes console bytes using the active output code
page, making UTF-8 depend on shared CP 65001 state."*

**Measured in #6.** The console survives `createCliRenderer` — mode reads `520`
and is readable at `SHELL_READY` — and is gone after `destroy()`. Under M1 the
fatal call is therefore the *restore*, or the accumulated state that the restore
disturbs, not the initial switch.

**Fit.** M1 explains why destroy is the boundary, because the restore only
happens at destroy. It also explains why the symptom is a *host* death rather
than a process death: the code page is console-global, owned by the host, and #6
measured `233 ERROR_PIPE_NOT_CONNECTED` from the **parent** process too, which
is what a dead console server looks like to every remaining client.

**Weakness.** The same calls are made under Windows Terminal, where #6 measured
`503 -> 503` on every exit path. M1 therefore requires the legacy host
specifically to be the fragile one. That is plausible — Windows Terminal is
served by `OpenConsole.exe`, a separately maintained newer console host, and its
window is owned by Windows Terminal rather than by the console host — but it is
**inference, not established**.

### M2 — the shutdown VT blob

**Source read.** The blob above is written to the console at destroy, and only
at destroy. Legacy conhost parses VT in-process; a parser fault kills the host,
which closes the window it owns and leaves every attached client failing console
calls with `233`. That is exactly the #6 symptom, including the parent's failure
and the window closing itself seconds later.

**Fit.** OpenTUI has a documented history of legacy-Windows-host failures caused
by VT emission rather than by handle work.
[opentui#933](https://github.com/anomalyco/opentui/issues/933) established that
sending `XTVERSION` before alt-screen entry poisons a real Windows Terminal
session for seconds; the reporter's minimal repro is three escape sequences and
a timer.
[opencode#41099](https://github.com/anomalyco/opencode/issues/41099) reports a
`STATUS_ACCESS_VIOLATION` during capability negotiation, with the crash located
"right around/after `[?1049h` ... and `[14t`". So "a sequence takes down the
Windows console path" is an established failure mode for this library, not a
novel theory.

**Weakness.** Setup also writes plenty of VT that legacy conhost does not
implement — including the capability query burst — and #6 measured the console
alive after setup. M2 therefore requires one of the shutdown-only sequences
listed above to be the fatal one. Which, if any, is **not established**.

### A third framing worth keeping

M1 and M2 are not exclusive. The renderer writes UTF-8 bytes through `WriteFile`
while the console sits at code page 65001 for the whole session; the shutdown
blob is the last such write. "Legacy conhost mishandles this byte stream under
65001" would produce M1's boundary and M2's failure shape simultaneously. The
first control below distinguishes the *mutation* from *everything else*, which
is the cut that matters for cost.

## The Deciding Experiment

Neither hypothesis can be settled by reading, and the ticket's constraint holds:
this needs a human in a real `conhost.exe` window. Both controls are cheap, and
neither patches OpenTUI or the prototype.

### Control A — start already at 65001

**What it tests.** `StdoutOutput.initForFile` returns early when the console
output code page is already `65001`, leaving `previousOutputCodePage` null, which
makes `deinit()` a no-op. With `chcp 65001` set first, **OpenTUI 0.4.5 makes zero
console-mutating calls for the entire session** — the only remaining console
contact is `GetConsoleMode` and `WriteFile`.

Open a legacy console host window:

```
conhost.exe powershell.exe
```

then, inside it:

```powershell
cd <repo>\prototypes\opencode-shell
chcp 65001
node --experimental-ffi --no-warnings scripts\real-terminal-check.mjs node
type $env:TEMP\crucible-real-terminal-check.log
```

- **Console survives** → M1 confirmed. The `SetConsoleOutputCP` pair is the
  trigger, and the Crucible workaround is roughly ten lines.
- **Console still dies** → M1 refuted. The code page mutation is exonerated and
  the fault is in what the renderer writes.

Re-run without `chcp 65001` in the same session shape to confirm the baseline
still dies; the `503 -> 503` control (`CRUCIBLE_SHELL_FAIL=startup`) already
exists for the clean case.

### Control B — suspend instead of destroy

**What it tests.** `renderer.suspend()` calls `lib.suspendRenderer`, which runs
`performShutdownSequence()` — the identical VT blob — and **nothing else**. It
never reaches `backend.deinit()`, so the code page is never restored and the
render thread is never joined.

Save this outside the repo (it must not be committed to the prototype), point it
at the prototype's `node_modules`, and run it in the same `conhost.exe
powershell.exe` window:

```js
// suspend-only probe: writes the shutdown VT blob, never calls destroy()
import { createCliRenderer, TextRenderable } from "@opentui/core"
const r = await createCliRenderer({ targetFps: 10 })
r.root.add(new TextRenderable(r, { id: "t", content: "suspend probe" }))
r.requestRender()
setTimeout(() => { r.suspend(); process.exit(0) }, 2000)
```

- **Console dies** → M2 confirmed. The shutdown VT blob is the trigger; no
  amount of teardown reordering helps and the fix must be upstream or vendored.
- **Console survives** → the fault is in `backend.deinit()`, which on the console
  means the code page restore. Combined with Control A this is conclusive.

Both controls must be run from a window the human opened as `conhost.exe`, not
Windows Terminal, not an IDE pane, and not through a pty. Read the result from
`%TEMP%\crucible-real-terminal-check.log`, because the window dies before the
report can be read.

## Scope: Does OpenCode Exhibit This?

### Current facts

**OpenCode pins the same version.** `anomalyco/opencode` `dev` (read 2026-08-19)
sets `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` to `0.4.5` in the
root workspace catalog, and `packages/tui/package.json` consumes them via
`catalog:`. OpenCode therefore ships the identical `opentui.dll` and the
identical destroy path.

**OpenCode's Windows console work does not cover this.**
`packages/tui/src/terminal-win32.ts` uses `bun:ffi` for `GetStdHandle`,
`GetConsoleMode`, `SetConsoleMode`, and `FlushConsoleInputBuffer`, solely to
clear and re-clear `ENABLE_PROCESSED_INPUT` and flush queued input. It never
touches the code page and never re-opens a console. #6 already measured that
Crucible's equivalent guard makes no difference to this symptom.

### Upstream reports

OpenCode's tracker carries a long-running cluster of reports of the identical
user-visible symptom. None is fixed.

| Issue | State | Terminal / shell | Note |
| --- | --- | --- | --- |
| [#22003 TUI exit closes terminal window on Windows](https://github.com/anomalyco/opencode/issues/22003) | **open** | Windows Terminal + cmd.exe | reporter's own FFI instrumentation: `GetConsoleWindow()` goes valid → `0x0`, no `CTRL_CLOSE_EVENT`, "the console is silently detached" |
| [#23720 /exit freezes Hyper and alacritty, force-closes PowerShell](https://github.com/anomalyco/opencode/issues/23720) | closed (stale) | Hyper, Alacritty, PowerShell | regression v1.14.18 → v1.14.19; explicitly *not* Windows Terminal, *not* VS Code |
| [#25691 OpenCode crashes terminal window on exit](https://github.com/anomalyco/opencode/issues/25691) | closed (stale) | cmd.exe | |
| [#26480 Default opencode corrupts ConPTY-hosted parent shell on exit](https://github.com/anomalyco/opencode/issues/26480) | closed (stale) | Warp / WT / VS Code | detailed `FreeConsole` hypothesis; shell dies with `0x80131623` (CLR `ObjectDisposedException` family) |
| [#27749 /exit or /quit kills the terminal on Windows PowerShell](https://github.com/anomalyco/opencode/issues/27749) | closed (stale) | PowerShell 7.6.1 | |
| [#28155 Fatal crash (0x80131623) in PowerShell 7.6.1 when exiting](https://github.com/anomalyco/opencode/issues/28155) | closed (stale) | PowerShell 7.6.1 / WT | same CLR code as #26480 |
| [#28673 Regression: /exit and Ctrl+C kill parent terminal since v1.14.25](https://github.com/anomalyco/opencode/issues/28673) | closed (stale) | pwsh 7, WezTerm, WT | **bisected to the `@opentui/core` 0.1.99 → 0.1.103 bump** |
| [#30495 opencode exit causes conhost.exe crash and kills all psmux panes](https://github.com/anomalyco/opencode/issues/30495) | closed (stale) | psmux 3.3.4 / pwsh 7.6.1 | Event Viewer: `conhost.exe` faults with `0xc0000005`; pwsh then FailFasts on `GetConsoleScreenBufferInfo` with error `0xE9`, "No process is on the other end of the pipe" |

Two of these are worth reading closely.

**#30495 is the same failure, with the crash record #6 could not capture.** It
names `conhost.exe` faulting with an access violation, and PowerShell then dying
on a console read with `0xE9` — which is `ERROR_PIPE_NOT_CONNECTED`, decimal
**233**, the exact error #6 measured from both the shell and its parent. This is
independent, first-party corroboration that the failure is *the console host
process dying*, not a handle being detached.

**#28673's bisect is the strongest causal link available.** The reporter
bisected OpenCode releases to v1.14.25 and identified the only relevant change
as the `@opentui/core` / `@opentui/solid` bump from 0.1.99 to 0.1.103. Reading
that OpenTUI range, the Zig changes are `8de7a016` (emit OSC 11/111 to sync
terminal background colour), `95d36f35` (preserve terminal colour intent),
`97af2de5` and `616b16f2` (theme-mode detection), and `bf8f195c` (native split
footer). **Every one of them changes what the renderer writes to the terminal.
None of them touches a console handle.** That is meaningful support for M2 and
against any handle-lifetime theory — though it is a user bisect over OpenCode
releases, not a maintainer-confirmed OpenTUI bisect, and it is a *different*
regression window from the code-page code, so it does not settle M1 vs M2.

### Inference

OpenCode running under `conhost.exe` executes the same native destroy path as
Crucible's prototype, so the same behaviour is expected. Note the polarity
disagreement worth carrying: #6 measured Windows Terminal clean and conhost
fatal, while #26480 reports the opposite matrix (native conhost fine, ConPTY
hosts fatal). #26480 is about OpenCode's *default server+TUI* mode with a forked
server child, and its own differential shows the failure disappears with
`opencode serve` + `opencode attach`. Crucible's prototype has no server child,
so #26480's mechanism is most likely a second, distinct Windows exit bug in
OpenCode rather than a contradiction of #6. **Not established**: whether OpenCode
without a server child dies in legacy conhost the way the prototype does.

### Crucible's exposure is not reduced by avoiding OpenCode

Every reproduction path here runs through `@opentui/core` alone. Crucible's
prototype imports no OpenCode code at all and still hits it. Extraction boundary
choices in #17 therefore do not affect this cost; only the OpenTUI version does.

## Scope: Upstream OpenTUI

### The code that mutates the code page is gone

**Source read.**
[`a597e88f`](https://github.com/anomalyco/opentui/commit/a597e88fb0a9a3704c0d487fbcc9e1cde3c64377)
("core(renderer): write Windows console output with WriteConsoleW",
[PR #1272](https://github.com/anomalyco/opentui/pull/1272), merged 2026-07-28)
deletes `WINDOWS_UTF8_CODE_PAGE`, both `SetConsoleOutputCP` call sites, and
`StdoutOutput.deinit()` entirely, replacing them with UTF-8 → UTF-16 conversion
and `WriteConsoleW`. `git tag --contains` puts it first in **v0.5.0** (released
2026-08-03). It is the only Windows-related commit touching the renderer between
v0.4.5 and v0.5.0.

Confirmed in the shipped artifacts, not just in source:

| KERNEL32 import | 0.4.5 DLL | 0.5.4 DLL |
| --- | --- | --- |
| `GetConsoleOutputCP` / `SetConsoleOutputCP` | present | **gone** |
| `SetConsoleMode` / `SetConsoleTextAttribute` / `GetConsoleScreenBufferInfo` | present | **gone** |
| `WriteConsoleW` | absent | **present** |
| `GetStdHandle` / `FlushConsoleInputBuffer` | absent | **present** |
| `GetConsoleMode` | present | present |
| `FreeConsole` / `AllocConsole` / `AttachConsole` / `SetStdHandle` | absent | absent |

**The 0.5.4 native library makes no console-mode and no code-page mutating call
at all.** If M1 is the mechanism, current upstream is already fixed.

If M2 is the mechanism, nothing upstream addresses it: the shutdown VT blob in
`Terminal.resetState()` is materially unchanged on `main`.

### It is not reported upstream

A search of `anomalyco/opentui` for `conhost`, `console closes`, `code page`,
`codepage`, `chcp`, `65001`, `legacy console`, `terminal closes`, and `window
closes` returns **no issue describing this symptom**. The closest neighbours are
[#933](https://github.com/anomalyco/opentui/issues/933) (Windows Terminal stalls
on XTVERSION-before-alt-screen, closed 2026-06-05),
[#992](https://github.com/anomalyco/opentui/issues/992) (Windows segfault
destroying a renderer during async palette detection, closed same-day),
[#940](https://github.com/anomalyco/opentui/issues/940) (opentui.dll panics
during DllMain/static init), and
[#514](https://github.com/anomalyco/opentui/issues/514), which is an OpenCode
user reporting garbled Windows console output whose diagnosis was *"opentui.dll
doesn't properly handle console encoding when outputting UTF-8 characters on
Windows"* — the same code path, closed for want of a reply.

**Nobody has connected the console death to `renderer.destroy()` upstream.** #6
and this ticket are, as far as the trackers show, the first evidence that
isolates it to that call. That is an asset for the upstream-patch option: a
crisp reproduction plus a named call site is most of a good issue.

### Upgrading to 0.5.x is not free

v0.5.0 also carries native image rendering, an audio input capture engine,
renderer-resolution lifecycle hardening, FFI struct storage reuse, and a Node
ESM fix; the DLL grows from 3.79 MB to 5.22 MB (relevant to the 102 MB packaged
Windows binary #6 measured). `main` has since migrated the Zig core to Zig 0.16.
The public export map still offers real `bun` and `node` conditions and the same
eight native optional dependencies, so #6's finding that one adapter serves both
runtimes survives the bump.

Open teardown defects on current upstream that Crucible would inherit either way:
[#1355](https://github.com/anomalyco/opentui/issues/1355) (the shared
`exitHandler` destroys the renderer without exiting, so `SIGHUP` and Ctrl+C leave
a process spinning at 100% CPU) and
[#904](https://github.com/anomalyco/opentui/issues/904)
(`cleanupBeforeDestroy()` disables raw mode before mouse tracking, garbling
escape sequences after destroy). Both are lifecycle bugs in the same region #6
already had to work around.

**Most important for #17: OpenCode has not moved.** It still pins 0.4.5 on `dev`
as of 2026-08-19. Adopting 0.5.x to get this fix means Crucible's OpenTUI pin
diverges from OpenCode's, so every upstream OpenCode port must be reviewed
against a renderer version OpenCode does not test against. That is a direct hit
on the "pin Bun, OpenTUI, Solid, Effect, and native packages as one tested set"
rule in `docs/research/opencode-tui-extraction-constraints.md`.

## Options And Costs

Read this table *after* running the deciding experiment; the two middle columns
change materially depending on the outcome.

| Option | What Crucible does | Cost if M1 (code page) | Cost if M2 (VT blob) | Effect on update cadence |
| --- | --- | --- | --- | --- |
| **Document "Windows Terminal required"** | Detect the legacy host at startup, warn or refuse; state the constraint in install docs | Same either way: roughly a day. Detection is cheap. Costs a real user segment — cmd.exe, standalone PowerShell, and any host embedding classic conhost | Same | **None.** The only option with zero recurring cost |
| **Teardown workaround in Crucible** | Set the console output code page to 65001 before `createCliRenderer`, so OpenTUI's own switch is a no-op and its restore never fires | **~10 lines, hours.** Needs `SetConsoleOutputCP` only; #6 established Crucible needs no runtime FFI, so this adds a small Windows-only FFI dependency back, or shells out to `chcp`. Leaves the user's code page at 65001 unless Crucible restores it once the console is safely idle | **Does not work.** The blob is written regardless | One Windows-only shim to re-validate on every OpenTUI bump; about one line of a smoke checklist |
| **Avoid `destroy()` entirely** | Call `suspend()`, then exit the process without destroying | Does not help on its own: `suspend()` merely skips the code page restore, so this is the workaround above with worse hygiene | **Does not work if Control B shows suspend also kills the console.** If it does not, this leaks the native renderer and the render thread by design, and #6 already found `destroy()` can stall — trading one lifecycle hazard for another | Fragile; every OpenTUI bump can change what `suspend()` emits |
| **Upgrade the pin to `@opentui/core` >= 0.5.0** | Take upstream's `WriteConsoleW` rewrite | **Fixed upstream, for free.** Costs a version bump plus revalidation: DLL 3.79 → 5.22 MB, new image/audio surface, Zig 0.16 on `main`, and the packaged-binary size budget re-checked | **No help.** `Terminal.resetState()` is unchanged on `main` | **High.** OpenCode still pins 0.4.5, so Crucible's renderer pin diverges from the tree it ports from. Every OpenCode port must then be reviewed against a renderer version upstream does not test together |
| **Upstream patch** | File the issue with #6's isolation plus this call-site analysis; contribute the fix | Already landed; worth filing only to confirm and get it acknowledged | **The right home.** Reproduction is crisp and the call site is named; nobody has reported it. Cost is an issue plus a Zig PR plus upstream release latency, with no guaranteed timeline | Best long-run: keeps Crucible on a stock pin. Needs a fallback while the fix is in flight |
| **Vendored native fix** | Fork `@opentui/core`, patch the Zig, rebuild and republish all eight native packages | Unjustifiable — upstream already did it | **Expensive.** No env-var override exists for the native library path (the platform package exports a hard-coded `./opentui.dll` URL), so this means owning the whole native package set: a Zig toolchain, cross-compilation for 8 targets (`x86_64`/`aarch64` × Windows/macOS/Linux-gnu/Linux-musl), plus the miniaudio/tree-sitter shims and a macOS SDK for the Darwin targets | **Highest.** Crucible owns a native build matrix and re-does it on every upstream bump. A different order of maintenance from vendoring TypeScript, and it should not be entered without the deciding experiment first |

### Recommendation for #17

Run the deciding experiment first; it is under an hour and it collapses the
table. Then:

- **If M1**: ship the ten-line pre-set as the near-term fix so Crucible stays on
  OpenCode's 0.4.5 pin, and schedule the OpenTUI >= 0.5.0 bump as a separate,
  independently validated change rather than an emergency one.
- **If M2**: do not attempt a vendored native fix. File upstream with #6's
  isolation table, and carry a documented "Windows Terminal required" constraint
  while it is in flight. Which host Crucible then supports is #17's decision, not
  this ticket's.

Either way, add to the per-update maintenance signals in
`docs/research/opencode-tui-extraction-constraints.md`: **a real-console Windows
smoke check on the legacy host.** #6's method note applies exactly — on Windows,
measure over a real API or a side channel, never over the terminal, and where
neither reaches, put a human in a real console. CI structurally cannot catch a
regression here.

## What Only A Real Console Can Settle

Listed explicitly, because none of it is guessable from source:

1. **M1 vs M2.** Controls A and B above. Everything in the cost table hangs on
   this.
2. **Whether `renderer.suspend()` alone kills the console.** Control B. Also
   tells Crucible whether any suspend/resume feature is viable on Windows at all.
3. **Which shutdown sequence is fatal, if M2.** Would need bisecting the blob by
   writing subsets to a real conhost from a bare script. Worth doing only if
   Crucible intends to file or write the upstream fix.
4. **Whether OpenTUI >= 0.5.0 actually survives legacy conhost.** The import
   table proves the mutating calls are gone; it does not prove the console lives.
   Install `@opentui/core@0.5.4` into a scratch copy of the prototype and re-run
   `scripts/real-terminal-check.mjs` in `conhost.exe`.
5. **Whether stock OpenCode reproduces it in legacy conhost.** Inference says yes
   — same pin, same DLL, same destroy path — but no report in the cluster above
   isolates a conhost run without OpenCode's forked server child.
6. **Whether the console dies at `destroy()` or only at process exit.** #6 places
   it at `destroy()`, before exit. Worth one confirmation with a deliberate delay
   inserted between destroy and exit, because it is load-bearing for ruling out
   runtime handle cleanup.

## Residual Fog

- Which of the two surviving mechanisms is real is **not established**. That is
  the honest state of this research, and it is a real-console question.
- Whether the failure is a conhost *crash* or a controlled teardown is supported
  by [opencode#30495](https://github.com/anomalyco/opencode/issues/30495)'s
  Event Viewer `0xc0000005` on `conhost.exe`, but that is one third-party report
  under psmux, not a dump Crucible has taken.
- The precise legacy-conhost behaviour under code page 65001 is not established
  from a Microsoft primary source here; the reasoning rests on OpenTUI's own
  stated rationale for removing its dependency on shared code page state.
- Whether `SetConsoleMode` / `SetConsoleTextAttribute` are reachable at runtime
  through the Zig standard library in 0.4.5 is not established; they are imported
  but uncalled from OpenTUI code.
- Windows arm64 is untested throughout. `@opentui/core-win32-arm64` was not
  inspected, and
  [opencode#41099](https://github.com/anomalyco/opencode/issues/41099) shows the
  Windows-on-ARM console path failing differently and earlier.
- No decision is made here about the supported Windows console host or the
  runtime. Both belong to
  [#17](https://github.com/DevFlow-HQ/devflow-cli/issues/17) and the
  product-scope tickets; this research exists to give them a priced menu.

## Corrected By Measurement

Added after [#33](https://github.com/DevFlow-HQ/devflow-cli/issues/33) ran twenty
controls in a real `conhost.exe powershell.exe` window on Windows 11, 2026-08-20.
Everything in this section is **measured**, not inferred. The harness is a
throwaway parent that reads console input mode and output code page over FFI
before the run, every 500ms while the child owns the console, after the child
exits, and then once a second for 15s; every line is flushed to a side channel,
because the window dies before its own report can be read.

### The mechanism

`renderer.destroy()` returns in ~0.1s and does not itself destroy the console.
It leaves live handles registered on the JavaScript event loop:

```
active resources right after destroy(): {"TTYWrap":3,"Timeout":1}
```

The console is destroyed when, and only when, **both** of these hold:

1. a keypress was actually delivered to the renderer during the session, and
2. the event loop is allowed to turn between `destroy()` and process exit.

Death follows ~0.8-1.6s after the loop resumes. During that window the parent's
own `GetConsoleMode` blocks, then returns 233 `ERROR_PIPE_NOT_CONNECTED`: the
console host wedges first and dies during the stall. A `destroy()` that appears
to hang is this symptom seen from inside, not a cause -- the prototype's 2s
`Promise.race` was reading the wedge, not a stuck teardown.

### The evidence

Both conditions are necessary; neither alone is sufficient. Twenty runs, no
exceptions:

| Run | Key delivered | Loop turns after destroy | Console |
| --- | --- | --- | --- |
| `baseline`, `input-destroy`, `input-reset-destroy`, `input-guard-destroy` | no | no | survives |
| `raw-only` (no OpenTUI at all) | no | yes | survives |
| `delay` (held open 10s) | no | yes | survives |
| `adapter-destroy` | no | yes | survives |
| `input-key-destroy`, `key-off-destroy`, `key-title-destroy`, `key-reset-destroy` | yes | no | survives |
| `key-spin-destroy` (main thread blocked 3s) | yes | no | survives |
| `key-race-destroy`, `key-wait-destroy`, `key-wait-resources` | yes | yes | **dies** |
| `key-stdin-before-destroy`, `key-stdin-after-destroy` | yes | yes | **dies** |
| `adapter-key-destroy`, `shell-bare`, `repro-shell` | yes | yes | **dies** |

`adapter-destroy` and `key-spin-destroy` are the load-bearing controls. The first
turns the loop without a keypress and lives; the second delivers a keypress and
passes 3s of wall-clock time with the main thread blocked by `Atomics.wait`, and
lives. So the actor is JS-scheduled work on the main loop, not a native or worker
thread, and not elapsed time.

### What this refutes

- **M1, the console output code page, is refuted as a sufficient cause.** The
  live sampler measured `outputCP` going 850 -> 65001 while the renderer was up
  and back to 850 after `destroy()` -- the exact switch-and-restore pair M1
  blames -- in runs where the console **survived**. This is also the first direct
  observation that 0.4.5 performs the switch at all; the source read inferred it.
- **M2, the shutdown VT blob, is refuted as a sufficient cause.** Every surviving
  keypress run executes the same `performShutdownSequence()`. `key-reset-destroy`
  additionally writes the prototype's own reset blob afterwards and survives.
- **Raw mode is not the trigger.** `raw-only` loads no OpenTUI, produces the same
  console input mode 520 (`ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT`)
  that the #6 repro records, and survives. Mode 520 is the runtime's, not
  OpenTUI's.
- **Tearing stdin down does not fix it** — *but see
  [The Actor](#the-actor-processstdin), which qualifies this.* `setRawMode(false)`
  plus `pause()`, before or after `destroy()`, dies either way and leaves
  `TTYWrap:3` registered. That last clause is the tell: `pause()` stops the read,
  not the handle. Actually removing the handle, before `destroy()`, does fix it.
- **The prototype's own teardown acts are innocent, individually.** Detaching the
  key handler from inside its own dispatch, `setTerminalTitle("")`, and the reset
  blob each survive in isolation.

### A gap in #6's isolation, for the record

[#6](https://github.com/DevFlow-HQ/devflow-cli/issues/6) recorded the Windows
console guard as ruled out because `CRUCIBLE_SKIP_CONSOLE_GUARD=1` also died. That
flag only skips the **initial** `SetConsoleMode`; `restore()` still calls
`SetConsoleMode` on teardown, so the guard's teardown call was never actually
controlled for. The conclusion survives -- `input-guard-destroy` isolates the real
guard and lives, and the #6 log shows `restore:err=233`, meaning the console was
already gone before restore ran -- but it was not established by the control that
was credited with it.

### What Crucible can do about it

> **Superseded by [The Actor](#the-actor-processstdin).** The workaround below
> works, but it is stricter than necessary: the requirement is not that teardown
> be synchronous, only that `process.stdin` be released before `destroy()`.

A workaround exists and is cheap, and it was not on the original options table:
**perform no event-loop work between `renderer.destroy()` and process exit.**
`destroy()` is synchronous (`destroy(): void`), so a teardown that calls it and
then exits in the same tick is achievable; every run that does so survives,
including one that burned 3s of wall clock first. The cost is a real constraint
on teardown design -- no `await` after destroy, which is exactly what the
prototype's adapter does today -- and it is a workaround, not a fix: the leaked
`TTYWrap` and `Timeout` handles are still there, and anything that resurrects the
loop re-arms the bug.

Not established here: which of the three `TTYWrap` handles or the one `Timeout`
is the actor, and whether a supported OpenTUI call disposes of them. That is the
detail an upstream report needs, and it is cheap to get with a Node handle dump
against a patched build; it does not block #17.

**Since resolved — see [The Actor](#the-actor-processstdin).** It is a `TTYWrap`,
and it is `process.stdin`.

## The Actor: process.stdin

Added after six further controls on 2026-08-20, same harness, same real
`conhost.exe powershell.exe` window on Windows 11. This section **resolves the
question the previous one left open**, and corrects two of its conclusions.

### The handle

`process._getActiveHandles()` returns the handle objects rather than a list of
type names, which is what makes the third `TTYWrap` identifiable at all:

| Phase | stdout | stderr | stdin |
| --- | --- | --- | --- |
| before the OpenTUI import | present | present | **absent** |
| after `createCliRenderer` | present | present | **present, `isRaw=true`** |
| after `destroy()` | present | present | **present, `isRaw=false`, `readable=true`, `destroyed=false`** |

`createCliRenderer` is what instantiates `process.stdin` and puts it in raw mode.
`destroy()` turns raw mode back off and leaves the handle open and registered on
the loop.

### The Timeout is exonerated, and was never a leak

OpenTUI creates exactly one timer during `createCliRenderer`, and it is not a
render-loop timer:

```
live timer seq=1 kind=timeout armed=5000 _idleTimeout=5000 _repeat=null
  from chunk-node-q0cwyvm9.js:4715:23) <- chunk-node-51kpf0mz.js:8665:43)
```

`destroy()` clears it. A control that clears every non-probe timer after
`destroy()` reported `cleared 0 timer(s)` — there was nothing left to clear — and
died anyway. The `Timeout:1` in the `key-wait-resources` dump above is the
**probe's own** 30s keypress-wait timer, not OpenTUI's; reading it as a leak was
wrong. Across every dying run, `TIMER FIRED post-destroy: 0` and
`WRITE post-destroy: 0` — nothing fires, nothing writes, and the console dies
anyway.

### The deciding trio

Three controls separate *what* must be done from *when*:

| Run | stdin action | On the loop at `destroy()` | Console |
| --- | --- | --- | --- |
| `key-stdin-before-destroy` | `setRawMode(false)` + `pause()`, before `destroy()` | yes — `TTYWrap:3` | **dies** |
| `handles-stdin-destroy`, `handles-stdin-close` | full release, **after** `destroy()` | yes | **dies** |
| `handles-stdin-before` | full release, **before** `destroy()` | no — `TTYWrap:2` | survives |

Both halves are load-bearing. Pausing the stream is not enough: `pause()` stops
the read, not the handle, and leaves `TTYWrap` at 3. And a full release after
`destroy()` is too late.

`handles-quiet-wait` rules out the probe itself. It touches the console in no way
after `destroy()` — every log line diverted to the side channel — turns the loop
for 3s, and dies on the same clock. Post-destroy console I/O is neither necessary
nor sufficient.

### Timing: why every after-the-fact intervention failed

The console is already unresponsive **0.1s after `destroy()` returns**. In
`handles-stdin-destroy` the probe's own `setRawMode(false)` at that point blocked
for 0.7s — the same signature as the parent's `GetConsoleMode` blocking before it
returns 233 — and the run died on the same clock as every other. Its exit code 1
is conhost taking the child down, not a crash.

Death lands 0.6–0.8s after `destroy()` returns in all five dying runs of this
round, independent of what the process does next. What the process does next
decides only whether the console **recovers**:

- exits before that deadline — recovers (`handles-census`)
- stays alive with the loop blocked — recovers (`key-spin-destroy`)
- stays alive with the loop turning — wedges permanently

### The corrected workaround

The requirement is **not** that teardown be synchronous:

> Release `process.stdin` **before** calling `renderer.destroy()`: remove its
> listeners, `setRawMode(false)`, `pause()`, `unref()`, `destroy()`.

With the handle off the loop, `handles-stdin-before` turns the event loop for a
full 3 seconds after `destroy()` — twelve sampled turns, the exact configuration
that kills the console in every other run — exits cleanly, and leaves the console
at `503 / 850` through a 15s watch.

This lifts the constraint the previous section imposed. Async teardown, `await`,
timeouts and `Promise.race` are all available again; only the stdin release has to
precede `destroy()`. The prototype's adapter dies because it never releases stdin
at all: `keyInput.off` detaches OpenTUI's listener but leaves the handle.

One cosmetic caveat, measured: because the release calls `setRawMode(false)`, the
console sits in ordinary cooked mode (`7`) for the duration of the post-destroy
window, returning to `503` at process exit. The final state is correct; the
intermediate one is not the original.

### For an upstream report

`destroy()` leaves the `process.stdin` handle that `createCliRenderer` created
registered on the event loop. On legacy conhost, any subsequent turn of the loop
wedges the console host. The repro is `handles-quiet-wait`; the surviving control
is `handles-stdin-before`; the fix is for `destroy()` to release the handle it
caused to be created.
