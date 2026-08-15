# Crucible Naming Conflicts and Availability

Checked 2026-08-15 at approximately 08:26 UTC. Registry and namespace status can change after that time.

## Answer

`Crucible` should not be treated as clear or broadly available for this product. The strongest constraints are independent of one another:

- Atlassian owns a live U.S. Principal Register standard-character mark for `CRUCIBLE`, registration 5,585,471, for "downloadable computer software for collaborative code review." Atlassian still presents Crucible as developer code-review software and lists Crucible among its active trademarks, although new sales ended in 2025 and support is scheduled to end in 2028.[^uspto-crucible][^atlassian-product][^atlassian-trademarks]
- A directly adjacent, established GitHub project already uses Crucible for a Claude Code and Codex workflow that researches, interviews, plans, reviews, and optionally builds software. It had about 1.2k stars when checked.[^chase-crucible]
- The exact executable `crucible` is already installed by several current packages and by an AI-agent sandbox product. The unscoped npm package `crucible-cli` is also occupied and installs `crucible`.[^npm-crucible-cli][^npm-air][^npm-cruciblelab][^npm-cruciblemcp][^cruciblehq]
- The obvious exact domains checked (`crucible.com`, `.dev`, `.ai`, `.io`, `.app`, and `.sh`) are registered. Common modifiers `getcrucible.com`, `usecrucible.com`, and `cruciblehq.dev` are registered too.[^rdap-com][^rdap-dev][^rdap-ai][^rdap-io][^rdap-app][^rdap-sh][^rdap-get][^rdap-use][^rdap-hq]

The owner-scoped GitHub repositories `DevFlow-HQ/crucible` and `DevFlow-HQ/crucible-cli` had no public repository, and the npm registry returned 404 for `@devflow-hq/crucible` and `@devflow-hq/crucible-cli`. Those are possible technical identifiers, not evidence that the product name is safe: GitHub absence can hide private, deleted, or reserved names, and scoped npm publication requires control of the `@devflow-hq` npm user or organization.[^gh-devflow-crucible][^gh-devflow-crucible-cli][^npm-scoped-crucible][^npm-scoped-cli][^npm-scopes]

**Practical conclusion:** unless there is a strong reason to retain the word and budget for professional clearance, remove exact `Crucible` from the product-name shortlist. If it remains under consideration, do not assume the exact CLI command or a primary Crucible web identity can be owned; keep a distinct executable and use owner-qualified repository/package identifiers while legal and brand review is completed.

## Scope And Caveat

This is naming research, not legal advice or trademark clearance. It checks exact and materially adjacent uses in registries and first-party sources proportionate to a later naming decision. It does not determine infringement, registrability, geographic rights, common-law priority, or likelihood of confusion.

The USPTO itself says a comprehensive search includes similar marks, related goods and services, federal and state records, domains, international systems, and common-law internet use, and suggests an experienced attorney for interpretation.[^uspto-clearance] This pass confirmed the known exact Atlassian record directly in USPTO TSDR. Automated result searches in WIPO's Global Brand Database were blocked by a CAPTCHA; EUIPO exposed its search shell but not usable results; and the UK IPO endpoint returned 403. A human or professional follow-up must therefore run similarity and status searches in the intended launch jurisdictions.

## Conflict And Availability Matrix

