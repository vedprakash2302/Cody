import { describe, expect, it } from "vite-plus/test";

import { classifyWorkEntry, findAnswerBeforeWrapUp, type TurnSequenceItem } from "./turnAnswer.ts";

const answer = (id: string, length: number): TurnSequenceItem => ({
  kind: "assistant",
  id,
  text: "x".repeat(length),
});
const work = (toolCalls: number): TurnSequenceItem => ({ kind: "work", toolCalls });
const reasoning: TurnSequenceItem = { kind: "reasoning" };

describe("findAnswerBeforeWrapUp", () => {
  it("finds a long answer followed by cleanup tools and a one-line wrap-up", () => {
    expect(
      findAnswerBeforeWrapUp([
        answer("opening", 181),
        work(40),
        reasoning,
        answer("answer", 5073),
        work(2),
        answer("wrap-up", 65),
      ]),
    ).toBe("answer");
  });

  it("keeps the last message as the answer when it is long", () => {
    expect(
      findAnswerBeforeWrapUp([answer("commentary", 400), work(1), answer("answer", 900)]),
    ).toBeNull();
  });

  it("does not promote commentary written before more work", () => {
    expect(
      findAnswerBeforeWrapUp([answer("long-commentary", 900), work(4), answer("wrap-up", 40)]),
    ).toBeNull();
    expect(findAnswerBeforeWrapUp([answer("check", 30), work(1), answer("done", 20)])).toBeNull();
  });

  it("looks past thinking between the answer and its wrap-up", () => {
    expect(
      findAnswerBeforeWrapUp([answer("answer", 1200), reasoning, work(1), answer("wrap-up", 50)]),
    ).toBe("answer");
  });

  it("returns null for a turn with no assistant text", () => {
    expect(findAnswerBeforeWrapUp([work(3), reasoning])).toBeNull();
  });

  it("does not promote text written before a subagent launch", () => {
    expect(
      findAnswerBeforeWrapUp([answer("commentary", 900), { kind: "boundary" }, answer("done", 40)]),
    ).toBeNull();
  });

  it("applies the length and tool-call limits at their edges", () => {
    expect(findAnswerBeforeWrapUp([answer("a", 281), work(3), answer("w", 280)])).toBe("a");
    expect(findAnswerBeforeWrapUp([answer("a", 281), work(4), answer("w", 280)])).toBeNull();
    expect(findAnswerBeforeWrapUp([answer("a", 281), work(1), answer("w", 281)])).toBeNull();
    expect(findAnswerBeforeWrapUp([answer("a", 280), work(1), answer("w", 10)])).toBeNull();
  });
});

describe("classifyWorkEntry", () => {
  it("counts tool calls, stops at subagent work, and ignores bookkeeping", () => {
    expect(classifyWorkEntry({ sourceActivityKind: "tool.completed" })).toEqual({
      kind: "work",
      toolCalls: 1,
    });
    expect(classifyWorkEntry({ sourceActivityKind: "task.started" })).toEqual({ kind: "boundary" });
    expect(
      classifyWorkEntry({
        sourceActivityKind: "tool.completed",
        itemType: "collab_agent_tool_call",
      }),
    ).toEqual({ kind: "boundary" });
    expect(classifyWorkEntry({ sourceActivityKind: "tool.completed", agentSpawn: {} })).toEqual({
      kind: "boundary",
    });
    expect(classifyWorkEntry({ sourceActivityKind: "context-compaction" })).toBeNull();
    expect(classifyWorkEntry({ sourceActivityKind: "runtime.warning" })).toBeNull();
  });
});
