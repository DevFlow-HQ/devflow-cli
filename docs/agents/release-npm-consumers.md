# npm Channel Consumers

Read before changing the platform-package or npm launcher consumer step, or the packing scripts they verify. [Release consumers](./release-consumers.md)
owns the per-OS `consumer` job, the release archive, and legal closure.

## Platform Package Consumer

The `Platform package consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the three per-platform npm packages (`scripts/pack.ts`,
#151) as an npm consumer receives them. Packing runs once on the Linux `build` job after assembly: `scripts/pack.ts` reads the archive candidate manifest
(`scripts/assemble.ts`), fails closed unless every dist binary and the legal material are byte-identical to that candidate, and emits one exact-version,
os/cpu-constrained npm tarball per target (built with `bun pm pack`, so the npm channel needs no Node toolchain) plus a `package-manifest.json`. Each
package carries only its executable, `LICENSE`, and `THIRD-PARTY-NOTICES.md`, with no lifecycle script. On the Windows x64, macOS arm64, and Linux x64
matrix, `scripts/package-consumer.ts` installs the matching package with `npm install --ignore-scripts` (npm is the channel under test) and proves its
os/cpu constraint, exact version, contents, the absence of a lifecycle script, inner-binary digest against the archive candidate, executable mode, native
execution and version, and — on macOS — the strict ad-hoc signature. `tests/release/pack.test.ts` unit-tests the pure logic — the package.json shape
(`platformPackageJson`), the byte-identity anchoring to the archive candidate (`computePackages`), the immutability/identity/version/digest checks
(`assertPackagesAgree`), the consumer's pre-install refusals (unknown target, wrong host, tampered/missing/malformed manifest), and its installed-contents
refusals against a hand-staged directory (stale version, lifecycle script, unexpected/missing/tampered files, inner-binary digest, executable mode via
`verifyInstalledPackage`) — and spawns no subprocess. Only the `bun pm pack` → `npm install` → run
round-trip on real binaries (npm's own os/cpu gating, mode preservation, native execution, macOS signature) is left to this CI job.

Platform-package cleanup failures stay blocking and retain any earlier verification error. Their stderr report records the verification phase, child
PIDs and exit statuses, and remaining install-tree entries; an unreadable tree cannot replace the cleanup error. A Windows `EBUSY` at cleanup alone
does not establish which process held the lock. Preserve this evidence before changing lifecycle behavior.

## npm Launcher Consumer

The `npm launcher consumer` step ([check.yml](../../.github/workflows/check.yml)) verifies the thin, script-free npm launcher `@secantdev/secant`
(`bin/secant.mjs`, packed by `scripts/pack-launcher.ts`, #152) as a consumer receives it. Packing runs once on the Linux `build` job after the platform
packages: `scripts/pack-launcher.ts` pins the assembled release version, generates the host-key → package/executable map from the one target manifest
(`scripts/targets.ts`), and stages the Node launcher, that map, and the legal material — no candidate executable, exact-version `optionalDependencies` on
all three platform packages, and no lifecycle script — into one tarball beside them in the `platform-packages` artifact. On the Windows x64, macOS arm64,
and Linux x64 matrix, `scripts/launcher-consumer.ts` installs the launcher and the matching platform package with `npm install --ignore-scripts`
(`--omit=optional`, so the install is network-free; npm is the channel under test) and proves: argument/stdio/native-exit forwarding under an npm-flat
layout and under a pnpm-symlinked layout (the platform package is not hoisted, so resolution only works because the launcher canonicalizes its own path);
the before-spawn missing-optional-package diagnostic; and — the acceptance seam — the Proof Bundle smoke (the M3 gate) completed end to end THROUGH the
launched command: build + install the Test Repair Proof Bundle, launch it against the recorded Claude Code replayer to its authored Human Gate, and once
answered reach `succeeded` and make the authored commit. `tests/release/launcher.test.ts` unit-tests the pure logic — the launcher package.json shape
(`launcherPackageJson`), the host-key map (`launcherPlatforms`), and the launcher's own target selection and before-spawn diagnostics (`selectTarget`,
`resolveExecutable`, with an injected resolver) — and spawns no subprocess. Only the
install → launch → Proof Bundle round-trip on real binaries is left to this CI job. Real-platform unsupported-target detection is not exercised here
(a real spawn cannot spoof `process.platform`); the `selectTarget` unsupported branch is proven deterministically in `bun test` instead.
