# Release-Channel Consumer Verification

Read this before changing a release-channel consumer scenario — the archive, platform-package, npm-launcher, or installer steps — or the scripts and CI
they run through.

Each shipped release channel is verified on the Windows x64, macOS arm64, and Linux x64 matrix (ADR 0027) by a named step of the per-OS `consumer`
job in [check.yml](../../.github/workflows/check.yml), driving the channel exactly as a consumer receives it. The job's shape (one download per
artifact, `continue-on-error` scenarios, the always-run aggregation) is owned by [release-workflow.md](./release-workflow.md); the evidence layers,
including why the semantic suite never reaches a real child, by [testing](./testing.md). Release-channel pure logic is unit-tested under `bun test`
in `tests/release/` with no subprocess; every real round-trip on real binaries lives only in the consumer job, like the compiled-binary smoke.

Before changing the platform-package or npm launcher consumer, read [npm channel consumers](./release-npm-consumers.md); before changing either
installer consumer, read [installer consumers](./release-installers.md).

## Release Archive Consumer

Separate from the package smoke, the `Release archive consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the assembled release
archives (`scripts/assemble.ts`, #150) as a consumer receives them. Assembly runs once on the Linux `build` job, emitting the three archives, a
candidate manifest, and `SHA256SUMS`; it never rebuilds an input and fails closed on any identity/version/digest disagreement. On the Windows x64,
macOS arm64, and Linux x64 matrix, `scripts/release-consumer.ts`
extracts the matching archive and proves layout, executable mode, inner-binary digest, bundled `LICENSE`/`THIRD-PARTY-NOTICES.md`, native execution and
version, and — on macOS — the strict ad-hoc signature. `tests/release/assemble.test.ts` unit-tests the pure logic — manifest facts and digests
(`computeCandidate`), the immutability/identity/version/digest checks (`assertAgrees`), and the consumer's pre-extraction refusals — and spawns no
subprocess. The archive create → extract → run round-trip on real binaries is proven only by this CI job.

## Release Legal Closure

The M4 artifact-level legal gate (spec [#137](https://github.com/secantdev/secant/issues/137) stories 99/100,
[#156](https://github.com/secantdev/secant/issues/156)) extends the fast declared-dependency notices check — `checkNoticesCoverage` in
[tests/architecture/check-vendor-provenance.ts](../../tests/architecture/check-vendor-provenance.ts), which **stays** in `bun run check` — into a
target-specific release gate. Unlike the channel consumers it is OS-independent (text and digest comparison, no binary to run), so it needs no matrix:
it runs once on the Linux `build` job (`scripts/inventory.ts`, after packing and before the dispatch-gated npm dry-run that
[release-workflow.md](./release-workflow.md) owns), the one place that has cross-compiled every target and installed every platform's @opentui native,
and it spawns no child process. It derives the transitive
runtime closure **actually embedded** per target from the actual compiler inputs (a real `Bun.build` of the shared build input, walked through the
sourcemap `sources`, each embedded file's version and licence read from the package that owns it on disk — the deepest `node_modules/` segment, so a
hoisted or nested duplicate reports the bytes actually shipped), adds the one `@opentui/core-<os>-<cpu>` native per target from the one target manifest
(`scripts/targets.ts`), names the embedded Bun runtime and vendored OpenCode subset as fixed members, and unions the three targets. It then verifies:
that `THIRD-PARTY-NOTICES.md` covers that union — every shipped component named, its shipped version named, and its licence family's text present,
failing closed on a missing component, a stale version, or an unrecognised licence identity — and that the source-of-truth legal material is what every
channel staged, by comparing each channel manifest's `licenseSha256`/`noticesSha256` (release archives, platform packages, launcher package) against the
repository files. The sibling consumer steps already prove the physical bytes in each channel match those manifest digests (and the installer results the
archive's), so this need not re-extract them. Harmless historical or grouped extra notices are tolerated (a named entry no longer in the closure, e.g.
`bun-ffi-structs`, does not fail). Licence identity is verified at licence-family granularity — an unrecognised SPDX identity fails closed, but a
per-package prose mislabel within a known family is a named limitation, not caught. `tests/release/legal-closure.test.ts` unit-tests the pure logic
(`verifyClosureNotices`, `verifyChannelLegalDigests`, `packageDirOfSource`, `nativePackageFor`) and spawns no subprocess; only the closure derivation (a
real build) runs in the `build` job. The embedded ripgrep closure comes from pinned official members and target-specific upstream Cargo trees.
Build and inventory verify the matching member's complete bytes in each candidate; `dist/legal-inventory.json` records that evidence per target.
`m10-audit-embedded-ripgrep-release` tests scoped licence admission and complete component notices on all three OSes; package smoke proves extraction.

The manual-dispatch candidate validation and the tag-triggered protected promotion are workflow-shape policy, not consumer round-trips; they live in
[release-workflow.md](./release-workflow.md).
