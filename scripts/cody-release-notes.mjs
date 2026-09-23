import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const upstreamRepository = "pingdotgg/t3code";
// GitHub rejects release bodies over 125,000 characters.
const maxListedChanges = 400;

/** Parse a Cody nightly tag, `v<major>.<minor>.<patch>-nightly.<yyyymmdd>.<run>`. */
export function parseNightlyTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** The newest nightly release tag that sorts below the one being published. */
export function resolvePreviousNightlyTag(currentTag, releaseTags) {
  const current = parseNightlyTag(currentTag);
  if (!current) throw new Error(`Invalid nightly tag '${currentTag}'.`);
  return (
    releaseTags
      .map((tag) => ({ tag, version: parseNightlyTag(tag) }))
      .filter(({ version }) => version && compareVersions(version, current) < 0)
      .toSorted((left, right) => compareVersions(right.version, left.version))[0]?.tag ?? null
  );
}

/**
 * Commit subjects are plain text. Escape what GitHub would format, and put
 * `@scope/package` style tokens in code spans so the release pings no one.
 */
function escapeSubject(subject) {
  return subject
    .replace(/[\\*_[\]<>]/g, (character) => `\\${character}`)
    .replace(/(^|[\s(])(@[\w./-]+)/g, "$1`$2`");
}

function formatUpstreamChange({ subject }) {
  const pullRequest = /\s*\(#(\d+)\)$/.exec(subject);
  if (!pullRequest) return `- ${escapeSubject(subject)}`;
  const title = escapeSubject(subject.slice(0, pullRequest.index));
  return `- ${title} ([#${pullRequest[1]}](https://github.com/${upstreamRepository}/pull/${pullRequest[1]}))`;
}

function formatCodyChange(repository, { sha, subject }) {
  return `- ${escapeSubject(subject)} ([${sha.slice(0, 7)}](https://github.com/${repository}/commit/${sha}))`;
}

/**
 * Builds the release body the in-app updater turns into "What's changed".
 * The popover keeps the last few list items of a release and shows them
 * newest first, so changes are listed oldest first and Cody's own changes
 * go last, where they stay visible even when an upstream sync brings dozens.
 */
export function formatCodyReleaseNotes({
  repository,
  tag,
  previousTag,
  upstreamChanges,
  codyChanges,
  buildUrl,
}) {
  const lines = [];
  if (previousTag === null) {
    lines.push("First Cody nightly with release notes.");
  } else if (upstreamChanges.length === 0 && codyChanges.length === 0) {
    lines.push(`No code changes since ${previousTag}.`);
  } else {
    lines.push("## What's Changed");
    const listedUpstream = upstreamChanges.slice(
      Math.max(0, upstreamChanges.length + codyChanges.length - maxListedChanges),
    );
    if (upstreamChanges.length > 0) {
      lines.push("", "### From T3 Code");
      const omitted = upstreamChanges.length - listedUpstream.length;
      if (omitted > 0) lines.push(`- ${omitted} earlier T3 Code changes, see the full changelog`);
      lines.push(...listedUpstream.map(formatUpstreamChange));
    }
    if (codyChanges.length > 0) {
      lines.push(
        "",
        "### Cody",
        ...codyChanges.map((change) => formatCodyChange(repository, change)),
      );
    }
  }
  // The updater stops reading at this heading, so nothing below reaches the popover.
  lines.push("", "### Full changelog", "");
  if (previousTag !== null) {
    lines.push(`https://github.com/${repository}/compare/${previousTag}...${tag}`, "");
  }
  lines.push(
    "Windows builds are unsigned and macOS builds are not notarized. " +
      "Older manual-install previews need one manual upgrade to reach the in-app updater.",
    "",
    `Build: ${buildUrl}`,
  );
  return `${lines.join("\n")}\n`;
}

function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

function listCommits(...revisions) {
  const output = run("git", ["log", "--reverse", "--no-merges", "--format=%H%x1f%s", ...revisions]);
  return output === ""
    ? []
    : output.split("\n").map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha, subject };
      });
}

/**
 * Usage: node scripts/cody-release-notes.mjs <repository> <tag> <commit> <build-url>
 *
 * Needs `gh` authenticated for the repository. Fetches just the commit graph it
 * needs, so it works from the shallow publish checkout.
 */
function main([repository, tag, commit, buildUrl]) {
  if (!repository || !tag || !commit || !buildUrl) {
    throw new Error(
      "Usage: node scripts/cody-release-notes.mjs <repository> <tag> <commit> <build-url>",
    );
  }
  // Only published releases count. The fork also carries upstream's bare tags.
  const releaseTags = run("gh", [
    "release",
    "list",
    "--repo",
    repository,
    "--exclude-drafts",
    "--limit",
    "200",
    "--json",
    "tagName",
    "--jq",
    ".[].tagName",
  ]).split("\n");
  const previousTag = resolvePreviousNightlyTag(tag, releaseTags);
  const upstreamChanges = [];
  const codyChanges = [];
  if (previousTag !== null) {
    // Commit graphs only: git log needs no trees or file contents.
    const fetch = ["fetch", "--quiet", "--no-tags", "--filter=tree:0"];
    const unshallow = run("git", ["rev-parse", "--is-shallow-repository"]) === "true";
    run("git", [
      ...fetch,
      ...(unshallow ? ["--unshallow"] : []),
      `https://github.com/${repository}.git`,
      commit,
      `+refs/tags/${previousTag}:refs/tags/${previousTag}`,
    ]);
    run("git", [
      ...fetch,
      `https://github.com/${upstreamRepository}.git`,
      "+refs/heads/main:refs/remotes/upstream/main",
    ]);
    const range = `refs/tags/${previousTag}..${commit}`;
    const codyShas = new Set(
      listCommits(range, "^refs/remotes/upstream/main").map((change) => change.sha),
    );
    for (const change of listCommits(range)) {
      (codyShas.has(change.sha) ? codyChanges : upstreamChanges).push(change);
    }
  }
  process.stdout.write(
    formatCodyReleaseNotes({
      repository,
      tag,
      previousTag,
      upstreamChanges,
      codyChanges,
      buildUrl,
    }),
  );
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2));
}
