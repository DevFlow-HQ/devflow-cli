# Installer Consumers

Read before changing the PowerShell or POSIX installer consumer step, or the installers they verify. [Release consumers](./release-consumers.md)
owns the per-OS `consumer` job, the release archive, and legal closure.

## PowerShell Installer Consumer

The `PowerShell installer consumer` step ([check.yml](../../.github/workflows/check.yml)) supplies the assembled candidate through a network-free
local-candidate seam. The macOS arm64 and Linux x64 legs exercise native unsupported-target detection before candidate access. The Windows x64 leg installs
into an isolated home, runs the installed executable, exercises latest and exact versions with their five phase lines in order on stdout, executes the
declined PATH instruction twice, and checks idempotent default PATH changes. It preserves the installed bytes across missing input (failing with its phase
and path), malformed manifest/version, target-identity, checksum, layout, inner-binary, legal-material, and executable-version failures, including a
well-formed candidate whose `--version` never exits: the installer kills it at the 30 s bound and leaves no probe running. That hanging stand-in is compiled
by the CI step before both installer consumers (Git Bash and the pinned Bun, from source written at run time); the scenario itself needs only native
PowerShell, no Git Bash, Node, Bun, credentials, or network. Every child run has an outer bound, so a regression fails the step instead of holding the leg. A
directory-swap failure is deliberately not induced: doing so deterministically would require a private installer hook or an inherently racy Windows file
lock. The installer runs its `--version` probe on a digest-checked copy outside the stage, never the staged executable: Windows can hold a just-executed
image briefly, which failed the stage rename (a sharing violation in CI, #216). CI runs only `pwsh`, so the Windows PowerShell 5.1 path is a named gap.

## POSIX Installer Consumer

The `POSIX installer consumer` step ([check.yml](../../.github/workflows/check.yml)) runs `scripts/posix-installer-consumer.sh` (the POSIX sibling of
`scripts/powershell-installer-consumer.ps1`) to give root `install.sh` the local candidate without a product runtime. On macOS arm64 and Linux x64 the
`supported` scenario installs the real candidate under fixed `~/.secant/bin` in an isolated home and proves: the executable runs and reports the candidate
version, the five phase lines print in order for latest and exact versions, `LICENSE`/`THIRD-PARTY-NOTICES.md` are installed while `SECANT_HOME` is not
used as the install root, the declined-PATH instruction is printed (with macOS Terminal guidance), exact-version selection accepts the matching version
and rejects a mismatch, and PATH modification is idempotent. It then tampers a local copy to prove a missing file (failing with its phase and path), a
malformed candidate — a checksum, archive-layout, manifest-version, or legal-material fault — or the hanging stand-in (strictly signed on macOS, killed at
the 30 s bound, no probe left running, under the scenario's own outer bound) is refused while the existing installation is preserved, each assertion naming
its scenario on failure. Windows x64 runs the `unsupported` scenario, proving only refusal before candidate access. This restores at the compiled-binary
layer the coverage the deterministic `tests/release/posix-installer.test.ts` suite carried before it was retired in the #185 subprocess-test migration so
the semantic suite spawns no child; the install, replacement, and tamper round-trips on the real binary live only in this CI job, the way the
compiled-binary smoke ([testing](./testing.md)) lives outside `bun test`.

Download timeouts and retries are a named gap in both installers: inducing a stalled network deterministically would need a private installer hook, which
they deliberately lack, so the native curl and `Invoke-WebRequest` bounds are proven only by review of the flags (curl's `--max-time` restarts per retry).
