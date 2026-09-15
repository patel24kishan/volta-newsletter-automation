#!/usr/bin/env bash
# Feature gate: runs when a Claude Code turn ends (Stop hook).
# - Skips if no file under src/ or test/ changed since the last commit.
# - Runs typecheck and tests. If anything fails, blocks the stop (exit 2)
#   so Claude keeps fixing. If everything passes, surfaces the results to
#   the user and lets the turn end.
set -u

cd "$(dirname "$0")/../.." || exit 0

# Avoid infinite loops: if this hook already blocked once this turn, allow stop.
input="$(cat)"
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# Nothing to gate before the project has a package.json.
[ -f package.json ] || exit 0

# Only gate when source or tests changed (tracked modifications or untracked files).
changed="$( { git diff --name-only HEAD -- src test 2>/dev/null; git ls-files --others --exclude-standard -- src test 2>/dev/null; } | sort -u )"
if [ -z "$changed" ]; then
  exit 0
fi

mkdir -p out
log="out/gate.log"
: > "$log"

status=0
{
  echo "== typecheck =="
  npm run --silent typecheck 2>&1 || status=1
  echo
  echo "== tests =="
  npm test --silent 2>&1 || status=1
} >> "$log"

if [ "$status" -ne 0 ]; then
  {
    echo "FEATURE GATE FAILED. Fix before ending the turn."
    echo "Changed files:"
    printf '  %s\n' $changed
    echo
    tail -n 60 "$log"
  } >&2
  exit 2
fi

summary="$(grep -E 'Test Files|Tests ' "$log" | tr -s ' ' | paste -sd ';' -)"
[ -n "$summary" ] || summary="typecheck and tests passed"

esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }
files="$(printf '%s' "$changed" | tr '\n' ' ')"

printf '{"systemMessage":"FEATURE GATE PASSED. %s. Changed: %s. Full log: out/gate.log. Report these results to the user and wait for go before the next feature."}\n' \
  "$(esc "$summary")" "$(esc "$files")"
exit 0
