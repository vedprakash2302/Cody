import { type LegendListRef } from "@legendapp/list/react";
import {
  scopedThreadKey,
  scopeThreadRef,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  deriveLatestThreadRun,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  AuthOrchestrationOperateScope,
  ThreadId,
  type ProviderApprovalDecision,
  type RunId,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, MoreHorizontalIcon, SquareIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../components/chat/ComposerPendingApprovalPanel";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import { useIncrementalTimelineEntries } from "../hooks/useIncrementalTimelineEntries";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { newMessageId, newThreadId } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import {
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
  derivePendingApprovals,
  derivePhase,
  isLatestRunSettled,
} from "../session-logic";
import {
  resolveThreadDetailRef,
  useProject,
  useThreadCheckpointSummaries,
  useThreadProjection,
  useThreadShell,
  waitForThreadShell,
} from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  codySideChats,
  useOpenSideChat,
  useSideChatDraftStore,
  useSideChatOwnTurnItems,
} from "./sideChats";

const NO_MESSAGES: never[] = [];
const noop = () => {};

const failureMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

/**
 * A side chat of `parentRef`, beside it in the right panel. It shows only the
 * side chat's own messages: the history it copied from the parent is in the
 * model's context, not repeated here.
 */
export function SideChatPanel(props: {
  readonly parentRef: ScopedThreadRef;
  readonly sideChatThreadId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
}) {
  const { parentRef } = props;
  const environmentId = parentRef.environmentId;
  const sideRef = scopeThreadRef(environmentId, ThreadId.make(props.sideChatThreadId));
  const threadKey = scopedThreadKey(sideRef);
  const navigate = useNavigate();

  const shell = useThreadShell(sideRef);
  const parentShell = useThreadShell(parentRef);
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  const detailRef = resolveThreadDetailRef(sideRef, {
    shellExists: shell !== null,
    waitForShell: true,
  });
  const projection = useThreadProjection(detailRef)?.projection ?? null;
  const turnDiffSummaries = useThreadCheckpointSummaries(detailRef);
  const ownItems = useSideChatOwnTurnItems(detailRef);
  const timelineEntries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: ownItems,
    optimisticMessages: NO_MESSAGES,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });

  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);
  const [sending, setSending] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);
  const draft = useSideChatDraftStore((state) => state.drafts[props.sideChatThreadId] ?? "");
  const setDraft = (text: string) =>
    useSideChatDraftStore.getState().setDraft(props.sideChatThreadId, text);

  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const mergeBack = useOrchestrationCommand(threadEnvironment.mergeBack, {
    reportFailure: false,
  });
  const forkFromRun = useOrchestrationCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const promote = useOrchestrationCommand(codySideChats.promote, { reportFailure: false });
  const openSideChat = useOpenSideChat();

  const latestRun = projection === null ? null : deriveLatestThreadRun(projection);
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadRuntime(projection);
  const runlessWorkStartedAt = projection === null ? null : deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || sending || runlessWorkStartedAt !== null;
  const canInterrupt = canOperate && deriveCanInterruptRunningThread(shell !== null, runtime);
  const requests = projection === null ? null : derivePendingThreadRequests(projection);
  const activeApproval = derivePendingApprovals(requests?.approvals ?? [])[0] ?? null;
  const pendingApprovalCount = requests?.approvals.length ?? 0;
  const hasPendingQuestion = (requests?.userInputs.length ?? 0) > 0;
  const mergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const cwd = shell?.worktreePath ?? project?.workspaceRoot ?? undefined;

  const reportFailure = (title: string, error: unknown, fallback: string) =>
    toastManager.add({ type: "error", title, description: failureMessage(error, fallback) });

  const openInFullView = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(sideRef) });

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || shell === null || sending) return;
    setSending(true);
    setDraft("");
    const result = await startTurn({
      environmentId,
      input: {
        threadId: sideRef.threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        dispatchMode: "auto",
      },
    });
    setSending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setDraft(text);
      reportFailure(
        "Couldn't send",
        squashAtomCommandFailure(result),
        "Failed to send the message.",
      );
    }
  };

  const stop = async () => {
    const result = await interruptTurn({ environmentId, input: { threadId: sideRef.threadId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Couldn't stop", squashAtomCommandFailure(result), "Failed to stop the turn.");
    }
  };

  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    setRespondingRequestIds((ids) => [...ids, requestId]);
    const result = await respondToApproval({
      environmentId,
      input: { threadId: sideRef.threadId, requestId, decision },
    });
    setRespondingRequestIds((ids) => ids.filter((id) => id !== requestId));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(
        "Couldn't answer the request",
        squashAtomCommandFailure(result),
        "Failed to answer the approval request.",
      );
    }
  };

  const bringBackToMain = async () => {
    if (mergeBackRun === null) return;
    const result = await mergeBack({
      environmentId,
      input: {
        sourceThreadId: sideRef.threadId,
        targetThreadId: parentRef.threadId,
        runId: mergeBackRun.id,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Couldn't bring it back", squashAtomCommandFailure(result), "Merge failed.");
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: "Brought back to main",
      description: "A summary of this side chat goes in with your next message there.",
    });
  };

  const keepAsThread = async () => {
    const result = await promote({ environmentId, input: { threadId: sideRef.threadId } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Couldn't keep it", squashAtomCommandFailure(result), "Promotion failed.");
      }
      return;
    }
    useRightPanelStore.getState().closeSurface(parentRef, `side-chat:${props.sideChatThreadId}`);
    toastManager.add({
      type: "success",
      title: "Kept as a thread",
      description: "It's in your thread list now.",
    });
  };

  // The server closes this side chat before starting the new one.
  const startFresh = () => void openSideChat(parentRef, { fresh: true });

  const forkResponse = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    const targetThreadId = newThreadId();
    const result = await forkFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${parentShell?.title ?? "Side chat"} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Couldn't fork", squashAtomCommandFailure(result), "Fork failed.");
      }
      return;
    }
    const targetRef = scopeThreadRef(environmentId, targetThreadId);
    if (await waitForThreadShell(targetRef)) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetRef),
      });
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  if (shell === null || shell.source.codySideChat !== true) {
    const promoted = shell !== null;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground text-sm">
          {promoted
            ? "This side chat is a regular thread now."
            : "This side chat was closed. Reopen it from the thread's lineage."}
        </p>
        <div className="flex gap-2">
          {promoted ? (
            <Button size="sm" variant="outline" onClick={openInFullView}>
              Open thread
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close tab
          </Button>
        </div>
      </div>
    );
  }

  const parentWorking = parentShell !== null && threadRuntimeIsActive(parentShell.runtime);
  const parentNeedsYou =
    parentShell !== null && (parentShell.hasPendingApprovals || parentShell.hasPendingUserInput);
  const forkedFromRunId = shell.forkedFrom?.type === "run" ? shell.forkedFrom.runId : null;
  const parentMovedOn =
    !parentWorking &&
    parentShell?.latestRun != null &&
    parentShell.latestRun.completedAt !== null &&
    parentShell.latestRun.runId !== forkedFromRunId;
  const parentStatus = parentNeedsYou
    ? "Main needs you"
    : parentWorking
      ? "Main is working"
      : parentMovedOn
        ? "Main has moved on since this side chat started"
        : "Sees the main thread up to its last finished response";

  return (
    <FileMetadataThreadProvider threadRef={sideRef} cwd={cwd} checkpoints={projection?.checkpoints}>
      <div className="flex h-full min-h-0 flex-col" data-cody-side-chat>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-sm">Side chat</div>
            <div className="truncate text-muted-foreground text-xs">{parentStatus}</div>
          </div>
          {parentMovedOn ? (
            <Button size="xs" variant="outline" onClick={startFresh}>
              New side chat
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Side chat actions" />}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={!canOperate || mergeBackRun === null}
                onClick={() => void bringBackToMain()}
              >
                Bring back to main
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void keepAsThread()}>
                Keep as thread
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={startFresh}>
                New side chat
              </MenuItem>
              <MenuItem onClick={openInFullView}>Open in full view</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={props.onClose}>Close side chat</MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {ownItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
              Ask anything about this thread. The side chat sees it up to its last finished
              response, works in the same files, and asks before it edits anything.
            </div>
          ) : (
            <MessagesTimeline
              isWorking={isWorking}
              runlessWorkActive={runlessWorkStartedAt !== null}
              activeTurnInProgress={isWorking || !isLatestRunSettled(latestRun, runtime)}
              awaitingUser={activeApproval !== null || hasPendingQuestion}
              activeTurnStartedAt={
                deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt
              }
              listRef={listRef}
              timelineEntries={timelineEntries}
              runs={projection?.runs ?? []}
              latestRun={activityRun}
              runningRunId={runtime?.activeRunId ?? null}
              turnDiffSummaries={turnDiffSummaries}
              activeThreadEnvironmentId={environmentId}
              routeThreadKey={threadKey}
              onOpenTurnDiff={openInFullView}
              onOpenThread={(threadId) =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
                })
              }
              onForkFromRun={forkResponse}
              // Restoring a side chat checkpoint would roll back files the main thread shares.
              supportsConversationRollback={false}
              onRevertToTurnCount={noop}
              isRevertingCheckpoint={false}
              onImageExpand={noop}
              markdownCwd={cwd}
              resolvedTheme={resolvedTheme}
              timestampFormat={settings.timestampFormat}
              workspaceRoot={cwd}
              anchorMessageId={null}
              onAnchorReady={noop}
              onAnchorSizeChanged={noop}
              contentInsetEndAdjustment={0}
              liveFollowEnabled={liveFollow}
              onIsAtEndChange={(isAtEnd) => {
                if (isAtEnd) setLiveFollow(true);
              }}
              onManualNavigation={() => setLiveFollow(false)}
              hideEmptyPlaceholder
            />
          )}
        </div>

        <div className="flex flex-col gap-2 border-t p-2">
          {activeApproval !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border p-2">
              <ComposerPendingApprovalPanel
                approval={activeApproval}
                pendingCount={pendingApprovalCount}
              />
              <ComposerPendingApprovalActions
                requestId={activeApproval.requestId}
                disabled={!canOperate}
                isResponding={respondingRequestIds.includes(activeApproval.requestId)}
                options={activeApproval.options}
                canRespond={activeApproval.responseCapability === "live"}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : null}
          {hasPendingQuestion ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="flex-1">The side chat is asking you a question.</span>
              <Button size="xs" variant="outline" onClick={openInFullView}>
                Answer in full view
              </Button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              size="sm"
              value={draft}
              disabled={!canOperate}
              placeholder="Ask about this thread"
              aria-label="Side chat message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            {canInterrupt ? (
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Stop the side chat"
                onClick={() => void stop()}
              >
                <SquareIcon className="size-3.5" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send to side chat"
                disabled={!canOperate || sending || draft.trim().length === 0}
                onClick={() => void send()}
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </FileMetadataThreadProvider>
  );
}
