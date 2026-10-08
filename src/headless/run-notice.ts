import { headlessJson } from "./json.js";
import type { RunSnapshot } from "../application/projection-port.js";

/** One stderr report per Run command, shared by live updates and final read. */
export function createRunNoticeReporter(
  write: (text: string) => void,
): (snapshot: RunSnapshot) => void {
  const reported = new Set<string>();
  return (snapshot) => {
    if (!snapshot.result.found) return;
    for (const notice of [
      snapshot.result.run.windowsCleanupNotice,
      snapshot.result.run.preferenceNotice,
      snapshot.result.run.modelChoiceNotice,
    ]) {
      if (notice === undefined || reported.has(notice)) continue;
      reported.add(notice);
      write(`${notice}\n`);
    }
  };
}

/** Keep transient informational copy out of the existing JSON contract. */
export function runSnapshotJson(snapshot: RunSnapshot): string {
  if (!snapshot.result.found) return headlessJson(snapshot);
  const {
    windowsCleanupNotice: _windowsNotice,
    preferenceNotice: _preferenceNotice,
    modelChoiceNotice: _modelChoiceNotice,
    ...run
  } = snapshot.result.run;
  return headlessJson({ ...snapshot, result: { ...snapshot.result, run } });
}
