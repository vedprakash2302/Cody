import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AssistantCitation,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import { useComposerDraftStore } from "../composerDraftStore";
import type { AssistantCitationSourceAnchor } from "../lib/assistantTextSelection";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import { quoteIntoSideChatComposer, sideChatComposerRef } from "./sideChatComposers";
import { isSummarizing, watchSummary } from "./sideChatSummaries";
import { readParentComposerSettings } from "./sideChatSettings";
import {
  addCatchUp,
  bringBackSideChat,
  bringBackSize,
  pickSideChat,
  summaryReply,
} from "./sideChats";

const environmentId = EnvironmentId.make("cody-side-chats-env");
const mainRef = scopeThreadRef(environmentId, ThreadId.make("cody-main"));
const sideChatRef = scopeThreadRef(environmentId, ThreadId.make("cody-side-chat"));
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);

const chipsIn = (ref: typeof mainRef) =>
  (useComposerDraftStore.getState().getComposerDraft(ref)?.threadContexts ?? []).map(
    (record) => record.threadId,
  );

describe("side chat chips", () => {
  it("Bring back puts the side chat's chip in the main thread's next message, once", () => {
    bringBackSideChat(sideChatRef, mainRef);
    bringBackSideChat(sideChatRef, mainRef);
    expect(chipsIn(mainRef)).toEqual([sideChatRef.threadId]);
  });

  it("catching up puts main's chip in the side chat's next message", () => {
    addCatchUp(sideChatRef, mainRef);
    expect(chipsIn(sideChatRef)).toEqual([mainRef.threadId]);
  });
});

describe("side chats started from the palette or Ask in side chat", () => {
  it("start with what the parent's composer would send", () => {
    const parentRef = scopeThreadRef(environmentId, ThreadId.make("cody-settings-parent"));
    expect(readParentComposerSettings(parentRef)).toEqual({
      runtimeMode: DEFAULT_RUNTIME_MODE,
      modelSelection: undefined,
    });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
    };
    useComposerDraftStore.getState().setRuntimeMode(parentRef, "approval-required");
    useComposerDraftStore.getState().setModelSelection(parentRef, modelSelection);
    expect(readParentComposerSettings(parentRef)).toEqual({
      runtimeMode: "approval-required",
      modelSelection: expect.objectContaining(modelSelection),
    });
  });

  it("Ask goes to the side chat whose tab is active, else the newest", () => {
    const sideChats = [
      { id: ThreadId.make("b"), createdAt: "2026-11-02T00:00:00.000Z" },
      { id: ThreadId.make("a"), createdAt: "2026-11-01T00:00:00.000Z" },
    ];
    expect(pickSideChat(sideChats, "side-chat:a")?.id).toBe("a");
    expect(pickSideChat(sideChats, "terminal")?.id).toBe("b");
    expect(pickSideChat([], null)).toBeNull();
  });
});

describe("Bring back size", () => {
  const sideChatRun = (ordinal: number) => ({
    id: RunId.make(`side-${ordinal}`),
    ordinal,
    status: "completed" as const,
    completedAt: at(ordinal * 10),
  });
  const sideChat = {
    runs: [sideChatRun(1), sideChatRun(2)],
    messages: [
      { runId: RunId.make("side-1"), text: "a".repeat(400) },
      { runId: RunId.make("side-2"), text: "b".repeat(800) },
    ],
  };
  const chip = threadContextRecord(sideChatRef, "Side chat");

  it("counts only the replies main hasn't received", () => {
    const main = {
      messages: [
        {
          id: MessageId.make("main-1"),
          runId: RunId.make("main-run-1"),
          role: "user" as const,
          text: `${formatComposerContextReference(chip)} what did it say?`,
          context: { version: 1 as const, records: [chip] },
          createdAt: at(14),
        },
      ],
      runs: [
        {
          id: RunId.make("main-run-1"),
          status: "completed" as const,
          userMessageId: MessageId.make("main-1"),
          activeAttemptId: null,
          startedAt: at(15),
          requestedAt: at(14),
        },
      ],
      providerTurns: [],
    };
    expect(bringBackSize(sideChat, main, sideChatRef.threadId)).toEqual({
      newReplies: 1,
      tokens: 200,
    });
    expect(
      bringBackSize(sideChat, { messages: [], runs: [], providerTurns: [] }, sideChatRef.threadId),
    ).toEqual({ newReplies: 2, tokens: 300 });
  });
});

