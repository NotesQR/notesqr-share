#!/usr/bin/env bash
# Check whether NotesQR appears in public agent plugin catalogs.
# Usage: ./scripts/check-plugin-listings.sh
set -euo pipefail

PLUGIN_NAME="notesqr"
REPO="NotesQR/notesqr-share"
GROK_PR="285"

pass() { printf "  ✅ %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }
info() { printf "  ℹ️  %s\n" "$1"; }

section() { echo; echo "=== $1 ==="; }

json_get() {
  python3 - "$@" <<'PY'
import json, sys, urllib.request
url, expr = sys.argv[1], sys.argv[2]
with urllib.request.urlopen(url, timeout=30) as r:
    data = json.load(r)
print(eval(expr, {"data": data}))
PY
}

in_json_list() {
  local url="$1" name="$2"
  curl -fsSL "$url" | python3 -c "
import json, sys
d = json.load(sys.stdin)
plugins = d.get('plugins', [])
names = [p.get('name','') for p in plugins]
print('yes' if '$name' in names else 'no')
" 2>/dev/null || echo "error"
}

section "Grok Build (xAI Plugin Marketplace)"
if [[ "$(in_json_list "https://raw.githubusercontent.com/xai-org/plugin-marketplace/main/.grok-plugin/marketplace.json" "$PLUGIN_NAME")" == "yes" ]]; then
  pass "Listed in xai-org/plugin-marketplace main"
else
  fail "Not in xai-org/plugin-marketplace main yet"
  if command -v gh >/dev/null 2>&1; then
    state=$(gh pr view "$GROK_PR" --repo xai-org/plugin-marketplace --json state,url -q '.state + " " + .url' 2>/dev/null || echo "unknown")
    info "PR #$GROK_PR: $state"
  fi
fi

section "Claude Code (community catalog)"
claude=$(in_json_list "https://raw.githubusercontent.com/anthropics/claude-plugins-community/main/.claude-plugin/marketplace.json" "$PLUGIN_NAME")
if [[ "$claude" == "yes" ]]; then
  pass "Listed in anthropics/claude-plugins-community"
else
  fail "Not in claude-plugins-community yet"
  info "Submit: https://claude.ai/settings/plugins/submit"
  info "Or install now: /plugin marketplace add $REPO"
fi

section "Cursor Marketplace"
cursor_html=$(curl -fsSL "https://cursor.com/marketplace" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
if echo "$cursor_html" | grep -q "$PLUGIN_NAME"; then
  pass "Found on cursor.com/marketplace (static HTML)"
else
  warn "Not found in cursor.com/marketplace static HTML (page may be JS-rendered)"
  info "Submit: https://cursor.com/marketplace/publish"
  info "Repo marketplace: .cursor-plugin/marketplace.json in $REPO"
fi

section "Gemini CLI gallery"
gemini_repo=$(curl -fsSL "https://api.github.com/search/repositories?q=topic:gemini-cli-extension+repo:$REPO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null || echo 0)
if [[ "$gemini_repo" != "0" ]]; then
  pass "Repo has topic gemini-cli-extension"
else
  fail "Repo missing topic gemini-cli-extension (gallery crawler)"
fi
if curl -fsSL "https://raw.githubusercontent.com/$REPO/main/gemini-extension.json" >/dev/null 2>&1; then
  pass "gemini-extension.json present on main"
else
  fail "gemini-extension.json not on main yet"
fi

section "OpenAI Codex (official directory)"
info "Public third-party directory not open yet — no automated check"
info "Repo-scoped: clone $REPO and use .agents/plugins/marketplace.json"

section "GitHub code search (any marketplace.json)"
hits=$(curl -fsSL "https://api.github.com/search/code?q=$PLUGIN_NAME+filename:marketplace.json" | python3 -c "import json,sys; print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null || echo 0)
info "marketplace.json mentions of '$PLUGIN_NAME': $hits"

section "notesqr-share plugin folders"
check_file() {
  local path="$1"
  if curl -fsSL "https://raw.githubusercontent.com/$REPO/main/$path" >/dev/null 2>&1; then
    pass "$path"
  else
    fail "$path (not on main yet)"
  fi
}
check_file "grok-plugin/.grok-plugin/plugin.json"
check_file "claude-plugin/.claude-plugin/plugin.json"
check_file "cursor-plugin/.cursor-plugin/plugin.json"
check_file "codex-plugin/.codex-plugin/plugin.json"
check_file "gemini-extension.json"
check_file ".claude-plugin/marketplace.json"
check_file ".cursor-plugin/marketplace.json"
check_file ".agents/plugins/marketplace.json"

echo
echo "Done. Re-run after PR merges or submissions complete."
