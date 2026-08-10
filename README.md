# notesqr

WebRTC **P2P** CLI for [NotesQR](https://notesqr.com). Both peers stay online; bytes never land on NotesQR disks.

## Quick start (no global install)

Needs [Node.js 18+](https://nodejs.org/). If `npx github:…` fails with `EALLOWGIT`, run `npm config set allow-git all` once, or clone this repo.

```bash
# Terminal A — sender
npx -y github:colocoquillo/notesqr-share send ./file.pdf --once

# Terminal B — or open the printed URL in a browser
npx -y github:colocoquillo/notesqr-share recv https://notesqr.com/xxx-xxxx-xxx -o ./out
```

From a clone:

```bash
npm install
node cli/notesqr.mjs send ./file.pdf --once
node cli/notesqr.mjs recv <url> -o ./out
```

## MCP

```json
{
  "mcpServers": {
    "notesqr": {
      "command": "npx",
      "args": ["-y", "-p", "github:colocoquillo/notesqr-share", "notesqr-mcp"]
    }
  }
}
```

Docs: https://notesqr.com/docs
