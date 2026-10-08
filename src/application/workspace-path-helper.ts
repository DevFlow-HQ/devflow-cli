import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

export type WorkspacePathHelper =
  | {
      readonly kind: "embedded";
      readonly stateDirectory: string;
      readonly version: string;
      readonly sha256: string;
      readonly readBytes: () => Promise<Uint8Array>;
    }
  | { readonly kind: "unavailable"; readonly cause: unknown };

/** Publish closed, verified bytes without ever replacing an executing helper.
 * Hard-link publication is atomic and no-clobber on POSIX and Windows. */
export function workspacePathHelper(
  input: Extract<WorkspacePathHelper, { kind: "embedded" }>,
) {
  let pending: Promise<string> | undefined;
  return () => {
    if (pending !== undefined) return pending;
    pending = ensure().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  async function verified(path: string): Promise<void> {
    const facts = await lstat(path);
    if (!facts.isFile() || facts.size > 16 * 1024 * 1024)
      throw new Error("Invalid Workspace path helper file");
    const bytes = await readFile(path);
    if (digest(bytes) !== input.sha256)
      throw new Error("Workspace path helper digest mismatch");
    await access(
      path,
      process.platform === "win32"
        ? constants.R_OK
        : constants.R_OK | constants.X_OK,
    );
  }
  async function ensure(): Promise<string> {
    if (
      !/^[a-zA-Z0-9.-]+$/.test(input.version) ||
      !/^[a-f0-9]{64}$/.test(input.sha256)
    )
      throw new Error("Invalid Workspace path helper pin");
    const path = join(
      input.stateDirectory,
      `rg-${input.version}-${input.sha256.slice(0, 16)}${process.platform === "win32" ? ".exe" : ""}`,
    );
    try {
      await verified(path);
      return path;
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "ENOENT"
      ))
        throw cause;
    }
    const bytes = await input.readBytes();
    if (digest(bytes) !== input.sha256)
      throw new Error("Embedded Workspace path helper digest mismatch");
    await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(input.stateDirectory, `.rg-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o700);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      await verified(temporary);
      try {
        await link(temporary, path);
      } catch (cause) {
        if (!(
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "EEXIST"
        ))
          throw cause;
      }
      await verified(path);
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
