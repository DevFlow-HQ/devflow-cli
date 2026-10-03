# Release Workflow Policy

Read this before changing the release CI workflow's shape or its policy checks — the manual-dispatch candidate validation, the tag-triggered protected
promotion, or the deterministic checks that guard them. Consumer round-trips (archive, package, launcher, installer) are a separate concern in
[release-consumers.md](./release-consumers.md).

The whole release path is **one** CI gate ([check.yml](../../.github/workflows/check.yml)), not a family of workflows. A `push`/`pull_request` run is the
plain gate; a manual dispatch adds the authenticated npm dry-run; a `v*` tag adds the protected promotion. The candidate is assembled once on the Linux
`build` job. One three-OS `consumer` matrix downloads each artifact once per OS and runs the seven native scenarios as named steps; every scenario uses
`continue-on-error`, and an always-run aggregation step fails the job if any outcome is not successful. Three deterministic checks prove the shape over
the parsed YAML (`Bun.YAML`, no dependency) in
[tests/architecture/check-release-workflow.ts](../../tests/architecture/check-release-workflow.ts): `checkValidationWorkflow`, `checkReleaseProtection`,
and `checkReleasePromotion`. They run in the structural step (`bun run structure:check`), the only place their `release/…` violations print, each at
`.github/workflows/check.yml:1:1` with a `fix:` and a `see:` line naming the owning section below. A missing or unparseable workflow fails the step
as a tool error. Each guard is proven under `bun test` by a synthetic workflow that breaks exactly that guard, so the step and the guards' proofs both run
on Windows, macOS, and Linux without publishing.

Each three-OS `check` job also runs the `Process runtime conformance` step after other check failures, so it blocks independently of the canonical
links ([testing](./testing.md)). On Windows it skips only when the preceding temp-drive guard fails, keeping that process-heavy step off the system disk.
A workflow-level `concurrency` group per ref cancels a superseded run in progress, except on the default branch and on `v*` tags:
those runs are durable release evidence — the default-branch gate and the tag's promotion — so a newer push must never cancel them.

The release scripts build the candidate once and download those artifacts everywhere else. After approval they never rebuild or repack: every promoted
byte must equal the digest recorded for the approved candidate.

## Candidate Validation

