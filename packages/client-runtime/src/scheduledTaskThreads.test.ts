import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  scheduledTaskCanClearThread,
  scheduledTaskModeAfterThreadChoice,
  scheduledTaskPostsToThread,
  scheduledTaskShowsThreadPicker,
  scheduledTaskThreadOptions,
} from "./scheduledTaskThreads.ts";

const thread = (
  id: string,
  updatedAt: string,
  overrides: {
    readonly archivedAt?: string | null;
    readonly relationshipToParent?: "subagent" | "fork" | null;
  } = {},
) => ({
  id: ThreadId.make(id),
  title: `Thread ${id}`,
  updatedAt,
  archivedAt: overrides.archivedAt ?? null,
  lineage: {
    rootThreadId: ThreadId.make(id),
    parentThreadId: null,
    relationshipToParent: overrides.relationshipToParent ?? null,
  },
});

describe("scheduledTaskThreadOptions", () => {
  it("lists open threads newest first, without archived threads or subagents", () => {
    const options = scheduledTaskThreadOptions(
      [
        thread("old", "2026-10-01T00:00:00.000Z"),
        thread("new", "2026-10-03T00:00:00.000Z"),
        thread("fork", "2026-10-02T00:00:00.000Z", { relationshipToParent: "fork" }),
        thread("archived", "2026-10-04T00:00:00.000Z", { archivedAt: "2026-10-05T00:00:00.000Z" }),
        thread("child", "2026-10-04T00:00:00.000Z", { relationshipToParent: "subagent" }),
      ],
      null,
    );
    expect(options.map((option) => option.id)).toEqual(["new", "fork", "old"]);
  });

  it("keeps the thread a task already posts to, even archived or missing", () => {
    const archived = thread("archived", "2026-10-04T00:00:00.000Z", {
      archivedAt: "2026-10-05T00:00:00.000Z",
    });
    expect(scheduledTaskThreadOptions([archived], "archived").map((option) => option.id)).toEqual([
      "archived",
    ]);
    expect(scheduledTaskThreadOptions([], "gone")).toEqual([
      { id: "gone", title: "Unavailable thread" },
    ]);
  });
});

describe("Post runs to with thread modes", () => {
  it("shows the picker beside a one-thread Destination, or alone on older servers", () => {
    expect(scheduledTaskShowsThreadPicker("new_thread", true)).toBe(false);
    expect(scheduledTaskShowsThreadPicker("continue", true)).toBe(true);
    expect(scheduledTaskShowsThreadPicker("fresh_session", true)).toBe(true);
    expect(scheduledTaskShowsThreadPicker("new_thread", false)).toBe(true);
  });

  it("binds a picked thread and clears it the way the server can", () => {
    // The server keeps a stored thread for a one-thread task, so a pick must carry a mode.
    expect(scheduledTaskModeAfterThreadChoice("new_thread", true, true)).toBe("continue");
    expect(scheduledTaskModeAfterThreadChoice("fresh_session", true, true)).toBe("fresh_session");
    expect(scheduledTaskModeAfterThreadChoice("continue", false, true)).toBe("continue");
    expect(scheduledTaskModeAfterThreadChoice("continue", false, false)).toBe("new_thread");
    expect(scheduledTaskModeAfterThreadChoice("new_thread", true, false)).toBe("continue");
  });

  it("hides the workspace only while runs go to a picked thread", () => {
    expect(scheduledTaskPostsToThread("thread-1", "continue")).toBe(true);
    expect(scheduledTaskPostsToThread("thread-1", "new_thread")).toBe(false);
    expect(scheduledTaskPostsToThread("", "continue")).toBe(false);
    expect(scheduledTaskPostsToThread(null, "fresh_session")).toBe(false);
  });

  it("offers no thread only where a save can unbind", () => {
    const bound = { threadId: ThreadId.make("thread-1"), threadMode: "continue" as const };
    expect(scheduledTaskCanClearThread(bound, true)).toBe(false);
    expect(scheduledTaskCanClearThread({ ...bound, threadMode: undefined }, true)).toBe(false);
    expect(scheduledTaskCanClearThread({ threadId: null, threadMode: "continue" }, true)).toBe(
      true,
    );
    expect(scheduledTaskCanClearThread(null, true)).toBe(true);
    expect(scheduledTaskCanClearThread(bound, false)).toBe(true);
  });
});
