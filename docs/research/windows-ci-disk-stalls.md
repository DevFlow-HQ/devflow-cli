# Windows CI Disk Stalls

Research date: 2026-09-30

Environment: GitHub-hosted `windows-latest` runners, image `windows-2025-vs2026` (versions `20260922.246.2` and `20260925.250.1`), runner
`2.337.0`, Bun `1.4.2+744846f84`, suite at `fb3ee06` (1,074 tests across 91 files).

Tickets: [Determine the cause and gate response for intermittent Windows CI failures](https://github.com/secantdev/secant/issues/274)
([resolution](https://github.com/secantdev/secant/issues/274#issuecomment-5911415757),
[two-worker addendum](https://github.com/secantdev/secant/issues/274#issuecomment-5911671537)). The fix is
[M7: Keep Windows test temp files off the runner's system disk](https://github.com/secantdev/secant/issues/299) (merge `736348a`). The run logs and
artifacts cited here expire on 2026-12-29. This note keeps the numbers and the tooling so the investigation can be repeated without them.

## How to recognise it

A Windows-only Check failure is probably this stall when every one of these holds:

- **Windows only.** The same commit passes on Linux and macOS, and a Windows rerun, or the twin push/PR run, usually passes.
- **Timeouts across unrelated files.** Bun's `this test timed out after 30000ms` fires in 3–4 files at once, all of them using temp directories
  and a real SQLite Run Store or Catalog.
- **Timers fire late.** A test with a median of 1–6 s reports 30–159 s, so its timer fired up to about 129 s late.
- **All workers go quiet together.** Every worker stops printing for 60–200 s. Passing jobs never go quiet for more than about 38 s.
- **The slow pair.** `run-list` "pages are bounded" and `execution` "an authored interval above the engine ceiling" come close to or exceed
  30 s.
- **Runtime conformance.** `matt-front-replayer-workbench did not settle within 20 seconds`, in a job whose Test step was already slow.
- **Knock-on failures.** A test fails right after a timed-out test in the same file, because the timed-out test's late cleanup changed shared
  state such as an environment variable.

A fast, deterministic failure is something else. The Codex approval `1 !== 2` in `[codex-approval-contract]` is an ordering race, resolved
separately in the same ticket.

## Cause

On Windows, `TEMP` pointed at `C:\Users\RUNNER~1\AppData\Local\Temp`, on the runner's OS disk. The runner also has a separate temp drive:
`RUNNER_TEMP` is `D:\a\_temp`, and both drives are `Msft Virtual Disk`.

The semantic suite makes about 60,000–85,000 disk writes per run: temp directories plus per-test SQLite databases in rollback-journal mode. That
workload always saturated C:, even on healthy runs:

- about 300–360 writes/s at about 10 ms per write;
- 0% idle time;
- about 345 writes/s with either two or three workers, so the ceiling does not move.

Sometimes C:'s throughput collapses. In the reproduced failure it fell to 4–26 writes/s at 200–650 ms per write, with peaks of 1.7 s, for 68 s
(12:07:51–12:08:56 UTC). The queue stayed at 5–11 and every Bun worker's CPU dropped to about 0. Every worker waits on the disk, so all of them
freeze at once, and any test in flight overruns its 30 s bound.

## Evidence

The runs used one throwaway Windows-only workflow on one commit, changing one variable at a time.

| Pass (run)                                                                                 | Variant                     | Jobs  | Test step            | Failed             | `run-list` "pages are bounded" |
| ------------------------------------------------------------------------------------------ | --------------------------- | ----- | -------------------- | ------------------ | ------------------------------ |
| 2 ([36712430959](https://github.com/secantdev/secant/actions/runs/36712430959))            | TEMP on C:, 3 workers       | 5     | 248–277 s, one 536 s | 1 (4 timeouts)     | 14.8–31.9 s                    |
| 2                                                                                          | TEMP on D:, 3 workers       | 5     | 80–104 s             | 0                  | 0.6–2.2 s                      |
| 3 ([36716329443](https://github.com/secantdev/secant/actions/runs/36716329443))            | TEMP on C:, 3 workers       | 5     | 235–371 s            | 1 (32.5 s timeout) | ~16 s                          |
| 3                                                                                          | TEMP on C:, 2 workers       | 5     | 216–332 s            | 0; one 10 s stall  | ~7.6 s                         |
| 1 ([36711823094](https://github.com/secantdev/secant/actions/runs/36711823094), cut short) | TEMP on D: / 1 worker on C: | 2 / 1 | 74–103 s / 176 s     | 0                  | 0.6–0.7 s / 2.9 s              |

- **Baseline.** Ordinary Check runs from 2026-09-27 to 2026-09-30 failed on attempt 1 in 14 of 72 Windows jobs (19%), and in none on Linux or
  macOS. Across passes 2 and 3 the controls failed 2 of 10.
- **After the fix.** The first eight Windows Check jobs on `main` and PRs after `736348a` all passed on attempt 1. The whole Windows job took
  4.2–5.9 min, down from 7.3–15.2 min, and the Test step took 40–104 s with the full test count.
- **Matt-front scenario.** 2.3–2.5 s on D:, against 3.5–7.5 s on C:, with a passing-run tail up to 22.5 s.

## Ruled out

- **Defender.** `Get-MpComputerStatus` reports `RealTimeProtectionEnabled: false` on the image. Defender (`MsMpEng`) used about 0 CPU during stalls.
- **CPU starvation.** Total CPU stayed at about 3–25% during a stall. Typecheck durations did not change in failing jobs.
- **Bun child-lifecycle loss** ([#149](https://github.com/secantdev/secant/issues/149)). The timed-out files spawn no children.
  - The one `killed 1 dangling process` line came from `live-run-workbench.test.tsx`: its real Process spawns `where.exe` and a `--version`
    probe, because `codex` and `claude` are not on the runner PATH. That is a separate leak.
  - [#172](https://github.com/secantdev/secant/issues/172)'s three-worker rejection was one untraced run with the same 30 s timeout signature.
- **Worker count.** Two workers stalled too and finished in the same wall time. Earlier worker-count evidence
  ([#172](https://github.com/secantdev/secant/issues/172), [#198](https://github.com/secantdev/secant/issues/198)) was one run per commit, with
  noise larger than any worker effect.
- **Commit content.** Every failing commit in the audit was docs, research, or a prototype, and the test code was unchanged across them.

## Fix in place

The Windows `check` job resolves `RUNNER_TEMP` and fails with a message naming both paths when it is on `SystemDrive`. Otherwise it exports
`TEMP` and `TMP` as `RUNNER_TEMP\secant-tests`, and runtime conformance runs only when that step succeeded. Three workers, the 30 s test bound, and
the 20 s scenario bound are unchanged.

Acceptance is the next 30 first-attempt Windows Check jobs after `736348a`, counted by `Audit: M7`. Any first-attempt Windows failure reopens this.

## If it comes back

1. **Check the guard ran.** The Windows log should show `Windows test TEMP and TMP: D:\...`. If a new image has no separate temp drive, the guard
   fails by design; decide the next place for temp files, and do not remove the guard.
2. **Match the signature above.** Count first-attempt failures across ordinary runs rather than rerunning.
3. **Re-measure on one commit.** Push a throwaway branch that runs the workflow sketched below, and stop `check.yml` running on it with
   `branches-ignore` under `push`. The release-workflow policy check reads only trigger names, so it stays green.
   - Start with the smallest informative batch: a control and one variant, 5 jobs each, in one parallel wave of about 10 minutes.
   - Make rep the outer matrix key so each wave mixes variants in time.
4. **Compare continuous measures, not pass counts.**
   - Test-step duration and the slow pair's durations, from `bun test --reporter=junit --reporter-outfile=<file>`, which keeps console output.
   - Per-second disk writes, latency, and queue for each drive during the Test step.
   - Stall windows. Count a stall as 10 or more consecutive samples in which summed `bun.exe` CPU grows by under 0.05 s, and only inside the Test
     step's own start and end times: conformance scenarios such as `store-locked-coordination` wait on purpose.
5. **Locate conformance stalls.** Print a streamed marker, for example `[diag-stage] +<ms> <stage>`, to stderr before each stage. The last marker
   printed then names the stage even when a synchronous child blocks the event loop and the scenario timer cannot fire.

### Host sampler

Save it as `diag/sampler.ps1` and start it before Test with
`Start-Process pwsh -ArgumentList '-NoProfile','-File','diag\sampler.ps1','-Out',"$dir\samples.jsonl",'-StopFile',"$dir\stop" -WindowStyle Hidden`.
It survives across steps until the job ends. Create the stop file after the last measured step, then upload the directory as an artifact.

```powershell
# DIAGNOSTIC (#274, throwaway branch): one-second host sampler for the Windows
# Test step. Writes JSON lines: monotonic ms since start, UTC time, per-drive disk
# latency/queue/idle, total CPU, and per-process CPU and I/O totals for bun, git,
# where, and Defender (MsMpEng). Stops when the stop file appears.
param([string]$Out, [string]$StopFile)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$counters = @(
  '\PhysicalDisk(*)\Avg. Disk sec/Write',
  '\PhysicalDisk(*)\Avg. Disk sec/Read',
  '\PhysicalDisk(*)\Current Disk Queue Length',
  '\PhysicalDisk(*)\% Idle Time',
  '\PhysicalDisk(*)\Disk Writes/sec',
  '\Processor(_Total)\% Processor Time',
  '\Memory\Available MBytes'
)
$filter = "Name='bun.exe' OR Name='git.exe' OR Name='where.exe' OR Name='MsMpEng.exe' OR Name='conhost.exe'"

while (-not (Test-Path $StopFile)) {
  $record = [ordered]@{ ms = $sw.ElapsedMilliseconds; utc = (Get-Date).ToUniversalTime().ToString('o') }
  try {
    $sample = Get-Counter -Counter $counters -MaxSamples 1 -ErrorAction Stop
    $values = @{}
    foreach ($c in $sample.CounterSamples) { $values[$c.Path -replace '^\\\\[^\\]+', ''] = [math]::Round($c.CookedValue, 5) }
    $record.counters = $values
  } catch { $record.counterError = $_.Exception.Message }
  try {
    $record.procs = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction Stop | ForEach-Object {
      [ordered]@{
        pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name
        cpu100ns = [int64]$_.KernelModeTime + [int64]$_.UserModeTime
        rd = [int64]$_.ReadTransferCount; wr = [int64]$_.WriteTransferCount
        ws = [int64]$_.WorkingSetSize
      }
    })
  } catch { $record.procError = $_.Exception.Message }
  $record.sampleMs = $sw.ElapsedMilliseconds - $record.ms
  Add-Content -Path $Out -Value ($record | ConvertTo-Json -Compress -Depth 5)
}
```

### Workflow sketch

```yaml
on:
  push:
    branches: [<throwaway-branch>]
jobs:
  diag:
    strategy:
      fail-fast: false
      matrix:
        rep: [1, 2, 3, 4, 5]
        variant: [control, <one-variable-change>]
    runs-on: windows-latest
    timeout-minutes: 45
    steps:
      # checkout, setup-bun (bun-version-file: package.json), bun install --frozen-lockfile
      # Probe: ImageVersion, TEMP, RUNNER_TEMP, Get-PSDrive, Get-PhysicalDisk, Get-MpComputerStatus, Get-Command codex/claude -> probe.json
      # Apply the variant, e.g. "TEMP=$env:RUNNER_TEMP\tmp" and "TMP=..." >> $env:GITHUB_ENV, or a DIAG_WORKERS count
      # The gate steps before Test (migrations:check, typecheck, format:check, lint), so the disk meets Test in the usual state
      # Start the host sampler
      # Test: bun test "--parallel=$env:DIAG_WORKERS" --timeout 30000 --reporter=junit "--reporter-outfile=$dir\junit.xml"
      #       (continue-on-error: true, so later steps still run)
      # Process runtime conformance (if: always(), continue-on-error: true)
      # Stop the sampler, upload probe.json, samples.jsonl, and junit.xml, then fail the job if Test or conformance failed
```

## Still unknown

- Whether D: ever stalls. Eight clean post-fix jobs cannot show zero; the 30-run count answers it.
- Whether future `windows-latest` images keep a separate temp drive. The guard makes that loud.
- What throttles C: on the storage side. From inside the VM it shows only as low throughput with high latency, and it does not follow our write
  rate.
