import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskThreadOptions } from "./scheduledTaskThreads.ts";

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
