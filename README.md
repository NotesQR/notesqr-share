# NotesQR

WebRTC **P2P** CLI for [NotesQR](https://notesqr.com). Both peers stay online; bytes never land on NotesQR disks.

**Current release: 2.1.0** — same transfer engine as the NotesQR web app (adaptive chunks up to 1 MiB, `zip_batch` DataChannel reuse, outbound concurrency 5→32, SCTP-safe roster batching, stall watchdog, largest-first multi-file recv).

## Quick start (no global install)

Needs [Node.js 18+](https://nodejs.org/). If `npx github:…` fails with `EALLOWGIT`, run `npm config set allow-git all` once, or clone this repo.

Prefer a **fresh** `npx` pull after upgrades so you are not stuck on an old cached checkout:

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

## What’s new in 2.1.0

- **Adaptive chunks** — probe SCTP `maxMessageSize`, send up to 1 MiB, step down if the peer rejects
- **`zip_batch`** — folder / multi-file transfers reuse one DataChannel (critical when a web guest downloads a folder from a CLI host)
- **Outbound concurrency** — base 5, grow toward 32 while in-flight bytes stay under ~10 MiB; emit `webrtc-file-queued` when deferred
- **Large rooms** — file list sent in ~180 KiB JSON batches; guests merge `webrtc-files` + `webrtc-file-add`
- **Recv** — multi-file downloads largest-first; stall watchdog instead of a hard wall-clock timeout from t=0

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
Changelog: https://notesqr.com/changelog
