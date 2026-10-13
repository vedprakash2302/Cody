import type { EnvironmentThreadShell } from "./state/models.ts";

export interface ScheduledTaskThreadOption {
  readonly id: string;
  readonly title: string;
}

type ScheduledTaskThreadCandidate = Pick<
  EnvironmentThreadShell,
  "id" | "title" | "archivedAt" | "lineage" | "updatedAt"
>;

/**
 * Top-level threads a scheduled task can post its runs to, most recently
 * active first. Archived threads and subagent threads are left out, except the
 * thread the task already posts to, so opening an editor never drops a saved
 * choice. Pass the threads of the task's project only.
 */
export function scheduledTaskThreadOptions(
  threads: ReadonlyArray<ScheduledTaskThreadCandidate>,
  selectedThreadId: string | null,
): ReadonlyArray<ScheduledTaskThreadOption> {
  const options = threads
    .filter(
      (thread) =>
        thread.id === selectedThreadId ||
        (thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent"),
    )
    // Not toSorted: mobile runs on Hermes, which lacks ES2023 array methods.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((thread) => ({ id: thread.id, title: thread.title }));
  if (selectedThreadId && !options.some((option) => option.id === selectedThreadId)) {
    return [{ id: selectedThreadId, title: "Unavailable thread" }, ...options];
  }
  return options;
}
