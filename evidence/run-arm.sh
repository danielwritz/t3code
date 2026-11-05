#!/usr/bin/env bash
# Runs one arm of trials on the SEPARATE dev T3 (home <root>/t3home, root in tools/env.sh; ports
# 13773 and 5733). Never the user's T3 (port 3773).
#   bash tools/trials/run-arm.sh before 10   # guidance file from origin/main (no fix line)
#   bash tools/trials/run-arm.sh after 10    # guidance file from the PR branch (fix line)
#   bash tools/trials/run-arm.sh before 5 1 case   # optional: first trial number, variant (plan, act, case)
# 1. sets the guidance file for the arm, 2. starts one stack, 3. runs N plan trials one after
# another (trial.mjs stores the file's hash and the server start time in every row), 4. stops the
# stack, 5. puts the branch file back. Rows go to the "results" file in trials.config.json.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/env.sh"
ARM="${1:?before|after}"; N="${2:?count}"; FIRST="${3:-1}"; VARIANT="${4:-plan}"
P=/d/t3code-trial/home/projects/t3code-feature-allow-forking
CLONE="$AFP/t3code"
F=packages/provider-core/src/server/orchestrationInstructions.ts
LOG="$AFP/server-demo.log"
if netstat -ano | grep LISTENING | grep -qE ":13773 |:5733 "; then echo "port 13773 or 5733 is in use; stop that stack first"; exit 2; fi
[ -z "$(git -C "$CLONE" status --porcelain -- "$F")" ] || { echo "the guidance file has local changes; restore it first"; exit 2; }
case "$ARM" in
  before) git -C "$CLONE" show "origin/main:$F" > "$CLONE/$F" ;;
  after) ;;
  *) echo "arm must be before or after"; exit 2 ;;
esac
HAS=$(grep -c "To fork a thread" "$CLONE/$F" || true)
echo "arm $ARM: guidance lines with the fix = $HAS"
{ [ "$ARM" = before ] && [ "$HAS" = 0 ]; } || { [ "$ARM" = after ] && [ "$HAS" = 1 ]; } || { git -C "$CLONE" checkout -- "$F"; echo "wrong guidance text for arm $ARM"; exit 2; }

: > "$LOG"
bash "$P/tools/demo/stack-nowatch.sh" "$AFW/t3home" &
STACK=$!
stop() {
  for port in 13773 5733; do
    pid=$(netstat -ano | grep LISTENING | grep ":$port " | awk '{print $5}' | head -1)
    [ -n "$pid" ] && taskkill //PID "$pid" //T //F > /dev/null 2>&1 || true
  done
  kill "$STACK" 2> /dev/null || true
  git -C "$CLONE" checkout -- "$F"
  echo "stack stopped, guidance file restored"
}
trap stop EXIT INT TERM
for i in $(seq 1 120); do grep -q "Listening on" "$LOG" && break; sleep 1; done
grep -q "Listening on" "$LOG" || { echo "server did not start"; exit 1; }
grep -m1 "Listening on" "$LOG"
cd "$P/tools/trials"
for i in $(seq "$FIRST" $((FIRST + N - 1))); do
  node trial.mjs "$ARM" "$i" "$VARIANT" | cut -c1-260
done
