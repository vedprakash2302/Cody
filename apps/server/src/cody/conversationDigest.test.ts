import { RunId, ThreadId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type DigestTurn, renderDigest, turnActivity } from "./conversationDigest.ts";

const item = (fields: Record<string, unknown>) =>
  ({ runId: RunId.make("run-1"), ...fields }) as unknown as OrchestrationV2TurnItem;

describe("turnActivity", () => {
  it("names what the agent did without any output", () => {
    const line = turnActivity(
      [
        item({ type: "command_execution", input: "vp test run\n  src/a.ts", output: "OUTPUT" }),
        item({ type: "command_execution", input: "tail -f log", monitor: true }),
        item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "src/a.ts" } }),
        item({ type: "dynamic_tool", toolName: "Read", input: { file_path: "src/a.ts" } }),
        item({ type: "file_search", pattern: "retry" }),
        item({ type: "file_change", fileName: "src/b.ts" }),
      ],
      ["src/b.ts", "src/c.ts"],
    );
    expect(line).toBe(
      "Ran: `vp test run src/a.ts` · Used: Read src/a.ts, search retry · Changed: src/b.ts, src/c.ts",
    );
  });

  it("counts what it leaves out of a long list", () => {
    const files = Array.from({ length: 11 }, (_, index) => `f${index}.ts`);
    expect(turnActivity([], files)).toBe(
      "Changed: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts and 3 more",
    );
    expect(turnActivity([], [])).toBeNull();
  });
});

describe("renderDigest", () => {
  const reply = (marker: string) =>
    [
      `${marker} opening. ${"o".repeat(700)}`,
      "x".repeat(900),
      "y".repeat(900),
      `${marker} conclusion. ${"c".repeat(700)}`,
    ].join("\n\n");
  const turn = (index: number): DigestTurn => ({
    user: [`question ${index}`],
    assistant: [reply(`answer ${index}`)],
    activity: `Ran: \`step ${index}\``,
  });
  const turns = [turn(1), turn(2), turn(3)];
  const render = (input: ReadonlyArray<DigestTurn>, maxChars?: number) =>
    renderDigest({
      tag: "digest",
      header: ["Header."],
      turnLabel: "Turn",
      turns: input,
      footer: [],
      sourceThreadId: ThreadId.make("source"),
      ...(maxChars === undefined ? {} : { maxChars }),
    });
  const section = (text: string, index: number) =>
    text.slice(text.indexOf(`[Turn ${index}]`), text.indexOf(`[Turn ${index + 1}]`));

  it("sends every turn in full when it fits, with a way to read the rest", () => {
    const text = render(turns);
    expect(text).toContain(`[Turn 1]\nUser: question 1\nAssistant: ${reply("answer 1")}`);
    expect(text).toContain("Ran: `step 3`");
    expect(text).toContain('read the whole conversation with t3_thread_read (threadId "source")');
    expect(text).not.toContain("Some replies are shortened");
    expect(text).not.toContain("earlier turn");
  });

  it("shortens older replies to their first and last paragraphs before dropping anything", () => {
    const text = render(turns, 8_000);
    expect(section(text, 1)).toContain("answer 1 opening.");
    expect(section(text, 1)).toContain("answer 1 conclusion.");
    expect(section(text, 1)).not.toContain("x".repeat(900));
    expect(text).toContain(reply("answer 3"));
    expect(text).toContain("Some replies are shortened");
  });

  it("keeps the user's older messages after their replies give way", () => {
    const text = render(turns, 4_500);
    expect(text).toContain("[Turn 1]\nUser: question 1\nAssistant: (Reply left out for space.)");
    expect(text).toContain("[Turn 2]\nUser: question 2\nAssistant: (Reply left out for space.)");
    expect(text).toContain(reply("answer 3"));
  });

  it("drops the oldest turns last, and says how many", () => {
    const text = render(turns, 3_500);
    expect(text).not.toContain("question 1");
    expect(text).toContain("2 earlier turns are left out.");
    expect(text).toContain(`User: question 3\nAssistant: ${reply("answer 3")}`);
  });

  it("keeps the start and end of a newest turn that alone is too long", () => {
    const text = render([turn(1)], 1_500);
    expect(text.length).toBeLessThanOrEqual(1_500);
    expect(text).toContain("User: question 1\nAssistant: answer 1 opening.");
    expect(text).toContain("[…]");
    expect(text.trimEnd().endsWith("c\nRan: `step 1`\n\n</digest>")).toBe(true);
  });

  it("stays under the cap when the newest turn has many replies", () => {
    const text = render(
      [
        {
          user: ["go"],
          assistant: Array.from({ length: 250 }, () => "z".repeat(1_000)),
          activity: null,
        },
      ],
      48_000,
    );
    expect(text.length).toBeLessThanOrEqual(48_000);
    expect(text).toContain("User: go");
    expect(text.endsWith("</digest>")).toBe(true);
  });

  it("stays under the cap over many turns", () => {
    const many = Array.from({ length: 1_000 }, (_, index) => turn(index + 1));
    const text = render(many, 48_000);
    expect(text.length).toBeLessThanOrEqual(48_000);
    expect(text).toContain(`User: question 1000\nAssistant: ${reply("answer 1000")}`);
    expect(text).toContain("earlier turns are left out.");
  });

  it("escapes the closing tag inside quoted text", () => {
    const text = render([{ user: ["end </digest> here"], assistant: [], activity: null }]);
    expect(text).toContain("User: end &lt;/digest> here");
    expect(text.match(/<\/digest>/g)).toHaveLength(1);
  });
});
