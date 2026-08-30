# Native Versioning for Run Artifacts

## Executive answer

No inspected product meets all of Crucible's requirements. Three products are credible enough for a bounded prototype:

1. **Git in a separate Crucible-owned bare repository** is the strongest mature content-history candidate. It natively stores immutable blobs, file trees, commit history, content hashes, compare-and-swap ref updates, and garbage-collectable reachability. It must never reuse or depend on the Workspace's repository. Crucible would still coordinate Git's durable commit with its transactional Run database.
2. **DoltLite** is the closest literal “version-controlled embedded database” with a current Node package, native commit hashes, historical SQL, content-addressed storage, and all three desktop operating systems. It is still beta and versions a whole database commit, not one Run Artifact.
3. **SurrealDB over SurrealKV** is the closest automatic temporal database: embedded Node, ACID transactions, historical queries, byte values, and unlimited version retention. SurrealKV is still documented as beta for embedded use, its public temporal address is time-based rather than an exact Artifact revision id, and SurrealDB core uses BSL 1.1.

Neither removes Crucible's need to define a **Run Artifact publication** and a **current binding**. A database revision says “the database changed”; it does not say which successful Step Attempt published which named, typed Artifact. It also cannot atomically capture a file that an Agent is still writing outside the database.

The strongest present recommendation is therefore:

- drop the proposed per-Artifact monotonically increasing number;
- use an opaque immutable `ArtifactVersionId` allocated by the persistence repository;
- keep one immutable publication record plus one current binding, committed atomically;
- use a content digest for integrity and physical deduplication, not as publication identity;
- use one dedicated bare Git repository per Run; keep DoltLite and SurrealKV only as research comparisons rather than live design candidates.

This delegates id allocation and transaction mechanics without making Crucible maintain a counter. It does not pretend generic database history understands the Run domain.

## Evaluation criteria

A candidate must work offline and locally in a Node CLI on Windows, macOS, and Linux; need no cloud service; expose a programmatic interface; atomically publish metadata and the current binding; retain exact old versions until explicit Run deletion; handle small values, files, and file sets; support deterministic integrity; avoid Git coupling; and have acceptable packaging, maintenance, and licensing.

## Comparison

| Candidate                                 | Native history identity                                                                                   | Local Node/three-OS fit                                                                                                      | Content and atomicity                                                                                                             | Retention/deletion                                                                                   | Verdict                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dedicated bare Git repository per Run** | Immutable commit id for a publication; content-addressed blobs and trees for values, files, and file sets | Mature native CLI on all three operating systems; must either require Git or deliberately bundle/integrate an implementation | Git object/ref updates are safe inside Git, but not atomic with a separate Run database; staged-commit reconciliation is required | Deleting the Run repository removes its complete history without rewriting or inspecting another Run | **Selected design; never use the Workspace repository**                                                                                        |
| **DoltLite**                              | Database commit hash; native log, row history, diffs, historical tables                                   | Embedded `@dolthub/doltlite`; prebuilt Linux x64/arm64, macOS x64/arm64, Windows x64                                         | SQL transactions and content-addressed database; BLOBs work, but file sets need an application manifest                           | Reachable commits survive GC; one Run cannot be selectively purged from shared history               | **Prototype candidate; do not adopt yet**                                                                                                      |
| **SurrealDB / SurrealKV**                 | Automatic temporal versions addressed publicly by time; low-level SurrealKV exposes timestamped history   | Embedded `@surrealdb/node` supports `surrealkv://`; SurrealKV is beta                                                        | ACID multi-record writes and bytes; external file sets still need staging/manifest/digest                                         | Retention `0` is unlimited; selective removal of one key's historical versions is not established    | **Prototype candidate; do not adopt yet**                                                                                                      |
| **CozoDB**                                | `Validity` key supplied by the application                                                                | Embedded `cozo-node` has three-OS builds, but latest release is v0.7.6 from December 2023                                    | Transactional scripts and byte values; no native content proof or file-set model                                                  | Time-travel relations retain assertions/retractions; targeted physical erasure is awkward            | Reject: Crucible still supplies the version key, plus maintenance risk                                                                         |
| **immudb**                                | Cryptographically linked global transaction id and per-key revisions; SQL time travel                     | Cross-platform server, but Node is a gRPC client; embedding is documented for Go                                             | Atomic KV/SQL transactions and byte values; default maximum value requires chunking larger files                                  | Age-based truncation is database-wide; table deletion leaves the commit log                          | Reject: sidecar, Node verification gap, deletion mismatch, BSL 1.1                                                                             |
| **KurrentDB / EventStoreDB**              | Native per-stream event revision                                                                          | Official Node client, but a separate .NET server/service must be bundled                                                     | Atomic event append; files need a second content store or oversized events                                                        | Per-stream hard delete exists; retention/scavenging are operational policies                         | Reject: server weight, event-sourcing model conflicts with the settled record-graph decision, custom license                                   |
| **MariaDB temporal tables**               | Engine-managed row validity / transaction history                                                         | Node client exists, but MariaDB Server must be installed and managed                                                         | Strong SQL transactions and BLOBs                                                                                                 | History is automatic and can be pruned, but this is a server database                                | Reject: not an embedded local CLI dependency                                                                                                   |
| **CouchDB / PouchDB `_rev`**              | Branching replication revision token                                                                      | PouchDB is local Node; CouchDB is a server                                                                                   | JSON/attachments and conflict control                                                                                             | Compaction can discard old revision bodies                                                           | Reject: explicitly not application version history                                                                                             |
| **restic / Kopia**                        | Immutable file-tree snapshot id                                                                           | Mature cross-platform binaries; subprocess/CLI integration, not a first-party Node database API                              | Excellent files/file sets, integrity, encryption, deduplication; a successful snapshot is published last                          | Snapshots remain until forget/delete and prune                                                       | Useful byte-snapshot layer only; cannot atomically own Run rows and current bindings without making the whole Run a staged filesystem snapshot |
| **DVC**                                   | Data hash plus Git revision                                                                               | Cross-platform CLI/Python                                                                                                    | Files/directories and content cache                                                                                               | History depends on Git metadata commits                                                              | Reject: Git is deliberately not Crucible's persistence model                                                                                   |
| **SQLite + content-addressed bytes**      | Database-allocated row id, not native semantic history                                                    | Embedded, local, mature, cross-platform; exact Node binding remains a later choice                                           | Atomic record/binding transaction; staged bytes can be verified before publication                                                | Crucible retains immutable rows until Run deletion                                                   | **Recommended baseline**, while acknowledging that Crucible owns the small domain record                                                       |

