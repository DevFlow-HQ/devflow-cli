# POSIX native-call policy

Research date: 2026-10-05

Scope: policy evidence for [#387](https://github.com/secantdev/secant/issues/387), traced through parent maps
[#2](https://github.com/secantdev/secant/issues/2) and [#235](https://github.com/secantdev/secant/issues/235).
This note records the research preceding the narrow Process allowance in [ADR 0030](../adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md#posix-root-lifetime-2026-10-05).

## Answer

Secant permits narrowly justified native OS calls. Its policy does not ban POSIX calls permanently or require a helper process to avoid them.
Windows containment earned a private `bun:ffi` allowance through a recorded design decision, demonstrated ownership and lifecycle behavior,
and implementation evidence. That Windows grant did not cover POSIX. The #387 implementation now records its own precise allowance in ADR 0030;
Linux Process Interface and copied-binary proof pass locally, while macOS execution remains part of the mandatory CI matrix.
[Windows resolution](https://github.com/secantdev/secant/issues/259#issuecomment-5890689876),
[current runtime-neutrality policy](../adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md#runtime-neutrality).

## Native dependency and native OS call are different decisions

[#21's dependency decision](https://github.com/secantdev/secant/issues/21#issuecomment-5497308855) prefers suitable built-ins and otherwise trusted
libraries that simplify Secant. Every additional native dependency requires a prior issue decision. Its
[findings](https://github.com/secantdev/secant/issues/21#issuecomment-5496912254) explain the concern: native packages multiply installation failures
and the release-evidence matrix. This remains the policy linked by [dependency guidance](../agents/dependencies.md).

[#59](https://github.com/secantdev/secant/issues/59#issuecomment-5618793207) replaced Node/npm distribution with a Bun-compiled binary and introduced
named runtime-neutrality exceptions. It did not repeal dependency discipline.
The Windows implementation packet explicitly says: "bun:ffi is a Bun built-in under the per-file allowance #259 pre-approves."
It adds no runtime dependency. Calling a platform system library through existing Bun FFI therefore differs from adding an npm native addon,
a bundled shim library, or a new build toolchain.
[#361 packet](https://github.com/secantdev/secant/issues/361#issuecomment-5968876862).

## How Windows earned the exception

1. [#258 research](https://github.com/secantdev/secant/issues/258#issuecomment-5887473614) and its
   [follow-up](https://github.com/secantdev/secant/issues/258#issuecomment-5890209519) established the actual `taskkill` failure and a viable Job Object route.
2. The human accepted [Process ownership](https://github.com/secantdev/secant/issues/259#issuecomment-5890396533). Native handles, launch machinery,
   streamed stdio, and cleanup stay private behind existing opaque Interfaces. Harness owns recovery and native terminal evidence.
3. [#259's resolution](https://github.com/secantdev/secant/issues/259#issuecomment-5890689876) states: "A cohesive private Windows implementation may
   earn a narrow per-file `bun:ffi` allowlist entry; this does not approve a new native package or loosen other import directions."
4. [#235](https://github.com/secantdev/secant/issues/235) records that decision. The
   [second Amendment approval](https://github.com/secantdev/secant/issues/249#issuecomment-5945230402) places it within M9.
5. [#361 completion](https://github.com/secantdev/secant/issues/361#issuecomment-5970565099) records the private implementation, updated ADR and check,
   no new dependency, successful three-OS CI and consumer acceptance. Its
   [exit-lifetime correction](https://github.com/secantdev/secant/issues/361#issuecomment-5970866985) proves why stream EOF alone cannot establish descendant death.

Windows' specific fallback policy was a human product decision. It does not automatically authorize a POSIX fallback with weaker cleanup guarantees.
[#259 resolution](https://github.com/secantdev/secant/issues/259#issuecomment-5890689876).

## Conditions for a POSIX proposal

The following is the route inferred from the existing rules and Windows precedent, not an approved POSIX design:

- Identify exact OS calls and the lifecycle invariant they establish. Show why a suitable existing built-in does not cover the need cleanly.
  Compare complexity against the helper design without asserting an unmeasured memory or latency advantage.
- Keep native resources and platform differences private to Process. Preserve existing normalized results, root-exit evidence, bounded cleanup,
  and truthful child facts. No native handles or OS-specific values cross the Process Interface.
- Prove the required identity guarantee on both supported POSIX targets. FFI availability alone does not prove that Linux and macOS offer
  equivalent lifetime guarantees.
- Surface the ADR conflict and record a narrow design decision before production use. Update the affected paragraph with a date,
  following [guidance maintenance](../agents/guidance.md#maintenance).
- Amend ADR 0030, the exact per-file and per-API `BUN_API_ALLOWLIST` in
  [the provenance check](../../tests/architecture/check-vendor-provenance.ts), and
  [topology's native-file inventory](../agents/topology.md). Update Process guidance when the actual lifecycle contract changes.
  The check deliberately rejects another API or another file without its named ADR allowance.
- Meet #387's deterministic standalone timeout, cancel, shutdown, descendant-death, attribution, and identity-reuse evidence, with Linux x64
  and macOS arm64 conformance and unchanged Windows coverage. Preserve three-OS canonical and compiled-consumer gates.
  [#387 acceptance and packet](https://github.com/secantdev/secant/issues/387#issuecomment-5990178494).

The original packet says no new runtime dependency and retains Node facilities inside Process. It contained no explicit prohibition on POSIX FFI
and granted no POSIX allowance. The implementation reconciles that packet through the named private-file amendment, preserving all Process Interfaces
and the existing OS gates. This is a finite lifecycle allowance, not a blanket native-call waiver.

## Concrete POSIX candidate and evidence

A no-helper candidate is to own native launch and root waiting inside Process: `posix_spawn` creates the isolated session/group;
`waitid(WEXITED | WNOWAIT)` observes native exit without releasing the root; cleanup signals the still-reserved group;
all signal authority retires before `waitpid` finally releases the root. This preserves a real exited-root identity rather than inferring
identity from open output pipes. It cannot be added only to the current Node-managed child, whose existing reaper already consumes root exit.
[POSIX ID reuse](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap04.html#tag_04_17),
[wait semantics](https://man7.org/linux/man-pages/man2/waitpid.2.html).

On 2026-10-05, a supervised Linux x64 probe using Bun 1.4.2 and direct `bun:ffi` calls to host libc passed both root outcomes:
normal status 17 and native SIGTERM. It retained each root as a zombie, observed no `VmRSS` entry for that exited root,
killed the pipe-holding descendant through its original group, observed pipe EOF and descendant death, and released the root once.
A runtime-managed synchronous child executed between two native exit observations without consuming the retained root.
Independent review caught a cleanup signal after final reap; authority now retires before reap, and the corrected rerun passes.
The probe uses only research files under `/tmp/secant-387-design/`, not production imports or a granted production allowance.
It proves the mechanism on this Linux host, not full Process integration or portable acceptance.

A separate Bun helper probe measured four helpers after root exit. Each had 26,052–26,156 KiB RSS, 8,232–8,254 KiB PSS,
and 5,132–5,152 KiB private dirty memory from `/proc/<pid>/smaps_rollup`. RSS includes shared mappings and must not be treated
as wholly incremental physical memory. The native candidate removes that extra live runtime process; it still allocates native buffers,
descriptors and temporary kernel bookkeeping. No native implementation memory total or latency advantage was measured.

Apple source supports the mechanism: WNOWAIT skips reaping, and final reap removes the root from its process group and PID hash.
PID allocation refuses identities still present in those hashes, including zombies. Darwin exposes native session creation and opaque
spawn-attribute/file-action handles; its constants and wait-result ABI differ from glibc. This is source feasibility, not macOS measurement.
[Exit observation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exit.c#L2984-L3019),
[final release](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exit.c#L2601-L2616),
[PID allocation](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_fork.c#L947-L972),
[spawn flags](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/spawn.h#L53-L67).

The adoption checks cover event-loop exit observation, stdio/backpressure integration, argv/env/cwd delivery, pre-execution cleanup,
shared timeout/interrupt/shutdown bounds, and relocated binary behavior on macOS and Linux. The research probe busy-polls native exit and
reads a raw descriptor to isolate lifetime. Production uses accepted Unix-socket peers with ordinary Node streams and SIGCHLD plus yielding
25 ms targeted probes. Bun's arbitrary descriptor-backed Socket import did not deliver readiness and was discarded. The accepted-socket probe
and Process conformance passed on Linux. No retries or timeout increases converted the failed descriptor probe into acceptance.

The native owner must be the only reaper of these roots. Ordinary pinned Bun waits on registered PIDs, but its special no-orphans sync
mode can wait on any child. That watchdog defaults off but can be enabled through inherited
`BUN_FEATURE_FLAG_NO_ORPHANS`, including in a compiled binary. A second small Linux probe retained its native root across
Node and Bun synchronous spawns with that flag enabled, so the broad-wait concern is not a reproduced blocker. Automatic reaping through SIGCHLD ignore/SA_NOCLDWAIT also defeats retention. Verify or exclude those modes;
an unexpected ownership loss retires numeric signal authority and reports cleanup failure. A retained zombie itself keeps the group
present, so `kill(-pgid, 0)` is not a descendant-death test. Escaped descendants remain outside POSIX group containment.
[Pinned Bun process implementation](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/spawn/process.rs),
[watchdog activation](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/io/ParentDeathWatchdog.rs#L202),
[wait semantics and automatic reaping](https://man7.org/linux/man-pages/man2/waitpid.2.html).

The concrete allowance under consideration is `bun:ffi` in one private Process file for this finite native launch/wait lifecycle,
with no new package, helper executable, CLI mode, or general native-call permission. The implementation decision is now recorded in ADR 0030. Local Linux event/stdio and Process Interface conformance pass; macOS runtime qualification remains CI evidence, not a claim from source feasibility.

## macOS CI root-cause qualification

The first full matrix passed macOS copied-binary and consumer acceptance but exposed runtime-only edges. Nested supervisor TMPDIR paths exceeded
Darwin's 104-byte Unix socket address capacity. A regression preserves the long authored cwd, argv, environment and TMPDIR while only private
socket acquisition chooses a short path; restoring the original selection makes the regression fail.

Bun 1.4.2's kqueue loop reports ordinary write-side EV_EOF as a connection reset for a full-duplex socket. Marking the parent output endpoint
write-shut before launch moves it to the shutdown path, which ignores zero-error write EOF while retaining real errors. Native stdin/output
use one owner per half-close: child stdin closes its write half, and parent output closes its write half, placing the peer read half at EOF.
This fixes the stream lifecycle without filtering ECONNRESET.
[Pinned kqueue EOF handling](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-usockets/src/eventing/epoll_kqueue.c#L363-L387),
[reset translation](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-usockets/src/loop.c#L911-L926),
[socket shutdown](https://github.com/oven-sh/bun/blob/bun-v1.4.2/packages/bun-usockets/src/socket.c#L717-L724).

Darwin's explicit-group kill skips zombie members and returns EPERM when no eligible member remains. An escaped pipe holder therefore reports
that native cleanup error against the retained root-only group; Linux reports the bounded drain timeout. The fixture asserts each exact result
and confirms the escaped descendant remains alive until its own release handshake. Production preserves the native error.
[Darwin group signalling](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c#L1709-L1718).

The first correction's explicit peer SHUT_RD was redundant after awaiting parent write shutdown. XNU `unp_shutdown` already marks that peer
SS_CANTRCVMORE; `soshutdownlock_final` then rejects a second read shutdown with ENOTCONN. The resulting pre-launch error reproduced in Codex and
Claude version probes. Removing the redundant operation preserves EOF ordering and real-error propagation, rather than accepting ENOTCONN as success.
[Peer EOF transition](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c#L2222-L2233),
[duplicate-shutdown rejection](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_socket.c#L4343-L4356).
