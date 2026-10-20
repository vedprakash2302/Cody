#!/usr/bin/env node
// Resolves merge conflict hunks in one file, one explicit choice per hunk, so an
// upstream sync never has to take a whole file from either side.
//
//   node scripts/resolve-conflict-hunks.mjs <file> <side>[,<side>...]
//
// Sides apply to hunks in order; the last side repeats for any remaining hunks.
// ours = the fork, theirs = upstream, both = ours then theirs, theirs+ours = theirs then ours.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const SIDES = new Set(["ours", "theirs", "both", "theirs+ours"]);

export function resolveConflictHunks(text, sides) {
  for (const side of sides) {
    if (!SIDES.has(side)) throw new Error(`Unknown side "${side}".`);
  }
  const lines = text.split("\n");
  const output = [];
  let hunks = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("<<<<<<< ")) {
      output.push(lines[index]);
      continue;
    }
    const ours = [];
    const theirs = [];
    index += 1;
    while (!lines[index].startsWith("=======") && !lines[index].startsWith("||||||| ")) {
      ours.push(lines[index]);
      index += 1;
    }
    // diff3 style: skip the merge-base section.
    while (!lines[index].startsWith("=======")) index += 1;
    index += 1;
    while (!lines[index].startsWith(">>>>>>> ")) {
      theirs.push(lines[index]);
      index += 1;
    }
    const side = sides[Math.min(hunks, sides.length - 1)];
    hunks += 1;
    if (side === "ours") output.push(...ours);
    else if (side === "theirs") output.push(...theirs);
    else if (side === "both") output.push(...ours, ...theirs);
    else output.push(...theirs, ...ours);
  }
  return { text: output.join("\n"), hunks };
}

if (NodeProcess.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  const [file, sideList] = NodeProcess.argv.slice(2);
  if (!file || !sideList) {
    console.error("Usage: node scripts/resolve-conflict-hunks.mjs <file> <side>[,<side>...]");
    NodeProcess.exit(2);
  }
  const result = resolveConflictHunks(NodeFS.readFileSync(file, "utf8"), sideList.split(","));
  NodeFS.writeFileSync(file, result.text);
  console.log(`${file}: ${result.hunks} hunks`);
}