| Surface | Status when checked | Meaning for a later decision |
| --- | --- | --- |
| Product name | **Material exact conflict** | Atlassian's live exact software mark and product are in adjacent developer tooling; Chase AI's exact-name workflow is directly adjacent to DevFlow's Claude/Codex orchestration. |
| GitHub organization | **Exact name occupied** | `github.com/crucible` and `github.com/cruciblehq` are existing organizations.[^gh-crucible-org][^gh-cruciblehq-org] |
| GitHub repository | **Owner-qualified exact names apparently unused** | The public API returned 404 for `DevFlow-HQ/crucible` and `DevFlow-HQ/crucible-cli`; repository names are owner-scoped, but creation/rename is the only conclusive availability test. |
| npm package `crucible` | **No installable release; publishability uncertain** | The registry retains an unpublished record and `npm view crucible` returns 404 stating it was unpublished on 2025-11-20. Do not call it available without an authenticated publishability check and npm-scope/ownership decision.[^npm-crucible] |
| npm package `crucible-cli` | **Occupied** | Active package, latest 0.1.3 when checked; installs the exact `crucible` executable.[^npm-crucible-cli] |
| Scoped npm variants | **No public package found** | Registry 404 for both `@devflow-hq/crucible` and `@devflow-hq/crucible-cli`; usable only if the matching npm scope is controlled. |
| Executable `crucible` | **Multiple exact collisions** | Existing npm, Rust, and standalone binary distributions already put this name on `PATH`; exact command ownership is not practical. |
| Homebrew exact formula/cask | **No current core listing found** | Both official Formulae API endpoints returned 404, but a future tap/formula would still collide at the installed binary name.[^brew-formula][^brew-cask] |
| Web identity | **Exact primary names occupied** | All six exact TLDs checked are registered; several obvious modifiers are also occupied. |
| Search/discoverability | **Crowded and ambiguous** | Software search is led by Atlassian; CLI and AI-coding searches return several unrelated Crucible products, including direct workflow and executable overlaps. |

## Product And Trademark Evidence

### Exact conflict: Atlassian Crucible

USPTO TSDR reports `CRUCIBLE`, serial 87/830,814 and registration 5,585,471, as live, issued, and active on the Principal Register. It is a standard-character mark owned by Atlassian Pty Ltd in International Class 009 for "downloadable computer software for collaborative code review," with first use claimed in 2007. Sections 8 and 15 were accepted in February 2025.[^uspto-crucible]

Atlassian's own product page describes Crucible as collaborative code review integrated with Git, Jira, and Bitbucket. It says new sales ended on 2025-05-13 and support and maintenance end on 2028-05-15.[^atlassian-product] End-of-sale is therefore not abandonment evidence. Atlassian's current trademark guidelines explicitly list `Crucible`, say some listed marks are registered or applied for internationally, and reserve the right to challenge confusing or diluting uses.[^atlassian-trademarks]

This research does not decide whether DevFlow's proposed use would be legally confusing. The exact wording, live status, and adjacent software/developer audience make specialist review a hard prerequisite rather than an optional polish step.

### Directly adjacent uses

- `chaseai-yt/crucible` describes a Claude Code skill/plugin in which Claude researches and interviews, Codex adversarially reviews the plan, and the models can swap roles to build and verify. That substantially overlaps DevFlow's provider-orchestrated context, planning, review, and execution story. GitHub showed about 1.2k stars and 119 forks when checked.[^chase-crucible]
- `gnana997/crucible`, branded at `cruciblehq.dev`, is a sandbox runtime "for AI coding agents" distributed as one Go binary named `crucible`; its docs install that binary into a global or user `bin` directory.[^cruciblehq][^cruciblehq-install]
- Crucible Solutions, Inc. markets `Crucible` at `usecrucible.ai` as "the AI ML Engineer," another exact AI-software product use.[^usecrucible]
- Older and broader developer uses include Galois's symbolic-execution library and Oxide Computer's storage service. These are less close functionally, but reinforce that exact-name GitHub discovery is crowded.[^galois][^oxide]

## GitHub Identity

GitHub's public API identifies `crucible` as an organization created in 2016 and `cruciblehq` as an organization created in 2025, so neither exact organization identity is available.[^gh-crucible-org][^gh-cruciblehq-org]

Within the existing `DevFlow-HQ` organization, API requests for `DevFlow-HQ/crucible` and `DevFlow-HQ/crucible-cli` returned 404. Because repository names are scoped to an owner, either appears technically plausible as a rename or new public repository. A 404 is only a point-in-time absence signal, not a reservation: verify in organization settings immediately before acting.[^gh-devflow-crucible][^gh-devflow-crucible-cli]

