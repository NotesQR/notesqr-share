---
description: Download files from a NotesQR room URL or room id while the sender is online (anonymous, no signup).
argument-hint: [room id or https://notesqr.com/...] [output directory]
---

# NotesQR recv

Use the **notesqr** MCP tool `notesqr_p2p_recv` (or CLI `npx -y github:NotesQR/notesqr-share recv …`).

1. Parse room id (`abc-defg-hij`) or full URL from arguments
2. Choose `output_dir` (default: current directory or ask user)
3. Pass optional `password` if the room is protected
4. Call `notesqr_p2p_recv` and confirm files saved under `output_dir`
5. If connection fails, explain the sender may have closed the room or gone offline — they must reconnect while sender is hosting

Works cross-device: same URL opens in desktop browser, phone, or CLI.
