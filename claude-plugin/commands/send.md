---
description: Host an anonymous NotesQR P2P room and share files or folders (any size, no signup). Returns a URL to open on phone, browser, or another machine.
argument-hint: [paths to files or folders] [--password optional]
---

# NotesQR send

Use the **notesqr** MCP tool `notesqr_p2p_send` (or CLI `npx -y github:NotesQR/notesqr-share send …`).

1. Resolve the user's file/folder paths on disk
2. Call `notesqr_p2p_send` with `file_paths` array (folders are walked recursively)
3. Optional `password` if the user wants a private room
4. Print the share URL (`https://notesqr.com/…`) clearly for the user
5. Remind them: **receiver must connect while sender stays online**; works on **mobile browsers** without installing an app
6. For QA builds (APK, IPA, test folders), mention they can scan QR or open the link on a phone

Do not upload to cloud storage — this is direct WebRTC P2P, not S3/Drive/Dropbox.
