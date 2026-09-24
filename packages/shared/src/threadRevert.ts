import { isImportedAgentSessionMessageId } from "@t3tools/contracts";

import { compareDateTimeStrings } from "./dateTime.ts";

interface RevertableMessage {
  readonly id: string;
  readonly role: string;
  readonly turnId: string | null;
  readonly createdAt: string;
}

/**
 * Messages that survive a thread revert to `turnCount` turns.
 *
 * Messages tied to kept turns stay. Older rows often carry no turn id, so a
 * fallback then adopts unlinked messages, oldest first, up to one user and one
 * assistant message per kept turn.
 *
 * Provider-initiated turns (a background agent waking the thread) have no user
 * message, so the user count runs past the kept turns. `keptUntil`, when the
 * last kept turn's checkpoint completed, stops that overrun: a prompt that opens
 * a later turn is normally sent after the previous turn completes. That is
 * necessary but not sufficient, because a steer can open a turn before the
 * previous one completes. Assistant text can land after its turn completes, so
 * it gets no boundary.
 *
 * Shared by the server read model and the client reducer. It uses `.sort()`,
 * not `.toSorted()`, because mobile runs on Hermes, which lacks ES2023 array
 * methods.
 */
export function retainMessagesAfterRevert<Message extends RevertableMessage>(
  messages: ReadonlyArray<Message>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
  keptUntil: string | undefined,
): Message[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retainedMessageIds.add(message.id);
    } else if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) =>
        message.role === role &&
        !isImportedAgentSessionMessageId(message.id) &&
        retainedMessageIds.has(message.id),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    const fallbackMessages = messages
      .filter(
        (message) =>
          message.role === role &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)) &&
          (role === "assistant" ||
            keptUntil === undefined ||
            compareDateTimeStrings(message.createdAt, keptUntil) <= 0),
      )
      .sort(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingCount);
    for (const message of fallbackMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}