Even with an obtainable owner-qualified URL, exact-name GitHub discoverability is weak. GitHub name search surfaced the directly overlapping Chase AI project first, followed by established exact-name repositories including `GaloisInc/crucible` and `oxidecomputer/crucible`.[^gh-search]

## Package And Executable Identity

### npm

The exact unscoped package records differ:

- `crucible` has no active version or dist-tag. Registry history remains, and the CLI reports it was unpublished on 2025-11-20.[^npm-crucible] npm's policy says published registry data is immutable, used versions cannot be reused, and a completely unpublished package cannot publish a new version for at least 24 hours.[^npm-unpublish] The elapsed period does not prove that DevFlow can claim or publish the name, so classify it as **uncertain**, not available.
- `crucible-cli` is actively published and maps its `bin.crucible` entry to its CLI. It is an Azure Service Bus operations tool.[^npm-crucible-cli]
- `@devflow-hq/crucible` and `@devflow-hq/crucible-cli` returned registry 404. npm documents that only a scope's user or organization can add packages to it, making these the cleanest package variants only if DevFlow controls that npm scope.[^npm-scopes]

### Exact command collisions

Current registry metadata declares a `crucible` executable for all of these packages:

- `crucible-cli`, an Azure Service Bus CLI.[^npm-crucible-cli]
- `@air-bizapps/crucible-cli`, a coding CLI connected to a LiteLLM proxy.[^npm-air]
- `@cruciblelab/crucible`, a component code-generation CLI.[^npm-cruciblelab]
- `@cruciblemcp/cli`, a Crucible command-line interface.[^npm-cruciblemcp]
- crates.io's exact `crucible` crate, which reports `bin_names: ["crucible"]`.[^crates-crucible]

The standalone AI-agent sandbox also installs `/usr/local/bin/crucible` or a user-local equivalent.[^cruciblehq-install] npm documents that global package `bin` entries are linked into the global binary directory and become commands on `PATH`.[^npm-bin] Installing more than one exact command makes command resolution dependent on installation order and package-manager behavior. Use a distinct executable if the product name remains under consideration.

Other exact package identities are already occupied on PyPI (`crucible`, an active quantitative-trading package), crates.io (`crucible`), and NuGet (`Crucible` and `Crucible.Cli`).[^pypi-crucible][^crates-crucible][^nuget-crucible][^nuget-cli] DevFlow's planned Node distribution makes these secondary, but they add search ambiguity and constrain future multi-ecosystem distribution.

Homebrew's official formula and cask APIs had no exact `crucible` listing. A qualified tap such as `devflow-hq/tap/crucible` may therefore be technically possible, but the installed executable should not be `crucible` without accepting the collisions above.

## Web Identity

Registry RDAP records confirmed these exact domains as registered:

| Domain | Registration evidence |
| --- | --- |
| `crucible.com` | Registered since 1997; current expiry shown as 2028.[^rdap-com] |
| `crucible.dev` | Registered since 2022; current expiry shown as 2027.[^rdap-dev] |
| `crucible.ai` | Registered since 2019; current expiry shown as 2027.[^rdap-ai] |
| `crucible.io` | Registered since 2019; current expiry shown as 2028.[^rdap-io] |
| `crucible.app` | Registered since 2018; current expiry shown as 2028.[^rdap-app] |
| `crucible.sh` | Registered since 2024; current expiry shown as 2026.[^rdap-sh] |

Obvious modifiers are also constrained: `getcrucible.com` and `usecrucible.com` are registered, `cruciblehq.dev` is registered and actively used by the AI-coding-agent sandbox, and `trycrucible.io` is registered and used by an AI engineering challenge product.[^rdap-get][^rdap-use][^rdap-hq][^rdap-try]

`cruciblecli.com` returned no Verisign RDAP record and had no delegated nameservers when checked, making it the only potentially obtainable web variant tested.[^rdap-cruciblecli] A missing record is not a purchase guarantee: verify price, premium/reserved status, and registration in a registrar UI immediately before any decision. It also does not cure the product-name or trademark constraints.

## Search And Discoverability

Point-in-time web searches are observations, not ownership evidence:

