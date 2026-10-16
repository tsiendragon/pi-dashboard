# Pi Dashboard — Feature Tour

[中文版](features.md)

Pi Dashboard is the browser console for the [pi](https://github.com/mariozechner/pi-coding-agent) coding agent. With it, your daily work with pi stops being "one conversation in a terminal" and becomes a workbench: many threads at once, visible progress, and a written trail.

- Chat with pi in the browser, multiple sessions in parallel, each with its own working directory, model, and history
- While pi edits code, read files, leave comments, and review diffs in the same window
- Watch several running pi sessions at once and take over any of them
- Track cost, time, and machine status without opening another terminal
- Use it from your phone (iOS / Android); an optional Electron shell covers desktop

This document walks through the modules in the sidebar. For install steps, see the [README](../README.md).

> Language: this is the English version. 中文版见 [features.md](features.md).

---

## Interface overview

The UI has three regions:

- **Left sidebar** (fixed width, collapsible), in two groups:
  - **Main**: Chat, Live Pi, Session Overview, Tasks, Supervisor, Cost · Time, System
  - **Tools**: Repos, Extensions, Logs, Jobs, Settings
- **Main area**: the current page.
- **Right file panel**: opened from the **📄 Files** button in the chat header, for browsing and editing files.

Chat is where you spend most of your time: a session list on the left (sortable by Date / Project / Tag / Status, with a filter box), and the conversation plus composer in the middle (model picker, attachments, send).

![Interface overview](images/features/00-nav-overview.png)

---

## Chat

The core is talking to pi, with a few things a terminal does not give you:

- **Multiple sessions** — each session is its own slot with its own working directory, model, and context. The left list manages them.
- **Streaming output** — replies arrive token by token; thinking blocks, tool calls, and command output render as distinct blocks, and images are inline.
- **Visible tool calls** — which file pi read, which command it ran, and what came back, all folded into the transcript.
- **Slash commands** — built-ins like `/clear`, `/compact`, `/import`, plus commands registered by extensions; type `/` for the menu.
- **Fork & resume** — branch a new session from any message, or continue an old one.
- **Context usage** — live token/context tracking, so you know when to `/compact`.
- **Voice input** — the composer accepts speech (see Settings → Voice).

---

## Files and document collaboration

This is where Pi Dashboard is clearly more than "chat in a terminal". Click **📄 Files** in the chat header:

- **File tree** — expand directories, switch workspaces, toggle hidden files with `.*`. File paths printed by pi in chat are clickable too.
- **Two modes**:
  - **Preview** — rendered markdown or syntax-highlighted code (the default)
  - **Edit** — change the file in place, save with Ctrl+S
- **Inline comments** — select a sentence (or click a line number, or drag a range), right-click → **Add Comment**. Each comment stores the line range *and* the quoted sentence, so pi knows exactly what you meant.
- **Review Comments** — one dialog collects every pending comment; delete the ones you no longer care about, edit the wording, then send them all as a single message.
- **Diff & versions** — every save snapshots a version; switch versions from the header dropdown and click **Diff** for word-level comparison.
- **Conflict handling** — if pi edits a file while you have unsaved changes, a yellow bar offers Reload / Keep Mine / Show Diff. With no unsaved changes, the panel follows pi's edits live.

Comments live in a `.{filename}.comments.json` sidecar next to the file (git-ignored), so pi can read them directly.

Typical loop: pi drafts a document → you open it and comment on the sentences you disagree with → Review Comments sends them in one shot → pi revises → the panel updates and you review the diff.

---

## Terminal

A full terminal (xterm.js + node-pty) lives inside the UI, so "quick, confirm this for me" moments do not require another window.

---

## Live Pi — real-time sessions

See the pi sessions that are **currently running**, and take one over.

- For safety, the first use asks for a **local control token**; the token file is `~/.pi/agent/run/pi-dashboard/live-control-token`.
- **Session Overview** offers two views: **session cards** (what several sessions are doing, at a glance) and a **family graph** (parent/child and derived-session relationships).
- Subagent and background-task status also show up here.

Sessions that are actively working show a small animated glyph at the head of the row — a mallet tapping a wooden fish, with a floating "+1" — so you can tell at a glance which ones are busy.

---

## Supervisor

Built for "many things are running — how do I know which one is off?". The rule is stated right on the page: **based on authorized tasks and session evidence; unknown is never treated as healthy**. In other words, "no evidence" is not "fine".

The page offers **Refresh** and **Ask supervisor**, to pull the current state or have the supervisor agent summarize it.

---

## Tasks

Manage work as tasks:

- A stats strip on top (active / in progress / to-do counts), status filters below (active, in progress, to-do, paused, done, archived, all), plus source filtering and search by title or ID.
- Two tabs: **task list** and **event ledger** (status-change history).
- An **ad-hoc task** button starts something that stays out of the formal flow.

---

## Cost · Time

Three tabs:

- **Cost** — this month's spend, token usage, cache hit rate, active sessions, plus a dual-axis daily spend/token chart.
- **Time** — duration-focused statistics.
- **Model leaderboard** — compares models on capability/cost-related metrics.

There is also a **Codex / Claude Code limits** panel showing the local account's 5-hour and weekly windows (requires the corresponding CLI to be logged in and to support subscription-usage queries).

---

## Monitoring: System / Logs / Jobs

- **System** — machine and environment overview. A card row shows session, pi process, skill, and extension counts; tabs cover Overview, Host Sessions, Memory, Skills, Sessions, and Vault.
- **Logs** — a real-time pi session log stream, with level filtering, Auto scroll / Live toggles, and Clear.
- **Jobs** — scheduled jobs. Cron-style prompts sent to pi on a schedule; each run spawns a fresh slot and keeps a run history. Good for recurring reviews, digests, and monitoring checks.

---

## Repos

Register the repositories you work in. Each entry stores an absolute path, kept in `~/.pi/dashboard.json`.

Each row shows branch, ahead/behind counts, and uncommitted/unpushed change counts, with quick actions: Graph (commit graph), Live Pi, GitHub, Fetch. Filter by tag (e.g. #platform, #task, #xdoc).

---

## Extensions

Manage the extension list pi actually loads (from `settings.json` + `extensions.config.json` + each package manifest):

- **Installed** — list with enable/disable toggles; each entry shows its package, version, and whether it is declared.
- **Install new** — install, update, remove.
- **Config** — each extension's own JSON config (same panel implementation as in Settings).
- **Audit & diagnostics** — operation history and rollback, plus a static cross-package reference scan.

![Installed extensions](images/features/09-extensions.png)

---

## Settings

Three groups:

- **Agent** — Model List (pick providers and available models), Model, Behavior, Skills
- **Interface** — Display (theme), Chat, Voice, Terminal, Shortcuts
- **System** — Packages, Vault (secrets), Tasks, Lark, Developer

![Settings](images/features/14-settings.png)

---

## Mobile and desktop

- **iOS** — a native SwiftUI app with chat, thinking-block expansion, tool-call detail, session management, push notifications for approval requests, and Siri Shortcuts ("Ask Pi", "Send to Pi", "Check Pi Status", "Get Active Chats").
- **Android** — see the `android/` directory.
- **Desktop** — an optional Electron shell with a system tray and automatic SSH tunnel setup for remote servers.

---

## Remote access

- **Tailscale (recommended)** — if both machines are on the same tailnet, open `http://<tailscale-ip>:7777`.
- **SSH tunnel** — `PI_DASH_HOST=your-server PI_DASH_USER=you ./pi-dash-connect.sh`.

More deployment detail: [guide/](../guide/README.md).

---

## Screenshot status

Some pages (Tasks, Repos, System, Cost · Time, Live Pi, Session Overview, Supervisor) currently contain internal information on this machine and are not suitable for publication, so their screenshots are pending. See [features-shotlist.md](features-shotlist.md) for the list and file-name conventions.