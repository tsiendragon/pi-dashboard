# Pi Extension Integrations for Dashboard — Tech Design

Status: Approved for implementation by user request
Owners: `pi-dashboard`, `pi-subagent-workbench`, `pi-tsien-extension`
Features: Subagent Workbench, BTW, Background Commands

## 1. Summary

Pi Dashboard currently renders ordinary Pi tool events but cannot inspect or control the retained runtime state owned by `pi-subagent-workbench`, BTW, or the session-owned background command manager. Their terminal interfaces depend on `ctx.ui.custom()`, which is unavailable in the dashboard's headless SDK/RPC hosts.

This design introduces a versioned, slot-scoped **Dashboard Extension Bridge**. Extensions keep ownership of execution and security. Dashboard receives immutable snapshots and sends a small whitelist of typed commands. The same browser contract is used for SDK and RPC transports:

```text
Extension runtime
  -> feature adapter
  -> Dashboard Extension Bridge
  -> REST commands + WebSocket snapshots
  -> first-party Dashboard React UI
```

The implementation does not depend on `pi-conductor`, does not rename existing tools, and does not modify Pi core.

Runtime prerequisite: dashboard and the loaded extensions must use `@earendil-works/pi-coding-agent >= 0.84.2`. Workbench uses APIs and TUI components unavailable in the dashboard's former `0.80.3` host, so the dashboard dependency is pinned to `0.84.2`.

RPC deployment prerequisite: the effective Pi extension graph must not contain duplicate tool/flag registrations. Pi RPC intentionally exits on any extension load error. Duplicate standalone and integrated Goal/Memory packages therefore block the whole RPC child before any bridge feature can attach; SDK mode contains those diagnostics and can continue with successfully loaded extensions.

## 2. Goals

1. Open and control Subagent Workbench from the WebUI.
2. Inspect Agents, Workflows, Stages, Tasks, timelines, tool calls, usage, and errors.
3. Start a Subagent or Workflow from the WebUI through typed Workbench commands.
4. Send a follow-up or interrupt an Agent/Workflow.
5. Open BTW as a right-side drawer with streaming answers, abort, parent-context refresh, and copy-to-draft.
6. Preserve BTW's read-only tool allowlist and keep BTW messages out of the parent transcript.
7. Display session-owned background Bash tasks with live status/output and cancellation.
8. Move a running foreground Bash command to the background from the dashboard, matching the TUI `Ctrl+B` handoff.
9. Prevent state leakage between dashboard slots in SDK mode.
10. Support both dashboard SDK and RPC transports with one frontend contract.
11. Preserve existing TUI behavior.

## 3. Non-goals

- Replacing `pi-conductor` or translating Workbench tools into `ensemble_*` tools.
- Letting the browser execute arbitrary Bash directly. WebUI background-command controls stay limited to refresh/output/cancel plus moving an already-running foreground command to the background; the browser never starts a process.
- Persisting volatile Workbench or BTW state across host process restarts.
- Automatically managing arbitrary OS processes that were not created by `background_command_start`.
- Exposing extension runtime objects, process handles, credentials, or auth material to the browser.

## 4. Existing Components

### 4.1 Workbench

`/mnt/workspace/lilong/repos/pi-subagent-workbench/src/runtime.ts` already provides:

- immutable `WorkbenchSnapshot` values;
- monotonic `revision`;
- `getSnapshot()` and `subscribe()`;
- typed `dispatch()` commands;
- projected Agent/Workflow timelines including tool start/progress/result.

The current process-global runtime is unsafe for multiple SDK slots because multiple extension instances can share one command handler. Dashboard instances must use a runtime scoped to their parent Pi session while retaining a process-level resource governor.

### 4.2 BTW

`/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/btw/session.ts` already owns a transport-independent child `AgentSession`, parent-context snapshots, history lookup, streaming events, abort, refresh, and disposal. The TUI command currently owns a module-global active controller and renders through `ctx.ui.custom()`.