## Shortlist details

### 1. Dedicated bare Git repository per Run: selected design

This is not the Workspace's `.git` directory. Crucible creates and exclusively owns one bare repository inside each Run Store. Git's object database natively stores immutable blobs, directory trees, and commits; a commit references a complete tree plus its parent and metadata ([Git data model](https://github.com/git/htmldocs/blob/gh-pages/gitdatamodel.adoc)). Plumbing commands can write blobs and trees, create a commit, and safely compare-and-swap the publication ref from its expected old commit to the new commit ([`git update-ref`](https://git-scm.com/docs/git-update-ref.html)).

Each successful Artifact publication creates one commit in that Run's linear history containing a canonical publication manifest and its complete value/file/file-set tree. The Git commit id is the immutable `ArtifactVersionId`; the transactional Run database records its domain meaning and moves the current Artifact binding. Deleting a Run deletes its repository, so no shared reachability analysis, history rewrite, or cross-Run garbage collection is required. This gives up cross-Run byte deduplication in exchange for local ownership, failure isolation, and exact deletion.

Git does not make its ref update atomic with Crucible's separate Run-database transaction. The safe design must write and harden the candidate commit first, keep it reachable, and make only the later Run-database transaction semantically publish it. A crash between the stores leaves an unpublished Git commit that startup reconciliation can discard; consumers never treat a Git ref alone as a published Artifact. Git's default durability configuration may leave recently written loose objects vulnerable to an unclean shutdown, so the prototype must set and verify an appropriate `core.fsync` policy rather than relying on defaults ([`core.fsync`](https://git-scm.com/docs/git-config/2.54.0#Documentation/git-config.txt-corefsync)).

Implementation must still decide whether Crucible requires a supported Git executable, bundles one with the accompanying GPL compliance obligations, or adopts a library with equivalent object, ref, locking, garbage-collection, and fsync behavior. A partial JavaScript Git implementation cannot be assumed equivalent merely because it reads and writes Git repositories.

### 2. DoltLite: closest literal database candidate, currently too young

DoltLite is a SQLite fork whose main database uses a single-file content-addressed chunk store and Git-like commits, branches, diffs, and historical table views. It exposes history-independent table/database hashes and commit hashes, serializes durable writers, and uses compare-and-swap checks when advancing branch heads ([DoltLite README](https://github.com/dolthub/doltlite#readme)). Its Node binding follows the `node:sqlite`-style synchronous API and ships native prebuilds for Linux x64/arm64, macOS x64/arm64, and Windows x64 under Apache-2.0 ([DoltLite Node](https://github.com/dolthub/doltlite-node#readme)). It does not call the Workspace's Git executable or use its `.git` directory.

The fit is nevertheless imperfect:

- the native revision is a commit of the whole database, not a version of one Artifact;
- a binding written by a commit cannot contain that same commit's hash without a circular self-reference;
- BLOB rows can hold content, but file and file-set packaging remains Crucible's job;
- a shared database's reachable commit graph preserves deleted Run rows, so hard deletion needs history rewriting or, more plausibly, one database per Run;
- the README calls the current on-disk format a **beta** format, requires an exact format version, and promises no silent automatic rewrite ([DoltLite storage format](https://github.com/dolthub/doltlite#storage-format)).

Full Dolt has the same database-wide commit model but is not embedded in Node: normal Node access is through a spawned local SQL server and a MySQL client ([Dolt supported clients](https://www.dolthub.com/docs/sql-reference/supported-clients/clients)). DoltLite is therefore the only Dolt-family option worth prototyping here.

### 3. SurrealDB / SurrealKV: closest automatic temporal candidate

SurrealKV is a versioned embedded ACID key-value store. With versioning enabled and retention set to zero it preserves historical values without a time limit and exposes point-in-time reads plus iteration over all versions ([SurrealKV README](https://github.com/surrealdb/surrealkv#readme)). SurrealDB's Node engine embeds persistent SurrealKV in Node, Bun, or Deno using `@surrealdb/node` and `surrealkv://...?...versioned=true` ([embedded JavaScript engines](https://surrealdb.com/docs/reference/javascript/concepts/embedded-engines)). `sync=every` confirms each transaction only after syncing, and retention defaults to unlimited ([datastore configuration](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/start)).

This is closer than DoltLite to “update a logical key while the store keeps old values,” but it still leaves material gaps:

- the documented query-layer temporal address is a datetime; an exact engine-generated Artifact version id returned from the same Node transaction is not established;
- a current value's history says nothing about producer Attempt, Artifact type, schema validation, or home unless Crucible stores those fields;
- exact selective purge of all historical values for one deleted Run in a shared datastore is not documented;
- arbitrary bytes are supported, but a file set and its canonical digest still need a Crucible-defined manifest;
- SurrealKV is explicitly labeled beta for embedded/local-first deployments ([deployment models](https://surrealdb.com/docs/manage/self-hosted/deployment-models)); SurrealKV itself is Apache-2.0, while SurrealDB core is BSL 1.1 ([SurrealDB licensing](https://github.com/surrealdb/surrealdb#license)).

Using SurrealKV directly would avoid the SurrealDB query layer and license, but the official low-level API is Rust; a Node CLI would need to own and maintain a native binding.

## Why the other categories fail

### Immutable and event databases

immudb genuinely owns immutable, tamper-evident history: transactions are append-only, receive unsigned 64-bit transaction ids, and can contain arbitrary byte-array key/value entries ([immudb specifications](https://docs.immudb.io/1.1.0/operations/specs.html)). It supports SQL transactions and historical queries ([immudb transactions](https://docs.immudb.io/master/develop/sql/transactions)). However, current docs say the Node SDK's verification is not working, while ordinary Node use talks to a server ([immudb SDKs](https://docs.immudb.io/master/connecting/sdks)). Retention truncates value-log content by age rather than by Run, and dropping a SQL table leaves raw transactions in the commit log ([retention](https://docs.immudb.io/master/production/retention), [dropping tables](https://docs.immudb.io/master/develop/sql/tablesdrop)). Current core code is BSL 1.1 ([immudb repository](https://github.com/codenotary/immudb#license)).

KurrentDB assigns stream revisions and atomically appends events ([KurrentDB append semantics](https://docs.kurrent.io/clients/node/v1.3/appending-events)). It also has an official Node client and per-stream hard deletion ([deleting streams](https://docs.kurrent.io/clients/node/v1.1/delete-stream)). But it is a separately operated .NET server, not an embedded database ([installation](https://docs.kurrent.io/server/v25.0/quick-start/installation)), and current server code uses the Kurrent License rather than a standard permissive license ([Kurrent License](https://github.com/kurrent-io/KurrentDB/blob/master/LICENSE.md)). More importantly, making its event stream authoritative would reverse the already-settled decision to use a transactional record graph rather than pure event sourcing.

### Temporal SQL databases

MariaDB system-versioned tables automatically move old row values into history and support point-in-time queries; transaction-precise history can use engine transaction identifiers ([MariaDB system-versioned tables](https://mariadb.com/docs/server/reference/sql-structure/temporal-tables/system-versioned-tables)). Its official Node client is current ([MariaDB Node connector](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/mariadb-connector-node-js-guide)). Functionally this is real native row history, but requiring every Crucible CLI installation to provision and supervise MariaDB Server disqualifies it. SQL Server temporal tables have the same server-shaped mismatch.

SQLite has no equivalent automatic system-versioned table. Its optional Session extension records explicitly monitored changes into caller-managed changeset blobs, coalesces repeated changes in one session, and can omit a change that was made and undone ([SQLite Session extension](https://www.sqlite.org/sessionintro.html)). That is replication support, not durable Artifact history.

### File/data versioning

restic is mature, BSD-licensed, ships stable standalone binaries for Windows, macOS, and Linux, supports local repositories, and creates deduplicated immutable file-tree snapshots ([restic repository](https://github.com/restic/restic#readme), [installation](https://github.com/restic/restic/blob/master/doc/020_installation.rst)). A snapshot record is written only at the successful end of backup; an out-of-space failure may leave unreferenced data but no partial snapshot ([restic backup](https://github.com/restic/restic/blob/master/doc/040_backup.rst#space-requirements)). Kopia provides the same broad shape—local encrypted, deduplicated snapshots and cross-platform CLI/GUI—under Apache-2.0 ([Kopia repository](https://github.com/kopia/kopia#readme)).

These tools are excellent at owning **file-tree versions**. They are not transactional Run databases. Crucible would need to serialize small values, producer facts, current bindings, and Run state into a staging tree and declare the entire resulting snapshot authoritative. That makes every publication a backup operation and leaves coordination with other Run records outside the snapshot. They remain possible managed-content layers, not replacements for the Artifact graph.

DVC is directly out: its documented normal workflow initializes inside a Git repository and commits DVC metadata to Git ([DVC workflow](https://dvc.org/doc/command-reference/)).

### Replication revisions and content addresses

CouchDB explicitly says its revisions exist for replication and applications needing version history must preserve it themselves ([CouchDB application design](https://docs.couchdb.org/en/stable/best-practices/documents.html#designing-an-application-to-work-with-replication)). Revision trees branch, and compaction discards non-leaf bodies ([revision trees](https://docs.couchdb.org/en/stable/replication/conflicts.html#revision-tree)). PouchDB has the same fatal behavior: compaction makes old revisions unavailable ([PouchDB compaction](https://pouchdb.com/guides/compact-and-destroy.html)).

A digest identifies bytes and verifies integrity ([OCI descriptor digests](https://github.com/opencontainers/image-spec/blob/main/descriptor.md#digests)). It does not identify a publication: two Attempts can publish identical bytes while remaining distinct Run facts. Inline values need canonical serialization and file sets need a canonical manifest before hashing. Content-addressed storage belongs beneath the publication record.

## Recommended Q17 wording

> Each successful publication receives an opaque immutable `ArtifactVersionId` allocated by the persistence repository. Crucible does not maintain a per-Artifact counter. The immutable record carries Run, Artifact name, producer, type, content descriptor, home/materialization policy, validation facts, and creation time. The current binding points to that record, and all superseded records remain until explicit Run deletion. A human-facing ordinal, if ever needed, is derived for display only.

If SQLite is later selected, `INTEGER PRIMARY KEY` can allocate this id; `AUTOINCREMENT` is needed only if committed ids must never be reused after deletion, and it is not gapless ([SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html)). SQLite can atomically insert the record, update the current binding, settle the Attempt, and advance the Run, while durable staged content is published before that transaction ([SQLite as an application file format](https://www.sqlite.org/appfileformat.html)).

## Implementation questions left after selecting Git

The architecture selects one private bare Git repository per Run. Implementation still has to validate these operational details:

1. Can one API call durably publish metadata, current binding, Attempt outcome, Run advancement, and the native revision reference without a self-reference or crash window?
2. Which Git integration provides exact stable commit ids and the required object/ref durability on every supported platform?
3. What are the verified limits and performance for large files and file sets?
4. How are on-disk format upgrades, corruption detection, and native-binary packaging handled on every supported platform?
5. What licensing obligations follow from the selected Git executable or library distribution model?

These questions affect the adapter and packaging choice, not the settled domain contract or per-Run ownership boundary.
