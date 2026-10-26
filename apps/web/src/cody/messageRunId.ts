import type { MessageId, OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";

/** The run of a loaded message. Earlier history loaded by scrolling up is in the turn items only. */
export function messageRunId(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "visibleTurnItems" | "turnItems">,
  messageId: MessageId,
): RunId | null {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message !== undefined) return message.runId;
  const items = [
    ...projection.visibleTurnItems.map((projected) => projected.item),
    ...projection.turnItems,
  ];
  const item = items.find(
    (candidate) =>
      (candidate.type === "assistant_message" || candidate.type === "user_message") &&
      candidate.messageId === messageId,
  );
  return item?.runId ?? null;
}
