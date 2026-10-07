# Closed-source transition verification

Checked 2026-10-07 after the maintainer requested that the earlier research uncertainties be verified. The budget is $21/month at the present one-user scale. Downloads remain free and anonymous. The maintainer confirms an Indian purchase before GST business registration.

This is a verification record, not authorization to buy Enterprise, start a trial, make the source private, provision a host, or change a license. The current account remains Free, with no pending plan change and no active trial. Browser upgrade forms were inspected and their billing-cadence preview changed; no form was submitted.

## What changed in the recommendation

The one-seat monthly Enterprise option is now observed in Secant's actual signed-in upgrade form. It quotes $21/month and requires only the one seat corresponding to the current member. An annual $252 option also exists. The public plan comparison confirms 50,000 included minutes. A multi-seat minimum or compulsory annual purchase is not a remaining uncertainty for the inspected route. The owner subsequently checked their Indian monthly preview and reports $21 with no tax line. That is the observed pre-purchase quote; no legal tax exemption or paid-invoice guarantee is inferred. Renewal rules are verified: the agreed price lasts for its payment term; future term prices may change with 30 days notice. No specific year-two price is guaranteed. [Terms](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#l-payment).

The earlier approximately 20,000 raw-minute monthly projection was a short-sample estimate. A complete September 7–October 6 census instead found 500 runs, 522 attempts and 11,188 rounded job-minutes. Their current standard-runner list-price value is $243.864. This is observed public-runner work, not a private invoice or a promise about next month's workload. The September billing API independently reports 7,131 minutes and $144.958 runner value, fully discounted to zero, for its calendar-month window.

The signed-in billing response settles the current account's allowance mechanism. Free's advertised 2,000 minutes is implemented as a recurring $12 monetary plan discount shared across the standard Linux, Windows and macOS SKUs. It is not a pool of 2,000 interchangeable wall-clock minutes. Applying that observed normalization to Enterprise's advertised 50,000 minutes predicts a $300 credit. A customer-facing guide corroborates $300, but Secant's future Enterprise entitlement has not been activated or observed. Keep $300 labelled inferred until its first-party entitlement is confirmed; do not restore the old 1/2/10 weights as the current billing formula.

Under a $300 credit, the complete recent workload leaves $56.136 of runner headroom. The present account also already has an Actions $0 paid budget with Stop usage enabled. This prevents uncontrolled paid overage; it does not prove a private workflow will fit or remain available after its allowance runs out. Private Linux and Windows machines have fewer resources than the public machines used for this census. A private rehearsal is still a real rollout check.

All historical distribution bytes are now directly verified. Five anonymous GitHub downloads match their SHA-256 metadata. Four anonymous npm tarballs match registry SHA-512 integrity. The executable and legal-file digests agree across all three native archive/package channels and the candidate manifest. This replaces the earlier metadata-only observation. Existing v0.1.0 can be copied byte for byte without rebuilding.

The runtime concern is now a confirmed packaging gap. Bun 1.4.2's pinned JavaScriptCore and TinyCC sources contain LGPL-covered code, while Secant's shipped notices/inventory do not carry the complete native licensing closure. That is stronger than the earlier generic-docs concern. A proprietary application is allowed by the operative license text with the appropriate rights and redistribution materials; no unbuilt relinking kit or undrafted EULA can yet be certified.

A [repeatable static inspector](./secant-linux-bundle-inspect.py) of the hash-verified Linux executable also confirms readable Secant application JavaScript in its embedded module graph. No executable was run. A private original TypeScript repository remains possible, but hiding all shipped application implementation is not a property of the current release packaging.

Detailed evidence:

- [Enterprise billing verification](./secant-enterprise-billing-verification.md).
- [Distribution verification](./secant-distribution-verification.md).
- [Runtime and licensing verification](./secant-runtime-licensing-verification.md).

## Confirmed account and provider facts

### Enterprise price, seats and features

