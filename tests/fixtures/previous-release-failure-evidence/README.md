# Previous-release failure-evidence fixture

This home comes from the public Bundle, Catalog, Process and Run Store Interfaces at
`d869a6a74c7d41db17f99c87db62f782b95246ea`, the parent of the first M11 run-journal migration.
`provenance.json` records source, database digests, migration journals and redactions.
`expected.json` records each Run's id, rest, creation time and Attempt log.

The home holds two Command-only Runs of one Bundle. Each first publishes a succeeded `prepare` Attempt with a real Git-backed Artifact.
The `halted` Run's `build` then fails once and ends `indeterminate`. The `failed` Run's `build` fails twice and exhausts its one retry.
Each owner releases its ownership, so reopening reconciles nothing and invents no crash cause. No row was written by SQL.

To reproduce, check out the source commit in a disposable checkout with its dependencies installed.
Copy `seed.txt` into that checkout as `.fixture-seed.ts`. Run
`FIXTURE_HOME=/tmp/secant-536-authentic-home timeout -k 10s 60s bun .fixture-seed.ts`, then remove the script.
The home path is stored as the Bundle's build folder; a neutral path keeps local user names out of the Catalog.
Copy the resulting home, including its `expected.json`. Run ids are generated; do not expect a reproduction to retain them.
Remove unused Git sample hooks and the empty `hooks` folders. Keep canonical database and Artifact bytes unchanged.

Tests copy the home before opening it. Semantic tests use its original Workspace `/fixture/failure-evidence`.
Copied-binary acceptance renames the Workspace group to match its temporary Workspace's slug and SHA-256 suffix,
then changes only each copied `run_record.workspace_path` before the binary's first open. The fixture remains unchanged.

`injectNewerEvidence` in `tests/application/previous-release-failure-fixture.ts` is the one synthetic fault.
After a copy has migrated, it inserts Failure evidence with an unknown source, an unknown receipt code, details missing a required field,
and an unknown effects value beside a valid receipt cause. It also gives the `halted` Run an unknown Resting-cause code and its diagnostic.
These rows stand in for a newer Secant's writes; they qualify tolerant reading, not any writer.
