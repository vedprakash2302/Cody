import type {
  OrchestrationV2Checkpoint,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/**
 * One finished turn of a conversation passed between a thread and its side
 * chat: the messages verbatim, and what the agent did as a single line.
 */
export interface DigestTurn {
  readonly user: ReadonlyArray<string>;
  readonly assistant: ReadonlyArray<string>;
  readonly activity: string | null;
}

/** The item types whose turn the activity line describes. */
export const ACTIVITY_ITEM_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

const ACTIVITY_LIST_LIMIT = 8;
const ACTIVITY_ENTRY_LENGTH = 100;

const oneLine = (text: string, max = ACTIVITY_ENTRY_LENGTH) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const listed = (entries: ReadonlyArray<string>) => {
  const unique = [...new Set(entries)];
  const shown = unique.slice(0, ACTIVITY_LIST_LIMIT).join(", ");
  const more = unique.length - ACTIVITY_LIST_LIMIT;
  return more > 0 ? `${shown} and ${more} more` : shown;
};

function toolTarget(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const fields = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "pattern", "query", "url", "command"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value);
  }
  return null;
}

/**
 * What the agent did in a turn, without the output: the commands it ran, the
 * tools it used and the files it changed. The agent can rerun or reread any
 * of it, and outputs are most of a turn's size.
 */
