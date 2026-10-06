# catalog — Module-local notes

Inherits the engineering baseline; records only non-obvious local facts. Ownership and import direction are the policy table's, not restated here.

## Invariants

- Preferences hold opaque string values per key. `setPreference` upserts one key; `changePreferences` writes a patch and resolves its result
  through Preference reads in one immediate transaction. A thrown resolver or failed write rolls back every supplied key.
  Latest commits win; unrelated keys and their encoding stay untouched.
  A malformed row throws at read ingress; Application defaults each appearance key independently, preserving Catalog-wide failures.

- First-install-wins is decided inside one immediate write transaction (`commitInstall`): a second install of the same identity whose digest already matches
  returns `already-installed`, and an identity collision (same id/version, different digest) returns `identity-collision` changing neither the store nor the
  Entry.
- The installation generation is a private monotonic increment (max + 1 per install), and a Trust grant is keyed on `(digest, installation_generation)`
  (`schema.ts` primary key), so reinstalling identical bytes lands a fresh generation and voids any earlier grant on that digest.
- A missing or incomplete asset tree is repaired (`repairTree`) under the install's immediate write lock, after re-reading the managed bytes and
  re-checking the tree, so concurrent repairs of one digest serialize across processes: a waiting caller reuses the tree the first one published, and only
  one extraction ever uses the staging path. A repair waits on the same 5-second `busy_timeout` as an install and throws past it.
- An intact tree is read without the lock: a repair replaces only a tree it found incomplete under the lock, and an install writes a tree only for a digest
  it newly installs.
- Tree intactness is a size check per declared asset, not a hash (`treeIntact`), so a same-length edit survives until the next reinstall; the managed bytes
  remain the authority either way.
- Extracted asset files are made read-only on POSIX only (`chmod 0o444`); Windows gets no read-only attribute, and directories stay writable on both, so a
  rewrite can `rmSync` the old tree without a chmod pass first.
- The installed asset root (`assetRoot`) is the one storage path that deliberately crosses the Interface — a Run reads the extracted layer from it; every
  other store path (the managed bytes, the tree layout) stays private (ADR 0025).
- `origin_location` is one polymorphic text column decoded by `origin_kind`: the build folder, the imported file path, or the installing Secant version for
  `built-in` (ADR 0029). A new origin kind must change the read-ingress `z.enum` on the entry row schema, `toEntry`, and `originLocation()` together, or persisted
  rows fail read ingress.
