#!/usr/bin/env bash
# Clean-environment smoke suite. Runs a context command exactly as an
# installed command would: empty HOME, empty cache, tiny fresh repo. Verifies
# the invariants a source-level test cannot: version identity, prepare output,
# fail-open cache, concurrent writers, init, and the semantic runtime boundary.
#
#   bash scripts/build/smoke.sh ./dist/context
#   bash scripts/smoke.sh "$HOME/.local/bin/context"   # installed launcher
set -euo pipefail

cmd="${1:?usage: smoke.sh <context-command>}"
smoke="$(mktemp -d)"
trap 'rm -rf "$smoke"' EXIT

export HOME="$smoke/home"
mkdir -p "$HOME"
export XDG_CACHE_HOME="$smoke/cache"
mkdir -p "$XDG_CACHE_HOME"

repo="$smoke/repo"
mkdir -p "$repo/src"
cat > "$repo/src/store.ts" <<'EOF'
// session persistence store: saves and loads session values
export class Store {
  save(key: string, value: string): void {}
}
export function openStore(): Store {
  return new Store();
}
EOF
cat > "$repo/README.md" <<'EOF'
# Demo

Session persistence lives in src/store.ts.
EOF

fail() { echo "smoke: FAIL: $*" >&2; exit 1; }
pass() { echo "smoke: ok: $*"; }

# 1. build identity: version + cache schema + runtime
ver="$("$cmd" --version)"
[[ "$ver" == *"cache-schema context-cache-v"* ]] || fail "--version lacks cache schema: $ver"
[[ "$ver" == *"runtime "* ]] || fail "--version lacks runtime kind: $ver"
pass "--version -> $ver"

# 2. prepare works and surfaces the store
"$cmd" observe "session persistence" --root "$repo" | grep -q "store.ts" || fail "prepare output lacks store.ts"
pass "prepare produces a capsule"

# 3. init into a fresh project (project scope, no agent dirs created at HOME)
proj="$smoke/proj"
mkdir -p "$proj"
"$cmd" init --project --root "$proj" --targets opencode >/dev/null
[[ -f "$proj/.opencode/skills/context/SKILL.md" ]] || fail "init did not install the skill"
pass "init installs the skill"

# 4. fail-open cache: cache dir cannot be created -> prepare still exits 0
blocker="$smoke/blocker"
echo not-a-dir > "$blocker"
XDG_CACHE_HOME="$blocker" "$cmd" observe "session persistence" --root "$repo" >/dev/null || fail "unwritable cache killed prepare"
pass "unwritable cache is fail-open"

# 5. concurrent writers never corrupt the cache record
"$cmd" observe "openStore" --root "$repo" >/dev/null &
p1=$!
"$cmd" observe "Store save" --root "$repo" >/dev/null &
p2=$!
wait "$p1" || fail "concurrent prepare #1 failed"
wait "$p2" || fail "concurrent prepare #2 failed"
cache_json="$(ls "$XDG_CACHE_HOME"/context/*.json | head -n1)"
[[ -n "$cache_json" ]] || fail "no cache record written"
cat "$cache_json" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null || fail "cache record is not valid JSON"
pass "concurrent prepares leave a valid cache record"

# 6. semantic runtime boundary: compiled runtime degrades loudly, source runs
if [[ "$ver" == *"runtime compiled"* ]]; then
  err="$(CONTEXT_SEMANTIC=1 "$cmd" observe "where does the app remember values" --root "$repo" 2>&1 >/dev/null)"
  [[ "$err" == *"compiled runtime"* ]] || fail "compiled runtime did not explain semantic unavailability: $err"
  CONTEXT_SEMANTIC=1 "$cmd" observe "where does the app remember values" --root "$repo" >/dev/null || fail "semantic request crashed compiled runtime"
  pass "compiled runtime degrades loudly, stays fail-open"
else
  pass "source runtime: semantic boundary exercised by unit tests"
fi

echo "smoke: all checks passed"
