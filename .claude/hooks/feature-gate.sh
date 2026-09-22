#!/usr/bin/env bash
# Feature gate: runs when a Claude Code turn ends (Stop hook). CLAUDE.md section 3.
#
# Gates when any file under src/ or test/ changed since the turn started: committed during the
# turn (diffed against the commit turn-start.sh recorded), uncommitted, or untracked. Then:
#   1. Unit tests exist: every changed source file is imported by a test file, and when source
#      changed, at least one test file changed too (a feature ships with its own tests).
#   2. Unit tests pass: the tests related to the changed files (vitest related), reported alone.
#   3. Integration coverage: every changed source file is reached by an integration test
#      (test/integration.test.ts, test/run-week.test.ts, test/*.int.test.ts), so the new feature
#      is exercised together with the features built before it.
#   4. Nothing else broke: typecheck, the full suite and lint.
# A failure blocks the stop (exit 2) so Claude keeps fixing, up to MAX_ATTEMPTS times per turn.
# After that it lets the turn end, but tells Claude to report the gate as still failing.
# Exempt from 1 and 3: CLI entrypoints (thin wiring, run by the npm commands) and type-only files.
set -u

cd "$(dirname "$0")/../.." || exit 0
MAX_ATTEMPTS=5

cat > /dev/null   # the hook's JSON input is not needed; attempts are counted in a file instead

[ -f package.json ] || exit 0

base=""
[ -f out/.turn-base ] && base="$(cat out/.turn-base)"
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  committed="$(git diff --name-only "$base" HEAD -- src test 2>/dev/null)"
else
  committed=""
fi
changed="$( { printf '%s\n' "$committed"; git diff --name-only HEAD -- src test 2>/dev/null; git ls-files --others --exclude-standard -- src test 2>/dev/null; } | sed '/^$/d' | sort -u )"
[ -n "$changed" ] || exit 0

mkdir -p out
log="out/gate.log"
attempts_file="out/.gate-attempts"
attempts=$(( $(cat "$attempts_file" 2>/dev/null || echo 0) + 1 ))
echo "$attempts" > "$attempts_file"
: > "$log"

# Source files that count as a feature: existing .ts under src/, minus CLI entrypoints and types.
gated=""
while IFS= read -r f; do
  case "$f" in
    src/cli/*|*/types.ts|*.d.ts) continue ;;
    src/*.ts) [ -f "$f" ] && gated="${gated}${f}
" ;;
  esac
done <<EOF
$changed
EOF
tests_changed="$(printf '%s\n' "$changed" | grep -E '^test/.*\.test\.ts$' | while read -r t; do [ -f "$t" ] && echo "$t"; done)"

status=0
problems=""
add_problem() { status=1; problems="${problems}- $1
"; }

# 1. Unit tests exist.
untested=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  module="${f%.ts}"
  grep -rqE "${module}(\.js|\.ts)?['\"]" test 2>/dev/null || untested="${untested}  ${f}
"
done <<EOF
$gated
EOF
[ -n "$untested" ] && add_problem "UNIT: no test file imports these changed source files; add unit tests for each:
${untested}"
if [ -n "$gated" ] && [ -z "$tests_changed" ]; then
  add_problem "UNIT: source changed this turn but no test file was added or changed; a feature ships with its own tests"
fi

# 2. Unit tests pass (the tests connected to what changed).
unit_summary="none related"
related_targets="$(printf '%s%s\n' "$gated" "$tests_changed" | sed '/^$/d' | tr '\n' ' ')"
if [ -n "$related_targets" ]; then
  {
    echo "== unit: tests related to the changed files =="
    # shellcheck disable=SC2086
    npx vitest related --run $related_targets 2>&1
  } > out/gate-unit.log
  unit_rc=$?
  cat out/gate-unit.log >> "$log"
  unit_summary="$(grep -E 'Test Files|Tests ' out/gate-unit.log | sed 's/\x1b\[[0-9;]*m//g' | tr -s ' ' | paste -sd ';' -)"
  if grep -qE 'Tests .*failed|FAIL ' out/gate-unit.log || [ "$unit_rc" -ne 0 ]; then
    add_problem "UNIT: tests for the changed files fail (${unit_summary:-see out/gate.log})"
  fi
fi

# 3. Integration coverage.
if [ -n "$gated" ]; then
  # shellcheck disable=SC2046
  unreached="$(node .claude/hooks/integration-reach.mjs $(printf '%s' "$gated" | tr '\n' ' ') 2>&1)"
  [ -n "$unreached" ] && add_problem "INTEGRATION: no integration test (test/integration.test.ts, test/run-week.test.ts, test/*.int.test.ts) reaches these changed files; add one that runs them with the existing pipeline:
$(printf '%s\n' "$unreached" | sed 's/^/  /')"
fi

# 4. Nothing else broke.
{
  echo; echo "== typecheck =="
  npm run --silent typecheck 2>&1 || echo "TYPECHECK FAILED"
  echo; echo "== full suite =="
  npm test --silent 2>&1 || echo "FULL SUITE FAILED"
  echo; echo "== lint =="
  npm run --silent lint 2>&1 || echo "LINT FAILED"
} >> "$log"
grep -q "TYPECHECK FAILED" "$log" && add_problem "TYPECHECK fails"
grep -q "FULL SUITE FAILED" "$log" && add_problem "FULL SUITE fails: an earlier feature may be broken"
grep -q "LINT FAILED" "$log" && add_problem "LINT fails"

full_summary="$(sed -n '/== full suite ==/,/== lint ==/p' "$log" | grep -E 'Test Files|Tests ' | sed 's/\x1b\[[0-9;]*m//g' | tr -s ' ' | paste -sd ';' -)"
files="$(printf '%s' "$changed" | tr '\n' ' ')"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

if [ "$status" -ne 0 ]; then
  if [ "$attempts" -lt "$MAX_ATTEMPTS" ]; then
    {
      echo "FEATURE GATE FAILED (attempt ${attempts} of ${MAX_ATTEMPTS}). Fix these, then end the turn again:"
      printf '%s' "$problems"
      echo "Changed files:"
      printf '%s\n' "$changed" | sed 's/^/  /'
      echo
      tail -n 60 "$log"
    } >&2
    exit 2
  fi
  printf '{"systemMessage":"FEATURE GATE STILL FAILING after %s attempts. Stopped retrying. Tell the user plainly that the gate is red and what is failing: %s Full log: out/gate.log. Do not report the feature as done."}\n' \
    "$attempts" "$(esc "$problems")"
  exit 0
fi

printf '{"systemMessage":"FEATURE GATE PASSED (attempt %s). Unit tests for the changed files: %s. Integration: every changed source file is reached by an integration test. Full suite: %s. Typecheck and lint clean. Changed: %s. Full log: out/gate.log. Report these results to the user and wait for go before the next feature."}\n' \
  "$attempts" "$(esc "$unit_summary")" "$(esc "$full_summary")" "$(esc "$files")"
exit 0
