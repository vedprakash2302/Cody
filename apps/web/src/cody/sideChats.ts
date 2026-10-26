import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createCodySideChatAtoms } from "@t3tools/client-runtime/state/cody-side-chats";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { ThreadId } from "@t3tools/contracts";
import type {
  AssistantCitation,
  CodySideChatMainView,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { formatAssistantCitationForComposer } from "../composer-logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { getClientSettings } from "../hooks/useSettings";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { threadContextRecord } from "../lib/composerContextRecords";
import { dispatchSnapShotComposerFocus } from "../lib/desktopSnapShot";
import { newMessageId } from "../lib/utils";
import { readLocalApi } from "../localApi";
import type { PendingUserInputDraftAnswer } from "../pendingUserInput";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readThreadShell,
  useQuietThreadShell,
  useServerConfigs,
  useThreadProjection,
  waitForThreadShell,
} from "../state/entities";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { useEnvironmentQuerySelector } from "../state/query";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { buildThreadRouteParams } from "../threadRoutes";
import { appendSideChatQuote, sideChatTitleSeed, type SideChatSentUpdate } from "./sideChatCommand";
import { messageRunId } from "./messageRunId";

export const codySideChats = createCodySideChatAtoms({
  runtime: connectionAtomRuntime,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

const NO_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];
const NO_TURN_ITEMS_ATOM = Atom.make(NO_TURN_ITEMS).pipe(
  Atom.withLabel("cody-side-chat-items:none"),
);
const NO_SIDE_CHATS: ReadonlyArray<OrchestrationV2ThreadShell> = [];
const NO_SIDE_CHATS_ATOM = Atom.make(NO_SIDE_CHATS).pipe(Atom.withLabel("cody-side-chats:none"));

// An atom keeps the filtered list's identity until the thread's items change,
// which the timeline's incremental derivation relies on.
const ownTurnItemsAtomFamily = Atom.family((key: string) => {
  const ref = parseScopedThreadKey(key);
  return Atom.make((get) =>
    ref === null
      ? NO_TURN_ITEMS
      : get(environmentThreadDetails.visibleTurnItemsAtom(ref)).filter(
          (row) => row.visibility === "local",
        ),
  ).pipe(Atom.withLabel(`cody-side-chat-items:${key}`));
});

/**
 * A side chat's own turn items. The history it copied from its parent is in
 * the model's context but not repeated in the panel.
 */
export function useSideChatOwnTurnItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return useAtomValue(
    ref === null ? NO_TURN_ITEMS_ATOM : ownTurnItemsAtomFamily(scopedThreadKey(ref)),
  );
}

/** A side chat tab's label: the side chat's name, or null for any other tab. */
export function useSideChatTabTitle(
  environmentId: EnvironmentId | null,
  sideChatThreadId: string | null,
): string | null {
  const shell = useQuietThreadShell(
    environmentId === null || sideChatThreadId === null
      ? null
      : scopeThreadRef(environmentId, ThreadId.make(sideChatThreadId)),
  );
  return sideChatThreadId === null ? null : (shell?.title ?? "Side chat");
}

/** Only Cody servers have side chats; every entry point hides without this. */
export function useSideChatsSupported(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.codySideChat === true
  );
}

/** A side chat question's answers so far, and which of its questions is showing. */
export interface SideChatQuestionDraft {
  readonly answers: Readonly<Record<string, PendingUserInputDraftAnswer>>;
  readonly questionIndex: number;
}