describe("summaries", () => {
  const request = MessageId.make("summary-request");
  const withRun = (status: OrchestrationV2Run["status"], replies: ReadonlyArray<string>) => ({
    runs: [{ id: RunId.make("summary-run"), status, userMessageId: request }],
    messages: [
      { runId: RunId.make("summary-run"), role: "user" as const, text: "Summarize" },
      ...replies.map((text) => ({
        runId: RunId.make("summary-run"),
        role: "assistant" as const,
        text,
      })),
    ],
  });

  it.each([
    ["no run yet", { runs: [], messages: [] }, { status: "pending" }],
    ["running", withRun("running", []), { status: "pending" }],
    [
      "finished",
      withRun("completed", ["Draft", " The summary. "]),
      { status: "done", text: "The summary." },
    ],
    ["finished without a reply", withRun("completed", ["  "]), { status: "failed" }],
    ["interrupted", withRun("interrupted", ["Partial"]), { status: "failed" }],
  ] as const)("%s", (_name, sideChat, expected) => {
    expect(summaryReply(sideChat, request)).toEqual(expected);
  });

  const watched = (name: string) => {
    const ref = scopeThreadRef(environmentId, ThreadId.make(name));
    const parentRef = scopeThreadRef(environmentId, ThreadId.make(`${name}-parent`));
    const thread = Atom.make<{ readonly projection: ReturnType<typeof withRun> } | null>({
      projection: withRun("running", []),
    }).pipe(Atom.keepAlive);
    const status = Atom.make<string>("live").pipe(Atom.keepAlive);
    const quiet = vi
      .spyOn(environmentThreadDetails, "quietThreadAtom")
      .mockReturnValue(thread as never);
    const statusSpy = vi
      .spyOn(environmentThreadDetails, "statusAtom")
      .mockReturnValue(status as never);
    onTestFinished(() => {
      quiet.mockRestore();
      statusSpy.mockRestore();
    });
    watchSummary({ sideChatRef: ref, parentRef, messageId: request });
    const draft = () => useComposerDraftStore.getState().getComposerDraft(parentRef)?.prompt ?? "";
    return { ref, thread, status, draft };
  };

  it("hands the finished summary to main once", () => {
    const { ref, thread, draft } = watched("cody-summary-once");
    expect(isSummarizing(ref)).toBe(true);
    appAtomRegistry.set(thread, { projection: withRun("completed", ["The summary."]) });
    appAtomRegistry.set(thread, { projection: withRun("completed", ["The summary."]) });
    expect(draft().match(/The summary\./g)).toHaveLength(1);
    expect(isSummarizing(ref)).toBe(false);
  });

  it("stops waiting when the side chat is deleted", () => {
    const { ref, thread, status, draft } = watched("cody-summary-deleted");
    appAtomRegistry.set(thread, null);
    appAtomRegistry.set(status, "deleted");
    expect(isSummarizing(ref)).toBe(false);
    expect(draft()).toBe("");
  });
});

describe("Ask in side chat", () => {
  const citation: AssistantCitation = {
    version: 1,
    ...mainRef,
    messageId: MessageId.make("main-reply"),
    text: "quoted",
    start: 0,
    end: 6,
    prefix: "",
    suffix: "",
  };
  const anchor = {} as AssistantCitationSourceAnchor;
  const composer = (accepts: boolean) =>
    ({
      citeAssistantText: vi.fn(() => accepts),
      insertTextAtEnd: vi.fn(() => accepts),
    }) as unknown as ChatComposerHandle & {
      readonly citeAssistantText: ReturnType<typeof vi.fn>;
      readonly insertTextAtEnd: ReturnType<typeof vi.fn>;
    };

  it("opens the comment box once a side chat's opening tab mounts its composer", async () => {
    const ref = scopeThreadRef(environmentId, ThreadId.make("cody-opening-side-chat"));
    quoteIntoSideChatComposer(ref, citation, anchor);
    const handle = composer(true);
    sideChatComposerRef(scopedThreadKey(ref)).current = handle;
    await Promise.resolve();
    expect(handle.citeAssistantText).toHaveBeenCalledExactlyOnceWith(citation, anchor);

    sideChatComposerRef(scopedThreadKey(ref)).current = null;
    sideChatComposerRef(scopedThreadKey(ref)).current = handle;
    await Promise.resolve();
    expect(handle.citeAssistantText).toHaveBeenCalledOnce();
  });

  it("keeps every quote sent while the tab opens, with the last one's comment box", async () => {
    const ref = scopeThreadRef(environmentId, ThreadId.make("cody-two-quotes-side-chat"));
    const second = { ...citation, text: "second", messageId: MessageId.make("other-reply") };
    quoteIntoSideChatComposer(ref, citation, anchor);
    quoteIntoSideChatComposer(ref, second, anchor);
    const handle = composer(true);
    sideChatComposerRef(scopedThreadKey(ref)).current = handle;
    await Promise.resolve();
    expect(handle.insertTextAtEnd).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("text=quoted"),
      { ensureLeadingBoundary: true },
    );
    expect(handle.citeAssistantText).toHaveBeenCalledExactlyOnceWith(second, anchor);
  });

  it("keeps quotes in the draft when the tab never mounts its composer", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const ref = scopeThreadRef(environmentId, ThreadId.make("cody-closed-side-chat"));
    quoteIntoSideChatComposer(ref, citation, anchor);
    expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "").toBe("");
    vi.runAllTimers();
    expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toContain(
      "[Assistant quote](t3-citation://",
    );
  });

  it("puts the quote in the draft when the composer refuses it", () => {
    const ref = scopeThreadRef(environmentId, ThreadId.make("cody-busy-side-chat"));
    sideChatComposerRef(scopedThreadKey(ref)).current = composer(false);
    quoteIntoSideChatComposer(ref, citation, anchor);
    expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toContain(
      "[Assistant quote](t3-citation://",
    );
  });
});
