---
name: personal-fork
description: Develop and publish features or fixes for Ved's T3 Code fork, integrate completed branches into personal/main, sync upstream main, resolve overlapping fixes in favor of upstream when it covers the required behavior, and build personal releases. Use when working on the fork's contribution branches, upstream synchronization, or personal release workflow.
---

# Maintain the personal T3 Code fork

Use this skill for `vedprakash2302/Cody`. Upstream is `pingdotgg/t3code`. Read the repository's `AGENTS.md` and `CONTRIBUTING.md` first. This skill does not authorize a commit, push, PR, release, installation, or restart by itself. Follow the user's requested scope and the agent's Git permissions.

## Establish the checkout and task

Inspect `git status --short`, `git worktree list`, `git remote -v`, and the current branch and tracking branch before changing anything. Confirm remote URLs instead of assuming names.

In the existing local checkout, `origin` is upstream and `personal` is the fork. On GitHub Actions runners, `origin` is the fork. The fork's default branch is `personal/main`; it combines upstream code, pending personal fixes, and fork-only workflows. The existing integration worktree is `/home/vedpandey/projects/personal/t3code-personal`, but verify that path before using it.

On Devbox, the clone is `/home/vedpandey/projects/personal/Cody`, `origin` is Cody, and `t3` is upstream. The project actions in `t3.json` discover these roles by URL. Use **Sync Cody** for checked local updates, **Start Cody Dev** for the integration app, and **Build Cody Release** only when the user requests publishing. Regression files are listed in `scripts/personal-fixes.json`.

Separate worktrees are optional for sequential feature work. They help when agents work concurrently. Keep one integration checkout and one dev app for testing combined features; feature branches do not each need an installation. Merging into local `personal/main` is distinct from pushing it or building a release.

For testing the current feature checkout, use `node scripts/cody-preview.mjs dev`, which snapshots existing threads on first run. Refresh with `snapshot` only while the preview backend is stopped. `native` opens a native development app; from WSL it stages and builds Windows Electron separately and connects it to the running WSL preview. It requires Preview This Checkout first. These commands never point a second server at the installed app's database. The snapshot clears auth and provider sessions, but repository paths remain real, so do not run editing prompts against a production worktree accidentally. See the fork runbook for pairing and platform setup.

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

Fork-only work such as Cody branding and personal automation starts from a current, upstream-synced `personal/main` on a separate `personal/` branch. Ved wants every Cody change to take the available upstream changes too, not leave them for a later release. An agent must perform and review that sync before building. Do not add an unattended merge to the release command or build workflow. The existing daily sync workflow stays. Keep fork-only work out of upstream PRs. Cody uses its own application ID, `cody://` URL scheme, Electron profile, and `~/.cody` desktop data directory so it can run alongside official T3. Its WSL backend also uses `~/.cody`. Preserve each app's existing data and credentials during updates. T3 Connect and the official App Store app keep their upstream names.

Cody branding is monochrome: the app icon is the black terminal pup, a prompt window with pointed spitz ears showing `>_`, on white. The mark uses straight lines only, no curves. The header uses the same SVG geometry, black in light mode and white in dark mode. Do not introduce teal or other accent colors into the logo.

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

The goal is functional parity: after the sync, Ved can still do everything Cody's patches let him do before it. Before merging, list the fork-only commits (`git log --no-merges t3/main..HEAD`) and write each capability as one sentence, such as "Ved can sign in to Microsoft work pages in browser tabs on a WSL backend". Note the code that delivers it and the tests that cover it. Then check every incoming upstream commit that touches that code, including commits that merge without a conflict. A clean merge can still break a capability. When upstream moved browser tabs from the desktop app to the server (#15328), the merge was clean and the Windows work-account sign-in tests still passed, but nothing called that code anymore.

For each overlap:

