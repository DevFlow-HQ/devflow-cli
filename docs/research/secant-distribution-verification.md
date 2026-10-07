# Verification of public artifacts and download hosts

Checked on 2026-10-07 using current official documentation, Context7, and anonymous HTTP downloads. This investigation made no publication, repository visibility, DNS, subscription, or source changes. Downloaded executables were inspected as bytes and were never executed.

## Published v0.1.0 is available and internally consistent

The public [v0.1.0 release](https://github.com/secantdev/secant/releases/tag/v0.1.0) contains exactly five uploaded assets. Anonymous requests downloaded all five successfully. Every recomputed SHA256 matched the digest returned by the [release API](https://api.github.com/repos/secantdev/secant/releases/tags/v0.1.0).

- `candidate-manifest.json`: 1,468 bytes; SHA256 `286edb5427d8377af0293a57b32d7853cfbb5b26eacb3a1ad3a8b81a2c862153`.
- `SHA256SUMS`: 269 bytes; SHA256 `bc47308e32d3981e3a82e6ecd2eb7c215cf27dd4c288e3b8fbee28570b931030`.
- `secant-darwin-arm64.zip`: 27,850,810 bytes; SHA256 `f8313892b7bdf65f29e39b4fb4add17fc4d25b5d6c32caa067773c67dc3c7283`.
- `secant-linux-x64.tar.gz`: 45,108,792 bytes; SHA256 `0e413177c841436839357185a4e1823694361ccb7fbbb9bf87cc3d836e192e3e`.
- `secant-windows-x64.zip`: 41,865,823 bytes; SHA256 `4a48722b13c08bde8c418b5d17cbd1ce8ad1d51107db99a86321e25afd02cdcf`.

The three archives total 114,825,425 bytes. All five assets total 114,827,162 bytes. The release API reports publication at `2026-09-26T11:57:44Z` and `immutable: false`. These hashes establish today's matching bytes; they do not establish that GitHub already prevents future mutation.

Every archive contains exactly the executable, `LICENSE`, and `THIRD-PARTY-NOTICES.md`. No standalone application source tree or sourcemap occurs in those archive entries. This does not prove that the executable hides its embedded source.

Checks recomputed each archive SHA256 against both `candidate-manifest.json` and `SHA256SUMS`. Checks also recomputed every executable and legal-file digest against the manifest. All passed. Shared legal-file SHA256 values are `b5d491fb2211b6656f238e0a6763f23a3ae975f0b0726b336ff9e1309178008a` for LICENSE and `dfdefe5aa2f1628fa75810b14ae282b1e9bbdab777c062dd573f6599dcfc04f0` for notices.

## Published npm packages are also available anonymously

Anonymous registry metadata requests and tarball downloads succeeded for all four v0.1.0 packages. Every downloaded tarball's computed SHA512 SSRI matched its registry integrity value. Each platform package's executable and legal files matched the corresponding GitHub archive and candidate manifest exactly.

- [Launcher registry metadata](https://registry.npmjs.org/@secantdev%2fsecant) lists versions `0.0.0` and `0.1.0`, with latest `0.1.0`.
- [Linux registry metadata](https://registry.npmjs.org/@secantdev%2fsecant-linux-x64), [macOS registry metadata](https://registry.npmjs.org/@secantdev%2fsecant-darwin-arm64), and [Windows registry metadata](https://registry.npmjs.org/@secantdev%2fsecant-windows-x64) each list only `0.1.0`, with latest `0.1.0`.

All four published v0.1.0 package manifests declare `MIT`. The launcher pins all three optional platform dependencies to exactly `0.1.0`. Its tarball includes `package.json`, LICENSE, notices, `platforms.json`, and a 6,401-byte plain JavaScript `secant.mjs`. Each platform tarball contains its package manifest, executable, LICENSE, and notices. No sourcemap or application source directory appears in any of the four tarballs. The plain launcher source will remain publicly readable as long as these tarballs remain available.

npm explicitly forbids reusing a published package name and version even after unpublishing. Therefore the historical version cannot be replaced with a rebuilt proprietary variant. Keep it intact and publish changed terms under a new version. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/). Public scoped organization packages can be downloaded by anyone. Their visibility is independent of the source repository's visibility. [Public npm packages](https://docs.npmjs.com/about-public-packages/).

These checks verify registry access and matching payloads. They did not run npm installation or execute the products on the three operating systems. Future package publishing credentials and a future private workflow are not tested by anonymous downloads of an existing public version.

## Domain installers are not deployed

Anonymous GET requests to [POSIX installer endpoint](https://secant.sh/install) and [PowerShell installer endpoint](https://secant.sh/install.ps1) each returned HTTP 404 at `2026-10-07T06:42:14Z`. Both responses had content length zero, no Content-Type header, and `server: cloudflare`. They did not return the website HTML fallback or a script redirect. The proposed domain installation commands are consequently not working commands today.

These responses establish Cloudflare at the public edge. They do not identify the origin application, account ownership, current deployment configuration, or permission to add a Worker route. A deployment inspection and a subsequent anonymous acceptance test must verify the chosen implementation.

## Host capabilities and costs are confirmed

GitHub documents up to 1,000 assets per release, each below 2 GiB, without a total-release-size or release-bandwidth limit. Automatic source archives contain the repository's tagged tree. Consequently a freshly created distribution repository with only deliberate public files can serve these binaries without product source appearing in its automatic archives. Its private source repository remains a separate access boundary. [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). GitHub still reserves controls for excessive hosting use. [Acceptable use](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies#9-excessive-bandwidth-use).

R2 Standard includes 10 GB-month storage, one million Class A operations, and ten million Class B operations per month. Internet egress is free. Paid units are $0.015 per GB-month, $4.50 per million Class A operations, and $0.36 per million Class B operations. Cloudflare rounds up billing units. Free allowances apply to Standard, not Infrequent Access. Other connected metered services can charge separately. [R2 pricing](https://developers.cloudflare.com/r2/pricing/). At today's asset size, 20 complete releases occupy about 2.30 GB and 80 about 9.19 GB, excluding duplicates and other objects. This is a storage calculation, not a promise of a zero total bill under arbitrary traffic.

R2 requires an account with an R2 subscription and checkout. No R2 account or subscription was created or inspected here. [R2 setup](https://developers.cloudflare.com/r2/get-started/). Production public downloads should use a custom domain. The domain must be a zone in the same Cloudflare account as the bucket. The `r2.dev` endpoint is rate-limited and explicitly intended for development. [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Pages' single-file cap is 25 MiB, or 26,214,400 bytes. All three downloaded release archives exceed that cap. They cannot be ordinary Pages static assets under the documented limit. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/). Workers Static Assets has the same per-file cap; streaming object-store responses is a separate capability. The ordinary CDN cacheable-object limit is 512 MB on Free, Pro, and Business, so these archives fit. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Workers Free includes 100,000 dynamic requests per day. Standard Paid has a $5 monthly subscription and includes ten million requests and 30 million CPU milliseconds monthly. Paid excess requests and CPU are metered. Static asset requests have separate free treatment. A paid Worker is not required merely to serve scripts or GitHub redirects when the existing website can do that. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

R2's storage consistency does not guarantee fresh CDN responses. Its documentation expressly identifies stale overwritten objects, cached deletions, and cached 404s. Immutable version paths plus deliberate latest/cache policy remain necessary. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/).

AWS confirms CloudFront flat-rate Free costs $0 per distribution monthly and Pro $15. Free includes one million requests, 100 GB transfer allowance, and 5 GB S3 Standard storage credits. Pro includes ten million requests, 50 TB allowance, and 50 GB storage credits. [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/). OAC can restrict a private S3 origin while allowing public downloads, including on Free. Allowances are not hard limits. Sustained or unusually high excess can cause slower delivery despite no CloudFront overage charges. S3 storage credits do not turn every origin cost into an included service. [CloudFront plan rules](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).

The separate CloudFront pay-as-you-go model has one TB internet transfer and ten million HTTP/HTTPS requests monthly in its Always Free allowance, then regional prices. AWS origin-to-CloudFront transfer is free; other origin costs remain separate. The previous report's 1 TB claim applies to this model, not flat-rate Free's 100 GB allowance. [Pay-as-you-go pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/).

## URL compatibility is a documented consequence, not a performed cutover

Releases require repository read access. Making the current repository private therefore removes anonymous access to release assets there. A private repository's raw source paths also require access. The old installer commands cannot remain anonymous merely because a website URL was added. This conclusion follows from GitHub's access model; this investigation did not temporarily privatize Secant to manufacture a test. [Repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), [Release access](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

GitHub expressly warns that reusing a renamed repository's original name breaks redirects to the renamed repository. Preserving the historical installer paths through a fresh public repository at `secantdev/secant` therefore conflicts with retaining old tracker redirects. Actual raw and release compatibility would need tests after a deliberate handover; it has not occurred. [Repository rename](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository).

## Remaining work is identifiable

The host capacities, advertised unit prices, current artifact bytes, npm inventory, anonymous availability, and absent domain routes are verified. The following are future implementation or account checks, not facts that more browsing can establish today:

- Create the selected distribution destination and copy exact historical assets. Verify that destination anonymously. No copy or new host exists from this investigation.
- Inspect actual website deployment and Cloudflare account state before selecting how its two installer routes are implemented.
- Test publisher credentials, protected cross-repository promotion, and absence of private source or metadata uploads after those workflows exist.
- Test latest selection, pinned versions, cache policy, installer failure preservation, and three-OS installation against the new host.
- Confirm exact subscriptions, taxes, existing shared cloud usage, and any paid extras in the relevant accounts before certifying a total monthly invoice.

Machine evidence is saved at `/tmp/secant-confirm-artifacts/evidence.json`, including per-file hashes, archive and npm entry inventories, registry metadata, responses, and the passing cross-channel comparisons. The anonymous download program is `/tmp/secant-confirm-download.py` and the integrity comparison is `/tmp/secant-confirm-integrity.py`. All started subprocesses exited and were reaped.

## Live website origin confirmed after the initial probes

The owner inspected the Cloudflare dashboard manually. The production service is Worker `wispy-haze-4b75`, with `secant.sh` as its custom domain and `wispy-haze-4b75.gargrohan831.workers.dev` as its default hostname. The account and zone use Free plans; there are no Pages projects. The owner reports proxied AAAA `100::` for the apex. Anonymous requests to both public hostnames return byte-identical 7,658-byte HTML pages, independently supporting the reported Worker origin. [Evidence](./secant-website-origin-evidence.json). The current installer paths still return 404. The proposed integration is path routing in the existing Worker to the selected public script/release host, without creating a Pages project.
