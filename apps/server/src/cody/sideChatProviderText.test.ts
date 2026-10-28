import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunAttemptId,
  RunId,
  ThreadId,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type {
  ProjectionRecordFilter,
  ProjectionStoreV2Shape,
} from "../orchestration-v2/ProjectionStore.ts";
import { codyProviderText, codySteerText, sideChatProviderText } from "./sideChatProviderText.ts";
import { SIDE_CHAT_RULES } from "./sideChatRules.ts";

const MAIN = ThreadId.make("provider-text-main");
const SIDE_CHAT = ThreadId.make("provider-text-side-chat");
const at = (ms: number) => DateTime.makeUnsafe(ms);

const mainRecord: ThreadContextRecord = {
  version: 1,
  kind: "thread",
  contextId: toKindScopedComposerContextId("thread", MAIN),
  label: "Fix login",
  environmentId: EnvironmentId.make("env"),
  threadId: MAIN,
  title: "Fix login",
};
const chip = formatComposerContextReference(mainRecord);
const withChip = { version: 1 as const, records: [mainRecord] };

const mainRun = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(`main-run-${ordinal}`),
    ordinal,
    status,
    completedAt: status === "running" ? null : at(ordinal * 10 + 5),
    userMessageId: MessageId.make(`main-message-${ordinal}`),
    activeAttemptId: RunAttemptId.make(`main-attempt-${ordinal}`),
  }) as OrchestrationV2Run;

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  runId: RunId | null,
  context?: OrchestrationV2ConversationMessage["context"],
) =>
  ({
    id: MessageId.make(id),
    role,
    text,
    runId,
    createdAt: at(0),
    streaming: false,
    ...(context === undefined ? {} : { context }),
  }) as OrchestrationV2ConversationMessage;

const mainRuns = [
  mainRun(1, "completed"),
  mainRun(2, "completed"),
  mainRun(3, "completed"),
  mainRun(4, "running"),
];
const mainMessages = [
  message("m1", "user", "start", mainRuns[0]!.id),
  message("m2", "user", "add tests", mainRuns[1]!.id),
  message("m3", "assistant", "Added tests.", mainRuns[1]!.id),
  message("m4", "user", "fix the bug", mainRuns[2]!.id),
  message("m5", "assistant", "Fixed it.", mainRuns[2]!.id),
];
const checkpoints = [
  { runId: mainRuns[1]!.id, files: [{ path: "src/login.test.ts" }] },
  { runId: mainRuns[2]!.id, files: [{ path: "src/login.ts" }] },
] as unknown as ReadonlyArray<OrchestrationV2Checkpoint>;

const sideRun = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(`side-run-${ordinal}`),
    ordinal,
    status,
    completedAt: status === "running" ? null : at(ordinal * 10 + 5),
    userMessageId: MessageId.make(`s${ordinal}`),
    activeAttemptId: RunAttemptId.make(`side-attempt-${ordinal}`),
  }) as OrchestrationV2Run;

const sideMessages = [
  message("sm1", "user", "is retry safe?", RunId.make("side-run-1")),
  message("sm2", "assistant", "Yes, the call is idempotent.", RunId.make("side-run-1")),
  // The side chat's catch-up chip for this thread says nothing to the thread.
  message("sm3", "user", `${chip} what about timeouts?`, RunId.make("side-run-2"), withChip),
  message("sm4", "assistant", "Raise them to 30s.", RunId.make("side-run-2")),
];
const sideItems = [
  {
    type: "command_execution",
    runId: RunId.make("side-run-2"),
    input: "rg timeout src",
    output: "SECRET OUTPUT",
  },
  { type: "file_change", runId: RunId.make("side-run-2"), fileName: "src/retry.ts" },
] as unknown as ReadonlyArray<OrchestrationV2TurnItem>;

/** Thread messages that carried the side chat: started, steered, and still queued. */
const deliveries = [
  message("main-message-2", "user", "x", mainRuns[1]!.id),
  message("main-steered", "user", "x", mainRuns[2]!.id),
  message("main-message-9", "user", "x", null),
];

