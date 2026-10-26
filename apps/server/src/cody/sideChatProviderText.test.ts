import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  RunAttemptId,
  RunId,
  ThreadId,
  type ThreadContextRecord,
} from "@t3tools/contracts";
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
import { sideChatProviderText } from "./sideChatProviderText.ts";
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
    ordinal,
    status,
    userMessageId: MessageId.make(`s${ordinal}`),
    activeAttemptId: RunAttemptId.make(`side-attempt-${ordinal}`),
  }) as OrchestrationV2Run;

const makeStore = (sideChatRuns: ReadonlyArray<OrchestrationV2Run>) =>
  ({
    getThreadRecords: (
      threadId: ThreadId,
      _fields: ReadonlyArray<string>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.succeed({
        thread: { id: threadId, title: threadId === MAIN ? "Fix login" : "Side chat" },
        messages: (threadId === MAIN ? mainMessages : []).filter(
          (entry) =>
            filter?.messageRunIds === undefined ||
            (entry.runId !== null && filter.messageRunIds.includes(entry.runId)),
        ),
        runs: threadId === MAIN ? mainRuns : sideChatRuns,
        providerTurns: [],
        checkpoints: threadId === MAIN ? checkpoints : [],
      }),
  }) as unknown as ProjectionStoreV2Shape;

const makeSideChats = (catchUps: Record<string, RunId> = {}) => {
  const recorded: Array<[MessageId, RunId]> = [];
  return {
    recorded,
    sideChats: {
      isSideChat: () => true,
      catchUps: () => catchUps as Record<MessageId, RunId>,
      recordCatchUp: (_threadId: ThreadId, messageId: MessageId, runId: RunId) =>
        Effect.sync(() => void recorded.push([messageId, runId])),
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
      assert.include(text, "Files changed: src/login.ts");
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
