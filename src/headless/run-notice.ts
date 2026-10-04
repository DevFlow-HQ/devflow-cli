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
    ]) {
      if (notice === undefined || reported.has(notice)) continue;
      reported.add(notice);
      write(`${notice}\n`);
    }
  };
}

/** Keep transient informational copy out of the existing JSON contract. */
export function runSnapshotJson(snapshot: RunSnapshot): string {
  if (!snapshot.result.found) return JSON.stringify(snapshot, null, 2);
  const {
    windowsCleanupNotice: _windowsNotice,
    preferenceNotice: _preferenceNotice,
    ...run
  } = snapshot.result.run;
  return JSON.stringify(
    { ...snapshot, result: { ...snapshot.result, run } },
    null,
    2,
  );
}