- `Crucible software` prominently returned Atlassian's code-review product and documentation.[^search-software]
- `Crucible CLI` returned multiple existing command-line products, including exact `crucible` commands and `crucible-cli` repositories.[^search-cli]
- `Crucible AI coding` returned the Chase AI workflow, the AI-agent security product, smart-contract testing, `usecrucible.ai`, and Atlassian.[^search-ai]
- The unqualified word is also a common English noun and strongly associated with Arthur Miller's *The Crucible*, making unqualified organic discovery intrinsically expensive even outside software.

A qualifier such as `Crucible by DevFlow` may help attribution in prose but does not provide a clean exact command, package, organization, or domain, and this research does not assess whether a qualifier is legally sufficient.

## Practical Variants And Decision Constraints

If `Crucible` remains a candidate after the conflicts above, the technically least-colliding shape is:

- Product display name: unresolved pending professional review; do not infer clearance from adding `DevFlow` or `CLI`.
- GitHub repository: `DevFlow-HQ/crucible` or `DevFlow-HQ/crucible-cli`, rechecked at decision time.
- npm package: `@devflow-hq/crucible` or `@devflow-hq/crucible-cli`, after confirming control of the npm scope.
- Executable: retain a distinct command rather than `crucible`; the existing `devflow` command is already differentiated from the exact collisions found here.
- Website: use an independently distinctive brand/domain. `cruciblecli.com` was only potentially obtainable, and relying on it would still leave the larger conflict unresolved.

Questions for the downstream naming decision:

1. Is the team willing to fund professional U.S. and launch-market clearance despite Atlassian's live exact software registration and active trademark claim?
2. Is a unique short executable a requirement? If yes, exact `crucible` fails that requirement today.
3. Is ownership of a matching short domain and GitHub organization a requirement? If yes, exact `Crucible` fails that requirement today.
4. Does the intended positioning include code review, planning/review loops, or AI coding-agent orchestration? The closer that positioning is to Atlassian or Chase AI, the more important professional assessment and differentiation become.
5. Does DevFlow control the `@devflow-hq` npm scope? If not, package naming remains unresolved even if the display name changes.

## Sources

