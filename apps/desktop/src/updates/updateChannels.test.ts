import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(desktopUpdateChannelOf("0.0.41-preview.20260911.7")).toBe("latest");
    expect(desktopUpdateChannelOf("0.1.4-nightly.20261029.73")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
