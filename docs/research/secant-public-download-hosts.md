# Public downloads after Secant source becomes private

Research date: 2026-10-07. This resolves the research question in [Compare public download hosts and the secant.sh installer contract](https://github.com/secantdev/secant/issues/425). It proposes decisions for review and makes no provider, repository, or source changes.

## Recommendation

Keep public npm packages. Give every native download a Secant-owned URL. My preferred long-term arrangement is `secant.sh/install` and `secant.sh/install.ps1` on the website, with approved native artifacts in Cloudflare R2 at `downloads.secant.sh`. A separate public GitHub Releases repository is a sound shorter migration, and an optional release mirror or support tracker later. It is not a requirement for closed-source software.

The choice depends more on operational scope than download costs. Public GitHub Releases preserves the current promotion model with the fewest changes. R2 gives Secant direct control of paths, publication metadata, cache policy, and rollback. Start with one primary host. Adding two required hosts before the next release creates a new distributed publication problem without solving an immediate consumer need.

This research assumes binaries stay freely and anonymously downloadable, source becomes private, and the existing npm channel remains public. A private source repository and a public binary store are independent access boundaries.

## What the repository currently does

Local evidence comes from `README.md`, `install.sh`, `install.ps1`, `scripts/assemble.ts`, `scripts/release-promote.ts`, `.github/workflows/check.yml`, `docs/agents/release-consumers.md`, `docs/agents/release-workflow.md`, and ADR 0027.

- The README fetches both installer scripts from `raw.githubusercontent.com/secantdev/secant/main`. Making the source repository private breaks those anonymous commands.
- Both installers hardcode `github.com/secantdev/secant/releases`. Moving only the script URL does not repair downloads after privatization.
- The native download contract consists of `candidate-manifest.json`, `SHA256SUMS`, and the host's archive. The installer checks archive, executable, and legal-file digests, verifies the executable's version, and preserves the existing install on failure.
- The current POSIX and PowerShell installers fetch the manifest, checksum list, and archive using separate `latest/download` requests. A publication between requests can select different versions. Digest checks make the failure safe, but installation can fail during promotion. Resolve `latest` once, then use an exact version prefix for the whole install.
- The candidate manifest has version, legal digests, and target identities and digests. It has no private commit or issue links today.
- Promotion publishes platform npm packages first, the launcher last among packages, and GitHub assets last. It never rebuilds an approved candidate. It creates a draft, verifies every existing asset, refuses conflicting bytes or unapproved assets, uploads missing draft assets, and publishes only the complete draft. An already-published partial release is refused.
- Installer scripts are not in the approved GitHub asset list today. The list contains the three archives, manifest, and checksums. Script publication needs an explicit identity and verification contract.
- GitHub CLI commands currently use the checked-out repository implicitly, and `--verify-tag` expects the release tag there. A public distribution repository needs explicit repository arguments and its own metadata-only tag. Do not push the private source commit or history to make the tag available.

The current archive sizes supplied by the parent investigation are approximately 27.9 MB, 45.1 MB, and 41.9 MB, totaling 114.8 MB per release. All are small for an object store or GitHub Release, but all exceed Cloudflare's 25 MiB static-site asset cap.

## Independent public GitHub Releases repository

Create a new repository such as `secantdev/secant-releases` containing a README, download instructions, release metadata, and any deliberately public installer code. Attach binaries as release assets. Do not commit binary archives to Git history, copy the source repository, or push private source tags.

GitHub Releases explicitly supports downloadable software binaries. A release can have up to 1,000 assets, each below 2 GiB, with no documented aggregate release-size or bandwidth quota. Generated ZIP and tarball source links contain the tagged repository's tree. In a separately created distribution repository that tree contains only distribution metadata, so these automatic archives do not disclose private product source. [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Public repository visibility does not require adopting an open-source license. GitHub's terms grant platform rights to view and copy public content through GitHub's functionality; additional license rights are separate. The technical conclusion is that a public distribution repository can hold proprietary binaries without publishing product source. Actual license wording belongs in the separate legal investigation. [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service).

The absence of a numeric Release bandwidth quota is not a promise of unlimited service. GitHub retains the right to throttle file hosting or suspend excessive usage. [GitHub acceptable use, excessive bandwidth](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#9-excessive-bandwidth-use).

Advantages are low migration effort, release notes, release subscriptions, native draft publication, and no download-host bill at this size. Disadvantages are a second repository and publication credential, GitHub-dependent download URLs, and weaker control over CDN behavior. Keep `secant.sh` as the stable entry point even if it redirects to GitHub.

Enable immutable releases on the distribution repository for future publication. GitHub locks the tag and assets once published, generates release attestations, and still allows release notes and the `latest` designation to change. Its documented sequence is draft, attach every asset, then publish. This matches Secant's existing exact-byte policy. [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

Native installers should download from direct `https://github.com/secantdev/secant-releases/releases/download/vVERSION/NAME` URLs. Avoid making each installer call the REST API to discover assets. Anonymous REST calls share a 60-per-hour allowance per originating IP, which is a problem behind office, cloud, or carrier NAT. Direct release-download paths avoid spending that API allowance, although normal download abuse controls still apply. [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Cloudflare R2 with a custom domain

Use Standard storage and a production custom domain such as `downloads.secant.sh`. Cloudflare documents `r2.dev` as a development endpoint with variable request and throughput throttling. Production custom domains enable Cloudflare caching. Only certain extensions cache by default, so set rules deliberately for archives, manifests, checksums, and scripts. A custom domain must belong to a zone in the R2 account. [Public R2 buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

R2 currently includes 10 GB-month of Standard storage, one million Class A operations, and ten million Class B operations each month. Beyond that, Standard storage costs $0.015/GB-month, writes cost $4.50/million, and reads cost $0.36/million. Internet egress is free. Billing rounds usage up to billing units. These are R2 charges, not a guarantee that adjacent services are free. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Twenty releases at the current archive size use about 2.3 GB, excluding npm tarballs or duplicate copies. Even 80 releases use about 9.2 GB. That leaves considerable room under the storage free tier for manifest and script files. Choose Standard storage rather than Infrequent Access for downloads.

Cloudflare CDN's cacheable-object limit is 512 MB on Free, Pro, and Business plans. The current largest archive, about 45.1 MB, fits. A Worker can stream an R2 body instead of reading the binary into memory. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Pages and Workers static assets can serve the small installers, but their individual static-file limit is 25 MiB. Neither is the right store for these archives. Cloudflare itself directs Pages users with larger files to R2. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).

A small Worker can route only `/install`, `/install.ps1`, and release-resolution endpoints while leaving the website's other paths with its current origin. A Worker Route requires an active Cloudflare zone and proxied DNS. If the website is already a Worker, integrate the route into that application's origin or use the documented route precedence. Confirm the actual deployment before choosing the integration. [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/).

Workers Free has 100,000 dynamic requests per day. Paid Workers starts at $5/month and includes ten million requests and 30 million CPU milliseconds monthly, with metered overages. If only installer aliases invoke a Worker and bulk binaries use the R2 custom domain, download traffic need not invoke the Worker for every binary. Static asset requests have different billing from dynamic requests. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

R2 gives strong object consistency, but a caching custom domain can still serve an old overwritten object, a deleted object, or a cached 404. Immutable versioned keys avoid most conflicts. Publication must handle a previously cached missing path before moving `latest`. Read-after-upload verification should use both direct authenticated storage access and anonymous public URLs. [R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/).

Unlike a GitHub draft, a directory prefix in a public R2 bucket is not an atomic publication unit. Uploading one file makes that file potentially accessible immediately. If exact-version consumers must never see a partial release, use a private staging bucket or a private bucket behind a Worker that serves a version only after its publication marker is committed. A simpler public bucket can write the manifest last and move `latest` last, but that is a narrower guarantee: unadvertised files can already be fetched if their paths are guessed. Keep this tradeoff explicit.

## AWS S3 and CloudFront

AWS is a viable alternative, especially if Secant already operates AWS. Use a private S3 origin with Origin Access Control and a public CloudFront distribution on a download subdomain. The bucket's privacy protects the storage origin; viewers still download anonymously through CloudFront. OAC is available across current flat-rate tiers. [CloudFront flat-rate developer guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).

Current CloudFront pricing has two models, so older advice can misprice this option:

- Flat-rate Free costs $0/month per distribution and includes 100 GB transfer, one million requests, and 5 GB of S3 storage credits. Pro costs $15/month and includes 50 TB transfer, ten million requests, and 50 GB of storage credits. Both advertise no overage charges. These are allowances, not unrestricted sustained usage. [CloudFront plan pricing](https://aws.amazon.com/cloudfront/pricing/).
- Pay-as-you-go includes one TB transfer and ten million HTTP or HTTPS requests each month. Above the allowance, bandwidth and requests are regional metered charges. AWS's US example uses $0.085/GB. [CloudFront pay-as-you-go](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/).

S3-to-CloudFront transfer is free; storage and S3 API requests remain separate unless the selected plan credits cover the storage component. Avoid comparing direct S3 internet egress to R2 while omitting CloudFront. [S3 pricing](https://aws.amazon.com/s3/pricing/).

AWS says sustained or unusually large flat-rate usage beyond the allowance can cause traffic delivery performance adjustments. Upgrade the tier for recurring load. Do not assume the $0 tier offers an unlimited binary CDN. [CloudFront allowance policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html#monthly-usage-allowances).

Migration effort is higher than R2 in the apparent current Cloudflare context. It needs AWS identity, bucket policy, distribution, certificate and domain setup, cache configuration, and private CI credentials or federated identity. AWS may still win if those systems already exist. R2 is not uniquely capable of this distribution design.

## npm-only and registries

The existing `@secantdev/secant` launcher and platform packages can remain public after source becomes private. Public npm organization packages are free. Source repository visibility is not the package access boundary. [npm organizations](https://docs.npmjs.com/orgs/) and [public packages](https://docs.npmjs.com/about-public-packages/).

Npm-only would preserve `npm install -g @secantdev/secant`, but it fails the requested native bootstrap experience. The native installer would either require Node and npm or implement npm package discovery and extraction. Secant already has an independently verified archive channel, so replacing it with registry tarballs increases coupling for little benefit. Keep npm as a parallel public channel.

GitHub Packages' npm registry is a poor replacement for npmjs in an anonymous product install. Most GitHub package registries require authentication even for public packages. The Container registry is the exception and permits anonymous public pulls. [GitHub package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages).

GHCR can distribute OCI images, but OCI pulls require manifest, blob, and registry-token handling or an OCI client. It is useful for containers and optional machine consumers, not the first choice for three standalone native executable archives. [Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

A static website alone is sufficient for installer scripts and redirects, not necessarily for long-lived large binaries. An independently operated S3-compatible store is also possible, but no uncovered requirement justifies adding another provider to the shortlist now.

## Stable installer and release contract

The provider-independent contract should be owned by Secant:

- `https://secant.sh/install` is the POSIX entry point. The current script starts with `#!/bin/sh`, so the natural command is `curl -fsSL https://secant.sh/install | sh`; piping to Bash also works.
- `https://secant.sh/install.ps1` is the Windows entry point. Preserve the native PowerShell consumer path.
- `https://downloads.secant.sh/releases/vVERSION/NAME` is an immutable archive and metadata namespace.
- `https://downloads.secant.sh/channels/stable.json` or a documented lightweight equivalent selects the stable version. A stable resolver can point at GitHub as readily as at R2.
- Provide immutable installer revisions or per-release installer URLs, so exact-version installation does not depend on mutable `main` source or a future incompatible bootstrap.

Treat `/install` as a stable bootstrap contract, not merely a redirect to whatever script happens to be latest in source. It must select the requested version once, select an installer compatible with that release's manifest schema, and use exact-version paths for all subsequent files. Either maintain one tested installer compatible with every supported release schema, or publish installers with each release and let a small stable dispatcher choose the right one. The dispatcher itself needs backward compatibility and an independently pinned revision URL.

A suggested exact-install command is `curl -fsSL https://secant.sh/install | sh -s -- --version 0.1.0`. This is a proposed contract, not a command that works today. A more reproducible command fetches a pinned installer revision and passes the exact product version. For PowerShell, download a pinned installer to a file and invoke it with `-Version 0.1.0` rather than losing argument semantics through a generic evaluation command.

Serve shell and PowerShell bytes as text with the correct content type and line endings. Missing installer routes must return a failure status, not the website's HTML fallback. The curl command follows redirects, so an ordinary temporary HTTP redirect is fine for routing. Avoid permanent, long-cached redirects for aliases that need rollback.

Versioned archives, manifests, and installer revisions can have long immutable cache lifetimes. `/install`, `/install.ps1`, and stable channel pointers need a short or disabled cache policy at both browser and edge. Rollback changes the stable pointer and alias, then purges relevant cached aliases. It never replaces the bytes under `vVERSION` with a different build. Keep the bad version available as an exact release unless an explicit withdrawal policy says otherwise.

Checksums downloaded from the same HTTPS host prove integrity relative to the fetched manifest, not an independent publisher signature. Preserve current digest checks. GitHub immutable-release attestations provide additional public release evidence when GitHub is the chosen host. An R2 primary can add detached signing later if publisher authenticity becomes a decision requirement.

## Publication and credentials

The source workflow's `GITHUB_TOKEN` is scoped to the repository containing that workflow. Increasing its `contents` permission does not grant write access to a second distribution repository. [GITHUB_TOKEN scope](https://docs.github.com/en/actions/concepts/security/github_token).

Prefer a GitHub App installed only on the distribution repository with the required contents permission, generating a short-lived token inside the approved publication job. Installation tokens can be narrowed to specified repositories and permissions and expire after one hour. A narrowly scoped fine-grained PAT is an acceptable simpler first implementation, with explicit expiry, rotation, and ownership. [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) and [additional workflow authentication](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token#granting-additional-permissions).

There are two distinct boundaries if a public approval workflow is used to compensate for private-plan environment restrictions. Before approval, it needs only a safe public candidate summary. After approval, it can obtain a separate read-only token to the specific private run's artifacts, and a write token for the public destination. It must verify run identity and the approved manifest before publication. Never check out private source, execute private scripts in the public workflow, echo secret-bearing metadata, or let an unreviewed fork choose arbitrary artifact origins. Public logs must contain only deliberately public evidence.

For R2, scope upload credentials to the release bucket and keep them inside the approved publication boundary. For either provider, publication follows the same invariant: build and approve once, upload the exact approved bytes, download and compare digests, expose the complete release, then update stable routing. A repeated publication accepts identical existing bytes and refuses conflicts. Publish installer bytes and their digests deliberately, rather than silently making an unverified script copy part of the release.

Keep the mapping from private source SHA and private check-run identifiers to artifact digests in private release evidence. Public manifests can expose version, platforms, artifact digests, installer revision, legal material, and public changelog. Public GitHub tags point to the distribution repository's metadata commit. A generated public release attestation proves the public tag-to-assets relationship; it does not alone prove private build provenance.

## Cutover and v0.1.0

Before changing source visibility, copy the existing v0.1.0 archives, manifest, and checksums from the published release to the selected public host and compare every hash. This is a byte-preserving migration, not a rebuild. Run anonymous native consumer verification against the public endpoint on all supported operating systems. Npm needs no hosting migration if its public package bytes remain unchanged.

Do not blindly copy the old installer as the new website entry point. That script hardcodes the source repository, so it fails after privacy changes. A revised installer can install the unchanged v0.1.0 binaries from the new host, but its own bytes and provenance are a new installer maintenance revision. State this explicitly rather than calling the altered script an exact mirror of the old release.

Existing published links into the source repository cannot remain anonymous after it becomes private. Creating a different public repository does not automatically redirect old asset or raw-source URLs. Publish the new website instructions before the cutover and record that users with old commands must switch. Domain aliases make subsequent hosting migrations possible without changing the user-facing command again.

The preferred ordering is public store and routes first, verified v0.1.0 migration second, compatible bootstrap and README changes third, protected publication changes fourth, anonymous full-path checks fifth, then source visibility change. No source visibility change or provider provisioning occurred during this research.

## Observed website state and remaining decisions

An anonymous HTTP GET on 2026-10-07 returned an under-development static page at `https://secant.sh`, with no download instructions. The HEAD response had `server: cloudflare` and `CF-Cache-Status: HIT`. This establishes Cloudflare in the delivery path, but does not identify whether its origin is Pages, Workers, or another host. No private website repository was inspected. Reproduce with `curl -fsSI https://secant.sh` and `curl -fsSL https://secant.sh`.

The user still needs to choose the primary host and whether the public distribution repository also holds support issues. The CI plan and private approval gate must be resolved with the separate CI research. Installer dispatch versus a single backward-compatible installer is a smaller engineering decision after hosting is selected. Public binaries can ship unchanged on either primary host, and Secant-owned entry points should be adopted whichever option wins.

