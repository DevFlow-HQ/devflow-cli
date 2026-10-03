# Support Matrix

Every operating system, architecture, and terminal Secant claims to support, each with the evidence that backs the claim. A row without evidence is
not claimed. Mandated by [ADR 0027](./adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md) ("`docs/support-matrix.md` lists every
claimed OS, architecture, and terminal row with its evidence source"); the [refactoring-gate](./agents/milestones.md) checklist requires it current. The three
gated build targets are fixed by [ADR 0030](./adr/0030-ship-the-shell-as-a-bun-compiled-single-file-executable.md), which also removed the
legacy-conhost row.

## Operating systems and architectures

Each cross-compiled single-file binary is built and then smoked on its own operating system inside the canonical three-OS gate, on every push and pull
request. The `build` job cross-compiles all three targets; the `consumer` job's `Compiled-binary smoke` step runs against the matching binary on the
matching runner. The scenarios it covers are enumerated once in [package smoke](./agents/package-smoke.md) — this row does not restate them.

| OS      | Architecture | Binary                   | Evidence                                                                                                                                                                                                            |
| ------- | ------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | x64          | `secant-windows-x64.exe` | `v0.1.0` release candidate, native `Compiled-binary smoke` on `windows-latest`, pass ([run 36236727413](https://github.com/secantdev/secant/actions/runs/36236727413/job/108389876187))                             |
| macOS   | arm64        | `secant-darwin-arm64`    | `v0.1.0` release candidate, native `Compiled-binary smoke` on `macos-latest`, pass including `codesign --verify` ([run 36236727413](https://github.com/secantdev/secant/actions/runs/36236727413/job/108389876224)) |
| Linux   | x64          | `secant-linux-x64`       | `v0.1.0` release candidate, native `Compiled-binary smoke` on `ubuntu-latest`, pass ([run 36236727413](https://github.com/secantdev/secant/actions/runs/36236727413/job/108389876210))                              |

## Terminals

CI cannot drive a real terminal, so terminal support rests on a human-recorded real-terminal check per release (ADR 0027). The re-run path is
`bun run check:windows-terminal` (`scripts/release-checks/windows-terminal.ts`). The `v0.1.0` release recorded a fresh pass against the exact Windows
candidate binary (`c1fab9956073b39ab689793f0a4232260986c521b98106fb28a9bd296ffa9577`).

| Terminal                      | Host                               | Evidence                                                                                                                                                                                                            |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Terminal 1.24.11911.0 | Windows 11 (10.0.26200), Bun 1.4.2 | `v0.1.0` human real-terminal check, pass — quit binding and Ctrl+C both delivered, shell exited, terminal stayed responsive ([#234 report](https://github.com/secantdev/secant/issues/234#issuecomment-5846031965)) |

Legacy conhost is deliberately **not** a claimed row: ADR 0030 removed it. The M6 report observed that the notice appeared and stayed readable until a
keypress, while the window did not survive quit, and the `v0.1.0` report observed the same; those observations do not decide the Windows Terminal outcome.

## Harnesses

Harness support is claimed only from a digest-bound report produced against an
installed, authenticated real Harness. The deterministic Claude Code and Codex
recordings prove Adapter behavior against recorded bytes; they do **not** prove
compatibility with a currently installed Harness and do not support a
real-Harness or three-OS parity claim.

The Steer fixture was refreshed on 2026-10-03 against codex-cli 0.160.0 on Linux x64 for #356. It records `clientUserMessageId` and the matching
`userMessage.clientId`; standalone conformance checks delivery, while synthetic replay covers Interrupt/loss drops and receipt ordering. The leftover
Steer fixtures (`steer-leftover`, `steer-leftover-resend`) were recorded on 2026-10-03 against codex-cli 0.160.0 on Linux x64 for #357: a Steer
taken after the last pending-input check is re-delivered by an empty-input `turn/start` and answered in the same Secant Turn. The re-send fixture
injects the empty-input refusal, which an idle 0.160.0 thread never sends. These recordings qualify those protocol fields, not a full
installed-Harness Proof Bundle pass.

The `v0.1.0` release recorded both Harness passes on Windows x64 against candidate
binary SHA-256 `c1fab9956073b39ab689793f0a4232260986c521b98106fb28a9bd296ffa9577`.
These rows make no macOS, Linux, or cross-operating-system real-Harness claim.

Three-OS replay evidence comes from the `check` job's `Process runtime conformance` step (standalone runtime conformance,
[ADR 0027 amendment 2026-09-21](./adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md);
`tests/process/runtime-conformance.ts`), which drives the real Adapters against recorded-protocol replayers; it is replay evidence, not
installed-Harness evidence. The Codex qualification and defaults recordings (`model/list` efforts and `config/read`, #341) come from codex-cli
0.160.0 and its stable schema. The Codex Turn recordings (completion, two Turns, approval, Steer, Interrupt, resume, and Test Repair) were
re-recorded on 0.160.0 against `codex-probe-3` with each Turn's `thread/read` and, on two Turns, `turn/start` effort (#345); the authentication
recording stays on 0.155.0, and `model/rerouted` is replayed from a synthetic case. The installed-version rows below change only with a new
installed-Harness report.

Recorded versions are replay provenance, not rows: the Claude Code native-interrupt case (`interrupt`, #346) was recorded on Claude Code 2.1.288,
as were the native Steer and compaction cases (`steer-within`, `steer-boundary`, `steer-cancel`, `compaction`, #359) on 2026-10-03 on Linux x64. They
qualify the Steer `uuid`, `command_lifecycle`, `user_message_uuids`, `cancel_queued`, and `compact_result` fields, not an installed-Harness Proof Bundle
pass, while the installed-Harness row below stays at the 2.1.283 that `v0.1.0` checked. Each case's version is in its `recording.json`.

| Harness     | OS/architecture | Installed version | Evidence                                                                                                                                    |
| ----------- | --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Windows x64     | 2.1.283           | `v0.1.0` installed-Harness Proof Bundle check, pass ([#234 report](https://github.com/secantdev/secant/issues/234#issuecomment-5845987175)) |
| Codex       | Windows x64     | 0.155.0           | `v0.1.0` installed-Harness Proof Bundle check, pass ([#234 report](https://github.com/secantdev/secant/issues/234#issuecomment-5846006851)) |
