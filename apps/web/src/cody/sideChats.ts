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
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  CodySideChatMainView,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { newMessageId } from "../lib/utils";
import type { PendingUserInputDraftAnswer } from "../pendingUserInput";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readThreadShell,
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
import { appendSideChatQuote } from "./sideChatCommand";
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
  /** The parent run whose "main has moved on" notice was dismissed. */
  readonly dismissedMovedOn: Readonly<Record<string, string>>;
  /** Keyed by `sideChatRequestKey`. */
  readonly questions: Readonly<Record<string, SideChatQuestionDraft>>;
  /** The side chat whose composer takes focus when it next renders. */
  readonly focusRequest: string | null;
  /** Side chats whose next message carries main's update. */
  readonly mainUpdates: Readonly<Record<string, true>>;
  readonly setDraft: (sideChatThreadId: string, text: string) => void;
  readonly appendDraft: (sideChatThreadId: string, text: string) => void;
  readonly appendQuote: (sideChatThreadId: string, selection: string) => void;
  readonly clearFocusRequest: (sideChatThreadId: string) => void;
  readonly setMainUpdate: (sideChatThreadId: string, attached: boolean) => void;
  readonly setModel: (sideChatThreadId: string, model: ModelSelection | null) => void;
  /** Undefined shows the notice again. */
  readonly dismissMovedOn: (sideChatThreadId: string, parentRunId: string | undefined) => void;
  readonly updateQuestion: (
    key: string,
    change: (current: SideChatQuestionDraft | undefined) => SideChatQuestionDraft | null,
  ) => void;
}>((set) => ({
  drafts: {},
  models: {},
  dismissedMovedOn: {},
  questions: {},
  focusRequest: null,
  mainUpdates: {},
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
  setMainUpdate: (sideChatThreadId, attached) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.mainUpdates;
      return attached
        ? { mainUpdates: { ...rest, [sideChatThreadId]: true }, focusRequest: sideChatThreadId }
        : { mainUpdates: rest };
    }),
  setModel: (sideChatThreadId, model) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.models;
      return { models: model === null ? rest : { ...rest, [sideChatThreadId]: model } };
    }),
  dismissMovedOn: (sideChatThreadId, parentRunId) =>
    set((state) => {
      const { [sideChatThreadId]: _previous, ...rest } = state.dismissedMovedOn;
      return {
        dismissedMovedOn:
          parentRunId === undefined ? rest : { ...rest, [sideChatThreadId]: parentRunId },
      };
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

/**
 * Shows the parent's open side chat in its right panel, starting one when it
 * has none. Every entry point (panel menu, `/side`, the shortcut, the command
 * palette, "Ask in side chat") goes through here.
 */
export function useOpenSideChat() {
  const open = useOrchestrationCommand(codySideChats.open, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return async (
    parent: ScopedThreadRef,
    options?: {
      /** Selected text to quote into the composer, which then takes focus. */
      readonly quote?: string;
      /** The main message the quote came from; one the side chat hasn't seen brings main's update. */
      readonly quoteMessageId?: MessageId;
      readonly send?: string;
      /** Attaches main's update to the open side chat's composer. */
      readonly catchUp?: boolean;
      /** Closes the open side chat and starts one from the parent's latest response. */
      readonly fresh?: boolean;
      /** A closed side chat of the parent to reopen in place of the open one. */
      readonly reopen?: ThreadId;
    },
  ): Promise<ScopedThreadRef | null> => {
    const replacing = options?.fresh === true || options?.reopen !== undefined;
    const existing = replacing
      ? undefined
      : appAtomRegistry.get(codySideChats.openSideChatsAtom(parent))[0];
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
      // The server closed any other open side chat, which the archive now lists.
      if (replacing) refreshArchivedThreadsForEnvironment(parent.environmentId);
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
      // Decided before the quote shows, so the question can't go without main's update.
      const unseen =
        options.quoteMessageId !== undefined &&
        (await isUnseenByMain(parent, sideChatRef, options.quoteMessageId));
      const drafts = useSideChatDraftStore.getState();
      drafts.appendQuote(sideChatRef.threadId, options.quote);
      if (unseen) drafts.setMainUpdate(sideChatRef.threadId, true);
    }
    if (options?.catchUp === true) void attachMainUpdate(sideChatRef);
    const panels = useRightPanelStore.getState();
    for (const surface of selectThreadRightPanelState(panels.byThreadKey, parent).surfaces) {
      if (surface.kind === "side-chat" && surface.resourceId !== sideChatRef.threadId) {
        panels.closeSurface(parent, surface.id);
      }
    }
    panels.openSideChat(parent, sideChatRef.threadId);
    const question = options?.send?.trim() ?? "";
    const sideChat = readThreadShell(sideChatRef);
    if (question.length > 0 && sideChat !== null) {
      const result = await startTurn({
        environmentId: sideChatRef.environmentId,
        input: {
          threadId: sideChatRef.threadId,
          message: { messageId: newMessageId(), role: "user", text: question, attachments: [] },
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
  return {
    /** Whether to show side chat entry points at all. */
    enabled,
    available,
    hasOpenSideChat: enabled && hasOpenSideChat,
    disabledReason: available
      ? undefined
      : "Side chats are available after the first response finishes.",
    open: (options?: Parameters<typeof openSideChat>[1]) =>
      thread === null
        ? Promise.resolve(null)
        : openSideChat(scopeThreadRef(thread.environmentId, thread.id), options),
    runAction,
  };
}

export type SideChatAction = "bring-back" | "keep" | "fresh" | "full-view";

/** What the side chat has seen of main, and what main finished since. */
export function useSideChatMainView(sideChatRef: ScopedThreadRef | null) {
  return useEnvironmentQuerySelector(
    sideChatRef === null ? null : codySideChats.mainViewAtom(sideChatRef),
    selectEnvironmentQueryData,
  );
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

/** Attaches main's update, or says why there's nothing to catch up on. */
async function attachMainUpdate(sideChatRef: ScopedThreadRef) {
  const view = await loadSideChatMainView(sideChatRef);
  if (view === null) {
    toastManager.add({
      type: "error",
      title: "Couldn't check main for new responses",
      description: "Try again in a moment.",
    });
    return;
  }
  if (view.wentBack) {
    toastManager.add({
      type: "info",
      title: "Main went back to an earlier response",
      description: "Start a fresh side chat to follow main from there.",
    });
    return;
  }
  if (view.newRunIds.length === 0) {
    toastManager.add({ type: "info", title: "The side chat is up to date with main" });
    return;
  }
  useSideChatDraftStore.getState().setMainUpdate(sideChatRef.threadId, true);
}

/** Whether a main response is one the side chat hasn't seen yet. */
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

/**
 * The side chat actions the tab's context menu and the panel's menu share.
 * Closing is the panel's own close, which archives the side chat.
 */
export function useSideChatActions() {
  const navigate = useNavigate();
  const mergeBack = useOrchestrationCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const promote = useOrchestrationCommand(codySideChats.promote, { reportFailure: false });
  const openSideChat = useOpenSideChat();

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
      case "bring-back": {
        if (parentRef === null) return;
        const projection = await loadThreadProjection(sideChatRef);
        if (projection === null) {
          toastManager.add({
            type: "error",
            title: "Couldn't bring it back to main",
            description: "The side chat didn't load. Try again in a moment.",
          });
          return;
        }
        const run = resolveLatestMergeBackRun(projection);
        if (run === null) {
          toastManager.add({
            type: "info",
            title: "Nothing to bring back yet",
            description: "Wait until the side chat finishes a response.",
          });
          return;
        }
        const result = await mergeBack({
          environmentId: sideChatRef.environmentId,
          input: {
            sourceThreadId: sideChatRef.threadId,
            targetThreadId: parentRef.threadId,
            runId: run.id,
          },
        });
        if (result._tag === "Failure") return fail("Couldn't bring it back to main", result);
        toastManager.add({
          type: "success",
          title: "Brought back to main",
          description: "Main gets a summary of this side chat with your next message.",
        });
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
      case "fresh":
        if (parentRef !== null) await openSideChat(parentRef, { fresh: true });
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
