# Private-source CI and release approval

Research for [Establish private-source CI costs and a viable release approval boundary](https://github.com/secantdev/secant/issues/424), accessed 2026-10-07. This report records provider facts, account observations, estimates, and advisory designs. It changes no settings and buys no plan.

## Findings that determine the decision

Making the repository private does not remove GitHub Actions. It changes billing and removes protections on the current Free plan. GitHub Team restores private branch protection and environment secrets, but **does not restore required human reviewers on private deployment environments**. Keeping the current private approval gate requires GitHub Enterprise Cloud, or moving the approval and publication job into a public distribution repository. [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

The frequently quoted Team price is not the likely complete CI bill for this repository. Recent jobs imply roughly $0.77–$1.18 per completed gate before included usage. The observed last-month volume was 508 workflow runs. The sampled workload suggests several hundred dollars of gross monthly compute at that pace. Enterprise's much larger included allowance deserves a real quote before assuming that Team is cheaper.

My recommendation is to compare two GitHub designs first: Enterprise with the existing private reviewer gate, and Team with a narrowly scoped public promotion workflow. A public distribution repository can serve users in either design. Source privacy, CI hosting, the approval location, and public download storage are separate decisions.

## Observed account and repository state

Read-only GitHub API checks on 2026-10-07 returned these facts:

- `orgs/secantdev` reports `plan.name: free`, `filled_seats: 1`, and `seats: 0`. The seat fields are API observations, not an Enterprise purchase quote.
- The source repository is currently public, as observed by the coordinating agent. Standard public runners currently incur no compute bill.
- `repos/secantdev/secant/environments/release` names `Sandstorm831` as the sole required reviewer, sets `prevent_self_review: false`, and sets `can_admins_bypass: false`. Selected deployment branch/tag policies are configured. Self-review being allowed is consistent with a sole maintainer approving their own release.
- `Check` builds candidates on Linux once. Its ordinary blocking jobs are three OS checks, the Linux build, and three OS consumers. Tag runs add `release-approval` and `promote`. The promotion job uses environment `release`, downloads already packed bytes, and publishes npm first, then the GitHub release.

The canonical contract requires all three OS, recorded human evidence bound to the candidate digest, and CI publication after approval. It rejects publishing from a laptop and moving Windows/macOS checks only to release time. A cheaper design that changes those rules needs an explicit policy decision. [Current workflow](https://github.com/secantdev/secant/blob/418625c4ebc7273e82a848e66a34ec5149abcc92/.github/workflows/check.yml), [release workflow contract](https://github.com/secantdev/secant/blob/418625c4ebc7273e82a848e66a34ec5149abcc92/docs/agents/release-workflow.md), [ADR 0027](https://github.com/secantdev/secant/blob/418625c4ebc7273e82a848e66a34ec5149abcc92/docs/adr/0027-gate-releases-on-three-os-ci-and-recorded-human-evidence.md).

## Documented plan restrictions

Free for organizations supports private repositories and private Actions. Private branch protection and repository rulesets require Team or Enterprise for an organization. A personal Pro subscription does not upgrade the organization's repositories. [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

On Free, Pro, and Team, required environment reviewers, wait timers, and custom deployment protection rules are available only for public repositories. Team permits private environment secrets and branch/tag restrictions. A wait timer is not a replacement for approval. Private reviewer protection therefore needs Enterprise Cloud. Public environment secrets remain withheld until an environment reviewer approves. [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

GitHub advertises Team at $4 per user/month and Enterprise starting at $21 per user/month, with first-12-month language on the pricing page. Treat those as advertised starting prices, not a binding quote, renewed price, or a confirmed one-seat Enterprise checkout. Confirm actual minimum seats, billing period, included allowance, tax, and renewal terms before choosing. [GitHub pricing](https://github.com/pricing?locale=en-US).

New Enterprise trials created since August 1, 2024 use billing for licenses actually consumed each month, rather than a fixed license commitment. Self-serve Enterprise customers can pay by credit card or PayPal. The official page states no minimum seat count. This makes a small Enterprise account worth checking, although this research did not enter a checkout or obtain its final terms. [Usage-based Enterprise license billing](https://docs.github.com/en/enterprise-cloud%40latest/billing/concepts/enterprise-billing/usage-based-licenses).

## Runner prices and included usage

Current standard rates are Linux x64 2-core $0.006/minute, Windows x64 2-core $0.010/minute, and macOS M1/Intel 3/4-core $0.062/minute. GitHub rounds each job up to a whole minute. Linux `ubuntu-slim` is $0.002/minute but is a container intended for lightweight work. Larger runners require Team or Enterprise, always cost money even for public repositories, and cannot consume included minutes. [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The hosted rate reductions took effect January 1, 2026. The separately announced $0.002/minute charge for self-hosted Actions was postponed. Current billing documentation still states that self-hosted runners are free. Do not budget the withdrawn self-hosted proposal as an active fee. [GitHub's updated pricing announcement](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/).

Free organizations include 2,000 standard-runner minutes/month and 500 MB of artifact storage. Team includes 3,000 minutes and 2 GB. Enterprise Cloud includes 50,000 minutes and 50 GB. Allowances belong to the owning account and are shared across its repositories. Artifact storage shares its allowance with GitHub Packages. Cache storage separately includes 10 GB per repository. Artifact/Packages overage is $0.25/GB-month, and configured cache overage is $0.07/GB-month. Storage accrues hourly. Without a valid payment method, Actions blocks after the included quota. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

### Included-minute conversion remains an uncertainty

Current primary sources are inconsistent about quota conversion. The current billing page describes a minutes allowance and current per-OS rates but no longer specifies numerical multipliers. The Actions metrics page still warns that metrics omit minute multipliers. The older official billing page states Linux 1, Windows 2, and macOS 10, but shows pre-2026 prices. The original pricing-change FAQ describes consumption based on list price, yet that page also retains the postponed self-hosted proposal. It is unsuitable as sole authority for the current model. [Actions billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage), [viewing execution time](https://docs.github.com/en/actions/how-tos/monitor-workflows/view-job-execution-time), [older official billing page](https://docs.github.com/ko/billing/managing-billing-for-your-products/about-billing-for-github-actions), [original pricing-change FAQ](https://github.com/resources/insights/2026-pricing-changes-for-github-actions).

The [official documentation issue about missing multipliers](https://github.com/github/docs/issues/45138) closed on July 21, 2026. A GitHub Docs contributor said the removal did not appear accidental and directed the reporter to support for precise billing. That reply does not establish a numerical current rule. It supports leaving the ambiguity explicit.

For that reason this report gives gross compute costs, not an exact net invoice. Verify the organization's actual included-usage conversion in Billing or with GitHub before promising that Enterprise covers the whole workload. Do not multiply dollar rates a second time by an OS multiplier.

## Measured workflow costs

The sample uses job `started_at` and `completed_at` from the GitHub Jobs API, excludes skipped jobs and jobs without a runner, and rounds each job duration upward. It applies current private standard-runner rates to observed public-runner durations. These are estimates of what the existing jobs would cost, not observed charges.

Twenty consecutive completed runs from 2026-10-06 08:49 through 2026-10-07 05:51 contained 18 successes and 2 failures. A separately selected cancelled run from 2026-10-05 had no started runner jobs. The 20-run cluster averages 11.8 Linux minutes, 17.1 Windows minutes, and 11.9 macOS minutes, or 40.8 rounded runner minutes/run. Its mean gross price is $0.9796/run. Adding the cancelled run changes the mean to 38.86 minutes and $0.933/run. This recent cluster is not a statistically representative month-long sample.

For one inspectable successful run, [Check on main at 2026-10-07 05:21](https://github.com/secantdev/secant/actions/runs/37575865723), rounded minutes were:

- Linux build 1, Linux check 8, Linux consumer 2. Total 11, priced at $0.066.
- Windows check 16 and Windows consumer 5. Total 21, priced at $0.210.
- macOS check 10 and macOS consumer 4. Total 14, priced at $0.868.
- Total 46 minutes, gross $1.144. Skipped tag-only jobs contribute zero.

macOS accounts for about 75% of the completed-cluster gross price. Optimizing Linux lint first would miss the main compute expense.

The workflow API returned `total_count: 508` for `created >= 2026-09-07` at query time. These are workflow invocations, including failed, cancelled, or incomplete runs, not 508 full successful gates. Applying the 20-run completed-cluster mean gives a scenario of about $498/month gross and 20,726 rounded raw minutes. Applying the mixed 21-run mean gives about $474 and 19,739 minutes. If every run resembled the inspectable $1.144 green gate, the scenario is $581 and 23,368 minutes. None is an audited monthly usage total.

Under the historical 1/2/10 allowance convention, the 20-run sample averages 165 allowance minutes/run. At 508 runs that would consume about 83,820 allowance minutes, rather than 20,726 raw minutes. This illustrates why 50,000 advertised minutes alone do not justify promising a $21 all-inclusive bill. The historical convention is a sensitivity scenario, not a verified current rule.

There is another source of uncertainty: standard private Linux and Windows runners have 2 cores/8 GB, versus 4 cores/16 GB on the current public runners. macOS M1 specifications remain 3 cores/7 GB. The same labels therefore do not imply the same runtime after privacy changes. Measure a private rehearsal before setting a final monthly budget. [Hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Storage estimate

The inspectable run retained `binaries` 117,268,594 bytes, `release-archives` 114,765,810 bytes, and `platform-packages` 114,028,187 bytes. Total 346,062,591 bytes, about 0.322 GiB. Expiry was 2027-01-05, confirming 90-day retention. Failed-job operational logs add storage separately.

If every one of 508 monthly invocations generated those artifacts, 90-day steady-state retention would reach about 491 GiB. That scenario implies roughly $122/month of artifact overage on Team, or $110 on Enterprise, before failures, cancelled builds, compression variation, other repositories, and historical retention differences. A seven-day routine retention scenario is about 38 GiB at the same pace, roughly $9/month on Team. This is a forecast, not current stored usage.

Shorten routine candidate retention only after checking which runs remain release evidence. Keep release candidates long enough for the human checklist and approval, and preserve approved evidence separately. GitHub workflow artifacts require a signed-in reader and expire. They are internal transport, not stable public installation hosting. [Downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

## Viable release designs

### Enterprise with approval in the private source repository

This preserves the current architecture most closely. All three-OS checks and the digest-bound summary stay private. The existing private `release` environment keeps Rohan's approval and scoped publication credentials. An approved job publishes the existing bytes to the public distribution repository or object storage. The distribution target needs its own credential because the private workflow's `GITHUB_TOKEN` cannot write another repository. [GITHUB_TOKEN repository scope](https://docs.github.com/en/actions/concepts/security/github_token).

Enterprise also permits native GitHub artifact attestations for private builds. Public attestations on Free/Team are available, but an attestation issued by a public copier proves that public workflow handled the bytes, not that it built the private source. Public attestation metadata and verification access need a separate disclosure decision. [Artifact attestations](https://docs.github.com/en/enterprise-cloud%40latest/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

Recommendation: prefer Enterprise if a small-account checkout or quote is reasonable and its allowance materially lowers the measured bill. Confirm quota conversion first. At this workload the larger allowance could outweigh the higher seat price. Enterprise also avoids building and maintaining another approval workflow. Team with public promotion is the fallback if the actual Enterprise terms are unattractive.

### Team with approval in a public distribution repository

Team keeps private source branch checks and rulesets. The public repository keeps a `release` environment with the existing sole reviewer and no admin bypass. Its code contains only the narrow distribution workflow, public installers and docs if desired, and release metadata. It never checks out private source, builds the product, or receives the full source tree.

Proposed sequence, subject to a later policy decision:

1. Private CI produces one candidate and finishes every existing gate. It retains candidate archives, packed npm tarballs, digest manifests, and the human-evidence reference privately.
2. A maintainer manually dispatches the trusted public promotion workflow with the private run ID and candidate identity. Automatic dispatch can follow later. Manual dispatch avoids adding a cross-repository write credential to the private pre-approval path.
3. Public preflight uses a narrowly scoped read-only private Actions identity to confirm the source run's repository, workflow, tag, commit, conclusion, run attempt, artifact IDs, and manifest digest. It prepares a sanitized approval summary. Its default `GITHUB_TOKEN` permissions are read-only.
4. The public protected job waits for Rohan's approval. Only that job gets npm publishing authority and public release write authority. It downloads the same artifacts again, verifies every approved digest, and invokes the promotion state machine. No build, repack, or selection of a newer candidate is allowed.
5. npm platform packages publish before the launcher, and the GitHub draft becomes public last, preserving the current ordering and conflict checks.

The approval record must bind the private candidate identity, not merely a public tag or an artifact called `latest`. Public preflight must never upload unapproved candidates as public workflow artifacts or draft assets. Even an authenticated public workflow artifact can expose an unreleased candidate to any signed-in repository reader. Pin the executable promotion logic independently of candidate data, and do not run source-provided scripts as trusted public workflow code.

Cross-repository transport is possible, but requires credentials beyond the default token. GitHub App installation tokens can restrict repositories and permissions and expire after one hour. `repository_dispatch` requires target `Contents: write`; that is more public publication authority than a pre-approval dispatcher needs. Prefer manual dispatch initially, or assess a workflow-dispatch identity limited to Actions write later. Credential scoping and public workflow changes are part of the design, not a copy-paste URL change. [GitHub App authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [repository dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event).

This design requires changes to the current ADR, workflow policy checks, tag admission, and promotion repository routing. A public promotion workflow cannot literally have `needs` edges to private jobs. It must prove their success from an exact private run and preserve the same evidence contract. Publication secrets must not move to ordinary source repository secrets to make the migration pass.

### Free with private CI and public verified promotion

Free private CI remains possible, including paid overage. A public approval workflow remains available on Free. The missing private branch protection means the three-OS merge gate is no longer enforced by GitHub settings in the source repository. Process discipline and a promotion verifier can block releases with bad CI, but cannot prevent ordinary unprotected source merges. This is a weaker development control and needs a maintainer policy choice. It does not save enough compute by itself to address the observed usage.

Manual verification should mean Rohan selects and approves a specific green candidate for a CI publisher. Downloading arbitrary local builds and uploading them from a laptop would contradict ADR 0027. A manual checklist alone also does not technically withhold publication secrets unless the publisher has a protected boundary.

### Self-hosted or external CI

Self-hosted Actions can lower recurring compute expense while leaving the same workflow structure. GitHub currently charges no Actions runner fee, but Secant must supply Windows x64, macOS arm64, and Linux x64 machines, updates, isolation, capacity, and availability. Keep publication on a clean hosted runner behind approval. Persistent self-hosted workers can retain compromise and secrets across jobs, including from private-repository pull requests. [Self-hosted runner concepts](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners), [self-hosted security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

A hybrid using an owned Apple Silicon Mac for expensive macOS checks deserves investigation if an always-available dedicated Mac already exists. It is a poor default for the next release if the maintainer must buy and operate all three workers. Self-hosting does not restore private required reviewers or branch protection on Free.

Azure Pipelines is a concrete external alternative. Its private Microsoft-hosted free tier gives one concurrent job, 1,800 minutes/month, and 60-minute job limits after enabling the grant. Paid capacity removes the monthly cap, and the product page advertises $40 per parallel job. Buying the first job does not give two concurrent jobs. [Microsoft's concurrency rules](https://learn.microsoft.com/en-us/azure/devops/pipelines/licensing/concurrent-jobs?view=azure-devops), [Azure Pipelines pricing](https://azure.microsoft.com/en-in/products/devops/pipelines/).

However, a $40 all-three-OS replacement is not supported by the current documentation. New Azure organizations cannot enroll in the paused macOS 15 ARM64 Microsoft-hosted preview. The current Apple Silicon option is a separate GitHub-hosted PAYG pool, with no included free minutes. It uses the same infrastructure and rates as GitHub Actions. This weakens Azure's cost case for Secant's native macOS arm64 gate. [Microsoft-hosted agent availability](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/hosted?view=azure-devops), [PAYG agent documentation](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/github-hosted?view=azure-devops), [PAYG FAQ](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/github-hosted-faq?view=azure-devops).

External CI still needs status-check integration, exact candidate provenance, credential separation, human approval, private artifact transport, and npm-first publication. A provider migration increases release-path change risk. Keep it as a later cost decision unless the Enterprise quote and current Actions forecast are unacceptable.

## Decisions still needed

- Choose the acceptable private development and approval protections. Team alone is insufficient for the current private release reviewer requirement.
- Confirm a real Enterprise quote and included-minute conversion. Compare total projected compute and storage, rather than seat prices alone.
- Decide whether public promotion metadata may disclose private commit and run identities. The required evidence can remain private while a sanitized public summary binds digests.
- Decide routine artifact retention and durable release evidence retention separately.
- Rehearse the whole gate on private standard runners to measure reduced Linux/Windows machine capacity.
- If Team is selected, specify and verify the cross-repository approval contract before making the source private. A plan upgrade by itself leaves the release policy incomplete.

No issue, branch, release, repository setting, secret, or plan was changed by this research. Every started external command used a bounded timeout and completed.
