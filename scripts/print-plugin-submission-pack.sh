#!/usr/bin/env bash
# Print ready-to-paste details for manual catalog submissions (Claude, Cursor).
# Automated submission requires browser login on those platforms.
set -euo pipefail

REPO_URL="https://github.com/NotesQR/notesqr-share"
SHA=$(curl -fsSL "https://api.github.com/repos/NotesQR/notesqr-share/commits/main" | python3 -c "import json,sys; print(json.load(sys.stdin)['sha'])")

cat <<EOF

NotesQR plugin submission pack
==============================

Repository: $REPO_URL
Pinned commit (main): $SHA

Claude Code community
---------------------
URL: https://claude.ai/settings/plugins/submit
  (alt: https://platform.claude.com/plugins/submit)

Suggested fields:
  - Repository URL: $REPO_URL
  - Plugin path: claude-plugin
  - Name: notesqr
  - Description: Anonymous WebRTC P2P file/folder sharing — no signup, any size, mobile browsers, MCP send/recv.

Install now (no wait):
  /plugin marketplace add NotesQR/notesqr-share
  /plugin install notesqr@notesqr-plugins

Cursor Marketplace
------------------
URL: https://cursor.com/marketplace/publish

Suggested fields:
  - Repository URL: $REPO_URL
  - Plugin path: cursor-plugin
  - Name: notesqr
  - Keywords: notesqr, p2p, webrtc, file transfer, anonymous, mobile, mcp

Gemini CLI gallery (GitHub topic)
---------------------------------
Repo → About → Topics → add: gemini-cli-extension
(Requires repo admin; crawler indexes daily)

Install now:
  gemini extensions install $REPO_URL

Grok Build
----------
PR: https://github.com/xai-org/plugin-marketplace/pull/285 (pending merge)

Check all listings:
  ./scripts/check-plugin-listings.sh

EOF
