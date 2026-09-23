# Doc Collaboration Mode

Pi-dashboard's doc collaboration mode lets you and the agent iterate on documents together — editing, commenting, tracking versions, and reviewing changes — all without leaving the dashboard.

## Opening Files

Click **📄 Files** in the chat header bar to open the file browser panel. Browse directories, expand folders inline, and click any file to open it in the side panel. Toggle hidden files with the `.*` button.

You can also click file paths in agent chat output to open them directly.

## Two Modes

The panel header has two mode buttons:

**Preview** — Rendered markdown (or syntax-highlighted code). The default when you open a file. Click line numbers to add inline comments.

**Edit** — Full text editing with the same commenting capability. Save with Ctrl+S or the Save button.

## Version Tracking

Every time you or the agent saves a file, a version snapshot is captured. Use the version dropdown in the header to browse previous versions (shown read-only). Click **Diff** to compare versions with word-level highlighting.

Versions are in-memory and session-scoped — they reset on server restart. The files themselves persist normally.

## Conflict Handling

If the agent edits a file while you have unsaved changes, a yellow conflict bar appears with three options:

- **Reload** — discard your changes, load the agent's version
- **Keep Mine** — dismiss the notification, keep editing
- **Show Diff** — open the diff view to compare your version with the agent's

If you don't have unsaved changes, the panel auto-updates to show the agent's edits live.

## Inline Comments

In Preview or Edit mode, select the sentence you want to comment on and right-click → **Add Comment**. You can also click line numbers in Edit mode to select a line (drag for a range). Comments are:

- **Anchored to a sentence** — each comment stores the line range *and* the quoted sentence, so the agent sees the exact text being reviewed
- **Version-scoped** — each comment records which version it was created on
- **Stored as JSON sidecars** — `.{filename}.comments.json` next to the file (git-ignored)
- **Agent-readable** — the agent can read the sidecar file directly
- **Navigable** — use ↑/↓ arrows in the comment bar to jump between comments

Commenting works in both surfaces that render a file:

- the **side panel** (📄 Files button or a file path in chat)
- the **full-screen preview modal** (click a document link in agent output)

Both read and write the same sidecar, so a comment left in one shows up in the other.

## Review Comments

Click **Review Comments** in the comment navigation bar. A dialog opens showing every pending comment with its line reference and quoted sentence:

- remove individual comments you no longer care about
- edit the exact message before it is sent
- **Send** delivers everything as a single chat message; **Cancel**/Esc keeps the comments

Sent comments are cleared from the dashboard so each review cycle starts fresh; unsent ones stay.

The agent receives:

```
Please review and address the comments in /path/doc.md:

[1] Lines 12-14
Quoted: "净额按日汇总"
Comment: 口径不对

[2] Line 30
Comment: 删掉这句
```

This is the core workflow for doc collaboration:
1. Agent drafts a document
2. You open it, leave inline feedback on the sentences you disagree with
3. Click Review Comments, adjust the list, send
4. Agent revises the document
5. Panel auto-updates, you review the diff

## File Browser

The file browser panel (📄 Files button) supports:

- **Directory navigation** — click folders to expand, ⬆ to go up
- **Filter** — type to filter entries in the current directory
- **Hidden files** — toggle with the `.*` button to show dotfiles
- **Click to open** — click any file to open it in the panel
