import { describe, expect, it } from "vite-plus/test";

import { openCodeSessionEnvironment } from "./OpenCodeDriver.ts";

describe("openCodeSessionEnvironment", () => {
  it("turns on OpenCode background subagents only when the setting is on", () => {
    const environment = { PATH: "/usr/bin", XDG_DATA_HOME: "/data" };
    expect(openCodeSessionEnvironment({ backgroundSubagents: true }, environment)).toEqual({
      ...environment,
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    });
    expect(openCodeSessionEnvironment({ backgroundSubagents: false }, environment)).toBe(
      environment,
    );
  });
});
