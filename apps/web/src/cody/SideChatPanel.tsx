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
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  AuthOrchestrationOperateScope,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CornerUpLeftIcon,
  GitBranchIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { ThreadVisitWatermark } from "../components/chat/ThreadVisitWatermark";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { FileMetadataThreadProvider } from "../hooks/FileMetadataThreadProvider";
import { useIncrementalTimelineEntries } from "../hooks/useIncrementalTimelineEntries";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { newThreadId } from "../lib/utils";
import {
  deriveActiveWorkStartedAt,
  deriveCanInterruptRunningThread,
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
import { SideChatComposer } from "./SideChatComposer";
import { useSideChatActions, useSideChatDraftStore, useSideChatOwnTurnItems } from "./sideChats";
import { useSideChatRequests } from "./useSideChatRequests";

const NO_MESSAGES: never[] = [];
const noop = () => {};
const EXCERPT_LENGTH = 80;

/** Main's answer at the fork point, as one plain line. */
function forkPointExcerpt(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage> | undefined,
  runId: RunId | null,
): string | null {
  if (messages === undefined || runId === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.runId !== runId) continue;
    const line = message.text
      .replace(/[`*_#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length === 0) return null;
    return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH).trimEnd()}…` : line;
  }
  return null;
}

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
  const parentDetailRef = resolveThreadDetailRef(parentRef, {
    shellExists: parentShell !== null,
    waitForShell: true,
  });
  const projection = useThreadProjection(detailRef)?.projection ?? null;
  const parentProjection = useThreadProjection(parentDetailRef)?.projection ?? null;
  const turnDiffSummaries = useThreadCheckpointSummaries(detailRef);
  const ownItems = useSideChatOwnTurnItems(detailRef);
  const timelineEntries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: ownItems,
    optimisticMessages: NO_MESSAGES,
    ...(projection === null
      ? {}
      : { attempts: projection.attempts, nodes: projection.nodes, plans: projection.plans }),
  });
  const requests = useSideChatRequests(sideRef, projection);

  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const listRef = useRef<LegendListRef | null>(null);
  const [liveFollow, setLiveFollow] = useState(true);
  const dismissedMovedOn = useSideChatDraftStore(
    (state) => state.dismissedMovedOn[props.sideChatThreadId],
  );
  const runAction = useSideChatActions();
  const forkFromRun = useOrchestrationCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const latestRun = projection === null ? null : deriveLatestThreadRun(projection);
  const activityRun = projection === null ? null : deriveThreadActivityRun(projection);
  const runtime = projection === null ? null : deriveThreadRuntime(projection);
  const runlessWorkStartedAt = projection === null ? null : deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const canInterrupt = canOperate && deriveCanInterruptRunningThread(shell !== null, runtime);
  const cwd = shell?.worktreePath ?? project?.workspaceRoot ?? undefined;

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

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
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Couldn't fork",
          description: error instanceof Error ? error.message : "Fork failed.",
        });
      }
      return;
    }
    if (await waitForThreadShell(scopeThreadRef(environmentId, targetThreadId))) {
      openThread(targetThreadId);
    }
  };

  if (shell === null || shell.source.codySideChat !== true) {
    const promoted = shell !== null;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground text-sm">
          {promoted
            ? "This side chat is a regular thread now."
            : "This side chat was closed. Reopen it from the thread's details."}
        </p>
        <div className="flex gap-2">
          {promoted ? (
            <Button size="sm" variant="outline" onClick={() => openThread(sideRef.threadId)}>
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

  const forkedFromRunId = shell.forkedFrom?.type === "run" ? shell.forkedFrom.runId : null;
  const excerpt = forkPointExcerpt(parentProjection?.messages, forkedFromRunId);
  const parentWorking = parentShell !== null && threadRuntimeIsActive(parentShell.runtime);
  const parentLatestRunId =
    parentShell?.latestRun?.completedAt != null ? parentShell.latestRun.runId : null;
  const parentMovedOn =
    !parentWorking &&
    parentLatestRunId !== null &&
    parentLatestRunId !== forkedFromRunId &&
    dismissedMovedOn !== parentLatestRunId;

  return (
    <FileMetadataThreadProvider threadRef={sideRef} cwd={cwd} checkpoints={projection?.checkpoints}>
      {props.visible ? <ThreadVisitWatermark threadRef={sideRef} /> : null}
      <div
        className="flex h-full min-h-0 flex-col"
        data-cody-side-chat
        data-composer-shortcut-scope={threadKey}
      >
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b ps-3 pe-1.5 text-muted-foreground text-xs">
          <GitBranchIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {excerpt === null ? (
              "Sees main up to its last finished response"
            ) : (
              <>
                Sees main up to <span className="text-foreground/80">“{excerpt}”</span>
              </>
            )}
          </span>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Side chat actions" />}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-56">
              <MenuItem
                disabled={
                  !canOperate ||
                  projection === null ||
                  resolveLatestMergeBackRun(projection) === null
                }
                onClick={() => void runAction("bring-back", sideRef)}
              >
                <CornerUpLeftIcon className="size-3.5" />
                Bring back to main
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void runAction("keep", sideRef)}>
                <ArrowUpRightIcon className="size-3.5" />
                Keep as thread
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void runAction("fresh", sideRef)}>
                <RotateCcwIcon className="size-3.5" />
                Start fresh from main
              </MenuItem>
              <MenuItem onClick={() => void runAction("full-view", sideRef)}>
                <Maximize2Icon className="size-3.5" />
                Open in full view
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={props.onClose}>
                <XIcon className="size-3.5" />
                Close side chat
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {ownItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
              Ask about this thread while main keeps working.
            </div>
          ) : (
            <MessagesTimeline
              isWorking={isWorking}
              runlessWorkActive={runlessWorkStartedAt !== null}
              activeTurnInProgress={isWorking || !isLatestRunSettled(latestRun, runtime)}
              awaitingUser={requests.activeApproval !== null || requests.activeUserInput !== null}
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
              onOpenTurnDiff={() => void runAction("full-view", sideRef)}
              onOpenThread={openThread}
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
              emptyPlaceholderInset={0}
            />
          )}
        </div>

        <div className="shrink-0 px-3 pb-3">
          <SideChatComposer
            sideRef={sideRef}
            shell={shell}
            requests={requests}
            canOperate={canOperate}
            isWorking={isWorking}
            canInterrupt={canInterrupt}
            cwd={cwd}
            movedOnNotice={
              parentMovedOn && parentLatestRunId !== null
                ? {
                    onStartFresh: () => void runAction("fresh", sideRef),
                    onDismiss: () =>
                      useSideChatDraftStore
                        .getState()
                        .dismissMovedOn(props.sideChatThreadId, parentLatestRunId),
                  }
                : null
            }
          />
        </div>
      </div>
    </FileMetadataThreadProvider>
  );
}
