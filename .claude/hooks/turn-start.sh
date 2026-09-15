#!/usr/bin/env bash
# UserPromptSubmit hook: record where HEAD was when the user's message arrived, so the
# feature gate can diff against it even if the turn commits before ending.
set -u
cd "$(dirname "$0")/../.." || exit 0
mkdir -p out
git rev-parse HEAD > out/.turn-base 2>/dev/null || echo "" > out/.turn-base
exit 0
