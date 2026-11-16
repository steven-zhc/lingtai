#!/bin/bash
# One case of experiment 018: write the acceptance on the origin's base, then run it on base, landed, fixed.
# Usage: run-case.sh <id> <origin issue> <origin merge> <fix merge> <ui|behaviour>
set -u
ID=$1 N=$2 MERGE=$3 FIX=$4 KIND=$5
E=$HOME/lingtai-018
REPO=/Users/steven/workspace/lingtai
W=$E/$ID
LOG=$E/$ID.log
exec >"$LOG" 2>&1
echo "== $ID #$N merge=$MERGE fix=$FIX kind=$KIND $(date -u +%FT%TZ)"
BASE=$(git -C "$REPO" rev-parse "$MERGE^1")
rm -rf "$W"; git clone -q "$REPO" "$W" && git -C "$W" checkout -q "$BASE" || exit 1
# The body as claimed: the claim's own when recorded, else the issue's (unedited since the claim, checked).
if [ -s "$E/$ID-ticket.md" ]; then cp "$E/$ID-ticket.md" "$W/TICKET.md"; else gh issue view "$N" --json title,body --jq '"# \(.title)\n\n\(.body)"' >"$W/TICKET.md"; fi
echo "base $BASE · ticket $(wc -c <"$W/TICKET.md") bytes"
(cd "$W" && pnpm install --frozen-lockfile >/dev/null 2>&1) || echo "install failed on base"
START=$(date +%s)
(cd "$W" && env -u LINGTAI_DATABASE_URL claude -p "$(cat "$E/acceptance-prompt.md")" --model claude-opus-5-5 --output-format json \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(npx vitest:*),Bash(pnpm:*),Bash(git status:*),Bash(git diff:*),Bash(ls:*),Bash(cat:*)" \
  >"$E/$ID-run.json" 2>"$E/$ID-run.err")
echo "agent rc=$? wall=$(( $(date +%s) - START ))s"
python3 -c "import json;d=json.load(open('$E/$ID-run.json'));print('cost',d.get('total_cost_usd'),'turns',d.get('num_turns'))"
FILES=$(cd "$W" && git status --porcelain --untracked-files=all | awk '$1=="??"{print $2}' | grep -E 'acceptance-[0-9]+\.test\.tsx?$' | tr '\n' ' ')
echo "files: $FILES"
mkdir -p "$E/$ID-out"; cp "$W/ACCEPTANCE.md" "$E/$ID-out/" 2>/dev/null
for f in $FILES; do cp "$W/$f" "$E/$ID-out/$(basename "$f").txt"; done
run_at() { # <label> <commit>
  git -C "$W" checkout -q "$2" || { echo "$1: checkout failed"; return; }
  (cd "$W" && pnpm install --frozen-lockfile >/dev/null 2>&1) || echo "$1: install failed"
  (cd "$W" && npx vitest run $FILES >"$E/$ID-$1.txt" 2>&1); echo "$1 vitest rc=$?"
  grep -E "Test Files|Tests  " "$E/$ID-$1.txt" | sed "s/^/$1 /"
}
[ -n "$FILES" ] && { run_at base "$BASE"; run_at landed "$MERGE"; run_at fixed "$FIX"; }
echo "== done $(date -u +%FT%TZ)"
