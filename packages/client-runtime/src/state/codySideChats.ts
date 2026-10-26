import {
  CODY_SIDE_CHAT_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** A thread's open side chats, most recently active first. Closed ones are archived. */
export function openSideChatsOf(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  parentThreadId: OrchestrationV2ThreadShell["id"],
): ReadonlyArray<OrchestrationV2ThreadShell> {
  return threads
    .filter(
      (thread) =>
        thread.codySideChat === true &&
        thread.lineage.parentThreadId === parentThreadId &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds);
}

type SignalShell = Pick<
  OrchestrationV2ThreadShell,
  "latestRunId" | "status" | "activeRunId" | "activityRunStatus" | "itemCount"
>;

/**
 * Changes when the side chat or its parent starts or finishes a run, or rolls
 * one back, which hides its items. Item counts move with every tool call, so
 * they count only while the thread is idle.
 */
export function sideChatMainViewSignal(
  sideChat: SignalShell | undefined,
  parent: SignalShell | undefined,
): string {
  return [sideChat, parent]
    .map((shell) =>
      shell === undefined
        ? ""
        : shell.activeRunId !== null
          ? `active:${shell.activeRunId}:${shell.activityRunStatus ?? ""}`
          : `idle:${shell.latestRunId}:${shell.status}:${shell.itemCount}`,
    )
    .join("|");
}

export function createCodySideChatAtoms<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>;
  readonly environmentThreadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
}) {
  const openSideChatsAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: ReadonlyArray<OrchestrationV2ThreadShell> = [];
    return Atom.make((get) => {
      const next = openSideChatsOf(
        get(input.environmentThreadsAtom(ref.environmentId)),
        ref.threadId,
      );
      if (arrayElementsEqual(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`cody-open-side-chats:${key}`));
  });

  const mainViewSignalFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const threads = get(input.environmentThreadsAtom(ref.environmentId));
      const sideChat = threads.find((thread) => thread.id === ref.threadId);
      const parentId = sideChat?.lineage.parentThreadId ?? null;
      const parent =
        parentId === null ? undefined : threads.find((thread) => thread.id === parentId);
      return sideChatMainViewSignal(sideChat, parent);
    }).pipe(Atom.withLabel(`cody-side-chat-main-signal:${key}`));
  });
  const mainView = createEnvironmentRpcQueryAtomFamily(input.runtime, {
    label: "environment-data:cody-side-chat:main-view",
    tag: CODY_SIDE_CHAT_WS_METHODS.mainView,
    refreshTrigger: ({ environmentId, input: { threadId } }) =>
      mainViewSignalFamily(threadKey({ environmentId, threadId })),
  });

  return {
    open: createEnvironmentRpcCommand(input.runtime, {
      label: "environment-data:cody-side-chat:open",
      tag: CODY_SIDE_CHAT_WS_METHODS.open,
    }),
    close: createEnvironmentRpcCommand(input.runtime, {
      label: "environment-data:cody-side-chat:close",
      tag: CODY_SIDE_CHAT_WS_METHODS.close,
    }),
    promote: createEnvironmentRpcCommand(input.runtime, {
      label: "environment-data:cody-side-chat:promote",
      tag: CODY_SIDE_CHAT_WS_METHODS.promote,
    }),
    openSideChatsAtom: (parent: ScopedThreadRef) => openSideChatsAtomFamily(threadKey(parent)),
    /** What the side chat has seen of its parent, and what the parent finished since. */
    mainViewAtom: (sideChat: ScopedThreadRef) =>
      mainView({ environmentId: sideChat.environmentId, input: { threadId: sideChat.threadId } }),
  };
}
