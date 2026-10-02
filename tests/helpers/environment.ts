// Per-test environment changes (#315). A test that sets a variable such as
// SECANT_CLAUDE_CODE claims it here, and the claim is released by the test's after
// hook. A timed-out test's hook can run after the next test in the file has set its
// own value, so a release must not simply write back what it saved: only the newest
// claim on a variable owns its live value. An older claim released late leaves the
// value in place, and the newest claim's release unwinds it with its own. Comparing
// the live value with the one the test set is not enough, because most tests set the
// same value (`process.execPath`).
//
// A release writes back the value from before its claim, so a test makes every
// change to a claimed variable through a claim: a direct write while one is live
// (an `ensureRuntimeOnPath` under a PATH claim) would be undone by the unwind.
//
// The registry is file-owned: each file runs in its own worker (scripts/test.ts), so
// a change for a whole file, like `ensureRuntimeOnPath`, needs no claim.

/** The part of a `node:test` TestContext the helper needs. */
interface CleanupScope {
  after(fn: () => void): void;
}

interface Claim {
  /** The value before this claim set the variable; undefined means unset. */
  readonly previous: string | undefined;
  released: boolean;
}

/** Each variable's live claims, oldest first. */
const claims = new Map<string, Claim[]>();

/** Set `values` for the test that owns `t` (undefined unsets a variable) and restore
 *  them when it ends. Returns the restore for a test that must end the change early;
 *  the after hook then does nothing. */
export function setEnvironmentForTest(
  t: CleanupScope,
  values: Readonly<Record<string, string | undefined>>,
): () => void {
  const owned = Object.entries(values).map(([name, value]) => {
    const claim: Claim = { previous: process.env[name], released: false };
    const stack = claims.get(name) ?? [];
    stack.push(claim);
    claims.set(name, stack);
    write(name, value);
    return { name, claim };
  });
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const { name, claim } of [...owned].reverse()) release(name, claim);
  };
  t.after(restore);
  return restore;
}

function release(name: string, claim: Claim): void {
  claim.released = true;
  const stack = claims.get(name) ?? [];
  // Unwind only from the newest claim: a claim with a live claim above it was
  // released late, and the newer test's value stays until that test releases too.
  for (let top = stack.at(-1); top?.released === true; top = stack.at(-1)) {
    stack.pop();
    write(name, top.previous);
  }
  if (stack.length === 0) claims.delete(name);
}

function write(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