/** Unsent side chat text and answers, kept while the panel shows another tab. */
export const useSideChatDraftStore = create<{
  readonly drafts: Readonly<Record<string, string>>;
  /** A model picked in the side chat that its next message switches to. */
  readonly models: Readonly<Record<string, ModelSelection>>;
  /**
   * What the user left out or dismissed: the thread's update by its newest
   * run, or the rollback notice by `went-back:<run>`. Either returns once the
   * key changes.
   */
  readonly dismissedMovedOn: Readonly<Record<string, string>>;
  /** The message that last carried the thread's update. */
  readonly sentUpdates: Readonly<Record<string, SideChatSentUpdate>>;
  /** Keyed by `sideChatRequestKey`. */
  readonly questions: Readonly<Record<string, SideChatQuestionDraft>>;
  /** The side chat whose composer takes focus when it next renders. */
  readonly focusRequest: string | null;
  /** The side chat whose tab label should turn into a name field. */
  readonly renameRequest: string | null;
  readonly setDraft: (sideChatThreadId: string, text: string) => void;
  readonly appendDraft: (sideChatThreadId: string, text: string) => void;
  readonly appendQuote: (sideChatThreadId: string, selection: string) => void;
  readonly clearFocusRequest: (sideChatThreadId: string) => void;
  readonly setRenameRequest: (sideChatThreadId: string | null) => void;
  readonly setModel: (sideChatThreadId: string, model: ModelSelection | null) => void;
  /** Undefined brings the update or notice back. */
  readonly dismissMovedOn: (sideChatThreadId: string, key: string | undefined) => void;
  readonly setSentUpdate: (sideChatThreadId: string, sent: SideChatSentUpdate | null) => void;
  readonly updateQuestion: (
    key: string,
    change: (current: SideChatQuestionDraft | undefined) => SideChatQuestionDraft | null,
  ) => void;
}>((set) => ({
  drafts: {},
  models: {},
  dismissedMovedOn: {},
  sentUpdates: {},
  questions: {},
  focusRequest: null,
  renameRequest: null,
  setDraft: (sideChatThreadId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [sideChatThreadId]: text } })),
  appendDraft: (sideChatThreadId, text) =>
    set((state) => {
      const current = state.drafts[sideChatThreadId] ?? "";
      return {
        drafts: {
          ...state.drafts,
          [sideChatThreadId]: current.trim().length === 0 ? text : `${current}\n\n${text}`,
        },
      };
    }),
  appendQuote: (sideChatThreadId, selection) =>
    set((state) => ({
      drafts: {
        ...state.drafts,
        [sideChatThreadId]: appendSideChatQuote(state.drafts[sideChatThreadId] ?? "", selection),
      },
      focusRequest: sideChatThreadId,
    })),
  clearFocusRequest: (sideChatThreadId) =>
    set((state) => (state.focusRequest === sideChatThreadId ? { focusRequest: null } : state)),
  setRenameRequest: (sideChatThreadId) => set({ renameRequest: sideChatThreadId }),
  setModel: (sideChatThreadId, model) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.models;
      return { models: model === null ? rest : { ...rest, [sideChatThreadId]: model } };
    }),
  dismissMovedOn: (sideChatThreadId, key) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.dismissedMovedOn;
      return { dismissedMovedOn: key === undefined ? rest : { ...rest, [sideChatThreadId]: key } };
    }),
  setSentUpdate: (sideChatThreadId, sent) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.sentUpdates;
      return { sentUpdates: sent === null ? rest : { ...rest, [sideChatThreadId]: sent } };
    }),
  updateQuestion: (key, change) =>
    set((state) => {
      const { [key]: current, ...rest } = state.questions;
      const next = change(current);
      return { questions: next === null ? rest : { ...rest, [key]: next } };
    }),
}));

export const sideChatRequestKey = (sideChatThreadId: string, requestId: string) =>
  `${sideChatThreadId}:${requestId}`;

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

const sideChatSurfaceId = (sideChatThreadId: string) => `side-chat:${sideChatThreadId}` as const;

/** The open side chat whose tab is active, else the most recently active one. */
function sideChatInUse(parent: ScopedThreadRef) {
  const open = appAtomRegistry.get(codySideChats.openSideChatsAtom(parent));
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, parent);
  return open.find((thread) => panel.activeSurfaceId === sideChatSurfaceId(thread.id)) ?? open[0];
}

/**
 * Shows one of the parent's side chats in its right panel. Without `fresh`
 * or `reopen` it picks the side chat in use: the one whose tab is active,
 * else the most recently active open one, starting one only when none is open.
 */
