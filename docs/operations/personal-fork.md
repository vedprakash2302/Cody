# Personal fork maintenance

`vedprakash2302/Cody` uses `personal/main` as its integration and default branch. The upstream repository is `pingdotgg/t3code`. Keep contribution branches based on upstream `main`, so each upstream PR contains only its own fix.

Agents should follow [the personal-fork skill](../../.agents/skills/personal-fork/SKILL.md) for feature development, publishing, and manual upstream reconciliation. It covers deciding when upstream supersedes a personal fix, including overlaps that Git merges without a conflict.

## Sync upstream

### Project actions

In a Cody project thread, use the action menu above the composer:

- **Sync Cody** updates the local `personal/main` checkout from the fork and upstream, installs locked dependencies, and runs regression checks. It does not push or update installed apps. Stop Cody Dev before syncing, then restart it after the checks pass.
- **Start Cody Dev** starts the integrated web client and backend with `<integration-checkout>/.t3` as its data directory. Open the printed localhost pairing URL in Windows Chrome when the server runs in WSL. Stop the action's terminal process before starting it again.
- **Build Cody Release** checks the integration checkout, pushes it to the fork, and requests the multi-platform installer workflow. Follow the printed Actions link for results. Install downloads manually after the build succeeds.

For feature testing, use **Refresh Preview Threads** in the feature checkout while its preview backend is stopped. It snapshots `~/.t3/userdata/state.sqlite` read-only into that checkout's `.t3`, retaining conversations and PR links. Set `CODY_SOURCE_HOME` to use another installed T3 home. Refresh backs up the previous preview database, clears copied authentication and provider sessions, and requires pairing again. It does not copy attachments or T3 Connect credentials. Agents in the preview still operate on the real repository paths, so use a test worktree before asking them to edit files.

**Preview This Checkout** runs the current feature checkout's web UI and modified backend. On its first run it copies thread history automatically; subsequent runs retain preview work. Refresh Preview Threads explicitly replaces that history with a new snapshot. This differs from Start Cody Dev, which always runs the integration checkout.

**Build & Open Cody Preview** builds the current checkout, including uncommitted source changes. On macOS or native Windows, it runs the native desktop development task with isolated `.t3` state. From WSL, first run Preview This Checkout. The action stages source under `%LOCALAPPDATA%\CodyPreview`, installs private Windows Node, Vite+, and pnpm tools, builds Windows Electron, and launches it with a separate profile. Add the WSL preview backend using its printed pairing URL once. This tests native Windows UI and the modified WSL backend without replacing the installed application. Windows dependency storage is separate from Linux `node_modules`. Close the Windows preview before building another checkout; the staging directory is shared.

The actions locate an existing `personal/main` worktree and discover remotes by GitHub URL. They do not switch a feature checkout. If a fresh upstream feature branch lacks these fork-only actions, invoke them from a thread in the Cody integration checkout. A missing integration worktree or dirty working tree produces instructions instead of changing branches or stashing work.

Sync leaves merge conflicts in the integration checkout for an agent to resolve using the fork skill. Failed checks leave the update local and do not publish a build. The regression file list is maintained in `scripts/personal-fixes.json`, shared by project actions and CI. GitHub authentication is required for Build Cody Release. Node 24, Git, and Vite+ are required for all actions.

The **Personal upstream sync** workflow runs daily at 06:23 UTC, subject to GitHub's scheduling delays. It merges upstream `main`, runs the regression suites in `.github/scripts/check-personal-fixes.sh`, and pushes only if those checks pass. Conflicts or failed checks leave the remote branch unchanged and fail the workflow. The workflow can also be dispatched manually:

```sh
gh workflow run personal-sync.yml --repo vedprakash2302/Cody --ref personal/main
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
gh workflow run personal-build.yml --repo vedprakash2302/Cody --ref personal/main
```

The workflow checks the integrated fixes and publishes a prerelease after all platform jobs succeed. Choose the installer for the host:

| Host               | Desktop download     | Embedded WSL runtime |
| ------------------ | -------------------- | -------------------- |
| Devbox and WorkWSL | Windows x64 `.exe`   | Linux x64            |
| Surface            | Windows ARM64 `.exe` | Linux ARM64          |
| Apple Silicon Mac  | ARM64 `.dmg`         | Not needed           |

It also builds Linux x64 and ARM64 AppImages and standalone Linux and macOS ARM64 server archives. Each Windows installer embeds the matching Linux archive from the same build. Checksums accompany the downloads.

Versions use `-nightly.YYYYMMDD.RUN` and tags use `v<version>`. The workflow embeds the `vedprakash2302/Cody` GitHub feed and publishes updater manifests and blockmaps. Windows x64 and ARM64 manifests are merged before publication so the updater downloads the correct installer. Keep the desktop update channel set to Nightly to receive these prereleases.

Older `-preview` installations have no embedded feed and need one manual upgrade to an update-enabled build. After that, use the sidebar update control to check, download, and install Cody releases. Installing an update preserves the Cody profile, data, and client pairings. Windows may show an unsigned-app warning. macOS builds are not notarized; reliable macOS in-app installation requires signing credentials, so keep manual DMG installation available. Native mobile builds are not part of this workflow; keep using the official iOS app.

The desktop app and bundled web client display the name Cody. Cody installs alongside official T3 with its own application ID, `cody://` URL scheme, and Electron profile. Desktop data lives in `~/.cody/userdata`, including in WSL. The default backend port is 4773. Existing T3 data stays in `~/.t3`; Cody starts with a separate environment identity and needs its own client pairing. Use different Tailscale Serve ports for the two apps, such as 443 for T3 and 8443 for Cody. Keep using the official T3 iOS app.

Standalone server archives still use the `t3` CLI. Pass `--base-dir ~/.cody` when starting a standalone Cody server to keep its state separate from official T3. Do not run it against a directory already used by a desktop backend.

Updating source or installing a client does not update independent remote servers. Install the matching server build on each environment that needs the fixes. Back up the environment's data before replacing a runtime; returning to an older executable does not undo database migrations.

The build uses the public T3 Connect settings from `.env.example`. It needs no upstream signing or deployment secrets. Upstream release and deployment workflows are disabled in this fork's Actions settings; only the personal workflows and their reusable desktop packaging workflow need to be enabled.

GitHub can disable scheduled workflows after extended inactivity in a public repository. If daily sync stops, check the workflow's Actions page and re-enable it.
