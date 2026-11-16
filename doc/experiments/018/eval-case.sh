#!/bin/bash
# Re-run only the evaluation of one case: its acceptance tests on base, landed, fixed.
# Usage: eval-case.sh <id> <origin merge> <fix merge>
set -u
ID=$1 MERGE=$2 FIX=$3
E=$HOME/lingtai-018
REPO=/Users/steven/workspace/lingtai
W=$E/$ID
exec >>"$E/$ID.log" 2>&1
BASE=$(git -C "$REPO" rev-parse "$MERGE^1")
FILES=$(cd "$W" && git status --porcelain --untracked-files=all | awk '$1=="??"{print $2}' | grep -E 'acceptance-[^/]*\.test\.tsx?$' | tr '\n' ' ')
echo "eval files: $FILES"
mkdir -p "$E/$ID-out"; cp "$W/ACCEPTANCE.md" "$E/$ID-out/" 2>/dev/null
for f in $FILES; do cp "$W/$f" "$E/$ID-out/$(basename "$f").txt"; done
run_at() {
  git -C "$W" checkout -q "$2" || { echo "$1: checkout failed"; return; }
  (cd "$W" && pnpm install --frozen-lockfile >/dev/null 2>&1) || echo "$1: install failed"
  (cd "$W" && npx vitest run $FILES >"$E/$ID-$1.txt" 2>&1); echo "$1 vitest rc=$?"
  grep -E "Test Files|Tests  " "$E/$ID-$1.txt" | sed "s/^/$1 /"
}
run_at base "$BASE"; run_at landed "$MERGE"; run_at fixed "$FIX"
echo "== eval done"
