# Previous-release conversation fixture

This home comes from the public Bundle, Catalog, Process and Run Store Interfaces at
`48f2f26638f9b1a936c60ea6bf12976d5bbfa006`, before #411 changes the schema.
`provenance.json` records source, database digests, migration journal and redactions.
`expected.json` records every conversation message, Turn, event, Session, outcome and gate.

The home contains 12 Turns across two Sessions. Both messages in the first Turn
are empty. Every later assistant transcript differs from its assistant event and
result copy. These cases use the predecessor's public writes, without SQL mutation.
The home also retains a real Git-backed Artifact, a gate answer and a pending gate.

To reproduce, check out the source commit in a disposable checkout with its dependencies installed.
Copy `seed.txt` into that checkout as `.fixture-seed.ts`. Run
`FIXTURE_HOME=<empty-home> timeout -k 10s 60s bun .fixture-seed.ts`, then remove the script.
Copy the resulting home and expected records together. Run ids and Git gate-answer
ids are generated; do not expect a reproduction to retain those random values.
Remove unused Git sample hooks. Keep canonical database and Artifact bytes unchanged.

Tests copy the home before opening it. Semantic tests use its original Workspace
`/fixture/conversation`. Copied-binary acceptance renames the Workspace group to
match its temporary Workspace's slug and SHA-256 suffix, then changes only the
copied `run_record.workspace_path` before first open. The fixture remains unchanged.

Orphan cases explicitly replace the first copied transcript row's Turn or Session
with `missing`. Rollback cases add an aborting insert trigger on copied `turn_event`.
These are synthetic migration fault injections against the authentic schema.
They qualify recovery semantics and do not qualify Harness wire fields.
The older pre-Drizzle fixture remains a separate, unchanged compatibility baseline.

The companion [Turn-order home](../previous-release-turn-order/README.md) extends this baseline with legacy activity and requests, interleaved Sessions,
and an unfinished Turn. Set `FIXTURE_TURN_ORDER=1` when running `seed.txt` to create it. The original database and Artifact bytes remain unchanged.

`headless-transcript-shared.txt`, `headless-transcript-other.txt`, and `headless-show.txt` are the predecessor's exact JSON stdout, including its final newline.
They were captured through the predecessor's public Application and headless Interfaces after copying this home. To recapture, copy `headless-seed.txt`
into the predecessor checkout as `.capture-headless.ts` and run `FIXTURE_SOURCE=<absolute-fixture-folder> timeout -k 10s 60s bun .capture-headless.ts`.
The capture script uses the predecessor's real Process for any Artifact reads and cleans its temporary copy after closing Application, Store and Catalog.
