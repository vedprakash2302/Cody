---
name: personal-fork
description: Develop and publish features or fixes for Ved's T3 Code fork, integrate completed branches into personal/main, sync upstream main, resolve overlapping fixes in favor of upstream when it covers the required behavior, and build personal releases. Use when working on the fork's contribution branches, upstream synchronization, or personal release workflow.
---

# Maintain the personal T3 Code fork

Use this skill for `vedprakash2302/Cody`. Upstream is `pingdotgg/t3code`. Read the repository's `AGENTS.md` and `CONTRIBUTING.md` first. This skill does not authorize a commit, push, PR, release, installation, or restart by itself. Follow the user's requested scope and the agent's Git permissions.

## Establish the checkout and task

Inspect `git status --short`, `git worktree list`, `git remote -v`, and the current branch and tracking branch before changing anything. Confirm remote URLs instead of assuming names.

In the existing local checkout, `origin` is upstream and `personal` is the fork. On GitHub Actions runners, `origin` is the fork. The fork's default branch is `personal/main`; it combines upstream code, pending personal fixes, and fork-only workflows. The existing integration worktree is `/home/vedpandey/projects/personal/t3code-personal`, but verify that path before using it.

Treat other worktrees as active user or agent work. Do not switch, reset, clean, or merge into them without checking their ownership and status. Use a new worktree for a new feature. Do not import an unfinished branch just because its name sounds relevant.

## Develop an upstream-ready feature

For a substantial feature, check upstream's Ideas discussions and contribution policy before implementation. Upstream currently favors small fixes and may decline unsolicited features. A personal feature can still ship in the fork.

Start from a freshly fetched upstream `main`, not the fork's default branch:

```sh
git fetch origin main
git worktree add -b feat/my-feature ../t3code-my-feature origin/main
```

Run these commands only after verifying the remote names and the parent directory. Use `fix/` for bug fixes. Work in that feature worktree, install with `vp i`, and use isolated development state. Never run a development server against the live T3 home.

Keep one concern per branch. Follow the repository's focused test, typecheck, lint, and client-verification guidance. For UI work, account for web, desktop, and native mobile. For wire changes, inspect `packages/contracts` and the affected clients and adapters.

The App Store iOS client does not acquire new UI from a server update. Preserve existing request and response behavior, use established capability checks for optional features, and test the installed client when compatibility matters. An unchanged protocol number alone is not proof of compatibility. Do not bump or suppress protocol checks just to make a personal feature connect. Breaking changes need an explicit rollout decision and compatible client builds.

When the user authorizes publishing the feature:

1. Inspect status, staged and unstaged diffs, and recent commits. Commit only the intended changes, following the repository's commit style.
2. Push the feature branch to the personal fork. Use the full destination ref when there is any naming ambiguity.
3. Review the complete `origin/main...HEAD` diff. It must not contain the fork's sync workflows, this skill, or unrelated personal patches.
4. If the user requested an upstream PR, create it with base `pingdotgg/t3code:main` and head `vedprakash2302:feat/my-feature`. Use `gh`, include the required evidence, and register the PR with the thread's PR-linking tool immediately.

For example, after the relevant authorization:

```sh
git push -u personal HEAD:refs/heads/feat/my-feature
gh pr create --repo pingdotgg/t3code --base main --head vedprakash2302:feat/my-feature
```

Do not merge `personal/main` into a contribution branch. Update that branch from upstream instead. Prefer a merge for a published branch unless the user explicitly requests a history rewrite.

Fork-only work such as Cody branding and personal automation starts from `personal/main` on a separate `personal/` branch. Keep it out of upstream PRs. Cody retains T3's application ID, URL schemes, CLI command, and data paths so existing installations and pairing remain compatible. T3 Connect and the official App Store app keep their upstream names.

## Integrate completed work

Publishing a feature branch does not put it in personal builds. When the user requests integration, inspect the integration worktree, ensure it is clean, and update it from the fork before merging the completed branch:

```sh
git fetch personal
git switch personal/main
git merge --ff-only refs/remotes/personal/personal/main
git merge --no-ff refs/remotes/personal/feat/my-feature
```

