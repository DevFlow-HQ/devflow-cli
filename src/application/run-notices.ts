import type { RunView } from "./projection-port.js";

export type RunNoticeSnapshot = Pick<
  RunView,
  "preferenceNotice" | "modelChoiceNotice" | "windowsCleanupNotice"
>;

/** Live notice evidence lasts for this Application lifetime, never as Run truth. */
export class RunNotices {
  private readonly runs = new Map<string, RunNoticeSnapshot>();

  snapshot(runId: string): RunNoticeSnapshot {
    return { ...this.runs.get(runId) };
  }

  setPreference(runId: string, notice: string | undefined): void {
    this.set(runId, "preferenceNotice", notice);
  }

  setModelChoice(runId: string, notice: string | undefined): void {
    this.set(runId, "modelChoiceNotice", notice);
  }

  observeWindowsCleanupFallback(runId: string): boolean {
    if (this.runs.get(runId)?.windowsCleanupNotice !== undefined) return false;
    this.set(
      runId,
      "windowsCleanupNotice",
      "Secant will use its usual Windows cleanup. Some tool processes may continue after you stop or close it.",
    );
    return true;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  private set(
    runId: string,
    field: keyof RunNoticeSnapshot,
    notice: string | undefined,
  ): void {
    const next = { ...this.runs.get(runId) };
    if (notice === undefined) delete next[field];
    else next[field] = notice;
    if (Object.keys(next).length === 0) this.runs.delete(runId);
    else this.runs.set(runId, next);
  }
}
