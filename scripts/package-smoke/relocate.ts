import { createHash } from "node:crypto";
import { readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

/** Rename a copied home's one Run group to the folder the Store derives for
 *  `workspace` (its slug and SHA-256 suffix), and return the group's path.
 *  Callers retarget each Run's stored Workspace before the binary opens it. */
export function relocateRunGroup(home: string, workspace: string): string {
  const runs = join(home, "runs");
  const [group] = readdirSync(runs);
  if (group === undefined) throw new Error(`${home} has no Run group.`);
  const slug = basename(workspace)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const digest = createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 16);
  const relocated = join(runs, `${slug || "workspace"}--${digest}`);
  renameSync(join(runs, group), relocated);
  return relocated;
}
