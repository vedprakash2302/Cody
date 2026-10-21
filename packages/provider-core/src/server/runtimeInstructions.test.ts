import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("asks agents to finish cleanup before the answer so the answer stays visible", () => {
    const instructions = buildRuntimeInstructions({ harness: "OpenCode" });
    expect(instructions).toContain("final tool calls before writing your final answer");
    expect(instructions).toContain("keep resources running when the user needs them");
    expect(instructions).toContain("Do not append a separate status-only message");
  });
});
