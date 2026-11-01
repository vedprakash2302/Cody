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

const run = (
  prefix: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  startedAt: number,
) =>
  ({
    id: RunId.make(`${prefix}-run-${ordinal}`),
    ordinal,
    status,
    startedAt: at(startedAt),
    requestedAt: at(startedAt),
    completedAt: status === "running" ? null : at(ordinal * 10 + 5),
    userMessageId: MessageId.make(`${prefix}-message-${ordinal}`),
    activeAttemptId: RunAttemptId.make(`${prefix}-attempt-${ordinal}`),
  }) as OrchestrationV2Run;
const mainRun = (ordinal: number, status: OrchestrationV2Run["status"], startedAt = ordinal * 10) =>
  run("main", ordinal, status, startedAt);
const sideRun = (ordinal: number, status: OrchestrationV2Run["status"], startedAt = ordinal * 10) =>
  run("side", ordinal, status, startedAt);

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  runId: RunId | null,
  context?: OrchestrationV2ConversationMessage["context"],
  createdAt = 0,
) =>
  ({
    id: MessageId.make(id),
    role,
    text,
    runId,
    createdAt: at(createdAt),
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

const byFilter = (
  entries: ReadonlyArray<OrchestrationV2ConversationMessage>,
  filter: ProjectionRecordFilter | undefined,
) =>
  entries.filter(
    (entry) =>
      (filter?.messageRoles === undefined || filter.messageRoles.includes(entry.role)) &&
      (filter?.messageRunIds === undefined ||
        (entry.runId !== null && filter.messageRunIds.includes(entry.runId))),
  );

/** A projection store holding the main thread and its side chat. */
const makeStore = (input: {
  readonly sideChatRuns: ReadonlyArray<OrchestrationV2Run>;
  /** The side chat's own user messages, read for its catch-ups. */
  readonly sideChatTurns?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  /** The main thread's earlier user messages, read for what it received. */
  readonly mainTurns?: ReadonlyArray<OrchestrationV2ConversationMessage>;
}) =>
  ({
    getThreadShell: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === SIDE_CHAT
          ? { id: SIDE_CHAT, lineage: { parentThreadId: MAIN, sideChat: true } }
          : { id: threadId, lineage: { parentThreadId: null } },
      ),
    getThreadRecords: (
      threadId: ThreadId,
      _fields: ReadonlyArray<string>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.succeed({
        thread: { id: threadId, title: threadId === MAIN ? "Fix login" : "Retry logic" },
        messages:
          threadId === MAIN
            ? byFilter([...mainMessages, ...(input.mainTurns ?? [])], filter)
            : filter?.messageRoles === undefined
              ? byFilter(sideMessages, filter)
              : (input.sideChatTurns ?? []),
        turnItems: (threadId === MAIN ? [] : sideItems).filter(
          (item) =>
            filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(item.runId),
        ),
        runs: threadId === MAIN ? mainRuns : input.sideChatRuns,
        providerTurns: [],
        checkpoints: threadId === MAIN ? checkpoints : [],
      }),
  }) as unknown as ProjectionStoreV2Shape;

const sideChatThread = {
  id: SIDE_CHAT,
  lineage: { parentThreadId: MAIN, sideChat: true },
  forkedFrom: { type: "run", threadId: MAIN, runId: mainRuns[0]!.id },
} as unknown as Parameters<typeof sideChatProviderText>[0]["thread"];

describe("sideChatProviderText", () => {
  it.effect("adds only the side chat rules to a message without main's chip", () =>
    Effect.gen(function* () {
      const text = yield* sideChatProviderText({
        projectionStore: makeStore({ sideChatRuns: [] }),
        thread: sideChatThread,
        message: message("s1", "user", "why?", null),
      });
      assert.strictEqual(text, `${SIDE_CHAT_RULES}\n\nwhy?`);

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
          projectionStore: makeStore({ sideChatRuns: [] }),
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
      const asking = message(
        "side-message-1",
        "user",
        `${chip} is the fix safe?`,
        RunId.make("side-run-1"),
        withChip,
      );
      const text = yield* sideChatProviderText({
        projectionStore: makeStore({
          sideChatRuns: [sideRun(1, "running", 40)],
          sideChatTurns: [asking],
        }),
        thread: sideChatThread,
        message: asking,
      });
      assert.include(text, "[Main turn 1]\nUser: add tests\nAssistant: Added tests.");
      assert.include(text, "Changed: src/login.ts");
      assert.notInclude(text, "User: start");
      assert.notInclude(text, "t3-context:");
      assert.isTrue(text.endsWith("</main-thread-update>\n\nis the fix safe?"));
    }),
  );

  it.effect("covers only what main finished since the last delivered catch-up", () =>
    Effect.gen(function* () {
      const earlier = message("side-message-1", "user", chip, RunId.make("side-run-1"), withChip);
      const asking = message("side-message-2", "user", chip, RunId.make("side-run-2"), withChip);
      const text = yield* sideChatProviderText({
        // The earlier catch-up started after main's second turn finished, before its third.
        projectionStore: makeStore({
          sideChatRuns: [sideRun(1, "completed", 30), sideRun(2, "running", 40)],
          sideChatTurns: [earlier, asking],
        }),
        thread: sideChatThread,
        message: asking,
      });
      assert.notInclude(text, "add tests");
      assert.include(text, "[Main turn 1]\nUser: fix the bug");
      assert.include(text, "Briefly tell them what changed in main.");
    }),
  );

  it.effect("repeats an update whose catch-up was cancelled, and its own retried start", () =>
    Effect.gen(function* () {
      const earlier = message("side-message-1", "user", chip, RunId.make("side-run-1"), withChip);
      const asking = message("side-message-2", "user", chip, RunId.make("side-run-2"), withChip);
      const text = yield* sideChatProviderText({
        projectionStore: makeStore({
          sideChatRuns: [sideRun(1, "cancelled", 40), sideRun(2, "running", 40)],
          sideChatTurns: [earlier, asking],
        }),
        thread: sideChatThread,
        message: asking,
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
  const sending = (text: string) => message("main-message-5", "user", text, null, attached);

  it.effect("leaves a message without a brought-back side chat to upstream", () =>
    Effect.gen(function* () {
      const unlinked = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns }),
        thread: mainThread,
        message: sending("ship it"),
      });
      assert.isNull(unlinked);
      // A chip to a thread that isn't this thread's side chat is upstream's too.
      const otherRecord = {
        ...mainRecord,
        contextId: toKindScopedComposerContextId("thread", "other"),
        threadId: ThreadId.make("other"),
      };
      const other = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns }),
        thread: mainThread,
        message: message(
          "main-message-5",
          "user",
          `${formatComposerContextReference(otherRecord)} hi`,
          null,
          { version: 1, records: [otherRecord] },
        ),
      });
      assert.isNull(other);
    }),
  );

  it.effect("puts the side chat's turns ahead of the message, without command output", () =>
    Effect.gen(function* () {
      const text = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns }),
        thread: mainThread,
        message: sending(`${sideChatChip} ship it`),
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
    }),
  );

  it.effect("sends only what the side chat said since the thread last received it", () =>
    Effect.gen(function* () {
      // Main's second turn brought the side chat back after its first turn finished.
      const earlier = message("main-message-2", "user", sideChatChip, mainRuns[1]!.id, attached);
      const text = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns, mainTurns: [earlier] }),
        thread: mainThread,
        message: sending(sideChatChip),
      });
      assert.notInclude(text, "is retry safe?");
      assert.include(text, "[Side chat turn 1]\nUser: what about timeouts?");
      assert.include(text, "Briefly say what from the side chat matters for this thread.");
    }),
  );

  it.effect("resends turns whose thread message was never delivered", () =>
    Effect.gen(function* () {
      const queued = message("main-message-9", "user", sideChatChip, null, attached);
      const text = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns, mainTurns: [queued] }),
        thread: mainThread,
        message: sending(sideChatChip),
      });
      assert.include(text, "is retry safe?");
    }),
  );

  it.effect("counts a message steered into a running turn as received", () =>
    Effect.gen(function* () {
      const steered = message("main-steered", "user", sideChatChip, mainRuns[2]!.id, attached, 30);
      const text = yield* codyProviderText({
        projectionStore: makeStore({ sideChatRuns, mainTurns: [steered] }),
        thread: mainThread,
        message: sending(`${sideChatChip} and?`),
      });
      assert.include(text, "Nothing new was said there since you last saw it.");
      assert.notInclude(text, "is retry safe?");
    }),
  );

  it.effect("gives a steered message the side chat's turns too", () =>
    Effect.gen(function* () {
      const steer = yield* codySteerText({
        projectionStore: makeStore({ sideChatRuns }),
        threadId: MAIN,
        message: message("main-steered", "user", `${sideChatChip} and?`, null, attached),
      });
      assert.include(steer, "[Side chat turn 2]\nUser: what about timeouts?");
      assert.isTrue(steer?.endsWith("</side-chat-context>\n\nand?"));
    }),
  );
});