- If upstream covers the fix, keep upstream's implementation and remove redundant personal code. Preserve useful regression coverage that upstream lacks.
- If upstream covers only part of it, keep upstream's implementation plus the smallest remaining personal change. Describe which behavior still needs the patch.
- If upstream replaced the underlying design, rebuild the capability on the new design rather than restoring old abstractions. Trace from where Ved triggers it, such as a setting, button, provider, or launch flag, to the code that does the work, and confirm the merged code still calls it. Add a regression test that fails if that path stops being called.
- If coverage is uncertain, retain the personal behavior temporarily or ask the user about the specific tradeoff. Do not silently discard a working feature.

Resolve individual conflicting sections. Do not use blanket `-X theirs`, a wholesale checkout of the upstream tree, a hard reset, or GitHub's discard-changes sync on `personal/main`. During an upstream merge, "ours" is the integration branch and "theirs" is upstream, but taking an entire upstream file can erase unrelated personal changes.

Upstream commonly squash-merges PRs, so commit ancestry does not establish whether a fix is present. Inspect patch and behavior equivalence. Do not revert the original personal commit after a squash merge; that can remove the now-shared fix. Preserve the existing history and make an explicit cleanup commit when a clean merge leaves duplicate logic.

After reconciliation:

1. Review every resolved file and the final diff against upstream. Confirm the remaining differences are intentional personal changes.
2. Run `.github/scripts/check-personal-fixes.sh` and focused checks for the affected code. Adapt obsolete test paths to upstream's replacement tests instead of dropping coverage blindly.
3. Commit the checked merge and any necessary cleanup, then push only to the fork's `personal/main`. Do not force-push.
4. Report to Ved in plain language, keeping the report in the thread or the owning issue rather than a committed checklist. Cover the patches first: which capabilities now come from upstream, which were rebuilt on upstream's new code and how you confirmed they still work, which patches remain, and anything he must test by hand. Then explain every upstream change since the last Cody release, including commits the daily workflow merged unreviewed. Group them by what he will notice. For each one, say what used to happen and what happens now, which machine needs the update (the server that runs threads, the app he looks at, or both), and anything that breaks until a later fix or needs him to act. Read the upstream PR description when a title is unclear. Skip internal refactors, tests, and CI. End with the upstream commit incorporated and the checks run.

### Sync working notes

These come from earlier syncs. Each run starts in a fresh thread, so anything learned during a sync that the next one needs belongs here.

