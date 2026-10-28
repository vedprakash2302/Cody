import type {
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  OlderSettledThreadsListing,
  OlderSettledThreadsQuery,
} from "../orchestration-v2/ProjectionStore.ts";

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

export const presentThreads = (
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
 * A page shorter than its limit ends a client's paging, so hidden side chats are dropped from an
 * over-read listing that still fills the requested page.
 */
export const listVisibleOlderSettledThreads = <E>(
  list: (query: OlderSettledThreadsQuery) => Effect.Effect<OlderSettledThreadsListing, E>,
  query: OlderSettledThreadsQuery,
  visibility: ThreadVisibility,
): Effect.Effect<OlderSettledThreadsListing, E> =>
  query.limit === 0
    ? list(query)
    : list({ ...query, limit: query.limit * 2 }).pipe(
        Effect.map((listing) => ({
          ...listing,
          threadIds: listing.threadIds
            .filter((threadId) => !visibility.isHidden(threadId))
            .slice(0, query.limit),
        })),
      );

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

const isDefined = <A>(value: A | undefined): value is A => value !== undefined;

export const filterShellStream =
  (visibility: ThreadVisibility) =>
  <E, R>(stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>) =>
    stream.pipe(
      Stream.map((item) => filterShellStreamItem(item, visibility)),
      Stream.filter(isDefined),
    );
