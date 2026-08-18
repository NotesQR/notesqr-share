# NotesQR agent plugin submissions

Plugin packages in this repo:

| Path | Platform | Install now (before catalog approval) |
|------|----------|----------------------------------------|
| `grok-plugin/` | Grok Build | Pending [xAI PR #285](https://github.com/xai-org/plugin-marketplace/pull/285) |
| `claude-plugin/` | Claude Code | `/plugin marketplace add NotesQR/notesqr-share` then `/plugin install notesqr@notesqr-plugins` |
| `cursor-plugin/` | Cursor | Team marketplace: import `NotesQR/notesqr-share` (`.cursor-plugin/marketplace.json`) |
| `codex-plugin/` | OpenAI Codex | Clone repo → `.agents/plugins/marketplace.json` (official directory closed) |
| Root + `gemini-extension.json` | Gemini CLI | `gemini extensions install https://github.com/NotesQR/notesqr-share` |

## Submit to public catalogs

1. **Grok Build** — https://github.com/xai-org/plugin-marketplace (PR open)
2. **Claude Code community** — https://claude.ai/settings/plugins/submit  
   Repo: `https://github.com/NotesQR/notesqr-share` · Plugin path: `claude-plugin`
3. **Cursor Marketplace** — https://cursor.com/marketplace/publish  
   Repo: `https://github.com/NotesQR/notesqr-share` · Plugin path: `cursor-plugin`
4. **Gemini CLI gallery** — add topic `gemini-cli-extension` on GitHub (automated crawl)

## Check listing status

From the NotesQR app repo:

```bash
./scripts/check-plugin-listings.sh
```
