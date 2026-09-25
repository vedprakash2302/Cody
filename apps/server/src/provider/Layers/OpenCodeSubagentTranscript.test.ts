import type { Part } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vite-plus/test";

import {
  toOpenCodeSubagentTranscript,
  TRANSCRIPT_MESSAGE_LIMIT,
} from "./OpenCodeSubagentTranscript.ts";

const base = { sessionID: "ses_child", messageID: "msg" };
const text = (id: string, value: string, extra: Record<string, unknown> = {}) =>
  ({ ...base, id, type: "text", text: value, ...extra }) as Part;
const tool = (id: string, state: Record<string, unknown>) =>
  ({ ...base, id, type: "tool", callID: `call-${id}`, tool: "bash", state }) as unknown as Part;

describe("toOpenCodeSubagentTranscript", () => {
  it("keeps the prompt, replies, thinking, and tool calls in order", () => {
    const transcript = toOpenCodeSubagentTranscript("ses_child", [
      {
        info: { id: "u1", role: "user" },
        parts: [text("p1", "Count the lines."), text("p2", "<file>…</file>", { synthetic: true })],
      },
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          { ...base, id: "s1", type: "step-start" } as Part,
          { ...base, id: "r1", type: "reasoning", text: "Use wc.", time: { start: 1 } } as Part,
          tool("t1", {
            status: "completed",
            input: { command: "wc -l math.ts" },
            output: "1 math.ts\n",
            title: "Count lines",
            metadata: {},
            time: { start: 1, end: 2 },
          }),
          tool("t2", { status: "error", input: {}, error: "denied", time: { start: 1, end: 2 } }),
          text("x1", "  "),
          text("x2", "It has 1 line."),
        ],
      },
    ]);
    expect(transcript.truncated).toBe(false);
    expect(transcript.entries).toEqual([
      { kind: "prompt", id: "p1", text: "Count the lines." },
      { kind: "reasoning", id: "r1", text: "Use wc." },
      {
        kind: "tool",
        id: "t1",
        tool: "bash",
        title: "Count lines",
        status: "completed",
        input: '{\n  "command": "wc -l math.ts"\n}',
        output: "1 math.ts",
      },
      { kind: "tool", id: "t2", tool: "bash", status: "failed", output: "denied" },
      { kind: "text", id: "x2", text: "It has 1 line." },
    ]);
  });

  it("clips long tool output and reports a cut history", () => {
    const clipped = toOpenCodeSubagentTranscript("ses_child", [
      {
        info: { id: "a1", role: "assistant" },
        parts: [
          tool("t1", {
            status: "completed",
            input: {},
            output: "x".repeat(10_000),
            title: "Dump",
            metadata: {},
            time: { start: 1, end: 2 },
          }),
        ],
      },
    ]);
    expect(clipped.truncated).toBe(true);
    const entry = clipped.entries[0];
    expect(entry?.kind === "tool" && entry.output?.length).toBe(4_001);

    const window = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        info: { id: `a${index}`, role: "assistant" as const },
        parts: [],
      }));
    // Callers fetch one past the limit: exactly the limit is a whole history.
    expect(
      toOpenCodeSubagentTranscript("ses_child", window(TRANSCRIPT_MESSAGE_LIMIT)).truncated,
    ).toBe(false);
    expect(
      toOpenCodeSubagentTranscript("ses_child", window(TRANSCRIPT_MESSAGE_LIMIT + 1)).truncated,
    ).toBe(true);
  });

  it("bounds the whole reply, keeping the task prompt and the newest work", () => {
    const transcript = toOpenCodeSubagentTranscript("ses_child", [
      { info: { id: "u1", role: "user" }, parts: [text("prompt", "Audit the repo.")] },
      {
        info: { id: "a1", role: "assistant" },
        parts: Array.from({ length: 1_000 }, (_, index) =>
          tool(`t${index}`, {
            status: "completed",
            input: {},
            output: "y".repeat(3_000),
            title: "t".repeat(500),
            metadata: {},
            time: { start: 1, end: 2 },
          }),
        ),
      },
    ]);
    expect(transcript.truncated).toBe(true);
    expect(transcript.entries[0]).toEqual({
      kind: "prompt",
      id: "prompt",
      text: "Audit the repo.",
    });
    expect(transcript.entries.at(-1)?.id).toBe("t999");
    expect(transcript.entries.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(transcript).length).toBeLessThan(400_000);
    const last = transcript.entries.at(-1);
    expect(last?.kind === "tool" && last.title?.length).toBe(201);
  });

  it("does not serialize tool input that falls outside the budget", () => {
    let serialized = 0;
    const input = {
      path: "big.ts",
      toJSON: () => {
        serialized += 1;
        return { path: "big.ts" };
      },
    };
    const transcript = toOpenCodeSubagentTranscript("ses_child", [
      {
        info: { id: "a1", role: "assistant" },
        parts: Array.from({ length: 1_000 }, (_, index) =>
          tool(`t${index}`, {
            status: "completed",
            input,
            output: "y".repeat(3_000),
            title: "write",
            metadata: {},
            time: { start: 1, end: 2 },
          }),
        ),
      },
    ]);
    expect(transcript.truncated).toBe(true);
    // Roughly the 80 newest calls fit; the other 900 are never converted.
    expect(serialized).toBeLessThan(transcript.entries.length + 5);
  });
});
