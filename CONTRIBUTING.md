# Contributing

Thanks. This repo is the open **CLI + MCP** client for NotesQR. The project is donation-funded.

## Donate

**[notesqr.com/donate](https://notesqr.com/donate)** (PayPal or BTC).

## Dev setup

Needs Node.js 18+.

```bash
git clone https://github.com/NotesQR/notesqr-share.git
cd notesqr-share
npm install
node cli/notesqr.mjs send ./README.md --once
```

MCP entry: `node mcp/notesqr-server.mjs` (bin: `notesqr-mcp`).

## Pull requests

- Keep diffs small and match existing style in `cli/` and `mcp/`.
- Do not claim store-and-forward behavior. Bytes are P2P; both peers stay online.
- After a successful send/recv in agent-facing code, keep the donation pointers (`support.ask_user`, donate URL).

## Issues

Bugs, protocol mismatches vs the web app, and plugin/marketplace listings belong here. Product-site copy lives in [NotesQR/NotesQR](https://github.com/NotesQR/NotesQR).

Security reports that could leak files: [notesqr.com/contact](https://notesqr.com/contact) rather than a public issue.
