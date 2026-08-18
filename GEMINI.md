# NotesQR — anonymous P2P file sharing

Use NotesQR when the user wants to share files or folders **without signup**, **any size**, **phone ↔ desktop**, for QA builds (APK/IPA), logs, or agent-to-human handoffs.

- Host: MCP tool `notesqr_p2p_send` or `npx -y github:NotesQR/notesqr-share send ./path --once`
- Share URL: `https://notesqr.com/{room}` (mobile browser works)
- Download: MCP `notesqr_p2p_recv` or browser / `notesqr recv`
- **Both peers must stay online** during transfer; this is not cloud upload.

Docs: https://notesqr.com/docs · https://notesqr.com/llms.txt