export function useOpenSideChat() {
  const open = useOrchestrationCommand(codySideChats.open, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return async (
    parent: ScopedThreadRef,
    options?: {
      /** Selected text to quote into the composer, which then takes focus. */
      readonly quote?: string;
      /** The thread message the quote came from; one the side chat hasn't seen brings back the thread's update. */
      readonly quoteMessageId?: MessageId;
      readonly send?: string;
      /** Starts a new side chat from the parent's latest response. */
      readonly fresh?: boolean;
      /** A closed side chat of the parent to reopen. */
      readonly reopen?: ThreadId;
    },
  ): Promise<ScopedThreadRef | null> => {
    const creating = options?.fresh === true || options?.reopen !== undefined;
    const existing = creating ? undefined : sideChatInUse(parent);
    let sideChatRef =
      existing === undefined ? null : scopeThreadRef(parent.environmentId, existing.id);
    if (sideChatRef === null) {
      const result = await open({
        environmentId: parent.environmentId,
        input: {
          parentThreadId: parent.threadId,
          ...(options?.fresh === true ? { fresh: true } : {}),
          ...(options?.reopen === undefined ? {} : { reopenThreadId: options.reopen }),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "Couldn't open a side chat",
            description: failureMessage(squashAtomCommandFailure(result), "Try again in a moment."),
          });
        }
        return null;
      }
      sideChatRef = scopeThreadRef(parent.environmentId, result.value.threadId);
      // A reopened side chat leaves the archive's list.
      if (options?.reopen !== undefined) refreshArchivedThreadsForEnvironment(parent.environmentId);
      // The side chat reaches this client through the shell stream like any thread.
      if (!(await waitForThreadShell(sideChatRef))) {
        toastManager.add({
          type: "error",
          title: "Couldn't open a side chat",
          description:
            "The side chat was created but hasn't reached this window. Reconnect and try again.",
        });
        return null;
      }
    }
    if (options?.quote !== undefined && options.quote.trim().length > 0) {
      // Decided before the quote shows, so the question can't go without the thread's update.
      const unseen =
        options.quoteMessageId !== undefined &&
        (await isUnseenByMain(parent, sideChatRef, options.quoteMessageId));
      const drafts = useSideChatDraftStore.getState();
      drafts.appendQuote(sideChatRef.threadId, options.quote);
      if (unseen) drafts.dismissMovedOn(sideChatRef.threadId, undefined);
    }
    useRightPanelStore.getState().openSideChat(parent, sideChatRef.threadId);
    const question = options?.send?.trim() ?? "";
    const sideChat = readThreadShell(sideChatRef);
    if (question.length > 0 && sideChat !== null) {
      const result = await startTurn({
        environmentId: sideChatRef.environmentId,
        input: {
          threadId: sideChatRef.threadId,
          message: { messageId: newMessageId(), role: "user", text: question, attachments: [] },
          ...sideChatTitleSeed(sideChat.title, question),
          runtimeMode: sideChat.runtimeMode,
          interactionMode: sideChat.interactionMode,
          dispatchMode: "auto",
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        useSideChatDraftStore.getState().appendDraft(sideChatRef.threadId, question);
        toastManager.add({
          type: "error",
          title: "Couldn't ask the side chat",
          description: failureMessage(
            squashAtomCommandFailure(result),
            "Your question is in its composer.",
          ),
        });
      }
    }
    return sideChatRef;
  };
}

/**
 * Whether a thread can have a side chat, and how to open it. Side chats need a
 * Cody server and a finished response to fork; a side chat has none of its own.
 */
export function useSideChatEntry(input: {
  readonly thread: EnvironmentThreadShell | null;
  /** The thread's runs when loaded; otherwise the shell's latest run decides. */
  readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "checkpointId">> | undefined;
}) {
  const { thread } = input;
  const supported = useSideChatsSupported(thread?.environmentId ?? null);
  const openSideChat = useOpenSideChat();
  const runAction = useSideChatActions();
  const rename = useRenameSideChat();
  const enabled =
    supported &&
    thread !== null &&
    thread.source.codySideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent";
  const ref = enabled && thread !== null ? scopeThreadRef(thread.environmentId, thread.id) : null;
  // Callers outside the thread view pass no runs; the view has them loaded already.
  const loadedRuns = useThreadProjection(input.runs === undefined ? ref : null)?.projection.runs;
  const runs = input.runs ?? loadedRuns;
  const hasOpenSideChat =
    useAtomValue(ref === null ? NO_SIDE_CHATS_ATOM : codySideChats.openSideChatsAtom(ref)).length >
    0;
  const hasFinishedResponse =
    runs === undefined
      ? thread?.latestRun?.status === "completed"
      : runs.some((run) => run.status === "completed" && run.checkpointId !== null);
  const available = enabled && (hasOpenSideChat || hasFinishedResponse);
  const disabledReason = "Side chats are available after the first response finishes.";
  const open = (options?: Parameters<typeof openSideChat>[1]) =>
    thread === null
      ? Promise.resolve(null)
      : openSideChat(scopeThreadRef(thread.environmentId, thread.id), options);
  return {
    /** Whether to show side chat entry points at all. */
    enabled,
    /** Whether `open` can show a side chat. */
    available,
    /** Whether `startNew` can fork one. */
    canStartNew: enabled && hasFinishedResponse,
    hasOpenSideChat: enabled && hasOpenSideChat,
    disabledReason: available ? undefined : disabledReason,
    startNewDisabledReason: hasFinishedResponse ? undefined : disabledReason,
    /** Shows the side chat in use, starting one when none is open. */
    open,
    /** Starts another side chat beside any open ones. */
    startNew: (options?: Omit<NonNullable<Parameters<typeof openSideChat>[1]>, "fresh">) =>
      open({ ...options, fresh: true }),
    runAction,
    rename,
  };
}

export type SideChatAction = "attach" | "keep" | "new" | "rename" | "delete" | "full-view";

/** What the side chat has seen of main, and what main finished since. */
export function useSideChatMainView(sideChatRef: ScopedThreadRef | null) {
  return useEnvironmentQuerySelector(
    sideChatRef === null ? null : codySideChats.mainViewAtom(sideChatRef),
    selectEnvironmentQueryData,
  );
}

/**
 * Whether the side chat has finished responses its thread hasn't been sent.
 * An older server doesn't say, so any finished response counts.
 */
export function sideChatHasUnsent(
  view: CodySideChatMainView | null,
  shell: Pick<EnvironmentThreadShell, "latestRun"> | null,
): boolean {
  return view?.unsentToThread === undefined
    ? shell?.latestRun?.status === "completed"
    : view.unsentToThread > 0;
}

/** `sideChatHasUnsent` for code outside React, such as a context menu. */
export function readSideChatHasUnsent(sideChatRef: ScopedThreadRef): boolean {
  const view = selectEnvironmentQueryData(
    appAtomRegistry.get(codySideChats.mainViewAtom(sideChatRef)),
  );
  return sideChatHasUnsent(view, readThreadShell(sideChatRef));
}

async function loadSideChatMainView(sideChatRef: ScopedThreadRef) {
  const loaded: { view: CodySideChatMainView | null } = { view: null };
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom: codySideChats.mainViewAtom(sideChatRef),
    predicate: (result) => {
      if (result.waiting || AsyncResult.isInitial(result)) return false;
      loaded.view = AsyncResult.isSuccess(result) ? result.value : null;
      return true;
    },
    timeoutMs: 5_000,
  });
  return loaded.view;
}

