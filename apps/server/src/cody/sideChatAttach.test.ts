import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  RunAttemptId,
  RunId,
  type ThreadContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { attachedSideChatRecords, sideChatSentThrough } from "./sideChatAttach.ts";

const run = (id: string, status: OrchestrationV2Run["status"], userMessageId: string) => ({
  id: RunId.make(id),
  status,
  userMessageId: MessageId.make(userMessageId),
  activeAttemptId: RunAttemptId.make(`${id}-attempt`),
});
const sideChatRuns = [1, 2, 3].map((ordinal) => ({
  id: RunId.make(`side-${ordinal}`),
  ordinal,
}));
const sentThrough = (
  runs: ReadonlyArray<ReturnType<typeof run>>,
  messages: ReadonlyArray<[string, string | null]>,
  sent: Record<string, string>,
  extra: { readonly accepted?: string; readonly exclude?: string } = {},
) =>
  sideChatSentThrough({
    sent: Object.fromEntries(
      Object.entries(sent).map(([messageId, runId]) => [messageId, RunId.make(runId)]),
    ),
    messages: messages.map(([id, runId]) => ({
      id: MessageId.make(id),
      runId: runId === null ? null : RunId.make(runId),
    })),
    runs,
    providerTurns:
      extra.accepted === undefined
        ? []
        : [
            {
              runAttemptId: RunAttemptId.make(extra.accepted),
              nativeTurnRef: "native" as never,
            },
          ],
    sideChatRuns,
    excludeMessageId: extra.exclude === undefined ? undefined : MessageId.make(extra.exclude),
  });

describe("sideChatSentThrough", () => {
  it("takes the newest side chat run any received message covered", () => {
    expect(
      sentThrough(
        [run("t1", "completed", "a"), run("t2", "completed", "b")],
        [
          ["b", "t2"],
          ["a", "t1"],
        ],
        { a: "side-2", b: "side-1" },
      ),
    ).toBe("side-2");
  });

  it("counts a message steered into another message's run", () => {
    expect(sentThrough([run("t1", "running", "a")], [["s", "t1"]], { s: "side-3" })).toBe("side-3");
  });

  it("ignores a message whose turn never reached the provider", () => {
    expect(
      sentThrough(
        [run("t1", "queued", "a"), run("t2", "failed", "b")],
        [
          ["a", "t1"],
          ["b", "t2"],
          ["c", null],
        ],
        { a: "side-1", b: "side-2", c: "side-3" },
      ),
    ).toBeNull();
    expect(
      sentThrough(
        [run("t2", "failed", "b")],
        [["b", "t2"]],
        { b: "side-2" },
        { accepted: "t2-attempt" },
      ),
    ).toBe("side-2");
  });

  it("ignores a rolled-back message and the message being sent now", () => {
    expect(
      sentThrough(
        [run("t1", "rolled_back", "a"), run("t2", "running", "b")],
        [
          ["a", "t1"],
          ["b", "t2"],
        ],
        { a: "side-2", b: "side-1" },
        { exclude: "b" },
      ),
    ).toBeNull();
  });
});

describe("attachedSideChatRecords", () => {
  it("keeps only side chat chips the text still links to", () => {
    const record = (threadId: string): ThreadContextRecord => ({
      version: 1,
      kind: "thread",
      contextId: toKindScopedComposerContextId("thread", threadId),
      label: threadId,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make(threadId),
      title: threadId,
    });
    const [side, unlinked, plain] = [record("side"), record("unlinked"), record("plain")];
    const attached = attachedSideChatRecords(
      {
        text: `${formatComposerContextReference(side)} ${formatComposerContextReference(plain)}`,
        context: { version: 1, records: [side, unlinked, plain] },
      },
      (threadId) => threadId !== "plain",
    );
    expect(attached).toEqual([side]);
  });
});
