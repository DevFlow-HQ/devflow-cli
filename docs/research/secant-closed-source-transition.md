# Secant's closed-source transition before the next release

Researched 2026-10-07 for [Chart the fixes Secant needs before its public release](https://github.com/secantdev/secant/issues/235). The maintainer has decided that the source becomes private before the next release. Downloads remain free and anonymous, including npm. The monthly ceiling is $21 at the present one-user scale, with a preference for the plan offering 50,000 CI minutes. That plan is Enterprise Cloud, not Team. This report recommends a route; it does not approve a purchase, hosting provider, license text, or production migration.

## Recommendation

Keep development private and distribution public. Put the installation contract on Secant's domain so users never need to know which provider stores a release. For the smallest cutover, create an independent public `secantdev/secant-releases` repository, copy the five existing v0.1.0 assets unchanged, keep npm public, and expose installers through `secant.sh`.

Use Enterprise Cloud as the preferred CI design, subject to confirming actual one-user terms and allowance accounting within the $21 monthly ceiling. It preserves the current required-reviewer gate inside the private source repository and advertises a much larger Actions allowance. At Secant's observed CI frequency, total compute and artifact storage matter more than advertised seat prices. If its actual total cost exceeds the ceiling, return the affordability conflict to the maintainer. Team with a public, digest-bound approval and promotion workflow is an architectural fallback, not proof of a lower total bill. Team alone does not preserve private environment reviewers.

Cloudflare R2 is the preferred alternative for direct download hosting control. It fits the present assets and plausible initial demand within its Standard free tier, with no egress charge. It can be adopted initially if custom-domain hosting control is worth the additional publication design. Otherwise migrate the backend later while retaining the same public URLs. Start with one primary host; do not make the next release depend on synchronous publication to two stores.

The detailed evidence lives in three reports:

- [Private CI and release approval](./secant-private-ci-and-release-approval.md) covers account observations, feature restrictions, measured job durations, storage, and alternative CI designs.
- [Public download hosts and the installer contract](./secant-public-download-hosts.md) compares GitHub Releases, R2, S3 with CloudFront, npm, and registries.
- [Historical releases and licensing](./secant-historical-release-and-licensing.md) covers exact historical assets, old links, future license metadata, embedded-runtime obligations, and source recoverability.

## CI is available, but the current protection changes

GitHub Free supports private Actions. The organization currently reports the Free plan. Team adds private branch protection, repository rules, and environment secrets, but GitHub documents required environment reviewers as public-only on Free, Pro, and Team. Enterprise is the direct way to retain the existing private reviewer boundary. A public promotion repository is an alternative architecture, not a plan upgrade that leaves the current workflow unchanged. [Deployment protections](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

The advertised allowances are 2,000 minutes for Free organizations, 3,000 for Team, and 50,000 for Enterprise Cloud. Starting seat prices are $4 for Team and $21 for Enterprise, subject to checkout, billing and renewal terms. These are not all-inclusive CI prices. [Included usage](https://docs.github.com/en/billing/reference/product-usage-included), [GitHub pricing](https://github.com/pricing).

A recent 20-run completed sample averaged $0.9796 gross per run using current private standard-runner rates. Applying that sample to the observed 508 workflow invocations gives about $498 gross monthly compute. A mixed sample including a no-job cancellation gives about $474. These are scenarios before quota, not an audited bill: the sample is short, invocations do not all complete the gate, and private Linux/Windows machines have half the current public runners' CPU and RAM. The numerical included-minute conversion is also unclear in current official documentation. Measure a private rehearsal and confirm quota accounting before promising a net monthly total. [Sampled green run](https://github.com/secantdev/secant/actions/runs/37575865723), [current runner rates](https://docs.github.com/en/billing/reference/actions-runner-pricing), [runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

One recent candidate retained about 0.322 GiB of binaries, archives, and packages for 90 days. Routine retention should be shortened independently of durable release evidence. Under the deliberately high scenario that every invocation generates that candidate, 90-day steady-state storage approaches 491 GiB. Keeping routine artifacts for seven days cuts that scenario to about 38 GiB. Actual storage requires a complete inventory and failure/cancellation mix. The detailed CI report states the assumptions and overage calculation. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Self-hosting an already owned, dedicated Apple Silicon Mac is a plausible later saving because macOS dominates the sampled compute cost. It does not repair private reviewer restrictions. Moving the whole gate to another CI provider adds substantial verification and release-path work; the researched Azure offer does not automatically include Secant's native macOS arm64 requirement. Preserve the three-OS gate unless the maintainer explicitly changes ADR 0027.

## Make the budget a selection gate

The maintainer sets a $21 monthly ceiling at the present one-user scale and favors the 50,000-minute plan. The plan name is Enterprise Cloud, despite the maintainer initially calling it Team. Select the total monthly CI and distribution design against that ceiling before buying a subscription. A $4 Team seat does not imply a $4 CI bill. Enterprise's higher allowance may lower total cost, but neither its advertised seat price nor its advertised minutes establishes the final invoice. Included-minute accounting, actual seat terms, tax, renewal terms, private-runner timing, and routine artifact retention still need verification.

The sampled projection is about 20,000 raw runner minutes per month. Under the historical OS-weighted sensitivity scenario it is about 84,000 allowance minutes. Current official documentation does not establish which conversion applies to this account. Therefore 50,000 advertised minutes cannot yet be certified as sufficient. Confirm Billing or obtain a support answer, then configure metered-spend limits to stop rather than charge beyond the approved ceiling. This may stop private CI when included usage runs out; it must never bypass required checks to make a release proceed.

Use an independent public releases repository and the existing website for the smallest initial hosting commitment. R2 is also plausible near-zero-cost hosting within its documented allowances. Neither option solves the private CI cost. Avoid paid mirrors or a second mandatory store at launch.

For a strict low monthly ceiling, investigate existing dedicated hardware before purchasing new hardware. A self-hosted Apple Silicon worker targets the largest sampled expense; Linux and Windows can remain hosted if their usage fits the remaining allowance. Include electricity, hardware amortization, maintenance, isolation and availability in the comparison. Self-hosting is not a substitute for an enforced release approval boundary.

Reduce unnecessary expenditure before relaxing verification. Shorten routine artifact retention while preserving approved release evidence. Inspect push and pull-request trigger overlap and superseded work; avoid duplicate verification only when candidate identity and required-check semantics prove it redundant. Inspect expensive job steps and keep the existing gate's behavior intact. The current default-branch and tag runs are intentionally durable evidence, so canceling them requires a policy change.

If the ceiling is too low for the current frequency of hosted three-OS verification and suitable hardware is unavailable, make that conflict explicit. A maintainer can choose fewer CI-triggering pushes, a revised batching or merge policy, or a differently scheduled consumer gate. Moving Windows or macOS verification only to releases contradicts the existing ADR and cannot be adopted as a silent optimization. Do not promise that a public workflow can run private product builds for free; the public-publisher design keeps private build/test execution private.

The present research supports a near-zero download-host cost and a preferred Enterprise architecture. It does not certify that current hosted three-OS usage fits the $21 ceiling. Resolve allowance accounting and reduce routine retention before promising an all-inclusive bill. Revisit the budget when a second paid user or other shared-account usage enters the calculation.

## Public hosting options

A fresh public releases repository requires the fewest changes to the present draft-to-publish model. Its generated source archives contain only its own metadata, scripts, and documents. It must have independent history and metadata-only tags; never push a private source tag into it. GitHub Releases supports binary distribution, but the absence of a numeric bandwidth quota is not an unlimited-service guarantee. Enable immutable releases for future candidates after verifying compatibility with the existing rerun behavior. [Release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), [bandwidth policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#9-excessive-bandwidth-use).

R2 gives Secant direct ownership of release paths and caching. Standard storage includes 10 GB-month, one million writes and ten million reads monthly, with free egress. Twenty releases at the current roughly 114.8 MB archive set occupy about 2.3 GB before duplicates and additional materials. Use a production custom domain; `r2.dev` is a throttled development endpoint. Pages' 25 MiB file cap excludes all three current archives. A public object prefix is not a draft: use private staging or publication-marker gating when partial exact-version downloads must remain invisible. [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

S3 with CloudFront is also viable. Current CloudFront flat-rate plans include a $0 tier with 100 GB transfer and a $15 tier with 50 TB, subject to published allowances and performance policy. Its older pay-as-you-go model remains available. AWS deserves consideration if the infrastructure already exists; it is not necessary to introduce a new provider for this cutover. [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/), [allowance policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).

Keep public npm as a parallel distribution channel. Making GitHub source private does not make existing npm packages private. npm-only would add a Node/npm requirement or custom registry extraction to the requested native installer. GitHub's npm package registry requires authentication and does not match anonymous installation; GHCR's anonymous OCI pulls are better suited to a container channel. [Public npm packages](https://docs.npmjs.com/about-public-packages/), [GitHub package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

## Own the public URL contract

The proposed commands are:

```sh
curl -fsSL https://secant.sh/install | sh
curl -fsSL https://secant.sh/install | sh -s -- --version 0.1.0
```

```powershell
irm https://secant.sh/install.ps1 | iex
```

These are proposed endpoints, not deployed commands. The current POSIX script is a `sh` script and can also be piped to Bash. Provide a pinned installer revision for reproducible installation, and a file-based PowerShell command when passing an exact version.

Use immutable asset paths such as `downloads.secant.sh/releases/v0.1.0/NAME`, plus a stable version resolver. Initially those paths can redirect to the public releases repository; later they can serve R2 objects. Keep alias caches short and versioned caches immutable. Missing routes must return an HTTP error rather than the website's HTML fallback.

Resolve the selected version once. Both current installers request manifest, checksums, and archive through separate `latest` paths; promotion between requests can mix releases and cause a safe but failed install. Every file should come from one exact-version namespace. Installer bytes also need an explicit approved revision: they are not among the five current release assets. A modified bootstrap is a maintenance revision even when it installs unchanged v0.1.0 binaries.

The website entry point and the script's internal download paths both need to change. Redirecting `/install` to today's unmodified source script fails after that source repository becomes private. Preserve the existing digest checks, version probe, legal material, and installation replacement behavior.

## Preserve approval and exact bytes

With Enterprise, the existing private protected job can publish to the public destination using a separate GitHub App token or narrowly scoped PAT. Its default `GITHUB_TOKEN` cannot write a second repository. Keep publication credentials behind the required reviewer. [Token scope](https://docs.github.com/en/actions/concepts/security/github_token).

With Team, the public workflow becomes the protected publisher. It verifies a particular private run, workflow, tag, commit, attempt, artifact identities, and approved manifest digest. It binds Rohan's approval to that candidate, then rehashes the same downloaded archives and npm tarballs before publishing. It never checks out private source or runs candidate-supplied code. Its public logs and artifacts contain only deliberately public material. The cross-workflow verifier replaces today's transitive `needs` proof and therefore requires an explicit ADR and policy-check amendment.

Both designs retain npm platform packages first, launcher last among packages, and a fully verified GitHub release last. R2 needs an equivalent complete-publication boundary. Only after publication verification may the stable pointer move. A rerun accepts identical bytes and refuses conflicts; it never rebuilds or silently overwrites an approved version. Public release attestations do not by themselves prove private build provenance.

## Historical rights and legacy links

Copy v0.1.0's three archives, manifest, and checksums byte for byte. Recompute their GitHub-reported hashes locally and verify anonymous downloads from the new origin. Do not replace their MIT license, rebuild their executable, or repack their npm versions. Existing npm name/version pairs cannot be republished. Historical MIT recipients retain their granted rights, and public forks can remain public after the source repository changes visibility. Privacy governs future access; it does not erase historical distribution. [MIT grant](https://choosealicense.com/licenses/mit/), [npm publication rules](https://docs.npmjs.com/cli/v11/commands/npm-publish/), [visibility effects](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).

Keep the current source/tracker repository identity unless retaining old raw installer URLs and cached scripts is a hard requirement. A different public repository does not preserve those paths, and Secant's domain cannot redirect GitHub-controlled URLs. Preserving them requires renaming the source and giving a clean public distribution repository the old `secantdev/secant` name. Reusing that name disables redirects for the old source repository's issues and PRs. That tradeoff is substantial given Secant's issue-based decision history. Announce the new domain command before the change if the old commands will expire. [Rename behavior](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

Future proprietary binaries need terms that explicitly permit free installation and use, updated root and generated package metadata, and continued third-party notices. A custom npm license can use `SEE LICENSE IN LICENSE`; a bare `UNLICENSED` declaration does not communicate the intended free-use grant. Review authorship and contribution rights before claiming exclusive ownership. [npm license metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/), [contribution ownership](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

Audit the exact embedded Bun 1.4.2 runtime before proprietary publication. Bun's own code is MIT, but its licensing documentation identifies statically linked LGPL components and relinking obligations. The present package-graph inventory does not settle all native-runtime obligations. This research identifies the audit requirement; it does not conclude that Secant must open its application source or that the existing release is conclusively noncompliant. [Bun licensing](https://bun.sh/docs/project/license).

A private repository is achievable. Unrecoverable client code is a different promise: Bun explicitly states that bytecode does not obscure source. Current compilation alone is not a secrecy boundary. Keep private maps and build evidence out of public artifacts, and distinguish intentionally public installer/launcher code from product implementation. [Bun executable behavior](https://bun.sh/docs/bundler/executables).

## Order the cutover before changing visibility

1. Use the $21 monthly ceiling and preferred Enterprise design to resolve the primary host, legacy-link policy, future license boundary, public support home, and placement in the implementation spine. Confirm actual subscription terms and quota accounting before purchase. Commission the exact runtime and ownership review.
2. Inventory historical npm versions, export the five v0.1.0 assets, and recompute their hashes. Preserve historical license and release evidence.
3. Provision the independent public store and stable domain paths. Copy v0.1.0 unchanged. Publish a verified bootstrap revision that uses the new origin and remains compatible with the historical manifest.
4. Adapt the protected publisher and its credentials. Preserve three-OS checks, exact tag/version admission, candidate reuse, legal closure, and digest-bound human evidence. Rehearse on private runners without public publication.
5. Verify anonymous latest and exact-version installation on supported native operating systems, npm installation, checksum refusal, rollback, support links, and failure responses. Advertise the new commands and any old-link cutoff.
6. Make the source private only after the replacement paths and protections work. Recheck actual repository settings and anonymous installation after the visibility change.
7. Build the new proprietary candidate once under a new version, verify the chosen legal materials, approve its exact digests, and publish through the established path.

Public documentation must include installation, support matrix, changelog, license, and a working support/security route. Development issues and internal guidance stay private. Do not mirror the source issue history merely to offer public bug reports. The next release keeps its normal human release Task; planning does not silently change M8–M11 or perform the cutover.

The next maintainer conversation is [Decide Secant's private-source CI, public distribution and cutover policy](https://github.com/secantdev/secant/issues/427). Research tickets can close on these factual findings, while the policy ticket remains open until the maintainer selects the route. Remaining uncertainties include the actual Enterprise checkout, quota conversion, private-runner timing, exact native-runtime redistribution materials, and the website's underlying deployment type.
