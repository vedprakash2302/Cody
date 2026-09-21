# Personal fork maintenance

`vedprakash2302/t3code` uses `personal/main` as its integration and default branch. The upstream repository is `pingdotgg/t3code`. Keep contribution branches based on upstream `main`, so each upstream PR contains only its own fix.

Agents should follow [the personal-fork skill](../../.agents/skills/personal-fork/SKILL.md) for feature development, publishing, and manual upstream reconciliation. It covers deciding when upstream supersedes a personal fix, including overlaps that Git merges without a conflict.

## Sync upstream

The **Personal upstream sync** workflow runs daily at 06:23 UTC, subject to GitHub's scheduling delays. It merges upstream `main`, runs the regression suites in `.github/scripts/check-personal-fixes.sh`, and pushes only if those checks pass. Conflicts or failed checks leave the remote branch unchanged and fail the workflow. The workflow can also be dispatched manually:

```sh
gh workflow run personal-sync.yml --repo vedprakash2302/t3code --ref personal/main
```

Resolve a conflict in the personal worktree with the existing remote names:

```sh
git fetch personal
git fetch origin main
git switch personal/main
git merge --ff-only personal/personal/main
git merge origin/main
# Resolve conflicts, then stage and commit the resolution.
bash .github/scripts/check-personal-fixes.sh
git push personal HEAD:refs/heads/personal/main
```

Here `origin` is upstream and `personal` is the fork. On GitHub runners, `origin` is the fork and `upstream` is the upstream repository. Avoid GitHub's discard-changes sync option on `personal/main`; it would remove personal fixes.

## Add a fix

Commit and test a focused fix on its own branch, submit that branch upstream when ready, then merge it into `personal/main`. Add its regression suite to `.github/scripts/check-personal-fixes.sh` when needed. Push the integration branch to `personal`, not `origin`.

When upstream incorporates a fix, merge upstream normally. Keep upstream's final implementation when resolving differences. Do not revert the personal fix just because upstream squashed it into a different commit.

## Build and install

Dispatch **Personal candidate build** on `personal/main`:

```sh
gh workflow run personal-build.yml --repo vedprakash2302/t3code --ref personal/main
```

The workflow checks the integrated fixes and publishes a prerelease in the fork after both platform jobs succeed. It builds an unsigned Windows x64 installer, a Linux x64 AppImage, and a standalone Linux x64 server archive. The Windows installer embeds that same Linux server archive for its WSL backend. Checksums accompany the downloads.

Versions use `-preview.YYYYMMDD.RUN`, which T3's packaging treats as manual-install builds with no automatic update feed. Install a candidate when ready, after active turns finish. Windows may show an unsigned-app warning. macOS and native mobile builds are not part of this workflow.

Updating source or installing a client does not update independent remote servers. Install the matching server build on each environment that needs the fixes. Back up the environment's data before replacing a runtime; returning to an older executable does not undo database migrations.

The build uses the public T3 Connect settings from `.env.example`. It needs no upstream signing or deployment secrets. Upstream release and deployment workflows are disabled in this fork's Actions settings; only the personal workflows and their reusable desktop packaging workflow need to be enabled.

GitHub can disable scheduled workflows after extended inactivity in a public repository. If daily sync stops, check the workflow's Actions page and re-enable it.
