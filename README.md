<div align="center">

# Multi-Agent Collaboration Orchestrator

Background multi-agent orchestration for Operit

[Project Repository](https://github.com/hujiayucc/Operit-Collaboration-Plugin)

**English | [简体中文](README.zh-CN.md)**

</div>

Operit ToolPkg plugin for delegating analysis, development, review, testing, and background work to persistent child Agents. It includes a native Compose DSL dashboard, task trees, messaging, recovery, diagnostics, and prompt-time tool filtering.

## Features

- Thirteen collaboration and control tools for spawning, tracking, messaging, follow-up Runs, waiting, interruption, detail and task-tree queries, event watching, settings, and history management.
- Parent-child task trees with per-root scheduling, status aggregation, and descendant cancellation.
- Persistent Agent, Run, message, checkpoint, tree-context, cursor, and request-id state in SQLite Event Store schema v4, with an explicit in-memory fallback when SQLite is unavailable.
- Optional shared main-conversation context. Each checkpoint reads the latest eligible user and assistant turns through the bound chat reference; system prompts and tool traces are excluded.
- Checkpoint-level task-tree context shared across parents, descendants, and siblings through revisioned events, bounded materialized snapshots, and per-Agent cursors.
- Structured `COLLABORATION_CONTROL` responses with `progress`, `finish`, `fail`, message acknowledgements, and Agent-to-Agent or Agent-to-main outbound messages.
- Native dashboard for status, results, task trees, messages, follow-ups, interruption, cleanup, and global settings.
- Lifecycle diagnostics and an Agent tool gateway. The gateway filters visible tools and protects plugin controls; it is not operating-system isolation.

## Install And Build

Import the project directory as a ToolPkg, or build the installable archive:

```bash
npm install
npm run build
```

The output is `<project-directory>-v<manifest.version>.toolpkg` in the project root. The builder verifies a temporary staged copy and applies conservative JavaScript compression while keeping function, class, parameter, local-variable, and property names unmangled; repository `src/` files are not rewritten. If the target already exists, it exits successfully without replacing it; use `--replace` only when replacement is intentional.

The archive contains only runtime files and a single-line `manifest.json`. Compiled JavaScript is stored under `dist/` in the archive; TypeScript source files are excluded, along with `LICENSE`, both README files, `tsconfig.json`, and `prompts/`.

## Collaboration Tools

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Create a stable Agent and queue its first Run. |
| `list_agents` | List or filter Agents, current Runs, results, messages, and task-tree state. |
| `send_message` | Queue an update for an active Agent's next checkpoint. |
| `followup_task` | Start a new Run on a terminal Agent while retaining its identity. |
| `wait_agent` | Wait for selected Agents to enter terminal states. |
| `interrupt_agent` | Cancel the current Run and its active descendants. |
| `inspect_agent` | Inspect one Agent's detailed Run, message, control, and tree state. |
| `list_tree` | List task-tree nodes rooted at an Agent. |
| `watch_tree_events` | Long-poll incremental events for a root Run. |
| `get_settings` | Read global scheduler settings. |
| `update_settings` | Update scheduler limits, `max_tool_calls`, `max_model_retries`, and `conversation_context_mode`. |
| `delete_agent` | Delete a terminal Agent and its history. |
| `clear_history` | Clear history for all terminal Agents. |

A queued response confirms scheduling, not task completion. The main Agent remains responsible for tracking and validating delegated work.

## Quick Start

```text
task: "Implement the user endpoint and run the relevant tests"
context: "Preserve the existing response format"
include_conversation_context: true
workspace_path: "/workspace"
target_paths_json: "[\"/workspace/server\"]"
workspace_env: "android"
read_only: false
priority: "normal"
timeout_ms: 900000
```

Writable tasks require `read_only: false` and a non-empty list of absolute target paths. Missing or empty write paths force read-only mode. Path declarations are scheduling and prompt constraints, not OS-level enforcement.

## Settings And Limits

| Setting | Values | Default |
| --- | --- | --- |
| Global active Runs | `0` unlimited, or `1` to `16` | `6` |
| Active Runs per root | `0` unlimited, or `1` to `8` | `3` |
| Global `max_tool_calls` | `0` unlimited, or `1` to `64` | `16` |
| `max_model_retries` | `-1` unlimited, or `0` to `12` | `5` |
| Conversation context | `off`, `on`, `auto` | `auto` |
| Agent `timeout_ms` | `0` unlimited, or an integer from `30000` to `3600000` | `900000` |

`timeout_ms` measures network-idle time before the first or next stream chunk, not total generation time. Invalid values return `timeout_invalid`.

Model retries cover network, rate-limit, timeout, and temporary service failures. Balance, authentication, parameter, context-limit, and policy failures are not retried. If a failed request may have invoked tools, the next checkpoint first verifies target state.

Task trees support a maximum depth of 8 and 12 direct child Runs per parent Run. A follow-up starts a new root tree.

## Messages And Control

Parent messages enter an Agent at its next checkpoint. `delivered` means the model received the update; `acknowledged` means the model returned the message ID in `message_acks`. Only IDs actually processed should be acknowledged.

Agents may add `outbound_messages` to `COLLABORATION_CONTROL` and target `main`, `parent`, `root`, or another active Agent in the same task tree. Messages to `main` are exposed as `main_messages` in Agent results.

## Persistence And Recovery

SQLite Event Store schema v4 is preferred. Successful responses report the persistence mode and revision; when SQLite is unavailable they report `persistence: "memory"`.

After a runtime restart, queued work is requeued. Eligible read-only work may resume in a new attempt on the same Run. Active writable Runs or Runs with unresolved side effects become `orphaned` instead of being repeated automatically.

## Probe And Gateway

The `tool_lifecycle_probe` subpackage exposes:

- `probe_get_status`, `probe_get_log`, `probe_clear_log`, `probe_get_prompt_compose_log`
- `gateway_register`, `gateway_unregister`, `gateway_status`

Probe buffers are in memory and reset on restart. The gateway uses exact tool names; a non-empty allow list takes precedence and fails closed when the host provides no available-tool list. Collaboration, probe, and gateway controls remain hidden from child-Agent, summary, and finalization contexts through prompt filtering and the IPC execution guard.

## System Prompt Templates

Optional host templates are stored in `prompts/`:

- `prompt-full-zh.md`, `prompt-full-en.md`
- `prompt-read-only-zh.md`, `prompt-read-only-en.md`
- `prompt-mini-zh.md`, `prompt-mini-en.md`

Neither the README files nor these source templates are automatically read or injected at runtime.

## Verification

```bash
npm run typecheck
npm test
```

## License

[GPL-3.0](LICENSE)