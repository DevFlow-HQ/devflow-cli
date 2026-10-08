# Run Store artifact publication and working area

Read before changing Artifact reads/publication, Gate-answer publication, output receipts, or working-area access.
The [Run Store notes](../../src/run/store/AGENTS.md) keep ownership and fencing rules.

- Artifact publication (#80) is all-or-nothing: the private Artifact Module stages one Git commit (its id is the version id) into `artifacts.git`, then one
  `run.db` transaction records the versions, moves the bindings, and settles the Attempt. A staged commit or ref alone is invisible candidate storage — only
  that transaction publishes — so a fault between the commit and the transaction leaves no binding moved, and republishing the same attempt id is a no-op.
- Git mechanics shell out to the `git` executable (no library); `artifacts.git` is created lazily on first publication. An absent `git` surfaces as a
  precise `git-unavailable` Problem only on the stage/publish path; the read path deliberately throws `GitUnavailable` (an environment fault is not an
  absent artifact) and `readArtifact` passes it through. Bindings/attempt reads validate their row at the read ingress like the coordination reads (D7).
- A Human Gate answer (#85) is a bound Artifact recorded through `recordGateAnswer` — a publication-shaped write (stage a commit, then one transaction moves the
  binding and appends the `gate_answer` row) that deliberately skips `attempt_log`, so `blocked` stays derived and iterations still count off the log. Idempotent
  per `operation_id` (a UNIQUE column); its `iterations_at_grant` is the offset the derived "iterations since the last grant" count resets from.
- `outputReceiptDirectory` (#215) hands execution one emptied `.receipts/<first 32 hex characters of sha256(attemptId)>` directory inside the Run working
  area (#220), so the one Harness grant covers it; hashed because Attempt ids carry `:`. `keep` (#354, a follow-up Turn) skips emptying, so it refuses any
  non-directory there (a planted link too). Candidate storage, never canonical or fenced: only `publishAttempt` binds receipt bytes; Run deletion removes it.
  A typed result, never a throw (#305): `working-area-unavailable`, or `output-receipt-directory-unavailable` for a squatted root, a root that does not
  resolve to itself (an agent-planted link, refused before emptying through it), or a failed removal/creation.
- `workingArea()` (#214, #479) lazily creates `working/` in the published Run directory; pre-M6 Runs gain it on resume. Its canonical `realpath` matches sandbox roots.
  It is unfenced working state, granted whole, with no private files; Output receipts are its only Store-named child. Refuse a linked leaf before grants or receipts.
  Parent aliases remain valid. This filesystem check cannot prevent replacement between validation and use.
