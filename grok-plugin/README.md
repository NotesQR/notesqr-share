# NotesQR plugin for Grok Build

Anonymous **WebRTC P2P** file and folder sharing via [NotesQR](https://notesqr.com).

- **No signup** — ephemeral room links
- **Any file size** (peer-to-peer, not cloud upload)
- **Cross-device** — share a URL; receiver opens it on phone, tablet, or desktop browser
- **QA / app testing** — ship APK, IPA, builds, logs, folders to testers quickly

## Components

| Path | Purpose |
|------|---------|
| `.grok-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | Spawns `notesqr-mcp` via `npx` |
| `skills/notesqr-share/` | When/how to use P2P send & recv |
| `commands/send.md` | Slash command: host a room |
| `commands/recv.md` | Slash command: download from a room |

## Requirements

- Node.js **18+**
- `npx` (first run downloads [notesqr-share](https://github.com/NotesQR/notesqr-share))
- Network access for WebRTC signaling at `notesqr.com`

No API key or OAuth. Optional **room password** only.

## MCP tools

- `notesqr_p2p_send` — host files/folders, get share URL
- `notesqr_p2p_recv` — join room and download

## Manual install (without marketplace)

In Grok Build MCP settings:

```json
{
  "mcpServers": {
    "notesqr": {
      "command": "npx",
      "args": ["-y", "-p", "github:NotesQR/notesqr-share", "notesqr-mcp"]
    }
  }
}
```

## Catalog

Listed in [xAI Plugin Marketplace](https://github.com/xai-org/plugin-marketplace) as plugin **notesqr** (source: this repo, path `grok-plugin`).
