import type { RunSnapshot } from "../application/projection-port.js";

/** One stderr report per Run command, shared by live updates and final read. */
export function createRunNoticeReporter(
  write: (text: string) => void,
): (snapshot: RunSnapshot) => void {
  let reported = false;
  return (snapshot) => {
    if (reported || !snapshot.result.found) return;
    const notice = snapshot.result.run.windowsCleanupNotice;
    if (notice === undefined) return;
    reported = true;
    write(`${notice}\n`);
  };
}

/** Keep transient informational copy out of the existing JSON contract. */
export function runSnapshotJson(snapshot: RunSnapshot): string {
  if (!snapshot.result.found) return JSON.stringify(snapshot, null, 2);
  const { windowsCleanupNotice: _notice, ...run } = snapshot.result.run;
  return JSON.stringify(
    { ...snapshot, result: { ...snapshot.result, run } },
    null,
    2,
  );
}
