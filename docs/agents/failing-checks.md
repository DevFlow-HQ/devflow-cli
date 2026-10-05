# Failing checks

Read this before fixing a failing check or changing its expected result. Resolve failures against the intended behavior and preserve detection of real defects.

## Decide what is wrong

1. State what the check proves and which incorrect behavior it must reject.
2. Establish the correct result from the authorized task, specification, schema, or declared assets. The failing implementation's output alone is not evidence.
3. If the implementation violates that requirement, fix the implementation. If an authorized change makes the expectation stale, update the expectation.

Limit check changes to what the authorized task requires. Keep unrelated passing checks out of the change.

Proceed without asking for permission when that evidence establishes the correct change. This includes expected values, fixtures, and snapshots.
Ask the user only when the intended behavior is unclear or the proposed change would reduce coverage of a requirement that still applies.

## Preserve defect detection

- Keep assertions for every unchanged requirement. When authorized work removes behavior, remove its obsolete tests and retain coverage of the remaining behavior.
- Do not skip tests, remove meaningful assertions, relax a policy or allowlist, add retries or sleeps, or increase timeouts merely to obtain a pass.
- Avoid expected values computed by the same logic being tested. A packaging check may compare a delivered artifact with its independently declared source assets.
- Replace manually maintained expectations with authoritative declarations when that preserves the check's purpose.
- For important checks, temporarily introduce the relevant defect in an isolated copy and confirm the revised check fails. Remove the defect before final verification.

Record why the expectation changed, its source of truth, and the incorrect behavior the revised check still rejects in the change summary.
Run the affected checks and the canonical gate. A passing check alone does not justify its own modification.

## Migration example

An authorized new migration changes the declared migration list. Update a stale expected count, or derive it from that list, without requesting another approval.
The check still requires exact agreement with the migrated database and must reject missing or extra migration records.
Changing an exact comparison to a lower bound would conceal unexpected records and reduce what the check proves.
