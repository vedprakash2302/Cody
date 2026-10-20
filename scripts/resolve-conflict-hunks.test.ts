import { assert, describe, it } from "@effect/vitest";

// @ts-expect-error The maintainer helper is plain JavaScript without declarations.
import { resolveConflictHunks } from "./resolve-conflict-hunks.mjs";

const conflicted = [
  "top",
  "<<<<<<< HEAD",
  "fork one",
  "=======",
  "upstream one",
  ">>>>>>> t3/main",
  "middle",
  "<<<<<<< HEAD",
  "fork two",
  "||||||| base",
  "base two",
  "=======",
  "upstream two",
  ">>>>>>> t3/main",
  "bottom",
].join("\n");

describe("resolveConflictHunks", () => {
  it("applies one choice per hunk and skips the diff3 base", () => {
    const result = resolveConflictHunks(conflicted, ["theirs", "both"]);
    assert.equal(result.hunks, 2);
    assert.equal(
      result.text,
      ["top", "upstream one", "middle", "fork two", "upstream two", "bottom"].join("\n"),
    );
  });

  it("repeats the last choice for remaining hunks", () => {
    const result = resolveConflictHunks(conflicted, ["theirs+ours"]);
    assert.equal(
      result.text,
      ["top", "upstream one", "fork one", "middle", "upstream two", "fork two", "bottom"].join(
        "\n",
      ),
    );
  });

  it("rejects an unknown side before changing anything", () => {
    assert.throws(() => resolveConflictHunks(conflicted, ["mine"]), /Unknown side "mine"/);
  });
});