/** Whether a thread response is one the side chat hasn't seen yet. */
async function isUnseenByMain(
  parent: ScopedThreadRef,
  sideChatRef: ScopedThreadRef,
  messageId: MessageId,
) {
  const [main, view] = await Promise.all([
    loadThreadProjection(parent),
    loadSideChatMainView(sideChatRef),
  ]);
  if (main === null || view === null) return false;
  const runId = messageRunId(main, messageId);
  return runId !== null && view.newRunIds.includes(runId);
}

/** The side chat's runs, loading them for a moment if its panel isn't showing. */
async function loadThreadProjection(
  ref: ScopedThreadRef,
): Promise<OrchestrationV2ThreadProjection | null> {
  const loaded: { projection: OrchestrationV2ThreadProjection | null } = { projection: null };
  await waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentThreadDetails.threadAtom(ref),
    predicate: (thread) => {
      loaded.projection = thread?.projection ?? null;
      return thread !== null;
    },
    timeoutMs: 5_000,
  });
  return loaded.projection;
}

/** Renames a side chat; its name then stays, since only an unnamed one takes a title seed. */
export function useRenameSideChat() {
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return async (sideChatRef: ScopedThreadRef, title: string) => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed === readThreadShell(sideChatRef)?.title) return;
    const result = await updateMetadata({
      environmentId: sideChatRef.environmentId,
      input: { threadId: sideChatRef.threadId, title: trimmed },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Couldn't rename the side chat",
        description: failureMessage(squashAtomCommandFailure(result), "Try again in a moment."),
      });
      return;
    }
    // A closed side chat is listed from the archive, which doesn't follow renames.
    refreshArchivedThreadsForEnvironment(sideChatRef.environmentId);
  };
}