### 4.3 Background Commands

`/mnt/workspace/lilong/repos/pi-tsien-extension/extensions/lib/background-commands/manager.ts` already exposes:

- `subscribe()`;
- `list()` and `get()`;
- `output()`;
- `cancel()`;
- throttled task updates and bounded output tails.

The current global manager must also become session-scoped for dashboard SDK slots.

## 5. Architecture

### 5.1 Shared wire contract

Dashboard defines a dependency-free JSON contract in:

`/mnt/workspace/lilong/repos/pi-dashboard/shared/src/extension-bridge.ts`

```ts
interface ExtensionFeatureSnapshot {
  slot: string
  feature: "subagent-workbench" | "btw" | "background-commands"
  apiVersion: 1
  revision: number
  generatedAt: number
  state: unknown
}

interface ExtensionFeatureCommand {
  feature: ExtensionFeatureSnapshot["feature"]
  requestId: string
  command: unknown
}

interface ExtensionFeatureCommandResult {
  requestId: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}
```

Feature payloads remain feature-specific, but all envelopes are bounded, JSON-serializable, and versioned.

### 5.2 Extension adapter contract

Producer repositories implement the same structural interface without importing dashboard source:

```ts
interface DashboardFeatureAdapter {
  readonly feature: string
  readonly apiVersion: 1
  getSnapshot(): unknown
  subscribe(listener: (snapshot: unknown) => void): () => void
  dispatch(command: unknown): Promise<unknown>
  dispose?(): Promise<void> | void
}
```

### 5.3 SDK registration

`PiSdkSession` annotates its session-specific `SessionManager` with a non-enumerable capability keyed by:

```ts
Symbol.for("pi.dashboard.extension-bridge.v1")
```

The capability exposes only `register(adapter)`. An extension detects it during `session_start` and registers its adapter. Since every SDK slot has a distinct `SessionManager`, registrations cannot cross slots.

The dashboard registry subscribes to the adapter, stores the latest immutable snapshot, and emits normalized bridge events.

### 5.4 RPC registration

RPC children cannot share objects with the dashboard process. Dashboard starts one local Unix domain socket server and passes these variables to each Pi RPC child:

```text
PI_DASH_BRIDGE_SOCKET
PI_DASH_BRIDGE_TOKEN
PI_SLOT_KEY
```

Protocol: newline-delimited JSON.

Child to dashboard:

```text
register
snapshot
result
error
unregister
```

Dashboard to child:

```text
command
shutdown
```

Security and lifecycle:

- socket lives under a private runtime directory and is mode `0600`;
- each slot receives a cryptographically random token;
- token is accepted only for its assigned slot;
- messages and snapshot sizes are bounded;
- malformed or unsupported messages close the connection;
- deleting a slot revokes the token and closes its connections;
- no TCP listener is introduced.

### 5.5 Dashboard backend registry

New backend modules:

```text
/mnt/workspace/lilong/repos/pi-dashboard/backend/extension-bridge/registry.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/extension-bridge/sdk-host.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/extension-bridge/rpc-server.ts
/mnt/workspace/lilong/repos/pi-dashboard/backend/routes/integrations.ts
```

Registry key: `(slotKey, feature)`.

Responsibilities:

- attach/detach feature adapters;
- cache latest snapshot;
- serialize one command at a time per feature unless the feature declares it safe;
- reject commands for missing/dead slots;
- broadcast snapshot changes;
- dispose subscriptions on slot deletion/replacement/shutdown.

### 5.6 Browser API

```text
GET  /api/chat/slots/:slot/integrations
GET  /api/chat/slots/:slot/integrations/:feature
POST /api/chat/slots/:slot/integrations/:feature/commands
```

WebSocket frames:

```text
extension_feature_attached
extension_feature_snapshot
extension_feature_detached
extension_feature_error
```

The existing dashboard token/origin checks apply. Feature command validators enforce exact command unions and input limits.

