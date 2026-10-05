// One relative-path rule, shared by the manifest validator (`relativePath`) and
// the constrained ZIP reader (`decodePath`) so an asset path in a manifest and
// an entry name in an archive accept or reject identically (audit D8). `node:path`
// stays out on purpose: the rule is OS-independent, and `node:path.isAbsolute`
// disagrees across platforms (`isAbsolute("C:\\x")` is false on POSIX).
// Paths cannot be absolute, drive-lettered, or contain a `..` segment.
// Backslashes, repeated separators, and dot segments normalize to one file name.

/** Normalize a path to its safe relative form, or `undefined` if it is
 *  absolute, drive-lettered, or traverses. */
export function normalizeRelativePath(raw: string): string | undefined {
  const normalized = raw.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  const canonical = normalized
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (/^[A-Za-z]:/.test(canonical)) return undefined;
  return canonical === "" ? "." : canonical;
}