The `candidate-validation` scenario (spec [#137](https://github.com/secantdev/secant/issues/137) stories 85/89,
[#157](https://github.com/secantdev/secant/issues/157)) is the manual-dispatch mode of the one gate: a `workflow_dispatch` run executes the whole gate on one
commit — the three-OS canonical check, the cross-build/assemble, and the per-OS consumer job's compiled-binary smoke, every release-channel consumer
scenario ([release-consumers.md](./release-consumers.md)), and terminal-lifecycle steps, plus the evidence contract and legal closure — against the single candidate the
`build` job assembles once. It adds the one thing a push/PR run cannot: a separately configured read-only npm identity (`secrets.NPM_READONLY_TOKEN`, no
publication authority) authenticates and publish-dry-runs every platform package first and the launcher last (`scripts/npm-dry-run.ts`), so the npm release
path is proven end to end with no route to publication. The dry-run is registry-facing and OS-independent, so it folds into the `build` job's final step under
`if: github.event_name == 'workflow_dispatch'`, gating the credential to that one manual run rather than paying for its own runner.

`checkValidationWorkflow` proves, over the parsed workflow, that the candidate is assembled once and reused (job dependencies and download-not-rebuild), that
the read-only identity is the only pre-approval secret and is dispatch-gated, and — outside the one protected promotion job below — that no publication credential, real
publish, GitHub-release step, retry, or public-asset path exists anywhere in it. `tests/release/npm-dry-run.test.ts` unit-tests the pure dry-run ordering and
spawns no subprocess; only the real `npm` round-trip runs in the dispatched `build` job.

## Release Protection Policy

The `release-protection-policy` scenario (spec [#137](https://github.com/secantdev/secant/issues/137) stories 82/90/94/96/97,
[#158](https://github.com/secantdev/secant/issues/158)) adds the tag-admission and protected-`release`-environment boundary to the same one gate. A `v*` tag
reruns the whole gate on its commit through the existing `push:` trigger; then two tag-gated jobs promote it:

- `release-approval` depends on every candidate check, so it runs only once they are green. It runs `scripts/release-gate.ts`, which admits the tag **only
  when it exactly equals the package version** — no branch run substitutes — and writes the reviewer's approval summary: tag, commit, version, candidate
  digests (read from the downloaded candidate manifest, never rebuilt), each Shipped Bundle's `id@version` and digest (read from the committed
  `bundles/builtin.lock.json` at the tag commit, never rebuilt — ADR 0029), blocking jobs, checklist reference (`docs/release-checklist.md`), and the Windows
  Terminal evidence trigger (fresh when the Bun pin, `@opentui/core` pin, or `src/tui/renderer/` changed since the previous tag, else carried forward). It
  holds no credential.
- `promote` depends on `release-approval` (and so, transitively, on every candidate check), targets the GitHub `release` environment, and pauses until the sole
  required reviewer approves. Only then does it receive the environment-scoped publication credential and run the promotion state machine below.

`checkReleaseProtection` verifies over the parsed workflow: the promote job targets `environment: release` and is the only job that may declare an
environment; its transitive `needs` closure includes every candidate check; both jobs are gated to a `v*` tag ref and the approval job runs the tag/version
gate; and no publication credential is reachable before the protected boundary. `tests/release/release-gate.test.ts` unit-tests the pure gate logic
(`tagMatchesVersion`, `windowsTerminalTrigger`, `formatApprovalSummary`) and spawns no subprocess; only the git/env/fs wiring runs in the `release-approval`
job.

## Release Promotion State Machine

The `release-promotion-state-machine` scenario (spec [#137](https://github.com/secantdev/secant/issues/137) stories 86-90,
[#159](https://github.com/secantdev/secant/issues/159)) remains inside the same `promote` job and the same one CI gate; it is not another workflow or CI job.
After protected-environment approval, the job downloads the existing `release-archives` and `platform-packages` artifacts and runs
`scripts/release-promote.ts`. The script accepts only a tag-triggered GitHub Actions invocation, checks that the tag exactly matches the candidate version,
re-validates the target identities and cross-manifest version/legal/binary facts, and re-hashes every archive and npm tarball. It never invokes a build,
assembly, or pack command.

Publication then walks every platform package in manifest order and the launcher last. A missing registry version is published; an existing version is
downloaded and succeeds only when its tarball SHA-256 equals the approved candidate. Any conflict or command failure stops before later packages and before
GitHub. Once npm is complete, the script creates or resumes a draft GitHub release, rejects unapproved or byte-conflicting assets, uploads only the approved
archives, checksums, and candidate manifest, and removes draft status last. Thus a failed asset upload stays invisible, while an identical complete rerun is
an idempotent success.

`checkReleasePromotion` proves that the protected job alone names `NPM_PUBLISH_TOKEN`, downloads both approved artifacts, has GitHub release-write permission,
and invokes the one state-machine script. `tests/release/release-promotion.test.ts` proves fresh, partial, identical-rerun, conflict, stop-on-failure, digest,
and draft-asset behavior without a registry or GitHub connection. Because this is ordinary deterministic `bun test` coverage, the named scenario runs on the
existing Windows, macOS, and Linux canonical check matrix without adding a CI gate.

## Operational Log Delivery

The three-OS `check` and `consumer` jobs first persist `SECANT_LOG_DIR` through a Bash step into `GITHUB_ENV`. The folder is
`runner.temp/secant-operational-logs`, outside every test home and beside Windows' `secant-tests`, so cleanup cannot remove the evidence.
Use the runner context in the step's `env`, where GitHub permits it; job-level `env` cannot reference `runner.temp`.

Each job ends with one `actions/upload-artifact@v4` step, `Upload failed-job operational logs`, whose artifact `with.name` is
`operational-logs-<job>-${{ matrix.os }}`; it reads `env.SECANT_LOG_DIR`, with `retention-days: 30` and `if-no-files-found: ignore`.
A failure before any Secant invocation leaves no folder and no artifact.
The `check` upload uses `failure()`, after the always-run runtime conformance step. The `consumer` aggregation keeps `if: always()`
and gains `id: consumer_result`; its upload uses `failure() && steps.consumer_result.outcome == 'failure'`, because scenario steps
continue on error. Successful jobs upload no logs. Keep existing scenario order, conditions, and `continue-on-error` behavior.

`checkValidationWorkflow` pins the directory setup, final upload shape, and failure trigger through three `release/log-…` rules.
Synthetic fixtures cover missing uploads, wrong triggers and retention, directory placement, and the aggregation's identity and blocking behavior.
The structural step pins each rule's report. Record induced-failure dispatch evidence per OS and an ordinary green run on the implementing issue;
the induced failure stays on the dispatched ref and never enters the default branch. Logs are safe by field allowlist, not by access restriction:
anyone who can read the repository's Actions runs can read these artifacts.

## Human Configuration

Two facts live in GitHub settings, not in the repository, and must be configured and verified out of band before a real release (like #157's read-only token
setup, which is likewise documented rather than automated):

- The `release` environment has **Rohan as the sole required reviewer**, so a tag cannot promote without his explicit approval.
- `NPM_PUBLISH_TOKEN` is a GitHub **environment secret scoped only to the `release` environment**, never a repository- or organization-level secret — so the
  build, test, candidate, and pre-approval `release-approval` jobs cannot reach it.

The policy checks prove nothing publishes before the protected job; these two settings prove nothing can publish without the human gate.
