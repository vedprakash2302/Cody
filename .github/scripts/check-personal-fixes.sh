#!/usr/bin/env bash
set -euo pipefail

# Keep the regression suites for carried fixes here until upstream owns them.
vp test run \
  apps/server/src/git/remoteUrls.test.ts \
  apps/server/src/project/RepositoryIdentityResolver.test.ts \
  apps/server/src/vcs/GitVcsDriver.test.ts \
  apps/server/src/vcs/VcsProcess.test.ts \
  apps/web/src/lib/previewAnnotation.test.ts
