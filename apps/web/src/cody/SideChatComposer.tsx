import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RuntimeMode, ScopedThreadRef } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { GitBranchIcon, ShieldIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { ComposerFooterModeControls } from "../components/chat/ComposerFooterControls";
import { ComposerBanner } from "../components/chat/ComposerBanner";
import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../components/chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "../components/chat/ComposerPendingUserInputPanel";
import { ComposerPrimaryActions } from "../components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";
import { ComposerHandleContext } from "../composerHandleContext";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { threadContextRecord, threadContextReference } from "../lib/composerContextRecords";
import { newMessageId } from "../lib/utils";
import { getAppModelOptionsForInstance } from "../modelSelection";
import { applyProviderInstanceSettings, deriveProviderInstanceEntries } from "../providerInstances";
import { useEnvironmentProviders } from "../state/environments";
import { useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { sideChatTitleSeed } from "./sideChatCommand";
import { useSideChatDraftStore } from "./sideChats";
import { SideChatMainUpdateChip } from "./SideChatMainUpdateChip";
import type { SideChatRequests } from "./useSideChatRequests";

const noop = () => {};

/** What the thread finished since the side chat last saw it, keyed by its newest response. */
export interface SideChatMainUpdate {
  readonly key: string;
  readonly responses: number;
  readonly files: number;
}

/** The thread rolled back past what the side chat has seen. */
export interface SideChatWentBack {
  readonly onNewSideChat: () => void;
  readonly onDismiss: () => void;
}

/**
 * The side chat's composer, assembled from the main composer's own surface,
 * banners, pickers and send button so it reads as the same control. Models
 * stay within the parent's provider instance, which holds the forked session.
 */
export function SideChatComposer(props: {
  readonly sideRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly requests: SideChatRequests;
  readonly canOperate: boolean;
  readonly isWorking: boolean;
  readonly canInterrupt: boolean;
  readonly cwd: string | undefined;
  /** Attaches itself to the next message unless the user leaves it out. */
  readonly mainUpdate: SideChatMainUpdate | null;
  readonly wentBack: SideChatWentBack | null;
}) {
  const { sideRef, shell, requests, canOperate } = props;
  const environmentId = sideRef.environmentId;
  const sideChatId = sideRef.threadId;
  const parentThreadId = shell.lineage.parentThreadId;
  const parentRef = parentThreadId === null ? null : scopeThreadRef(environmentId, parentThreadId);
  const parentShell = useThreadShell(parentRef);
  const draft = useSideChatDraftStore((state) => state.drafts[sideChatId] ?? "");
  const focusRequested = useSideChatDraftStore((state) => state.focusRequest === sideChatId);
  const mainUpdate = parentRef === null ? null : props.mainUpdate;
  const pendingModel = useSideChatDraftStore((state) => state.models[sideChatId] ?? null);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });

  const instanceEntry = applyProviderInstanceSettings(
    deriveProviderInstanceEntries(providers ?? []),
    settings,
    shell.projectId,
  ).find((entry) => entry.instanceId === shell.modelSelection.instanceId);
  const selectedModel = pendingModel?.model ?? shell.modelSelection.model;
  const supportedRuntimeModes = instanceEntry?.snapshot.supportedRuntimeModes ?? [];
  const modeOptions = runtimeModeOptions
    .filter((mode) => supportedRuntimeModes.length === 0 || supportedRuntimeModes.includes(mode))
    .map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

  const { activeApproval, activeUserInput, progress } = requests;
  const choiceOnly = progress?.activeQuestion?.allowCustomAnswer === false;
  const promptValue = progress !== null ? progress.customAnswer : draft;
  const placeholder =
    activeApproval !== null
      ? "Resolve this approval request to continue"
      : progress !== null
        ? choiceOnly
          ? "Choose an option above"
          : "Type your own answer, or leave this blank to use the selected option"
        : "Ask about this thread";
  const editorDisabled = !canOperate || activeApproval !== null || choiceOnly;
  const hasSendableContent = progress === null && (draft.trim().length > 0 || mainUpdate !== null);
  const draftEditable = progress === null && !editorDisabled;

  // Decided once requests load, then dropped: a request answered later must
  // not pull focus from wherever the user went meanwhile.
  // oxlint-disable-next-line t3code/react-effect-budget -- moves DOM focus once requests load
  useEffect(() => {
    if (!focusRequested || !requests.loaded) return;
    useSideChatDraftStore.getState().clearFocusRequest(sideChatId);
    const textarea = textareaRef.current;
    if (!draftEditable || textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
  }, [focusRequested, requests.loaded, draftEditable, sideChatId]);

  const setDraft = (text: string) => useSideChatDraftStore.getState().setDraft(sideChatId, text);

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error && error.message.length > 0 ? error.message : undefined,
    });
  };

  const send = async () => {
    const text = draft.trim();
    const sentUpdate = parentRef === null ? null : mainUpdate;
    if ((text.length === 0 && sentUpdate === null) || sending || activeApproval !== null) return;
    const mainRecord =
      sentUpdate === null || parentRef === null
        ? null
        : threadContextRecord(parentRef, parentShell?.title ?? "Thread");
    const store = useSideChatDraftStore.getState();
    const messageId = newMessageId();
    setSending(true);
    setDraft("");
    // Until the provider takes the turn, the server still counts these responses as new.
    if (sentUpdate !== null) store.setSentUpdate(sideChatId, { key: sentUpdate.key, messageId });
    const result = await startTurn({
      environmentId,
      input: {
        threadId: sideChatId,
        message: {
          messageId,
          role: "user",
          text:
            mainRecord === null
              ? text
              : `${formatInlineContextReference(threadContextReference(mainRecord))}\n\n${text}`.trim(),
          ...(mainRecord === null ? {} : { context: { version: 1, records: [mainRecord] } }),
          attachments: [],
        },
        ...sideChatTitleSeed(shell.title, text),
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        ...(pendingModel === null ? {} : { modelSelection: pendingModel }),
        // A steer joins the running turn, which never delivers the thread's update.
        dispatchMode: props.isWorking || mainRecord !== null ? "queue" : "auto",
      },
    });
    setSending(false);
    if (result._tag === "Failure") {
      // Anything typed since sending stays, after the text that failed.
      const typedSince = useSideChatDraftStore.getState().drafts[sideChatId] ?? "";
      setDraft(typedSince.trim().length === 0 ? text : `${text}\n\n${typedSince}`);
      if (useSideChatDraftStore.getState().sentUpdates[sideChatId]?.messageId === messageId) {
        store.setSentUpdate(sideChatId, null);
      }
      reportFailure("Couldn't send", result);
      return;
    }
    useSideChatDraftStore.getState().setModel(sideChatId, null);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (progress !== null) requests.advance();
    else void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const stop = async () => {
    const result = await interruptTurn({ environmentId, input: { threadId: sideChatId } });
    if (result._tag === "Failure") reportFailure("Couldn't stop the side chat", result);
  };

  const changeRuntimeMode = async (runtimeMode: RuntimeMode) => {
    const result = await setRuntimeMode({
      environmentId,
      input: { threadId: sideChatId, runtimeMode },
    });
    if (result._tag === "Failure") reportFailure("Couldn't change the mode", result);
  };

  const banner =
    activeApproval !== null ? (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="warning" density="spacious">
          <ComposerBanner.Row layout="approval">
            <ComposerBanner.Icon>
              <ShieldIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <ComposerPendingApprovalPanel
                approval={activeApproval}
                pendingCount={requests.pendingApprovals.length}
              />
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ComposerPendingApprovalActions
                requestId={activeApproval.requestId}
                disabled={!canOperate}
                isResponding={requests.respondingRequestIds.includes(activeApproval.requestId)}
                options={activeApproval.options}
                canRespond={activeApproval.responseCapability === "live"}
                onRespondToApproval={requests.respondToApproval}
              />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    ) : activeUserInput !== null && progress !== null ? (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="info">
          <ComposerPendingUserInputPanel
            pendingUserInputs={requests.pendingUserInputs}
            cwd={props.cwd}
            threadRef={sideRef}
            disabled={!canOperate}
            respondingRequestIds={requests.respondingRequestIds}
            answers={requests.activeDrafts}
            questionIndex={progress.questionIndex}
            onToggleOption={requests.toggleOption}
            onAdvance={requests.advance}
            onDismiss={requests.dismiss}
            shortcutScope={scopedThreadKey(sideRef)}
          />
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    ) : props.wentBack !== null ? (
      <ComposerBanner.Attachment>
        <ComposerBanner.Root variant="warning" density="comfortable">
          <ComposerBanner.Row layout="wrap-actions">
            <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
              <GitBranchIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              <span className="min-w-0 font-medium leading-7 sm:leading-6">
                The thread went back. This side chat still knows the dropped responses.
              </span>
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <Button
                size="xs"
                variant="outline"
                disabled={!canOperate}
                onClick={props.wentBack.onNewSideChat}
              >
                New side chat
              </Button>
              <ComposerBanner.Dismiss aria-label="Dismiss" onClick={props.wentBack.onDismiss} />
            </ComposerBanner.Actions>
          </ComposerBanner.Row>
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    ) : null;

  return (
    // The app-wide handle is main's composer; without it, menus here return
    // focus to their own trigger instead of jumping into main.
    <ComposerHandleContext value={null}>
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <form
            onSubmit={submit}
            className="w-full min-w-0"
            data-chat-composer-form="true"
            data-cody-side-chat-composer="true"
          >
            <ComposerBanner.Dock>
              <ComposerBanner.Column>{banner}</ComposerBanner.Column>
            </ComposerBanner.Dock>
            <div className="relative">
              <ComposerSurface.Main>
                <div data-chat-composer-surface="true" className="rounded-3xl">
                  <div
                    data-chat-composer-body="true"
                    className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4"
                  >
                    <div className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)">
                      {mainUpdate !== null && parentRef !== null && progress === null ? (
                        <div className="mb-1.5">
                          <SideChatMainUpdateChip
                            parentRef={parentRef}
                            responses={mainUpdate.responses}
                            files={mainUpdate.files}
                            onRemove={() => {
                              useSideChatDraftStore
                                .getState()
                                .dismissMovedOn(sideChatId, mainUpdate.key);
                              textareaRef.current?.focus();
                            }}
                          />
                        </div>
                      ) : null}
                      <textarea
                        ref={textareaRef}
                        value={promptValue}
                        disabled={editorDisabled}
                        placeholder={placeholder}
                        aria-label="Side chat message"
                        rows={1}
                        className="-m-1 block field-sizing-content max-h-52 min-h-10 w-[calc(100%+0.5rem)] resize-none overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent p-1 text-foreground leading-relaxed placeholder:text-placeholder/75 focus:outline-none disabled:cursor-not-allowed"
                        onChange={(event) =>
                          progress !== null
                            ? requests.setCustomAnswer(event.target.value)
                            : setDraft(event.target.value)
                        }
                        onKeyDown={onKeyDown}
                      />
                    </div>
                  </div>
                  <div
                    data-chat-composer-footer="true"
                    className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
                  >
                    <div
                      data-chat-composer-controls="left"
                      className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                      {instanceEntry !== undefined ? (
                        <ProviderModelPicker
                          environmentId={environmentId}
                          compact={false}
                          isComposerOwned
                          disabled={!canOperate || sending}
                          activeInstanceId={instanceEntry.instanceId}
                          model={selectedModel}
                          lockedProvider={instanceEntry.driverKind}
                          instanceEntries={[instanceEntry]}
                          modelOptionsByInstance={
                            new Map([
                              [
                                instanceEntry.instanceId,
                                getAppModelOptionsForInstance(
                                  settings,
                                  instanceEntry,
                                  selectedModel,
                                ),
                              ],
                            ])
                          }
                          size="sm"
                          triggerClassName="-ms-2.5 min-w-13"
                          instanceIndicatorBackground="var(--contrast-input)"
                          onInstanceModelChange={(instanceId, model) =>
                            useSideChatDraftStore
                              .getState()
                              .setModel(
                                sideChatId,
                                model === shell.modelSelection.model
                                  ? null
                                  : createModelSelection(instanceId, model),
                              )
                          }
                        />
                      ) : null}
                      <ComposerFooterModeControls
                        showInteractionModeToggle={false}
                        interactionMode={shell.interactionMode}
                        runtimeMode={shell.runtimeMode}
                        runtimeModeOptions={modeOptions}
                        onToggleInteractionMode={noop}
                        onRuntimeModeChange={(mode) => void changeRuntimeMode(mode)}
                      />
                    </div>
                    <div
                      data-chat-composer-actions="right"
                      className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                    >
                      <ComposerPrimaryActions
                        compact={false}
                        canOperateThread={canOperate}
                        pendingAction={
                          progress === null
                            ? null
                            : {
                                questionIndex: progress.questionIndex,
                                isLastQuestion: progress.isLastQuestion,
                                canAdvance: progress.canAdvance,
                                isResponding: requests.isResponding,
                                isComplete: progress.isComplete,
                              }
                        }
                        isRunning={props.isWorking}
                        canInterrupt={props.canInterrupt}
                        followUpBehavior="queue"
                        canSteer={false}
                        showPlanFollowUpPrompt={false}
                        promptHasText={promptValue.trim().length > 0}
                        isSendBusy={sending}
                        sendDisabledReason={
                          activeApproval !== null ? "Resolve the approval request first" : null
                        }
                        isConnecting={false}
                        isEnvironmentUnavailable={false}
                        isPreparingWorktree={false}
                        hasSendableContent={hasSendableContent}
                        onPreviousPendingQuestion={requests.previousQuestion}
                        onInterrupt={() => void stop()}
                        onImplementPlanInNewThread={noop}
                      />
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </ComposerHandleContext>
  );
}
