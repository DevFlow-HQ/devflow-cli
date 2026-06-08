import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ManagedProviderSessionInput } from "./managedSessionAdapter.js";

/**
 * Resolves the Hook IPC endpoint socket path for a managed session.
 *
 * The socket is bound at a short, machine-scoped path under the OS temp dir
 * rather than inside the deep per-run scratch tree, so the full path stays
 * within the platform `sun_path` budget regardless of repo depth or run id
 * (see ADR 0013). The fixed-length digest of `workingDirectory + phase.id`
 * keeps the path unique across concurrent runs and repos.
 *
 * The single source of truth for both runners and tests.
 */
export function resolveHookSocketPath(
  input: ManagedProviderSessionInput,
): string {
  const scope = input.phase?.id ?? "unscoped";
  const hash = createHash("sha256")
    .update(`${input.workingDirectory}${scope}`)
    .digest("hex")
    .slice(0, 16);

  return join(tmpdir(), `devflow-${hash}.sock`);
}
