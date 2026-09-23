import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { formatCodyReleaseNotes, resolvePreviousNightlyTag } from "./cody-release-notes.mjs";

const test = NodeTest.test;
const Assert = NodeAssert;

const base = {
  repository: "vedprakash2302/Cody",
  tag: "v0.0.42-nightly.20260924.8",
  previousTag: "v0.0.42-nightly.20260923.7",
  buildUrl: "https://github.com/vedprakash2302/Cody/actions/runs/1",
};

test("previous nightly is the newest release below the current one", () => {
  Assert.equal(
    resolvePreviousNightlyTag("v0.0.42-nightly.20260924.8", [
      "v0.0.42-nightly.20260922.6",
      "personal-v0.0.42-preview.20260922.4",
      "v0.0.42-nightly.20260923.7",
      "v0.0.42-nightly.20260925.9",
      "v0.0.41",
    ]),
    "v0.0.42-nightly.20260923.7",
  );
  Assert.equal(resolvePreviousNightlyTag("v0.0.42-nightly.20260924.8", ["v0.0.41"]), null);
  Assert.throws(() => resolvePreviousNightlyTag("v0.0.42", []));
});

test("lists upstream changes before Cody's so Cody's lead the in-app popover", () => {
  const notes = formatCodyReleaseNotes({
    ...base,
    upstreamChanges: [
      { sha: "a".repeat(40), subject: "fix(web): drop @expo/metro-runtime from <Button> (#13148)" },
      { sha: "b".repeat(40), subject: "chore(mobile): bump app version to 1.3.1" },
    ],
    codyChanges: [{ sha: "c".repeat(40), subject: "fix(server): OpenCode compaction keeps turns" }],
  });
  Assert.equal(
    notes,
    [
      "## What's Changed",
      "",
      "### From T3 Code",
      "- fix(web): drop `@expo/metro-runtime` from \\<Button\\> ([#13148](https://github.com/pingdotgg/t3code/pull/13148))",
      "- chore(mobile): bump app version to 1.3.1",
      "",
      "### Cody",
      `- fix(server): OpenCode compaction keeps turns ([ccccccc](https://github.com/vedprakash2302/Cody/commit/${"c".repeat(40)}))`,
      "",
      "### Full changelog",
      "",
      "https://github.com/vedprakash2302/Cody/compare/v0.0.42-nightly.20260923.7...v0.0.42-nightly.20260924.8",
      "",
      "Windows builds are unsigned and macOS builds are not notarized. Older manual-install previews need one manual upgrade to reach the in-app updater.",
      "",
      "Build: https://github.com/vedprakash2302/Cody/actions/runs/1",
      "",
    ].join("\n"),
  );
});

test("drops the oldest upstream changes to stay under GitHub's body limit", () => {
  const upstreamChanges = Array.from({ length: 450 }, (_, index) => ({
    sha: String(index).padStart(40, "0"),
    subject: `change ${index}`,
  }));
  const notes = formatCodyReleaseNotes({
    ...base,
    upstreamChanges,
    codyChanges: [{ sha: "c".repeat(40), subject: "cody change" }],
  });
  const items = notes.split("\n").filter((line) => line.startsWith("- "));
  Assert.equal(items.length, 401);
  Assert.equal(items[0], "- 51 earlier T3 Code changes, see the full changelog");
  Assert.equal(items[1], "- change 51");
  Assert.match(items.at(-1), /^- cody change /);
});

test("says so when there is nothing to compare", () => {
  Assert.match(
    formatCodyReleaseNotes({ ...base, previousTag: null, upstreamChanges: [], codyChanges: [] }),
    /^First Cody nightly with release notes\.\n\n### Full changelog\n\nWindows/,
  );
  Assert.match(
    formatCodyReleaseNotes({ ...base, upstreamChanges: [], codyChanges: [] }),
    /^No code changes since v0\.0\.42-nightly\.20260923\.7\./,
  );
});
