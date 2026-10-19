import {
  CODY_SIDE_CHAT_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { arrayElementsEqual, parseThreadKey, threadKey } from "./entities.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

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
    .toSorted(
      (left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds,
    );
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
  };
}