The authenticated organization comparison and upgrade form show one Enterprise seat at $21/month, or $252/year. Selecting monthly changes only the quote preview. The existing member count is one. The organization and billing payload remain Free, with `hasPendingPlanChange: false` and `onTrial: false`. Required environment reviewers on private repositories are an Enterprise feature; Team's reviewers remain public-only. [Public pricing](https://github.com/pricing), [deployment protections](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

The signed-in comparison states 50,000 minutes for Enterprise and 3,000 for Team. These are owning-account allowances, not a new allowance for every purchased seat. The public documentation lists 50 GB shared Actions/Packages storage for Enterprise. [Included usage](https://docs.github.com/en/billing/reference/product-usage-included).

The inspected monthly checkout requires billing details to be linked for an individual-owned account. The owner confirms India without current GST business registration and manually reports a $21 preview with no tax line. Accordingly $21 is both the agent-observed base quote and the owner-reported pre-purchase preview total. The agent entered or saved no country/address or tax identifier, no payment was made, and the absence of a line is not interpreted as legal tax exemption. GitHub documents additional recurring-payment handling for Indian payment methods; this does not establish the final tax charge. [India payment handling](https://docs.github.com/en/billing/how-tos/set-up-payment/india-one-time-payments).

### Current allowance and budget

The signed-in Billing Overview shows no private minutes or storage consumed this month. Public usage is fully discounted. Its read-only included-discount response identifies a recurring fixed $12 plan credit across six standard Actions SKUs and a $0.125 credit shared by Actions and Packages storage. The Budgets page already shows Actions budget $0 and Stop usage Yes. No budget was changed.

The observation is from GitHub's account-specific frontend feed, not a promised public REST contract. The report stores sanitized claims rather than cookies, tokens, customer identifiers, payment data or raw account responses. An independent reviewer with account access can read the same page/feed; no authenticated response is made publicly accessible by this research.

### Actual usage and storage

The complete rolling-month census enumerated every run and attempt, including failures, cancellations and reruns. It found Linux 3,157, Windows 5,250 and macOS 2,781 rounded job-minutes, total 11,188. Current list-price arithmetic yields $243.864. The first report's $474–$498/month sample extrapolation is not the observed monthly total and should not drive the purchase decision.

The September metered API summary is a separate calendar window and reports $144.958 gross runner value and $0 net. Average storage for September was approximately 18.40 GiB, fully discounted while public. This does not prove future storage will remain below Enterprise's allowance. A complete artifacts API inventory additionally found 1,310 nonexpired artifacts totaling 142,396,346,093 bytes, approximately 132.62 GiB. This compressed transport-size sum is distinct from hourly metered storage, but it is a concrete retained inventory above Enterprise’s advertised 50 GB. Cleanup and shorter routine retention must be planned before privatization; a seat-only $21 budget does not cover arbitrary retained private storage. [Inventory evidence](./secant-ci-storage-evidence.json).

Native GitHub logs and job summaries do not consume artifact storage. Secant's uploaded operational JSONL files do because they are workflow artifacts. Cache storage is separately limited. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

### Historical artifacts and npm

All five release assets download without credentials. Their combined size is 114,827,162 bytes; the three archives alone total 114,825,425 bytes. Every recomputed SHA-256 agrees with GitHub's metadata. All four npm v0.1.0 tarballs match the registry's SHA-512 integrity, and the inner executable, `LICENSE` and notices agree with the candidate across all targets. npm latest selects 0.1.0 for each package. The launcher also has its historical 0.0.0 placeholder; platform packages have only 0.1.0.

The packages declare MIT, contain no separate `src` directory or sourcemap, and expose the launcher JavaScript as normal package content. GitHub reports the existing release `immutable: false`. These are confirmed observations, not an assumption that publishing to a second repository has already happened. [Historical release](https://github.com/secantdev/secant/releases/tag/v0.1.0).

### Hosting and installer facts

Current official documentation confirms public binary release assets, GitHub's asset limits, R2's Standard free allowance and free egress, Cloudflare's 25 MiB static-file limit, and current CloudFront alternatives. These provider capabilities are verified. They do not confirm that a selected destination account has been provisioned or its public upload path works. [Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [CloudFront plans](https://aws.amazon.com/cloudfront/pricing/).

Anonymous HTTP GET confirms both `secant.sh/install` and `secant.sh/install.ps1` return 404. The homepage returns 200 with Cloudflare headers. The owner manually inspected the existing Cloudflare account after Turnstile blocked the agent browser. The live origin is production Worker `wispy-haze-4b75`, default hostname `wispy-haze-4b75.gargrohan831.workers.dev`, with custom domain `secant.sh`. The account is Free, the zone is Free Website, and there are zero Pages projects. The owner reports a proxied apex AAAA record targeting `100::`. Independent anonymous GETs to the apex and supplied Worker hostname both return 200 with byte-identical 7,658-byte HTML bodies and SHA-256 `565c0819f47247d47e7c01ac0152c6b25a84c301aebd3338889f3bd8276433d9`. This settles the live origin using owner account evidence plus an independent public check. [Origin evidence](./secant-website-origin-evidence.json).

Both existing installers still point internally at source-repository releases. A domain alias alone cannot repair that after source privacy changes. Old GitHub-controlled raw/release paths also cannot be redirected by Secant's domain. Those code and provider constraints are verified; the maintainer's compatibility choice remains a decision.

### Exact runtime and legal constraints

Bun 1.4.2 resolves to `744846f844374847c902b5e7fd59b4342a51ef99`, with WebKit pin `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` and TinyCC pin `05f0fafaa3be31e31d7b4b5c17dc60f62c991171`. Actual pinned implementation files carry LGPL terms. Secant's released notices omit that complete native closure, and its inventory represents Bun only as MIT. The archive contents were checked on all three targets. [Exact Bun license](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md), [pinned JSC terms](https://github.com/oven-sh/WebKit/blob/2e2aa2290fac856d6f451ceacb58f7f5b44dd057/Source/JavaScriptCore/COPYING.LIB).

The LGPL text permits proprietary combined applications with recipient modification/debugging rights and the specified source/relinking materials. Bun's exact-version implementation supports `compile.executablePath` for a custom runtime. These are confirmed mechanisms; a companion compliance kit is a design that still requires building and testing. Future proprietary terms and exact native component closure must be selected and verified before publication.

The Linux artifact's static ELF module parser found 52 embedded modules/assets, no application bytecode or sourcemaps, and readable application JavaScript. It does not recover original TypeScript types, all comments or Git history. Source privacy does not erase historical MIT grants or public forks. A repository author listing is not evidence of off-repository copyright assignment or trademark clearance.

## The precise remaining checks

These are the remaining evidence requirements, with no claim that they have already passed:

1. Enterprise's actual configured credit: inspect the plan's first-party entitlement after a separately authorized purchase, or obtain a first-party support confirmation. The current Free $12 mechanism and public 50,000-minute entitlement support the $300 inference, but do not equal an observed Enterprise credit on Secant.
2. Private CI performance: a real private run must measure the full gate on the documented 2-core Linux/Windows runners. Public runs cannot certify that timing. No private probe repository or workflow was created.
3. New distribution behavior: after host and URL decisions, provision and test the destination, scoped publisher credentials, exact v0.1.0 copy, and native latest/pinned installs on all three OS. Those proposed components do not yet exist.
4. Runtime redistribution remedy: complete exact native notices/source closure and prove a user-modified-runtime rebuild/relink path against the final package and compatible license. Documentation confirms the obligation and supported mechanism, not a kit that has never been built.
5. Owner/legal facts: establish any off-repository assignment, employment, incorporation or trademark facts the owner intends to rely on. Git history and a visibility change cannot establish them.

Research can verify existing facts and expose concrete defects. It cannot truthfully mark an unpurchased plan, unimplemented installer route or undrafted license as tested. These remaining requirements belong to [Decide Secant's private-source CI, public distribution and cutover policy](https://github.com/secantdev/secant/issues/427) and its resulting acceptance work.
