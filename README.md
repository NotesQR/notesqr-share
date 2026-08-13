# NotesQR

WebRTC **P2P** CLI for [NotesQR](https://notesqr.com). Both peers stay online; bytes never land on NotesQR disks.

## Quick start (no global install)

Needs [Node.js 18+](https://nodejs.org/). If `npx github:…` fails with `EALLOWGIT`, run `npm config set allow-git all` once, or clone this repo.

```bash
# Terminal A — sender
npx -y github:NotesQR/notesqr-share send ./file.pdf --once

# Terminal B — or open the printed URL in a browser
npx -y github:NotesQR/notesqr-share recv https://notesqr.com/xxx-xxxx-xxx -o ./out
```

From a clone:

```bash
npm install
node cli/notesqr.mjs send ./file.pdf --once
node cli/notesqr.mjs recv <url> -o ./out
```


## Folders

Also available in the **web app, desktop installers, and browser extensions** (Browse → Folder).

`send` accepts directories (recursive). Peers only see **share-relative** paths (never absolute disk paths). `recv` recreates the tree under `-o`.

```bash
npx -y github:NotesQR/notesqr-share send ./project/ README.md --once
npx -y github:NotesQR/notesqr-share recv <room|url> -o ./out
```

## MCP

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

Docs: https://notesqr.com/docs
