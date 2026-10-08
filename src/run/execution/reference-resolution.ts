import { isAbsolute, resolve } from "node:path";
import type { ArtifactType } from "../../workflow/workflow.js";
import type { RunOwner } from "../store/store.js";

/** Resolve Launch input paths against the Run's Workspace. File sets retain their
 * newline-separated encoding; other Artifact types remain opaque text. */
export function resolveLaunchInputValue({
  type,
  value,
  workspacePath,
}: {
  readonly type: ArtifactType;
  readonly value: string;
  readonly workspacePath: string;
}): string {
  const absolutePath = (path: string) =>
    isAbsolute(path) ? path : resolve(workspacePath, path);
  if (type === "file") return absolutePath(value);
  if (type === "file-set") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(absolutePath)
      .join("\n");
  }
  return value;
}

/** Bound Run Artifacts take precedence over Launch inputs. Their canonical bytes
 * remain text; only Launch inputs use declared file types for path resolution. */
export function resolveArtifactReference(
  name: string,
  {
    owner,
    inputTypes,
  }: {
    readonly owner: RunOwner;
    readonly inputTypes: Readonly<Record<string, ArtifactType>>;
  },
): string {
  const versionId = owner.currentVersion(name);
  if (versionId !== undefined) {
    const bytes = owner.readArtifact(versionId, name);
    if (bytes === undefined) {
      throw new Error(
        `execution: artifact "${name}" has no bytes at its bound version.`,
      );
    }
    return new TextDecoder().decode(bytes);
  }
  const launch = owner.record.launch;
  const value =
    launch !== null && typeof launch === "object"
      ? Object.entries(launch).find(([key]) => key === name)?.[1]
      : undefined;
  if (typeof value !== "string") {
    throw new Error(
      `execution: artifact "${name}" is neither bound nor a Launch input at this Step.`,
    );
  }
  return resolveLaunchInputValue({
    type: inputTypes[name] ?? "text",
    value,
    workspacePath: owner.record.workspacePath,
  });
}
