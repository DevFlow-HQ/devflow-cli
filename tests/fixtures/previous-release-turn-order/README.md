# Previous-release Turn-order fixture

This companion to [the original conversation home](../previous-release-conversation/README.md) comes from the same predecessor commit,
`48f2f26638f9b1a936c60ea6bf12976d5bbfa006`. Generate it through that checkout's public Store Interface using the original `seed.txt`
with `FIXTURE_HOME=<empty-home> FIXTURE_TURN_ORDER=1 timeout -k 10s 60s bun .fixture-seed.ts`.

The four Turns alternate `shared`, `other`, `shared`, `other`. Each writes the observed model, tool start and approval request.
The first three then write the human answer, tool completion and divergent assistant event before settling the authoritative transcript reply.
The first Turn's input and reply are empty. The last Turn remains unfinished with a pending request in a running Run whose owner has exited.
Every fact has the same timestamp, so only predecessor write order can determine event order. No database or canonical Artifact bytes were edited.

`expected.json` records the public Store reads before the owner exits. Migration tests first preserve those live facts, then reopen with a dead owner
and verify the last Turn becomes lost without an invented reply. Projection Port tests verify each Session's input, event order, authoritative reply
and closing line while live and across two reopens after loss. The predecessor's assistant event copies remain diagnostic evidence and never become duplicate messages.
`provenance.json` records the source, database hashes, journals and reproduction command. Remove unused Git sample hooks after generation.
