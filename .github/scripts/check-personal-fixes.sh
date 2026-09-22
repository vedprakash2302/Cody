#!/usr/bin/env bash
set -euo pipefail

# Share the regression suites with the cross-platform project actions.
node scripts/cody.mjs check
