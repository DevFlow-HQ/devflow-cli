# Release Workflow Policy

Read this before changing the release CI workflow's shape or its policy checks — the manual-dispatch candidate validation, the tag-triggered protected
promotion, or the deterministic checks that guard them. Consumer round-trips (archive, package, launcher, installer) are a separate concern in
[release-consumers.md](./release-consumers.md).

One CI gate ([check.yml](../../.github/workflows/check.yml)) owns the release path. Push runs the plain gate, manual dispatch adds the authenticated
npm dry-run, and a `v*` tag push adds protected promotion. Linux `build` assembles one candidate. The three-OS `consumer` matrix downloads each artifact
once per OS and runs seven native scenarios with `continue-on-error`; always-run aggregation fails the job unless every outcome succeeds.
Four parsed-YAML checks in [check-release-workflow.ts](../../tests/architecture/check-release-workflow.ts) own scenario selection, validation, protection,
and promotion. Their `release/…` findings print only through `bun run structure:check`, at `.github/workflows/check.yml:1:1`, with `fix:` and `see:` lines.
Missing or unparseable YAML is a tool error. Synthetic workflow mutations prove each guard on Windows, macOS, and Linux without publishing.

Each three-OS `check` job also runs the `Process runtime conformance` step after other check failures, so it blocks independently of the canonical
links ([testing](./testing.md)). On Windows it skips only when the preceding temp-drive guard fails, keeping that process-heavy step off the system disk.
A workflow-level `concurrency` group per ref cancels a superseded run in progress, except on the default branch and on `v*` tags:
those runs are durable release evidence — the default-branch gate and the tag's promotion — so a newer push must never cancel them.

The release scripts build the candidate once and download those artifacts everywhere else. After approval they never rebuild or repack: every promoted
byte must equal the digest recorded for the approved candidate.

## Check triggers

Check runs on every unfiltered `push`, including branch, default-branch, and `v*` tag pushes, and on `workflow_dispatch`. It has no `pull_request`
trigger. Same-repository pull requests retain the push run on their head commit; fork pull requests receive no CI. This accepted trade-off removes the
duplicate run for each pushed pull-request commit. Default-branch and release-tag runs remain durable under the workflow's concurrency condition.

## Candidate Validation

