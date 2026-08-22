# Handoff: Verify The OpenTUI Console Defect On 0.5.6, Then File It Upstream

**Transient document.** Delete it in the same pull request that lands the upstream issue URL — it exists only to move this task from a Linux session to a Windows one.

## What happened before you

[Choose the OpenCode-derived TUI adoption and maintenance boundary](https://github.com/DevFlow-HQ/devflow-cli/issues/17) decided Crucible adopts OpenCode's presentation layer as a pinned reduced vendor, pinned to OpenTUI `0.4.5`. Part of that decision: Crucible owns a teardown workaround for an OpenTUI defect, and files the defect upstream. Recorded in [ADR 0018](../adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md).

**The defect.** `createCliRenderer()` touches `process.stdin`, which instantiates the TTY stream and registers its handle on the event loop. `destroy()` removes the data listener, clears raw mode and calls `pause()` — but never releases the handle. On the legacy Windows console host, if a keypress was delivered **and** the loop turns between `destroy()` and exit, the console host wedges and the window dies roughly 0.6–0.8s later.

Established by measurement in [#33](https://github.com/DevFlow-HQ/devflow-cli/issues/33) — twenty-plus controlled runs in a real Windows 11 conhost window — against `0.4.5`. Read the [correction comment](https://github.com/DevFlow-HQ/devflow-cli/issues/33#issuecomment-5359398258) first; it supersedes parts of the resolution above it.

**Why this task exists.** Current OpenTUI is `0.5.6`; the measurement was on `0.4.5`. A source read of both packages found `cleanupBeforeDestroy()` unchanged — still `removeListener("data", …)` then `setRawMode(false)` then `pause()` — and `unref(` and `stdin.destroy(` appear **zero times in either version**. Since #33 proved that `setRawMode(false)` plus `pause()` is exactly what is not enough, the cause should survive into `0.5.6`. That is a source read, not a measurement. You have the Windows box; close the gap.

## Step 1 — Setup

```powershell
mkdir opentui-conhost; cd opentui-conhost
npm init -y
npm pkg set type=module
npm install @opentui/core@0.5.6
```

Runtime: **Bun 1.3.14 preferred**, because it matches the original measurement and OpenCode's own pin. Node >= 26 also works. OpenTUI itself needs no FFI and no experimental flag — that requirement came from Crucible's old `win32.mjs`, not from OpenTUI.

## Step 2 — The repro script

Save as `opentui-conhost-repro.mjs` in that folder.

```js
// Does OpenTUI's renderer.destroy() still wedge the legacy Windows console on 0.5.6?
//
// MUST be run inside a real legacy console:  conhost.exe powershell.exe
// Windows Terminal will NOT reproduce this.
//
//   bun opentui-conhost-repro.mjs <mode>      (preferred - matches the original measurement)
//   node opentui-conhost-repro.mjs <mode>     (Node >= 26)
//
// modes:
//   die     press a key, then turn the loop 3s      EXPECT: console wedges and window dies
//   nokey   no keypress, turn the loop 3s           EXPECT: console survives
//   nowait  press a key, exit in the same tick      EXPECT: console survives
//   fixed   press a key, release stdin BEFORE       EXPECT: console survives
//           destroy(), then turn the loop 3s
//
// Everything is logged to repro-<mode>.log because on conhost the window can die
// before you can read stdout. Never trust the terminal here; trust the file.

import { createCliRenderer } from "@opentui/core";
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "die";
const LOG = `repro-${mode}.log`;
const t0 = Date.now();

function log(message) {
  const line = `${String(Date.now() - t0).padStart(6)}ms  ${message}\n`;
  try {
    appendFileSync(LOG, line);
  } catch {
    // the log file is the only reliable channel; if it fails there is nowhere else to go
  }
}

function handleCensus() {
  const counts = {};
  for (const handle of process._getActiveHandles?.() ?? []) {
    const name = handle?.constructor?.name ?? "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

log(
  `mode=${mode} runtime=${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`,
);

const renderer = await createCliRenderer({});
log(`renderer created; handles=${JSON.stringify(handleCensus())}`);

if (mode === "nokey") {
  log("control: no keypress will be delivered");
} else {
  process.stderr.write("\r\npress any key...\r\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  log("keypress delivered");
}

if (mode === "fixed") {
  process.stdin.removeAllListeners("data");
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.unref();
  process.stdin.destroy();
  log(
    `stdin released BEFORE destroy; handles=${JSON.stringify(handleCensus())}`,
  );
}

log(`calling destroy(); handles=${JSON.stringify(handleCensus())}`);
renderer.destroy();
log(`destroy() returned; handles=${JSON.stringify(handleCensus())}`);

if (mode === "nowait") {
  log("exiting in the same tick - the loop never turns");
  process.exit(0);
}

await new Promise((resolve) => setTimeout(resolve, 3000));
log("survived 3s of event loop turning");
process.exit(0);
```

## Step 3 — Run it, in a legacy console only

Open a legacy console with Win+R, then `conhost.exe powershell.exe`. Not Windows Terminal, not VS Code's terminal, not a PowerShell tab. Use a fresh window for each run.

| Run | Command                                                | Expected                            |
| --- | ------------------------------------------------------ | ----------------------------------- |
| 1   | `bun opentui-conhost-repro.mjs die` — key, then wait   | window **wedges and closes itself** |
| 2   | `bun opentui-conhost-repro.mjs nokey`                  | window **survives**                 |
| 3   | `bun opentui-conhost-repro.mjs nowait` — press a key   | window **survives**                 |
| 4   | `bun opentui-conhost-repro.mjs fixed` — key, then wait | window **survives**                 |

After each run, read `repro-<mode>.log` from a different window. The `handles=` line immediately after `destroy()` is the payload: a `ReadStream`/`WriteStream` count of 3 means the handle is still registered.

**Method rule from [#6](https://github.com/DevFlow-HQ/devflow-cli/issues/6), learned the hard way — do not skip it.** On Windows, measure over a real API or a side channel, never over the terminal. ConPTY is a screen scraper and has produced false readings in both directions on this exact defect. That is why the script logs to a file.

## Step 4 — Branch on the result

**Runs 1 through 4 all as expected.** Confirmed on `0.5.6`. Post the issue in Step 6, but first delete the sentence beginning _"I have not re-run the console experiment against 0.5.6"_ and change the environment line to say `0.4.5` measured and `0.5.6` confirmed. Then continue to Step 7.

**Run 1 survives.** The defect is fixed in `0.5.6`. **Do not post.** This is a significant finding for Crucible: it makes an OpenTUI bump a real fix, and ADR 0018's pin rationale needs rewriting. Open a devflow issue instead, referencing #17 and #33.

**Run 4 dies.** The workaround does not hold on `0.5.6`. **Stop and escalate.** ADR 0018's teardown invariant is load-bearing for keeping legacy conhost supported; if it fails there, that decision needs revisiting.

## Step 5 — Check nobody beat you to it

Search `anomalyco/opentui` for `conhost`, `console`, `destroy`, and `stdin` before filing. As of 2026-08-22 nothing described this symptom.

## Step 6 — The issue

File at <https://github.com/anomalyco/opentui/issues/new>.

**Title:** `renderer.destroy() leaves the process.stdin handle it created registered on the event loop, wedging the legacy Windows console host`

**Body:**

````markdown
### Summary

`createCliRenderer()` touches `process.stdin`, which lazily instantiates the TTY read stream and registers its handle on the event loop. `destroy()` removes the data listener, clears raw mode and calls `pause()` — but never releases the handle. On the **legacy Windows console host** (`conhost.exe`), if a keypress was delivered during the session **and** the event loop turns between `destroy()` and process exit, the console host wedges and then dies, taking the window with it.

`pause()` stops the read; it does not remove the handle from the loop. That distinction is the whole bug.

### Environment

- `@opentui/core` **0.4.5** (measured), Windows 11, `conhost.exe powershell.exe`
- Reproduced on both Node 26.7.0 and Bun 1.3.14 — it is not runtime-specific
- Windows Terminal is **not** affected; this is legacy conhost only

The relevant code is **unchanged in 0.5.6**. `cleanupBeforeDestroy()` still does exactly `stdin.removeListener("data", …)` → `setRawMode(false)` → `stdin.pause()`, and neither `unref()` nor `stdin.destroy()` appears anywhere in the package on either version. 0.5.6 additionally calls `stopTerminalKeepAlive()` and drains buffered input, but neither touches the handle registration. I have not re-run the console experiment against 0.5.6, so please treat the version currency as a source read rather than a measurement.

### Reproduction

Run in a real `conhost.exe powershell.exe` window (not Windows Terminal):

```js
// repro.mjs
import { createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({});

process.stderr.write("press any key, then wait\n");
await new Promise((resolve) => process.stdin.once("data", resolve));

renderer.destroy();

// let the event loop turn. no console I/O of any kind happens here.
await new Promise((resolve) => setTimeout(resolve, 3000));
process.exit(0);
```

The console window wedges roughly 0.6–0.8s after `destroy()` and closes itself shortly after. Remove either condition and it survives:

- don't press a key → survives
- replace the 3s wait with an immediate `process.exit(0)` → survives

### What the conditions are, precisely

Both are necessary, neither is sufficient. Twenty-plus controlled runs in a real conhost window:

| Condition                                                       | Result       |
| --------------------------------------------------------------- | ------------ |
| no keypress, loop turns 3s                                      | survives     |
| no keypress, renderer held open 10s                             | survives     |
| keypress, main thread blocked 3s with `Atomics.wait`, then exit | **survives** |
| keypress, loop allowed to turn                                  | **dies**     |
| keypress, loop turns, no console I/O at all after `destroy()`   | **dies**     |

The blocked-thread case is the informative one: 3 seconds of wall clock pass and the console lives, so the trigger is JS-scheduled work on the main loop, not elapsed time, not a worker, and not anything native.

### The handle

`process.stdin` does not exist before the OpenTUI import; `createCliRenderer` brings it into being.

| Phase                     | stdin                                        |
| ------------------------- | -------------------------------------------- |
| before import             | absent                                       |
| after `createCliRenderer` | present, `isRaw=true`                        |
| after `destroy()`         | present, `isRaw=false`, **still registered** |

Right after `destroy()`, active handles are `{"TTYWrap":3,"Timeout":1}`.

### Deciding control

Releasing the handle **before** `destroy()` fixes it; releasing it after does not.

| stdin handling                                     | On the loop at `destroy()` | Console      |
| -------------------------------------------------- | -------------------------- | ------------ |
| `setRawMode(false)` + `pause()` before `destroy()` | yes — `TTYWrap:3`          | dies         |
| full release **after** `destroy()`                 | yes                        | dies         |
| full release **before** `destroy()`                | no — `TTYWrap:2`           | **survives** |

Where "full release" is: remove listeners → `setRawMode(false)` → `pause()` → `unref()` → `destroy()`.

With the handle off the loop, the surviving run turns the loop for a full 3 seconds after `destroy()` — the exact configuration that kills the console in every other run — exits cleanly, and holds console mode `503` and code page `850` through a 15-second watch.

By the time `destroy()` has returned, intervening is already too late: the console is unresponsive ~0.1s in, and a `setRawMode(false)` issued there blocks for 0.7s. A parent process's `GetConsoleMode` on the same window blocks and then fails with **233 `ERROR_PIPE_NOT_CONNECTED`**.

### Things this is _not_

Ruled out by direct measurement, in case they look like candidates:

- **Not the console output code page.** A live sampler saw `outputCP` go 850 → 65001 → 850 across `destroy()` in runs where the console **survived**.
- **Not the shutdown VT blob.** Every surviving keypress run executes the same `performShutdownSequence()`.
- **Not raw mode.** A script that loads no OpenTUI at all reproduces console input mode `520` and survives.
- **Not a timer leak.** The one 5000ms one-shot OpenTUI creates is cleared by `destroy()`; a control clearing every remaining timer afterwards reported `cleared 0 timer(s)` and died anyway.
- **Not `FreeConsole` or a closed handle.** The shipped `@opentui/core-win32-x64@0.4.5` `opentui.dll` imports no `FreeConsole`, `AllocConsole`, `AttachConsole`, `GetStdHandle` or `SetStdHandle`, never opens `CONOUT$`/`CONIN$`, and has no native stdin path.

### Suggested fix

`destroy()` should release the `process.stdin` handle it caused to be created, rather than only pausing it — `unref()` at minimum, and only when the renderer instantiated it (i.e. `this.stdin === process.stdin` and no caller-supplied `config.stdin`). Releasing a handle the caller passed in would be wrong.

### Workaround for anyone hitting this

Release stdin yourself, before calling `destroy()`:

```js
process.stdin.removeAllListeners("data");
if (process.stdin.setRawMode) process.stdin.setRawMode(false);
process.stdin.pause();
process.stdin.unref();
process.stdin.destroy();

renderer.destroy();
```

Ordering is load-bearing: the same five lines after `destroy()` do not help.

### Possibly the same root cause

Several downstream reports describe a terminal or parent shell dying on TUI exit on Windows. They pin `@opentui/core@0.4.5`:

- https://github.com/anomalyco/opencode/issues/30495 — Event Viewer shows `conhost.exe` faulting `0xc0000005`, then pwsh failing on `GetConsoleScreenBufferInfo` with `0xE9` (decimal **233**), matching the error above
- https://github.com/anomalyco/opencode/issues/28673 — user bisect landing on an `@opentui/core` version bump

Happy to run further controls on the same Windows setup if any of this would be more useful in a different form.
````

**Two things in that draft are deliberate — do not "improve" them.** The suggested fix is narrowed to `this.stdin === process.stdin` because releasing a caller-supplied handle would be a regression. And the OpenCode links say _possibly_ the same root cause: that link was inferred from an identical pin and a matching error code, and stock OpenCode was never run in conhost, so do not upgrade it to a claim.

## Step 7 — Close the loop

1. In [ADR 0018](../adr/0018-adopt-opencode-presentation-as-pinned-reduced-vendor.md), replace `— and its URL recorded in this ADR once filed` with the actual issue URL.
2. Delete this handoff file.
3. Commit on `docs/tui-adoption-boundary`. Repo convention is conventional commits scoped by issue, such as `docs(#17): …`, and **no `Co-Authored-By` trailer**.
4. `npm run check` must be green before pushing — one entrypoint covering typecheck, format, lint, 539 tests, the build, and the installed-package smoke.
5. Rebase-merge the pull request with `gh pr merge --rebase`; `main` stays linear.
6. Comment the issue URL on [#17](https://github.com/DevFlow-HQ/devflow-cli/issues/17) so the decision points at its own follow-through.

## Gotcha

`gh issue view` fails in this repository with a Projects-classic GraphQL deprecation error. Use `gh api repos/DevFlow-HQ/devflow-cli/issues/<number>` instead.
