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
- **Slash commands** — built-ins like `/clear`, `/compact`, `/import`, plus commands registered by extensions; type `/` for the menu. `/resume` is handled by the dashboard itself: it opens history search and continues whichever session you pick (a web chat has no pi picker to defer to).
- **Fork & resume** — branch a new session from any message, or continue an old one: open the command palette (`⌘K` / `Ctrl+K`) and pick **Resume Session…** (or press `Ctrl/⌘+Shift+H`) to search past sessions by title, project, or transcript text. No full-text index needed — the dashboard reads the session files directly.
- **Context usage** — live token/context tracking, so you know when to `/compact`.
- **Voice input** — the composer accepts speech (see Settings → Voice).

![Chat transcript](images/features/01-chat.png)

A real slice of a conversation: thinking blocks collapse, and tool calls are grouped — the group header states how many steps ran and how many succeeded or failed (here "2 done · 1 failed"). Failures are not hidden.

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

![File tree](images/features/02-files.png)

![Document preview](images/features/02-preview.png)

Together they show the whole loop: on the left, the file tree (switch workspaces, filter by name); on the right, the full-screen preview, whose header row is exactly **Preview / Edit toggle, Save, and Download** — you never leave the dashboard to read or change a file. Images, PDFs, spreadsheets, and source files all open in the same window.

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

## Subagents

When pi works on something it fans out a batch of subagents. This panel brings their live state into the dashboard, so you do not have to dig through logs or guess:

- **Grouped by state** — running / needs attention / completed / stopped. Whatever needs your decision sits where you will see it.
- **No pretending work is happening** — a subagent that has lost its session is labelled "currently disconnected" instead of looking busy.
- **Stop one whenever** — running subagents carry a Stop button (click once more to confirm).
- **A step-by-step record** — an activity card follows, showing what this activity is doing and when it started, plus an execution log: which step ran, which one failed. Long runs collapse into "show the other N items", and failed steps stay visible.

![Subagents in real time](images/features/04-subagent.png)

That is the real thing above: three subagent tasks marked "needs attention", one activity with its execution log underneath (step 2 failed, the later steps carried on), and 99 more items folded away.

---

## Context inspector (the context command)

The Live Pi session toolbar has a **◲ Context** button that answers a question you would otherwise be guessing at: **what did this session actually send to the model?**

- **The source is labelled honestly** — "real request" means the last payload actually sent to the provider (normalised across OpenAI Responses / Chat Completions, Anthropic Messages, Google and Bedrock Converse). Before the process has sent one, it says "approximate reconstruction" and names what is left out.
- **Five tabs** — overview, system prompt, tools, messages, request fields. Overview gives estimated tokens and shares per category plus the ten largest messages; the system prompt is split into project docs / skills / guidelines / base prompt; tools are sorted by definition size; messages can be searched and expanded; request fields cover the model, reasoning effort and other non-content fields.
- **Token counts are estimates** (ASCII ≈4 characters per token, CJK 1 character per token) — useful for comparing blocks, not for billing. pi's own reported usage sits beside them, and a gap between the two is normal. Every row also carries the real character count, so a truncated body still counts.
- **Copy report** exports a plain-text summary (source, shares, biggest blocks) with no bodies in it, ready to paste to a colleague or hand back to the agent for optimisation.
- Read-only — no session takeover needed, and it still works while another browser holds control.

![Context inspector](images/features/05-context.png)

That is a real report: tool calls take 50% (120.7k), tool results 23%, user messages 14% — you can see at a glance what the context is being eaten by.

> One gotcha: this comes from a pi extension loaded when the pi process starts, so sessions that are already running need a **reload** before the button does anything; newly started sessions have it from the beginning.

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

## Memory

The sidebar **Memory** page (`/memory`) answers four questions: what pi actually remembers, what it changed on its own, what is still waiting for you, and whether recalled memory really reached the context. The data comes from the local memory database written by the `pi-tsien-memory` extension, and the page is **read-only** — accepting, correcting, and forgetting still go through the extension's `/memory` command and the `memory_*` tools; there is no edit button here.

- **Overview** — counts per status (active / candidate / stale / superseded / rejected / forgotten), the three review problems (conflicts, unverified sources, global scope), pending and failed index jobs, and self-management counts such as “auto-accepted by the system” and “created by the agent”.
- **Items** — filter by status or search the content; each row shows whether the source is verified, who the source belongs to, conflict count, and how often the memory was observed and applied.
- **Changes** — a newest-first log of who (user / agent / system) moved which memory from one status to another, when, and why, with a content preview.
- **Review queue** — candidates only, ranked conflicts first, then unverified source, then global scope, then the rest, so the highest-impact ones come first.
- **Recall effect** — over the last 7 days (adjustable): recall runs, candidate count, how many actually entered the context, how many were verified or corrected, average latency, and the most-used memories.

If the extension auto-accepts a candidate on evidence (verified tool result, confidence above the threshold, no unresolved conflict), it shows up here: the overview's “auto-accepted by the system” counter goes up and the change log records a system action. Vague or conflicting candidates still wait for a human. When the database does not exist yet the page says “start one pi session so the extension can create it” instead of reporting zero memories. Reading requires the browser auth first.

---

## Repos

Register the repositories you work in. Each entry stores an absolute path, kept in `~/.pi/dashboard.json`.

Each row shows branch, ahead/behind counts, and uncommitted/unpushed change counts, with quick actions: Graph (commit graph), Live Pi, GitHub, Fetch. Filter by tag (e.g. #platform, #task, #xdoc).

Each card also shows the raw `origin` URL plus its derived `ssh` and `https` forms (each with a copy button), and the commit identity in effect (`user.name` / `user.email`), highlighted when missing. A repo with no remote reads “无远端（只在本地使用）” and is not counted as needing attention.

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