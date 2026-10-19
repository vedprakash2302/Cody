import type {
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ArchivedShellStreamItem,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

/**
 * How one client receives side chats in its thread lists. A Cody client gets
 * them marked with `codySideChat`; any other client, such as the official
 * apps, never receives them.
 */
export interface ThreadVisibility {
  readonly isHidden: (threadId: ThreadId) => boolean;
  readonly present: (shell: OrchestrationV2ThreadShell) => OrchestrationV2ThreadShell;
}

export const sideChatVisibility = (input: {
  readonly isSideChat: (threadId: ThreadId) => boolean;
  readonly clientWantsSideChats: boolean;
}): ThreadVisibility =>
  input.clientWantsSideChats
    ? {
        isHidden: () => false,
        present: (shell) => (input.isSideChat(shell.id) ? { ...shell, codySideChat: true } : shell),
      }
    : { isHidden: input.isSideChat, present: (shell) => shell };

const presentThreads = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  visibility: ThreadVisibility,
) =>
  threads.flatMap((thread) => (visibility.isHidden(thread.id) ? [] : [visibility.present(thread)]));

export const filterShellSnapshot = (
  snapshot: OrchestrationV2ShellSnapshot,
  visibility: ThreadVisibility,
): OrchestrationV2ShellSnapshot => ({
  ...snapshot,
  threads: presentThreads(snapshot.threads, visibility),
  archivedThreads: presentThreads(snapshot.archivedThreads, visibility),
});

export const filterArchivedShellSnapshot = (
  snapshot: OrchestrationV2ArchivedShellSnapshot,
  visibility: ThreadVisibility,
): OrchestrationV2ArchivedShellSnapshot => ({
  ...snapshot,
  threads: presentThreads(snapshot.threads, visibility),
});

/**
 * Hidden items are dropped rather than sent as removals: the client never had
 * the thread, and its cursor still moves with the next visible item.
 */
const filterShellStreamItem = (
  item: OrchestrationV2ShellStreamItem,
  visibility: ThreadVisibility,
): OrchestrationV2ShellStreamItem | undefined => {
  switch (item.kind) {
    case "snapshot":
      return { ...item, snapshot: filterShellSnapshot(item.snapshot, visibility) };
    case "thread.updated":
      return visibility.isHidden(item.thread.id)
        ? undefined
        : { ...item, thread: visibility.present(item.thread) };
    case "thread.removed":
      return visibility.isHidden(item.threadId) ? undefined : item;
    default:
      return item;
  }
};

const filterArchivedShellStreamItem = (
  item: OrchestrationV2ArchivedShellStreamItem,
  visibility: ThreadVisibility,
): OrchestrationV2ArchivedShellStreamItem | undefined => {
  switch (item.kind) {
    case "snapshot":
      return { ...item, snapshot: filterArchivedShellSnapshot(item.snapshot, visibility) };
    case "thread.updated":
      return visibility.isHidden(item.thread.id)
        ? undefined
        : { ...item, thread: visibility.present(item.thread) };
    case "thread.removed":
      return visibility.isHidden(item.threadId) ? undefined : item;
  }
};

const isDefined = <A>(value: A | undefined): value is A => value !== undefined;

export const filterShellStream =
  (visibility: ThreadVisibility) =>
  <E, R>(stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>) =>
    stream.pipe(
      Stream.map((item) => filterShellStreamItem(item, visibility)),
      Stream.filter(isDefined),
    );

export const filterArchivedShellStream =
  (visibility: ThreadVisibility) =>
  <E, R>(stream: Stream.Stream<OrchestrationV2ArchivedShellStreamItem, E, R>) =>
    stream.pipe(
      Stream.map((item) => filterArchivedShellStreamItem(item, visibility)),
      Stream.filter(isDefined),
    );