## 6. Workbench Integration

### 6.1 Runtime scoping

In dashboard mode, each loaded Workbench extension instance owns one `WorkbenchRuntimeHost` and one command handler. SDK instances share only a `ResourceGovernor`; conversations, workflows, errors, listeners, and command handlers are per parent session.

Normal TUI mode retains the existing process-global compatibility runtime so reload and external consumers do not regress.

### 6.2 Commands

Existing commands retained:

```text
refresh
start-agent
send-agent
interrupt-agent
interrupt-workflow
```

Add:

```ts
{
  type: "start-workflow"
  label?: string
  stages: Array<{
    label?: string
    tasks: Array<{
      task: string
      label?: string
      cwd?: string
      model?: string
      context?: string
    }>
  }>
}
```

Validation reuses Workbench service limits. The browser cannot set internal provider handles, process options, or resource limits.

### 6.3 WebUI

First-party components live under:

```text
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/workbench/
```

The panel provides:

- Agent and Workflow lists;
- governor and health summary;
- workflow Stage/Task hierarchy;
- Agent timeline using existing assistant/thinking/tool renderers;
- follow-up and interrupt controls;
- start-Agent and start-Workflow forms;
- explicit volatile-state indicator;
- deep-linkable active slot and selected Agent/Workflow.

`/subagent-workbench` typed in chat is intercepted locally and opens the panel rather than being sent as a normal prompt. Existing model tool calls remain visible in the main transcript.

Closing the panel does not cancel background work.

## 7. BTW Integration

### 7.1 Session-scoped controller

Move active BTW state into the extension instance/session scope. The controller exposes immutable snapshots and subscription instead of a single mutable `onChange` callback.

State:

```ts
interface BtwSnapshot {
  apiVersion: 1
  revision: number
  generatedAt: number
  status: "closed" | "starting" | "ready" | "busy" | "error"
  parentMessageCount: number
  model?: string
  activity?: string
  conversation: Array<{ role: "user" | "assistant" | "notice"; text: string }>
  error?: string
}
```

Commands:

```text
open
submit
abort
refresh-parent
close
```

### 7.2 Security

The controller continues creating its child with only:

```text
read
grep
find
ls
session_history
```

The WebUI cannot change the tool list, model credentials, system prompt, or parent context. `copy-to-main` is implemented entirely as a browser draft update and never auto-submits.

### 7.3 WebUI

Components live under:

```text
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/btw/
```

`/btw` opens a right-side drawer. The drawer streams conversation snapshots, shows current read-only tool activity, supports abort/refresh/close, and can copy the final answer into the parent draft.

Closing the drawer dispatches `close`, disposes the temporary AgentSession, and does not alter the parent transcript.

## 8. Background Command Integration

### 8.1 Adapter

The existing manager becomes a bridge adapter with snapshots containing public task fields and a bounded output tail. Running foreground commands are listed too, carrying `mode: "foreground"` and their `toolCallId`; retained tasks carry `mode: "background"`. Commands:

```text
refresh
output { taskId, tailLines }
cancel { taskId }
background { toolCallId }
```

There is intentionally no browser `start` command. `background` never starts a process: it only hands off a foreground command this session already runs, resolving the blocking `bash` tool with exit code 0 and a notice to read `background_command_status`/`background_command_output` while the child process keeps running.

### 8.2 WebUI

Components live under:

```text
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/features/background-commands/
```

A compact floating dock appears only when the active slot owns retained tasks. It shows status, title, command, cwd, elapsed time, output size, exit information, a bounded live tail, and cancel control.

Running foreground commands appear in the same dock and offer **Move to background** instead of Cancel; background tasks keep Cancel. The dock therefore shows up as soon as a command starts, and the handoff refreshes the snapshot through the regular command path.

For a Workbench child Agent, ordinary background-command tool calls already appear in its projected timeline. Full nested child-process task control is not part of the first bridge version because those managers live in Workbench-owned child Pi processes; the timeline remains truthful and the child can call status/output/cancel. A later protocol version may forward nested manager snapshots with explicit parent ownership.

