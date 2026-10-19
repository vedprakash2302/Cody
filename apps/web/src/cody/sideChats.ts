import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createCodySideChatAtoms } from "@t3tools/client-runtime/state/cody-side-chats";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2Run,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { newMessageId } from "../lib/utils";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, useServerConfigs, waitForThreadShell } from "../state/entities";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export const codySideChats = createCodySideChatAtoms({
  runtime: connectionAtomRuntime,
  environmentThreadsAtom: environmentThreadShells.environmentThreadsAtom,
});

const NO_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [];
const NO_TURN_ITEMS_ATOM = Atom.make(NO_TURN_ITEMS).pipe(
  Atom.withLabel("cody-side-chat-items:none"),
);

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

/** Unsent side chat text, kept while the panel shows another tab. */
export const useSideChatDraftStore = create<{
  readonly drafts: Readonly<Record<string, string>>;
  readonly setDraft: (sideChatThreadId: string, text: string) => void;
  readonly appendDraft: (sideChatThreadId: string, text: string) => void;
}>((set) => ({
  drafts: {},
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
}));

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

/**
 * `/side` alone opens the side chat; `/side <question>` also asks it. Returns
 * null for any other text.
 */
export function parseSideChatCommand(text: string): string | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match === null ? null : (match[1] ?? "").trim();
}

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
      readonly draft?: string;
      readonly send?: string;
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
    if (options?.draft !== undefined && options.draft.trim().length > 0) {
      useSideChatDraftStore.getState().appendDraft(sideChatRef.threadId, options.draft);
    }
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
  const enabled =
    supported &&
    thread !== null &&
    thread.source.codySideChat !== true &&
    thread.lineage.relationshipToParent !== "subagent";
  const hasFinishedResponse =
    input.runs === undefined
      ? thread?.latestRun?.status === "completed"
      : input.runs.some((run) => run.status === "completed" && run.checkpointId !== null);
  return {
    /** Whether to show side chat entry points at all. */
    enabled,
    available: enabled && hasFinishedResponse,
    disabledReason: hasFinishedResponse
      ? undefined
      : "Side chats are available after the first response finishes.",
    open: (options?: Parameters<typeof openSideChat>[1]) =>
      thread === null
        ? Promise.resolve(null)
        : openSideChat(scopeThreadRef(thread.environmentId, thread.id), options),
  };
}