[^uspto-crucible]: [USPTO TSDR, serial 87830814](https://tsdr.uspto.gov/statusview/sn87830814)
[^atlassian-product]: [Atlassian, Crucible product page](https://www.atlassian.com/software/crucible)
[^atlassian-trademarks]: [Atlassian Trademark Guidelines](https://www.atlassian.com/legal/trademark)
[^uspto-clearance]: [USPTO, Comprehensive clearance search for similar trademarks](https://www.uspto.gov/trademarks/search/comprehensive-clearance-search-similar-trademarks)
[^chase-crucible]: [chaseai-yt/crucible](https://github.com/chaseai-yt/crucible)
[^cruciblehq]: [Crucible sandbox documentation](https://cruciblehq.dev/docs)
[^cruciblehq-install]: [Crucible sandbox installation documentation](https://cruciblehq.dev/docs/install)
[^usecrucible]: [Crucible Solutions, Inc. product site](https://usecrucible.ai/)
[^galois]: [GaloisInc/crucible](https://github.com/GaloisInc/crucible)
[^oxide]: [oxidecomputer/crucible](https://github.com/oxidecomputer/crucible)
[^gh-crucible-org]: [GitHub API: crucible organization](https://api.github.com/users/crucible)
[^gh-cruciblehq-org]: [GitHub API: cruciblehq organization](https://api.github.com/users/cruciblehq)
[^gh-devflow-crucible]: [GitHub API probe: DevFlow-HQ/crucible](https://api.github.com/repos/DevFlow-HQ/crucible)
[^gh-devflow-crucible-cli]: [GitHub API probe: DevFlow-HQ/crucible-cli](https://api.github.com/repos/DevFlow-HQ/crucible-cli)
[^gh-search]: [GitHub repository search for Crucible](https://github.com/search?q=crucible+in%3Aname&type=repositories&s=stars&o=desc)
[^npm-crucible]: [npm registry metadata: crucible](https://registry.npmjs.org/crucible)
[^npm-crucible-cli]: [npm registry metadata: crucible-cli](https://registry.npmjs.org/crucible-cli)
[^npm-scoped-crucible]: [npm registry probe: @devflow-hq/crucible](https://registry.npmjs.org/%40devflow-hq%2Fcrucible)
[^npm-scoped-cli]: [npm registry probe: @devflow-hq/crucible-cli](https://registry.npmjs.org/%40devflow-hq%2Fcrucible-cli)
[^npm-air]: [npm registry metadata: @air-bizapps/crucible-cli](https://registry.npmjs.org/%40air-bizapps%2Fcrucible-cli/latest)
[^npm-cruciblelab]: [npm registry metadata: @cruciblelab/crucible](https://registry.npmjs.org/%40cruciblelab%2Fcrucible/latest)
[^npm-cruciblemcp]: [npm registry metadata: @cruciblemcp/cli](https://registry.npmjs.org/%40cruciblemcp%2Fcli/latest)
[^npm-unpublish]: [npm Unpublish Policy](https://docs.npmjs.com/policies/unpublish)
[^npm-scopes]: [npm documentation: Scope](https://docs.npmjs.com/cli/v11/using-npm/scope)
[^npm-bin]: [npm package.json documentation: bin](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin)
[^pypi-crucible]: [PyPI JSON API: crucible](https://pypi.org/pypi/crucible/json)
[^crates-crucible]: [crates.io API: crucible](https://crates.io/api/v1/crates/crucible)
[^nuget-crucible]: [NuGet flat-container index: Crucible](https://api.nuget.org/v3-flatcontainer/crucible/index.json)
[^nuget-cli]: [NuGet flat-container index: Crucible.Cli](https://api.nuget.org/v3-flatcontainer/crucible.cli/index.json)
[^brew-formula]: [Homebrew Formulae API probe: crucible formula](https://formulae.brew.sh/api/formula/crucible.json)
[^brew-cask]: [Homebrew Formulae API probe: crucible cask](https://formulae.brew.sh/api/cask/crucible.json)
[^rdap-com]: [Verisign RDAP: crucible.com](https://rdap.verisign.com/com/v1/domain/crucible.com)
[^rdap-dev]: [Google Registry RDAP: crucible.dev](https://pubapi.registry.google/rdap/domain/crucible.dev)
[^rdap-ai]: [Identity Digital RDAP: crucible.ai](https://rdap.identitydigital.services/rdap/domain/crucible.ai)
[^rdap-io]: [Identity Digital RDAP: crucible.io](https://rdap.identitydigital.services/rdap/domain/crucible.io)
[^rdap-app]: [Google Registry RDAP: crucible.app](https://pubapi.registry.google/rdap/domain/crucible.app)
[^rdap-sh]: [Identity Digital RDAP: crucible.sh](https://rdap.identitydigital.services/rdap/domain/crucible.sh)
[^rdap-get]: [Verisign RDAP: getcrucible.com](https://rdap.verisign.com/com/v1/domain/getcrucible.com)
[^rdap-use]: [Verisign RDAP: usecrucible.com](https://rdap.verisign.com/com/v1/domain/usecrucible.com)
[^rdap-hq]: [Google Registry RDAP: cruciblehq.dev](https://pubapi.registry.google/rdap/domain/cruciblehq.dev)
[^rdap-try]: [Identity Digital RDAP: trycrucible.io](https://rdap.identitydigital.services/rdap/domain/trycrucible.io)
[^rdap-cruciblecli]: [Verisign RDAP probe: cruciblecli.com](https://rdap.verisign.com/com/v1/domain/cruciblecli.com)
[^search-software]: [DuckDuckGo query: Crucible software](https://html.duckduckgo.com/html/?q=Crucible+software)
[^search-cli]: [DuckDuckGo query: Crucible CLI](https://html.duckduckgo.com/html/?q=Crucible+CLI)
[^search-ai]: [DuckDuckGo query: Crucible AI coding](https://html.duckduckgo.com/html/?q=Crucible+AI+coding)