Review what the merge brings in and preserve unrelated fixes. Add meaningful regression suites to `.github/scripts/check-personal-fixes.sh` when needed. Run those checks and any checks required by new conflict resolutions, then push the integration branch explicitly:

```sh
bash .github/scripts/check-personal-fixes.sh
git push personal HEAD:refs/heads/personal/main
```

If the feature is revised after integration, merge the subsequent commits from the same branch. Do not automatically cherry-pick a rebased replacement over its previous implementation; inspect the history and final behavior first.

## Sync upstream and retire superseded code

The daily **Personal upstream sync** workflow performs a normal merge and runs focused regression checks before pushing. It fails on conflicts rather than guessing. It cannot determine whether a cleanly merged personal implementation has become redundant. Do that semantic review during manual syncs too.

Start from a clean, current integration branch. Fetch upstream and record the current commit plus the old common ancestor so the incoming changes and any resolution can be reviewed. Read `git log` and `git diff` for both the incoming upstream changes and the personal changes affecting overlapping behavior. Use upstream PR descriptions, tests, and issues when the intent is unclear.

```sh
git fetch origin main
git fetch personal
git merge --ff-only refs/remotes/personal/personal/main
git merge --no-ff --no-commit origin/main
```

Apply this rule: **prefer upstream's implementation when it includes or supersedes the personal fix and preserves its required behavior.** Matching titles or a closed issue do not establish that. Compare the affected functions and edge cases, then run the personal regression tests against the upstream implementation.

For each overlap:

- If upstream covers the fix, keep upstream's implementation and remove redundant personal code. Preserve useful regression coverage that upstream lacks.
- If upstream covers only part of it, keep upstream's implementation plus the smallest remaining personal change. Describe which behavior still needs the patch.
- If upstream replaced the underlying design, express any still-needed behavior using the new design rather than restoring old abstractions.
- If coverage is uncertain, retain the personal behavior temporarily or ask the user about the specific tradeoff. Do not silently discard a working feature.

Resolve individual conflicting sections. Do not use blanket `-X theirs`, a wholesale checkout of the upstream tree, a hard reset, or GitHub's discard-changes sync on `personal/main`. During an upstream merge, "ours" is the integration branch and "theirs" is upstream, but taking an entire upstream file can erase unrelated personal changes.

Upstream commonly squash-merges PRs, so commit ancestry does not establish whether a fix is present. Inspect patch and behavior equivalence. Do not revert the original personal commit after a squash merge; that can remove the now-shared fix. Preserve the existing history and make an explicit cleanup commit when a clean merge leaves duplicate logic.

After reconciliation:

1. Review every resolved file and the final diff against upstream. Confirm the remaining differences are intentional personal changes.
2. Run `.github/scripts/check-personal-fixes.sh` and focused checks for the affected code. Adapt obsolete test paths to upstream's replacement tests instead of dropping coverage blindly.
3. Commit the checked merge and any necessary cleanup, then push only to the fork's `personal/main`. Do not force-push.
4. Report the upstream commit incorporated, which personal changes upstream superseded, which patches remain, and the checks run. Keep this report in the thread or the owning issue, not a new committed implementation checklist.

If resolving the merge would require uncertain product decisions, leave the remote branch unchanged. Explain the conflict and the decision needed.

## Build and install separately

When the user requests a candidate release:

```sh
gh workflow run personal-build.yml --repo vedprakash2302/Cody --ref personal/main
```

Wait for the build result and verify the release assets before claiming a release is available. The workflow produces Windows x64 for Devbox and WorkWSL, Windows ARM64 for Surface, and macOS ARM64 for the Apple Silicon Mac. Each Windows installer must embed its matching Linux architecture from the same build. Linux x64 and ARM64 AppImages and standalone Linux/macOS server archives are also published. Preview versions have no automatic desktop update feed. Windows builds are unsigned and macOS builds are not notarized.

A source push does not update a running app. Installation and restarting environments are separate actions requiring the user's authorization. Preserve the existing T3 home, environment identity, secrets, and client application data to retain pairing. Independently running remote servers need their own runtime update. Keep the official iOS app unless a feature specifically requires a custom native build.

For existing workflow names, troubleshooting, and manual maintenance commands, read [the fork runbook](../../../docs/operations/personal-fork.md).