const makeStore = (sideChatRuns: ReadonlyArray<OrchestrationV2Run>) =>
  ({
    getThreadRecords: (
      threadId: ThreadId,
      _fields: ReadonlyArray<string>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.succeed({
        thread: { id: threadId, title: threadId === MAIN ? "Fix login" : "Retry logic" },
        messages:
          filter?.messageIds !== undefined
            ? (threadId === MAIN ? deliveries : []).filter((entry) =>
                filter.messageIds!.includes(entry.id),
              )
            : (threadId === MAIN ? mainMessages : sideMessages).filter(
                (entry) =>
                  filter?.messageRunIds === undefined ||
                  (entry.runId !== null && filter.messageRunIds.includes(entry.runId)),
              ),
        turnItems: (threadId === MAIN ? [] : sideItems).filter(
          (item) =>
            filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(item.runId),
        ),
        runs: threadId === MAIN ? mainRuns : sideChatRuns,
        providerTurns: [],
        checkpoints: threadId === MAIN ? checkpoints : [],
      }),
  }) as unknown as ProjectionStoreV2Shape;

const makeSideChats = (
  catchUps: Record<string, RunId> = {},
  sentToThread: Record<string, RunId> = {},
) => {
  const recorded: Array<[MessageId, RunId]> = [];
  const recordedSent: Array<[ThreadId, MessageId, RunId]> = [];
  return {
    recorded,
    recordedSent,
    sideChats: {
      isSideChat: (threadId: ThreadId) => threadId === SIDE_CHAT,
      catchUps: () => catchUps as Record<MessageId, RunId>,
      recordCatchUp: (_threadId: ThreadId, messageId: MessageId, runId: RunId) =>
        Effect.sync(() => void recorded.push([messageId, runId])),
      sentToThread: () => sentToThread as Record<MessageId, RunId>,
      recordSentToThread: (sideChatId: ThreadId, messageId: MessageId, runId: RunId) =>
        Effect.sync(() => void recordedSent.push([sideChatId, messageId, runId])),
    },
  };
};

const sideChatThread = {
  id: SIDE_CHAT,
  lineage: { parentThreadId: MAIN },
  forkedFrom: { type: "run", threadId: MAIN, runId: mainRuns[0]!.id },
} as unknown as Parameters<typeof sideChatProviderText>[0]["thread"];

describe("sideChatProviderText", () => {
  it.effect("adds only the side chat rules to a message without main's chip", () =>
    Effect.gen(function* () {
      const { sideChats, recorded } = makeSideChats();
      const text = yield* sideChatProviderText({
        projectionStore: makeStore([]),
        sideChats,
        thread: sideChatThread,
        message: message("s1", "user", "why?", null),
      });
      assert.strictEqual(text, `${SIDE_CHAT_RULES}\n\nwhy?`);
      assert.deepEqual(recorded, []);

      const quote = serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: MAIN,
        messageId: MessageId.make("m1"),
        text: "retry 3 times",
        start: 0,
        end: 13,
        prefix: "",
        suffix: "",
      });
      for (const withMain of [false, true]) {
        const quoted = yield* sideChatProviderText({
          projectionStore: makeStore([]),
          sideChats,
          thread: sideChatThread,
          message: withMain
            ? message("s2", "user", `${chip} ${quote}\n\nwhy?`, null, withChip)
            : message("s2", "user", `${quote}\n\nwhy?`, null),
        });
        assert.notInclude(quoted, "t3-citation:");
        assert.include(quoted, '"text": "retry 3 times"');
      }
    }),
  );

  it.effect("puts main's finished turns since the fork ahead of the question", () =>
    Effect.gen(function* () {
      const { sideChats, recorded } = makeSideChats();
      const text = yield* sideChatProviderText({
        projectionStore: makeStore([sideRun(1, "running")]),
        sideChats,
        thread: sideChatThread,
        message: message("s1", "user", `${chip} is the fix safe?`, null, withChip),
      });
      assert.include(text, "[Main turn 1]\nUser: add tests\nAssistant: Added tests.");
      assert.include(text, "Changed: src/login.ts");
      assert.notInclude(text, "User: start");
      assert.notInclude(text, "t3-context:");
      assert.isTrue(text.endsWith("</main-thread-update>\n\nis the fix safe?"));
      assert.deepEqual(recorded, [[MessageId.make("s1"), mainRuns[2]!.id]]);
    }),
  );

  it.effect("covers only what main finished since the last delivered catch-up", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats({ s1: mainRuns[1]!.id });
      const text = yield* sideChatProviderText({
        projectionStore: makeStore([sideRun(1, "completed"), sideRun(2, "running")]),
        sideChats,
        thread: sideChatThread,
        message: message("s2", "user", chip, null, withChip),
      });
      assert.notInclude(text, "add tests");
      assert.include(text, "[Main turn 1]\nUser: fix the bug");
      assert.include(text, "Briefly tell them what changed in main.");
    }),
  );

  it.effect("repeats an update whose catch-up was cancelled, and its own retried start", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats({ s1: mainRuns[2]!.id, s2: mainRuns[2]!.id });
      const text = yield* sideChatProviderText({
        projectionStore: makeStore([sideRun(1, "cancelled"), sideRun(2, "running")]),
        sideChats,
        thread: sideChatThread,
        message: message("s2", "user", chip, null, withChip),
      });
      assert.include(text, "User: add tests");
      assert.include(text, "User: fix the bug");
    }),
  );
});