## 9. Frontend State

Add one generic Redux slice:

```text
/mnt/workspace/lilong/repos/pi-dashboard/frontend/src/store/integrationsSlice.ts
```

Key: `(slot, feature)`.

It stores attachment state, latest revision/snapshot, pending command IDs, and errors. Stale revisions are ignored. On WebSocket reconnect, the active slot is re-fetched over REST.

Feature React components consume this generic state but validate their own payloads defensively.

## 10. Failure Semantics

- Missing adapter: HTTP `409 integration_unavailable`.
- Unsupported API version: adapter detached and visible error shown.
- Extension process exit: feature detached; retained last snapshot is marked stale.
- Browser disconnect: execution continues; reconnect fetches current snapshot.
- Command timeout: request fails without assuming cancellation.
- BTW startup failure: snapshot enters `error`; close remains available.
- Workbench volatile child failure: existing runtime status/error remains authoritative.
- RPC socket loss: reconnect with bounded exponential backoff while the Pi child lives.

## 11. Resource and Data Limits

- bridge message: maximum 2 MiB;
- background output tail: maximum 2,000 lines and 512 KiB per snapshot;
- BTW conversation snapshot: bounded to controller-retained content;
- Workbench snapshot: existing transcript byte limit remains authoritative;
- snapshot broadcasts: coalesced to at most 20 updates/second per feature;
- one outstanding control command per `(slot, feature)` by default.

## 12. Implementation Stages

### Stage A — Bridge foundation

- shared protocol;
- backend registry and routes;
- SDK capability;
- RPC Unix socket and token lifecycle;
- frontend generic integration state;
- transport and isolation tests.

### Stage B — Workbench

- dashboard-scoped runtime;
- `start-workflow` command;
- bridge adapter;
- Agent/Workflow panel and timeline;
- follow-up/interrupt/create flows.

### Stage C — BTW and Background Commands

- BTW session scoping and snapshot adapter;
- BTW drawer;
- background manager scoping and adapter;
- background task dock.

### Stage D — Integration hardening

- two-slot SDK isolation;
- RPC parity;
- reconnect and disposal;
- TUI regression;
- frontend/backend builds and existing repository test suites.

## 13. Acceptance Criteria

1. Two simultaneous SDK slots never share Workbench, BTW, or background-command state.
2. The same three features attach and operate in RPC mode.
3. WebUI can start/open a Subagent, inspect its timeline, send follow-up, and interrupt it.
4. WebUI can start/open a Workflow, inspect Stages/Tasks, open a Task's Agent, and interrupt the Workflow.
5. A background Workbench run remains visible after its original tool call returns.
6. `/btw` opens the drawer, streams replies, aborts, refreshes parent context, copies to draft, and closes cleanly.
7. BTW has no write or shell tool and does not add messages to the parent transcript.
8. Main-slot `background_command_start` tasks appear automatically with live status/output and can be cancelled from WebUI.
9. Workbench child background-command tool calls are visible in the child timeline without falsely claiming full nested process control.
10. Browser reconnect restores current snapshots without restarting work.
11. Deleting/replacing a slot releases subscriptions, sockets, adapters, BTW sessions, and dashboard-owned bridge resources.
12. Existing TUI `/subagent-workbench` and `/btw` behavior and existing tests do not regress.

## 14. Verification Status

Implemented and verified:

- dashboard SDK host registers all three features without model inference;
- SDK refresh/close command round-trips succeed;
- RPC Unix Socket authentication, snapshot streaming, slot ownership, and command round-trip pass an integration test;
- a full RPC dashboard smoke with the integrated `pi-tsien-extension` package registers Workbench, BTW, and Background Commands and completes control-command round-trips;
- dashboard backend, frontend, standalone Workbench, and integrated tsien extension suites pass;
- frontend production build succeeds.
