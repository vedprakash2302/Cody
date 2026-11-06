import {
  scheduledTaskThreadMode,
  type ScheduledTask,
  type ScheduledTaskThreadMode,
} from "@t3tools/contracts";

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

/**
 * The "Post runs to" picker sits beside the Destination picker on servers with thread modes.
 * Older servers have no modes, so the picker alone chooses between new threads and one thread.
 */
export function scheduledTaskShowsThreadPicker(
  threadMode: ScheduledTaskThreadMode,
  offersThreadModes: boolean,
): boolean {
  return !offersThreadModes || threadMode !== "new_thread";
}

/** Picking a thread for a new-thread task continues it; clearing it on an older server unbinds. */
export function scheduledTaskModeAfterThreadChoice(
  threadMode: ScheduledTaskThreadMode,
  pickedThread: boolean,
  offersThreadModes: boolean,
): ScheduledTaskThreadMode {
  if (pickedThread) return threadMode === "new_thread" ? "continue" : threadMode;
  return offersThreadModes ? threadMode : "new_thread";
}

/** Runs go to the picked thread's checkout, so the workspace fields don't apply. */
export function scheduledTaskPostsToThread(
  threadId: string | null,
  threadMode: ScheduledTaskThreadMode,
): boolean {
  return Boolean(threadId) && threadMode !== "new_thread";
}

/**
 * Whether the picker can leave the thread empty. The server keeps a saved binding unless the
 * task switches to new threads, so a bound one-thread task can only move to another thread.
 */
export function scheduledTaskCanClearThread(
  savedTask: Pick<ScheduledTask, "threadId" | "threadMode"> | null,
  offersThreadModes: boolean,
): boolean {
  return (
    !offersThreadModes ||
    savedTask === null ||
    savedTask.threadId === null ||
    scheduledTaskThreadMode(savedTask) === "new_thread"
  );
}