- On Devbox, the active `gh` account cannot reach Cody. Run `export GH_TOKEN="$(gh auth token --user vedprakash2302)"` and use `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch|push ...`. `gh pr view` can hang; read a PR with `timeout 100 gh api repos/pingdotgg/t3code/pulls/<n> -q .body`.
- Find the overlap before merging. List files changed on both sides since the merge base (`git diff --name-only $(git merge-base HEAD t3/main) <side>`, then `comm -12`), and for each upstream commit print which of those files it touches. That list drives the capability review.
- Resolve conflicts with `node scripts/resolve-conflict-hunks.mjs <file> <side>[,<side>...]`, one choice per hunk (`ours`, `theirs`, `both`, `theirs+ours`). Edit by hand when neither side is right. When a patch is superseded, take upstream's hunks, delete the patch's non-conflicting leftovers, and confirm `git diff t3/main -- <file>` is empty or intentional.
- Check that Cody's changes survived. For each overlapping file, compare the lines Cody added (`git diff <merge-base> HEAD -- <file>`, `+` lines) with the lines still differing from upstream after resolution (`git diff --cached t3/main -- <file>`). Every missing line must be a deliberate supersession.
- Frequent conflicts: `ChatView.tsx`, `BranchPicker.tsx`, `BranchToolbar.logic.ts`, `ScheduledTasksSettings.tsx`, `ConnectionsSettings(.logic).ts`, `ServerBrowser.ts` and its test, `GitVcsDriverCore.ts`, mobile `new-task-flow-provider.tsx` and `new-task-context-presentation.ts`, `desktopUpdate.logic.ts`, `usageLimits.ts` in provider-opencode, and `scripts/build-desktop-artifact.ts`.
- Upstream tests that hard-code T3 branding need Cody's values: scheme `cody`, Linux desktop id `com.vedpandey.cody.desktop`, name `Cody`, userData `cody-v2`/`cody-dev`, manifest name "Cody". Cody user-facing strings, including new macOS permission prompts, say Cody.
- Muse replay fixtures (`apps/server/src/orchestration-v2/testkit/fixtures/*/muse_transcript.ndjson`) contain the injected instructions. Keep Cody's `<final_answer>` block right after `</runtime_info>` in every `turn/start` frame when upstream rewrites the surrounding text.
- Desktop startup tests mock `DesktopUpdates.subscribe`. Cody's auto-install listener subscribes during startup, so a mock that never returns hangs the test.
- Tests are not typechecked. After an upstream rename, a fork test can pass on `undefined === undefined`. Run `npx tsc --noEmit` per package and read failing assertions instead of loosening them.
- Package `node_modules/.bin/tsc` shims in a reused worktree can still point at the removed `typescript@7` package, so `npx tsc` fails with "Cannot find module" and prints no `error TS` lines. Check that the log is empty, or run the root shim from each package: `"$ROOT/node_modules/.bin/tsc" --noEmit`.
- Install with `CI=true vp install --frozen-lockfile`. If Electron tests report "Electron failed to install correctly", run `(cd node_modules/.pnpm/electron@*/node_modules/electron && node install.js)`.
- Mobile code uses the React Compiler. Re-express Cody logic without `useMemo` or `useCallback`.
- Upstream prunes tests in bulk (#22557 and its second passes). When it deletes a test Cody only rebranded, drop Cody's copy. Keep fork-only tests, and keep a rebranded test only when it is the last check of a Cody identity value. Pruning also removes the imports and helpers those tests used. The seven typechecked packages report the gaps, but `scripts/`, `source-control-*`, and `.mjs` tests only fail at run time with `ReferenceError`, so run the personal checks before trusting a merge.
- Upstream packages Windows on Linux runners (#22584). Cody keeps Windows runners in `personal-build.yml` because the work-account sign-in helper needs MSVC, and `build-windows-sso.mjs` fails packaging on any other host. `release-desktop.yml` builds the resource monitor with plain cargo on a Windows host instead of cargo-xwin.
- Playwright has no Chromium for this WSL host's Ubuntu, so web browser tests only run in CI.
- Upstream split `ChatView.tsx` into hooks (#23062 and its neighbours), so its conflicts show as one huge hunk where upstream deleted the moved code. Take upstream's hunks and re-add Cody's lines where the code went: `/side` is checked in ChatView's wrapper around `onSend` (`sideChatQuestionForSend`), the side chat shortcut sits in ChatView's `useChatShortcuts` commands, the `/side` menu item in `useComposerMenuItems`, and the worktree base ref flows through `useComposerSend` into `planComposerTurn` (a required `worktreeBaseRef`) and `useMultipleModelSend`. Side chat props reach the panel through `ChatRightPanel`.
- Every thread list in client-runtime's `threadShell.ts` must skip `codySideChat` shells. When upstream adds a list atom (such as `quietThreadShellsAtom`, which the sidebar reads), add the filter and extend `codySideChats.test.ts`.
- Upstream's `t3code/no-em-dash-copy` lint (#23799) rejects em dashes in strings and JSX text under `apps/*/src` and `packages/*/src`, tests excluded. Check Cody's added copy with `git diff t3/main -- <files> | grep '^+' | grep '—'`.
- The side chat panel (`apps/web/src/cody/SideChatPanel.tsx`) renders upstream's `MessagesTimeline` with the same props ChatView passes. When upstream changes a `MessagesTimeline` prop (#23752 turned `awaitingUser` into `"approval" | "input" | null` and added screen reader announcements), update the panel to match. The panel passes `announceTurnStatus={false}` because those announcements name no thread. The web typecheck catches a changed prop shape, not a newly added optional prop.
- Upstream splits and renames test files. When a file in `scripts/personal-fixes.json` disappears, point the entry at the file that now holds those tests (the Muse replays moved to `MuseReplayFixtures.integration.test.ts`).
- Upstream caps comment blocks at four lines (#21514, lint rule `t3code/no-low-value-comments`), and most comment-only conflicts come from that rewrite. Keep Cody's code, take upstream's shortened comment, and cut Cody's own comments in the hunk to four lines or fewer.
- Web completion alerts go through `createThreadNotificationGate` (#24760). Side chats stay silent on completion through `threadCompletionIsQuiet` in `ThreadNotificationCoordinator.logic.ts`, covered by `apps/web/src/cody/sideChatNotifications.test.ts`.
- `EnvironmentOrchestrationShellSnapshotQuery` in `environmentHttp.ts` is one struct holding upstream's `omitIdleSubagents` and Cody's `codyFeatures`. When upstream adds a field, a clean merge can leave two declarations, which breaks every package's typecheck. `shellSnapshotHttp.ts` sends both params.
- Shells can leave out older settled threads (#24723); clients read them back through `getThreadFamily`, `getOlderSettledThreads`, and `searchThreads` rows. Each of those paths in `ws.ts` must pass rows through the side chat visibility, and the `ws.test.ts` side chat test fails when one stops. When upstream adds another way to read thread rows, filter it too. A client that holds a thread only through such a read needs `useThreadFamily` to keep it, as the scheduled task "Post runs to" labels do.
- Side chat context reaches the agent through two calls in upstream server code: `codyProviderText` in `ProviderTurnStartService.ts`, where the turn's `userText` is built (after the `/goal` check; upstream builds it before the provider thread loads so the handoff budget can measure it), and `codySteerText` in `ProviderTurnControlService.steer`, whose text replaces the steer message's and whose `record` runs only after `steerTurn` succeeds. When upstream reshapes either function, take upstream's code and put the call back where the provider text is built. `apps/server/src/cody/sideChatTurnWiring.test.ts` runs both services and fails if either call goes missing. On the web side, "Attach to thread" also relies on `citeLabel` passing from `MessagesTimeline` to `AssistantSelectionToolbar` ("Quote in thread"), on `ThreadContextChip` showing a side chat chip's own label instead of its live title ("Title · N new"), and on the `side-chat:attach` item in `RightPanelTabs`.
- Upstream renamed the worktree base key from `gh-merge-base` to `t3-merge-base` and still reads the old key. Fork tests that read the key after `createWorktree` use the new name.
- `AgentContextBudget.test.ts` (#25785) requires `apps/server/src/provider/agentContextBudget.json` to equal the measured instruction sizes. Cody's `<final_answer>` block adds 371 bytes to the Claude and Codex values, so keep Cody's numbers and re-measure with that test whenever upstream changes its instructions.
- Browser settings live on `/settings/browser` (`BrowserSettingsPanel` in `IntegrationsSettings.tsx`); `/settings/integrations` only redirects. The Windows work-account sign-in row sits in its Browsing section, and its search item must point at `/settings/browser` (covered in `settingsSearch.test.ts`).
- Mobile queued-message delivery moved from `use-thread-outbox-drain.ts` to `threadOutboxDelivery.ts` (#25678). Both its restore path and its `buildProjectThreadStartTurnInput` call carry `worktreeBaseRef`. The new-task branch list goes through `newTaskBranchChoices`, which keeps remote branches for worktrees.
- Pending approvals render on their timeline row (#26255), not in the composer. `SideChatPanel` passes its `requests` approvals to `MessagesTimeline`; `apps/web/src/cody/sideChatApprovals.test.ts` fails if that stops.
- Upstream's startup recovery window (`DesktopStartupRecovery.ts`, #25903) hard-codes "T3 Code" and T3's releases page. Cody uses `environment.branding.baseName` and the Cody releases URL there; recheck after upstream edits it.
- Dead-code sweeps such as #26238 delete RPCs and props Cody filtered or extended (`subscribeArchivedShell`, `onRollbackCheckpoint`). Drop Cody's matching filter or prop instead of restoring upstream's code. Helpers Cody imports can move packages (`threadContextRecord` now lives in `@t3tools/shared/composerContextReferences`).
- Upstream's usage fallback (#26164, #26234) decides which usage windows block a model in `exhaustedUsageWindow` (`packages/shared/src/usageLimits.ts`). Cody's OpenCode driver also reports GitHub Copilot quotas as `copilot_*` windows, so the `opencode` case limits them to `github-copilot` models and ignores `copilot_completions`. `usageLimits.test.ts` covers it; recheck when upstream edits that switch.
- Question answer helpers live in `@t3tools/client-runtime/state/pending-user-input` (#26167), and `setPendingUserInputCustomAnswer` takes `(question, draft, text)`. The side chat's question card decides Next and Submit through `planSideChatAdvance` (`apps/web/src/cody/sideChatAnswers.ts`), which keeps upstream's rule that an unanswered question doesn't advance.
- The thread details card shows only the items a user picks (#26904). `SideChatsDetailsSection` sits after Lineage and is always shown in full density, because it is not one of upstream's item ids.
- The side chat RPC test in `ws.test.ts` and the `ThreadManagementService` mock in `SideChatService.test.ts` list services and methods by hand. When upstream adds a service to `layerWsRpc` or a method to thread management, the server typecheck fails there; add a `Layer.mock` or `unused` entry.
- Cody's auto-install IPC (`getAutoInstallUpdates`, `setAutoInstallUpdates`) sits beside upstream's `setUpdateChannel(channel, minimumVersion)` in `preload.ts` and `ipc.ts`. Upstream's `desktopUpdateChannelOf` (`@t3tools/shared/cliRelease`) replaced `resolveDefaultDesktopUpdateChannel`.
- After an Electron version bump, the first personal check can fail with "File exists (os error 17)" while two test workers download Electron at once. Run Electron's `install.js` as above and rerun.

If resolving the merge would require uncertain product decisions, or a capability can only be confirmed by hand, leave `personal/main` unchanged. Push the checked merge to a new `sync/<date>` branch instead of discarding it, and explain the conflict and the decision or test needed.

## Build and install separately

When the user requests a candidate release, the agent must first fetch current upstream `main`, merge it into `personal/main`, reconcile conflicts and clean semantic overlaps, and run the personal regression checks. Ved expects every Cody change and release to include upstream changes available at that time. Do not delegate this pre-build merge to `node scripts/cody.mjs release` or the build workflow. The daily **Personal upstream sync** may have already merged clean changes, but the agent still fetches and reconciles any newer upstream commits before building, applying the rules in [Sync upstream and retire superseded code](#sync-upstream-and-retire-superseded-code).

After pushing the checked combined branch:

```sh
gh workflow run personal-build.yml --repo vedprakash2302/Cody --ref personal/main
```

Wait for the build result and verify the release assets before claiming a release is available. The workflow produces Windows x64 for Devbox and WorkWSL, Windows ARM64 for Surface, and macOS ARM64 for the Apple Silicon Mac. Each Windows installer must embed its matching Linux architecture from the same build. Linux x64 and ARM64 AppImages and standalone Linux/macOS server archives are also published. Cody releases use nightly versions, SemVer tags, and the fork's GitHub update feed. Publish the merged Windows manifests and the macOS/Linux manifests with the installers and blockmaps. Old preview installations need one manual upgrade to acquire the feed. Windows builds are unsigned and macOS builds are not notarized.

GitHub's macOS arm64 runners sometimes go unavailable, and the job is cancelled unstarted after about 15 minutes. Rerun the failed job once. If it fails the same way again, ask Ved before adding `-f skip_mac=true` to the dispatch. That publishes the other platforms and copies the previous release's macOS installers and `nightly-mac.yml` into the new release, so Macs see no update rather than an updater error.

A source push does not update a running app. Installation and restarting environments are separate actions requiring the user's authorization. Preserve the existing T3 home, environment identity, secrets, and client application data to retain pairing. Independently running remote servers need their own runtime update. Keep the official iOS app unless a feature specifically requires a custom native build.

For existing workflow names, troubleshooting, and manual maintenance commands, read [the fork runbook](../../../docs/operations/personal-fork.md).
