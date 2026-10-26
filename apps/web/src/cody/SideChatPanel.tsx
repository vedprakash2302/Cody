import { type LegendListRef } from "@legendapp/list/react";
import {
  scopedThreadKey,
  scopeThreadRef,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
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
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { ThreadVisitWatermark } from "../components/chat/ThreadVisitWatermark";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
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
import {
  SideChatComposer,
  type SideChatMainUpdate,
  type SideChatWentBack,
} from "./SideChatComposer";
import { sentUpdatePending } from "./sideChatCommand";
import {
  useSideChatActions,
  useSideChatDraftStore,
  useSideChatMainView,
  useSideChatOwnTurnItems,
} from "./sideChats";
import { useSideChatRequests } from "./useSideChatRequests";

const NO_MESSAGES: never[] = [];
const noop = () => {};
/**
 * A side chat of `parentRef`, beside it in the right panel. It shows only the
 * side chat's own messages: the history it copied from the parent is in the
 * model's context, not repeated here.
 */
const NO_RUNS = { runs: [], providerTurns: [] };

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
  const mainView = useSideChatMainView(shell?.source.codySideChat === true ? sideRef : null);
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
  // A menu returns focus to its trigger on close, which would end the tab rename it started.
  const renamePicked = useRef(false);
  const keepFocus = () => {
    const picked = renamePicked.current;
    renamePicked.current = false;
    return !picked;
  };
  const [liveFollow, setLiveFollow] = useState(true);
  const sentUpdate = useSideChatDraftStore((state) => state.sentUpdates[props.sideChatThreadId]);
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

  const excerpt = mainView?.seenExcerpt ?? null;
  const latestNewRunId = mainView?.newRunIds.at(-1) ?? null;
  // Keyed by the thread's newest response, so a left-out update returns with the next one.
  const mainUpdate: SideChatMainUpdate | null =
    mainView === null ||
    mainView.wentBack ||
    latestNewRunId === null ||
    dismissedMovedOn === latestNewRunId ||
    sentUpdatePending(sentUpdate, latestNewRunId, projection ?? NO_RUNS)
      ? null
      : {
          key: latestNewRunId,
          responses: mainView.newRunIds.length,
          files: mainView.filesChanged,
        };
  // A rollback has its own key: it can undo the very response a catch-up covered.
  const wentBackKey =
    mainView?.wentBack && mainView.seenRunId !== null ? `went-back:${mainView.seenRunId}` : null;
  const wentBack: SideChatWentBack | null =
    wentBackKey === null || dismissedMovedOn === wentBackKey
      ? null
      : {
          onNewSideChat: () => void runAction("new", sideRef),
          onDismiss: () =>
            useSideChatDraftStore.getState().dismissMovedOn(props.sideChatThreadId, wentBackKey),
        };
  const canMergeBack =
    canOperate && projection !== null && resolveLatestMergeBackRun(projection) !== null;

  return (
    <FileMetadataThreadProvider threadRef={sideRef} cwd={cwd} checkpoints={projection?.checkpoints}>
      {props.visible ? <ThreadVisitWatermark threadRef={sideRef} /> : null}
      <div
        className="flex h-full min-h-0 flex-col"
        data-cody-side-chat
        data-composer-shortcut-scope={threadKey}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b ps-3 pe-1.5 text-muted-foreground text-xs">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <GitBranchIcon className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">
                    {excerpt === null ? (
                      "Up to the thread's last finished response"
                    ) : (
                      <>
                        Up to <span className="text-foreground/80">“{excerpt}”</span>
                      </>
                    )}
                  </span>
                </span>
              }
            />
            <TooltipPopup>This side chat knows the thread up to this response.</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Merge back to the thread"
                  disabled={!canMergeBack}
                  onClick={() => void runAction("merge-back", sideRef)}
                />
              }
            >
              <PullRequestGlyph.merged className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>
              {canMergeBack
                ? "Merge this side chat back into the thread"
                : "Merge back after the side chat finishes a response"}
            </TooltipPopup>
          </Tooltip>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Side chat actions" />}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-44" finalFocus={keepFocus}>
              <MenuItem
                disabled={!canOperate}
                onClick={() => {
                  renamePicked.current = true;
                  void runAction("rename", sideRef);
                }}
              >
                <PencilIcon className="size-3.5" />
                Rename
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void runAction("keep", sideRef)}>
                <ArrowUpRightIcon className="size-3.5" />
                Keep as thread
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!canOperate}
                onClick={() => void runAction("delete", sideRef)}
              >
                <Trash2Icon className="size-3.5" />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          {ownItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm">
              Ask about this thread while it keeps working.
            </div>
          ) : (
            <MessagesTimeline
              isWorking={isWorking}
              runlessWorkActive={runlessWorkStartedAt !== null}
              activeTurnInProgress={isWorking || !isLatestRunSettled(latestRun, runtime)}
              awaitingUser={
                requests.activeApproval !== null
                  ? "approval"
                  : requests.activeUserInput !== null
                    ? "input"
                    : null
              }
              // Announcements carry no thread name; the main thread's timeline speaks for the view.
              announceTurnStatus={false}
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
              onViewportAttach={(viewport) =>
                viewport.subscribe((navigation) => {
                  if (navigation.source === "command" && navigation.releasesFollow) {
                    setLiveFollow(false);
                  }
                })
              }
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
            mainUpdate={mainUpdate}
            wentBack={wentBack}
          />
        </div>
      </div>
    </FileMetadataThreadProvider>
  );
}