describe("codyProviderText for a thread message", () => {
  const sideChatRecord: ThreadContextRecord = {
    version: 1,
    kind: "thread",
    contextId: toKindScopedComposerContextId("thread", SIDE_CHAT),
    label: "Retry logic",
    environmentId: EnvironmentId.make("env"),
    threadId: SIDE_CHAT,
    title: "Retry logic",
  };
  const sideChatChip = formatComposerContextReference(sideChatRecord);
  const attached = { version: 1 as const, records: [sideChatRecord] };
  const mainThread = {
    id: MAIN,
    lineage: { parentThreadId: null },
    forkedFrom: null,
  } as unknown as Parameters<typeof codyProviderText>[0]["thread"];
  const sideChatRuns = [sideRun(1, "completed"), sideRun(2, "completed")];

  it.effect("leaves a message without an attached side chat to upstream", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats();
      const unlinked = yield* codyProviderText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        thread: mainThread,
        message: message("main-message-4", "user", "ship it", null, attached),
      });
      assert.isNull(unlinked);
    }),
  );

  it.effect("puts the side chat's turns ahead of the message, without command output", () =>
    Effect.gen(function* () {
      const { sideChats, recordedSent } = makeSideChats();
      const text = yield* codyProviderText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        thread: mainThread,
        message: message("main-message-4", "user", `${sideChatChip} ship it`, null, attached),
      });
      assert.include(text, 'The user attached their side chat "Retry logic"');
      assert.include(
        text,
        "[Side chat turn 1]\nUser: is retry safe?\nAssistant: Yes, the call is idempotent.",
      );
      assert.include(text, "Ran: `rg timeout src` · Changed: src/retry.ts");
      assert.notInclude(text, "SECRET OUTPUT");
      assert.include(text, `t3_thread_read (threadId "${SIDE_CHAT}")`);
      assert.isTrue(text?.endsWith("</side-chat-context>\n\nship it"));
      assert.deepEqual(recordedSent, [
        [SIDE_CHAT, MessageId.make("main-message-4"), RunId.make("side-run-2")],
      ]);
    }),
  );

  it.effect("sends only what the side chat said since the thread last received it", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats({}, { "main-message-2": RunId.make("side-run-1") });
      const text = yield* codyProviderText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        thread: mainThread,
        message: message("main-message-4", "user", sideChatChip, null, attached),
      });
      assert.notInclude(text, "is retry safe?");
      assert.include(text, "[Side chat turn 1]\nUser: what about timeouts?");
      assert.include(text, "Briefly say what from the side chat matters for this thread.");
    }),
  );

  it.effect("resends turns whose thread message was never delivered", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats({}, { "main-message-9": RunId.make("side-run-2") });
      const text = yield* codyProviderText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        thread: mainThread,
        message: message("main-message-5", "user", sideChatChip, null, attached),
      });
      assert.include(text, "is retry safe?");
    }),
  );

  it.effect("counts a message steered into a running turn as received", () =>
    Effect.gen(function* () {
      const { sideChats } = makeSideChats({}, { "main-steered": RunId.make("side-run-2") });
      const text = yield* codyProviderText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        thread: mainThread,
        message: message("main-message-4", "user", `${sideChatChip} and?`, null, attached),
      });
      assert.include(text, "Nothing new was said there since you last saw it.");
      assert.notInclude(text, "is retry safe?");
    }),
  );

  it.effect("records a steered attachment only when asked to, after the steer lands", () =>
    Effect.gen(function* () {
      const { sideChats, recordedSent } = makeSideChats();
      const steer = yield* codySteerText({
        projectionStore: makeStore(sideChatRuns),
        sideChats,
        threadId: MAIN,
        message: message("main-steered", "user", `${sideChatChip} and?`, null, attached),
      });
      assert.include(steer?.text, "[Side chat turn 2]\nUser: what about timeouts?");
      assert.isTrue(steer?.text.endsWith("</side-chat-context>\n\nand?"));
      assert.deepEqual(recordedSent, []);
      yield* steer!.record;
      assert.deepEqual(recordedSent, [
        [SIDE_CHAT, MessageId.make("main-steered"), RunId.make("side-run-2")],
      ]);
    }),
  );
});