The `candidate-validation` scenario ([#137](https://github.com/secantdev/secant/issues/137) stories 85/89,
[#157](https://github.com/secantdev/secant/issues/157)) runs the complete gate on one manually dispatched commit: three-OS checks, cross-build/assembly,
compiled-binary and release-channel consumers, terminal lifecycle, evidence contract, and legal closure, against the single Linux-built candidate.
The final `build` step adds an OS-independent authenticated npm dry-run (`scripts/npm-dry-run.ts`), platform packages first and launcher last.
Its `if: github.event_name == 'workflow_dispatch'` confines `secrets.NPM_READONLY_TOKEN`, a read-only identity without publication authority, to dispatch.
`checkValidationWorkflow` proves candidate reuse, dispatch-gated read-only credentials, and no pre-approval publication credential, real publish,
GitHub release, retry, or public-asset path. `tests/release/npm-dry-run.test.ts` proves pure ordering without subprocesses; dispatched CI runs real npm.

## Candidate retention and expiry

Every `build` upload of `binaries`, `release-archives`, and `platform-packages` sets the same explicit `retention-days` expression:

```yaml
retention-days: ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && 35 || github.event_name == 'workflow_dispatch' && 30 || 1 }}
```

This gives ordinary pushes 1 day, manual dispatches 30 days even on a tag ref, and `refs/tags/v*` pushes 35 days. `checkValidationWorkflow` pins this
expression on exactly one upload per bulk artifact under `release/candidate-retention`. The `m12-candidate-retention` scenario proves missing retention,
wrong durations, missing or inverted trigger exceptions, upload omissions/duplicates, the diagnostic, and an induced defect through the structural step.
Failure-only operational logs keep their separate 30-day contract below. Natural expiry is the only routine cleanup; add no deletion job or broader
permission. Existing artifacts keep their recorded expiry; the new configuration does not change historical artifacts retroactively.

A job rerun may reuse the original candidate only while every required artifact remains available and within GitHub's rerun limit. Publication retries
reuse the exact checked and approved bytes. Missing approved bytes stop promotion. Rebuilding or repacking creates a new candidate even at the same
commit, since archive metadata can change digests. Use a complete rerun or fresh validation run for that commit, run the complete gate, produce a new
approval summary, and obtain fresh human approval before promotion. Expiry alone does not require a new tag: tag reuse still requires complete fresh
checks and approval, exact tag/version admission, and publication-conflict checks. Conflicting bytes never replace published GitHub Release assets or
npm packages. Those published copies remain immutable and available independently of temporary Actions artifact expiry.

## Release Protection Policy

The `release-protection-policy` scenario ([#137](https://github.com/secantdev/secant/issues/137) stories 82/90/94/96/97,
[#158](https://github.com/secantdev/secant/issues/158)) adds two tag-gated jobs after the complete `v*` push gate:

- `release-approval` needs every candidate check and holds no credential. `scripts/release-gate.ts` admits only the exact package-version tag,
  then writes tag, commit, version, downloaded candidate digests, committed Shipped Bundle identities/digests (`bundles/builtin.lock.json`, ADR 0029),
  blocking jobs, and `docs/release-checklist.md`. Windows Terminal evidence is fresh when the Bun pin, `@opentui/core` pin, or `src/tui/renderer/`
  changed since the previous tag, otherwise carried forward. Neither the candidate nor locked Bundle bytes are rebuilt.
- `promote` needs `release-approval`, transitively every check, and targets the GitHub `release` environment. Only the sole reviewer's approval
  releases its environment-scoped publication credential to the promotion state machine.

`checkReleaseProtection` proves sole environment placement, the transitive gate, both `v*` conditions, tag/version gate execution, and no pre-approval
publication credential. `tests/release/release-gate.test.ts` proves `tagMatchesVersion`, `windowsTerminalTrigger`, and `formatApprovalSummary` without
subprocesses; only git/env/fs wiring runs in the approval job.

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
and draft-asset behavior without a registry or GitHub connection on the existing Windows, macOS, and Linux check matrix.

## Operational Log Delivery

The three-OS `check` and `consumer` jobs first persist `SECANT_LOG_DIR` through a Bash step into `GITHUB_ENV`. The folder is
`runner.temp/secant-operational-logs`, outside every test home and beside Windows' `secant-tests`, so cleanup cannot remove the evidence.
Use the runner context in the step's `env`, where GitHub permits it; job-level `env` cannot reference `runner.temp`.

Each job ends with one `actions/upload-artifact@v4` step, `Upload failed-job operational logs`, whose artifact `with.name` is
`operational-logs-<job>-${{ matrix.os }}`; it reads `env.SECANT_LOG_DIR`, with `retention-days: 30` and `if-no-files-found: ignore`.
A failure before any Secant invocation leaves no folder or artifact. `check` uploads on `failure()`, after runtime conformance. `consumer` retains its
always-run blocking aggregation as `id: consumer_result` and uploads on `failure() && steps.consumer_result.outcome == 'failure'`.
Successful jobs upload no logs. Keep scenario order, conditions, and `continue-on-error` behavior.

`checkValidationWorkflow` pins the directory setup, final upload shape, and failure trigger through three `release/log-…` rules.
Synthetic fixtures cover missing uploads, wrong triggers and retention, directory placement, and the aggregation's identity and blocking behavior.
The structural step pins each rule's report. Record induced-failure dispatch evidence per OS and an ordinary green run on the implementing issue;
the induced failure stays on the dispatched ref and never enters the default branch. Logs are safe by field allowlist, not by access restriction:
anyone who can read the repository's Actions runs can read these artifacts.

## Human Configuration

Verify these GitHub settings out of band before a real release, alongside #157's read-only token setup:

- The `release` environment has **Rohan as the sole required reviewer**, so a tag cannot promote without his explicit approval.
- `NPM_PUBLISH_TOKEN` is a GitHub **environment secret scoped only to the `release` environment**, never a repository- or organization-level secret — so the
  build, test, candidate, and pre-approval `release-approval` jobs cannot reach it.