export function turnActivity(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  changedFiles: ReadonlyArray<string>,
): string | null {
  const ran: string[] = [];
  const used: string[] = [];
  const changed = [...changedFiles];
  for (const item of items) {
    switch (item.type) {
      case "command_execution":
        if (!item.monitor) ran.push(`\`${oneLine(item.input)}\``);
        break;
      case "dynamic_tool": {
        if (item.toolName === null) break;
        const target = toolTarget(item.input);
        used.push(target === null ? item.toolName : `${item.toolName} ${target}`);
        break;
      }
      case "file_search":
        used.push(item.pattern === undefined ? "file search" : `search ${oneLine(item.pattern)}`);
        break;
      case "web_search":
        used.push(
          item.patterns === undefined || item.patterns.length === 0
            ? "web search"
            : `web search ${oneLine(item.patterns.join(", "))}`,
        );
        break;
      case "file_change":
        changed.push(item.fileName);
        break;
      default:
        break;
    }
  }
  const parts = [
    ran.length === 0 ? null : `Ran: ${listed(ran)}`,
    used.length === 0 ? null : `Used: ${listed(used)}`,
    changed.length === 0 ? null : `Changed: ${listed(changed)}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Files each run changed, by its checkpoints. */
function checkpointFiles(
  runId: RunId,
  checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "runId" | "files">>,
): ReadonlyArray<string> {
  return checkpoints.flatMap((checkpoint) =>
    checkpoint.runId === runId ? checkpoint.files.map((file) => file.path) : [],
  );
}

/** A conversation's finished runs as digest turns, oldest first. */
export function digestTurns(input: {
  readonly runIds: ReadonlyArray<RunId>;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "text" | "runId" | "streaming">
  >;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "runId" | "files">>;
}): ReadonlyArray<DigestTurn> {
  return input.runIds.map((runId) => {
    const text = (role: "user" | "assistant") =>
      input.messages.flatMap((message) => {
        if (message.runId !== runId || message.streaming || message.role !== role) return [];
        const body = replaceComposerContextReferences(
          message.text,
          (occurrence) => `[${occurrence.label}]`,
        ).trim();
        return body.length === 0 ? [] : [body];
      });
    return {
      user: text("user"),
      assistant: text("assistant"),
      activity: turnActivity(
        input.items.filter((item) => item.runId === runId),
        checkpointFiles(runId, input.checkpoints),
      ),
    };
  });
}

/**
 * How far a turn is cut to fit: in full, with older replies cut to their
 * first and last paragraphs, with the user's messages only, or left out.
 */
type TurnLevel = 0 | 1 | 2 | 3;

const PARAGRAPH_LENGTH = 600;
const SHORT_USER_LENGTH = 2_000;

const headAndTail = (text: string, max: number) => {
  if (text.length <= max) return text;
  const half = Math.floor((max - 5) / 2);
  return `${text.slice(0, half).trimEnd()}\n[…]\n${text.slice(-half).trimStart()}`;
};

function shortened(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0);
  if (paragraphs.length <= 2) return headAndTail(text, PARAGRAPH_LENGTH * 2);
  return [
    headAndTail(paragraphs[0]!, PARAGRAPH_LENGTH),
    "[…]",
    headAndTail(paragraphs.at(-1)!, PARAGRAPH_LENGTH),
  ].join("\n\n");
}

export interface DigestInput {
  readonly tag: string;
  readonly header: ReadonlyArray<string>;
  /** Names a turn, such as "Main turn" or "Side chat turn". */
  readonly turnLabel: string;
  readonly turns: ReadonlyArray<DigestTurn>;
  readonly footer: ReadonlyArray<string>;
  /** Where the agent can read the whole conversation. */
  readonly sourceThreadId: ThreadId;
  readonly maxChars?: number;
}

const DIGEST_MAX_CHARS = 48_000;
const MIN_SECTION_LENGTH = 200;

/**
 * The block sent ahead of a message that carries another conversation. Over
 * the cap, older turns give way first: replies shortened, then dropped, then
 * whole turns. Each turn renders once, so long conversations stay linear.
 */
export function renderDigest(input: DigestInput): string {
  const escape = (text: string) => text.replace(new RegExp(`<(?=/?${input.tag}\\b)`, "gi"), "&lt;");
  const turnText = (turn: DigestTurn, index: number, level: Exclude<TurnLevel, 3>) => {
    const user = turn.user.map((text) =>
      level === 0 ? text : headAndTail(text, SHORT_USER_LENGTH),
    );
    const assistant =
      level === 2
        ? ["(Reply left out for space.)"]
        : turn.assistant.map((text) => (level === 1 ? shortened(text) : text));
    return [
      `[${input.turnLabel} ${index + 1}]`,
      ...user.map((text) => `User: ${escape(text)}`),
      ...assistant.map((text) => `Assistant: ${escape(text)}`),
      ...(turn.activity === null ? [] : [escape(turn.activity)]),
    ].join("\n");
  };
  const versions = input.turns.map((turn, index) => {
    const full = turnText(turn, index, 0);
    return [full, turnText(turn, index, 1), turnText(turn, index, 2), ""] as const;
  });

  const pointer = `For anything left out or shortened here, read the whole conversation with t3_thread_read (threadId "${input.sourceThreadId}").`;
  const notes = (dropped: number, shortenedAny: boolean) =>
    [
      dropped > 0
        ? `${dropped} earlier ${dropped === 1 ? "turn is" : "turns are"} left out.`
        : null,
      shortenedAny ? "Some replies are shortened, marked […] or left out." : null,
    ].filter((note) => note !== null);
  const assemble = (sections: ReadonlyArray<string>, dropped: number, shortenedAny: boolean) =>
    [
      `<${input.tag}>`,
      ...input.header,
      ...notes(dropped, shortenedAny),
      pointer,
      "",
      ...sections.flatMap((section) => (section.length === 0 ? [] : [section, ""])),
      ...input.footer,
      `</${input.tag}>`,
    ].join("\n");

  const max = input.maxChars ?? DIGEST_MAX_CHARS;
  const levels: TurnLevel[] = input.turns.map(() => 0);
  const sectionLength = (index: number) => {
    const length = versions[index]![levels[index]!].length;
    return length === 0 ? 0 : length + 2;
  };
  const notesLength = (dropped: number, shortenedAny: boolean) =>
    notes(dropped, shortenedAny).reduce((sum, note) => sum + note.length + 1, 0);
  const base = assemble([], 0, false).length;
  let sectionsLength = versions.reduce((sum, version) => sum + version[0].length + 2, 0);
  let dropped = 0;
  let shortenedCount = 0;
  const total = () => base + notesLength(dropped, shortenedCount > 0) + sectionsLength;
  const isShortened = (level: TurnLevel) => level === 1 || level === 2;
  const setLevel = (index: number, level: TurnLevel) => {
    const previous = levels[index]!;
    sectionsLength -= sectionLength(index);
    levels[index] = level;
    sectionsLength += sectionLength(index);
    shortenedCount += Number(isShortened(level)) - Number(isShortened(previous));
    dropped += Number(level === 3) - Number(previous === 3);
  };
  // Older turns step down one level at a time, oldest first; the newest stays whole.
  const last = levels.length - 1;
  for (const level of [1, 2, 3] as const) {
    for (let index = 0; index < last && total() > max; index += 1) {
      setLevel(index, level);
    }
  }
  if (last >= 0 && total() > max) setLevel(last, 1);
  const sections = versions.map((version, index) => version[levels[index]!]);
  if (last >= 0 && total() > max) {
    // The newest turn alone is too long: keep its start and its end.
    const budget = max - (total() - sectionLength(last)) - 2;
    sections[last] = budget < MIN_SECTION_LENGTH ? "" : headAndTail(sections[last]!, budget);
    if (sections[last] === "") dropped += 1;
  }
  return assemble(sections, dropped, shortenedCount > 0);
}