/** Deletes side chats of `parent` after the same confirmation as deleting a thread. */
export function useDeleteSideChats() {
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  return async (
    parent: ScopedThreadRef,
    sideChats: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "title">>,
  ) => {
    const [first] = sideChats;
    if (first === undefined) return;
    if (getClientSettings().confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          (sideChats.length === 1
            ? [`Delete side chat "${first.title}"?`, "This permanently clears its conversation."]
            : [
                `Delete all ${sideChats.length} side chats?`,
                "This permanently clears their conversations.",
              ]
          ).join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    // Closed first, so no tab shows its side chat as gone.
    const panels = useRightPanelStore.getState();
    for (const sideChat of sideChats) panels.closeSurface(parent, sideChatSurfaceId(sideChat.id));
    const results = await Promise.all(
      sideChats.map((sideChat) =>
        deleteThread({ environmentId: parent.environmentId, input: { threadId: sideChat.id } }),
      ),
    );
    refreshArchivedThreadsForEnvironment(parent.environmentId);
    const failed = results.filter(
      (result) => result._tag === "Failure" && !isAtomCommandInterrupted(result),
    );
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title:
          sideChats.length === 1
            ? "Couldn't delete the side chat"
            : `Couldn't delete ${failed.length} of ${sideChats.length} side chats`,
        description: "Try again in a moment.",
      });
    }
  };
}

/** Quotes selected side chat text into its thread's composer. */
export function citeInThread(threadRef: ScopedThreadRef, citation: AssistantCitation): boolean {
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(threadRef)?.prompt ?? "";
  const separator = prompt.length === 0 || /\s$/.test(prompt) ? "" : " ";
  store.setPrompt(
    threadRef,
    `${prompt}${separator}${formatAssistantCitationForComposer(citation)}`,
  );
  dispatchSnapShotComposerFocus();
  return true;
}

/**
 * The side chat actions the tab's context menu and the panel's menu share.
 * Closing is the panel's own close, which archives the side chat.
 */
export function useSideChatActions() {
  const navigate = useNavigate();
  const promote = useOrchestrationCommand(codySideChats.promote, { reportFailure: false });
  const openSideChat = useOpenSideChat();
  const deleteSideChats = useDeleteSideChats();

  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title,
      description: failureMessage(squashAtomCommandFailure(result), "Try again in a moment."),
    });
  };

  return async (action: SideChatAction, sideChatRef: ScopedThreadRef) => {
    const sideChat = readThreadShell(sideChatRef);
    const parentThreadId = sideChat?.lineage.parentThreadId ?? null;
    const parentRef =
      parentThreadId === null ? null : scopeThreadRef(sideChatRef.environmentId, parentThreadId);
    switch (action) {
      case "attach": {
        if (parentRef === null || sideChat === null) return;
        const unsent = selectEnvironmentQueryData(
          appAtomRegistry.get(codySideChats.mainViewAtom(sideChatRef)),
        )?.unsentToThread;
        const label = unsent ? `${sideChat.title} · ${unsent} new` : sideChat.title;
        useComposerDraftStore
          .getState()
          .addThreadContexts(parentRef, [threadContextRecord(sideChatRef, label)]);
        dispatchSnapShotComposerFocus();
        return;
      }
      case "keep": {
        const result = await promote({
          environmentId: sideChatRef.environmentId,
          input: { threadId: sideChatRef.threadId },
        });
        if (result._tag === "Failure") return fail("Couldn't keep it as a thread", result);
        // Leaves the panel without the close that would archive it.
        if (parentRef !== null) {
          useRightPanelStore
            .getState()
            .closeSurface(parentRef, `side-chat:${sideChatRef.threadId}`);
        }
        toastManager.add({
          type: "success",
          title: "Kept as a thread",
          description: "It's in your thread list now.",
        });
        return;
      }
      case "new":
        if (parentRef !== null) await openSideChat(parentRef, { fresh: true });
        return;
      case "rename":
        useSideChatDraftStore.getState().setRenameRequest(sideChatRef.threadId);
        return;
      case "delete":
        if (parentRef !== null && sideChat !== null) {
          await deleteSideChats(parentRef, [sideChat]);
        }
        return;
      case "full-view":
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(sideChatRef),
        });
        return;
    }
  };
}
