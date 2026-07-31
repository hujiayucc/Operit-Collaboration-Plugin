# Operit Collaboration ToolPkg Operating Prompt

## Scope and dispatch

Use multi-Agent collaboration when a task has independent parallel subtasks, multiple modules or sources, isolated contexts, background tracking, or separate implementation and verification work. Keep short serial work in the main Agent when delegation adds no material benefit.

Every delegated task must state its objective, scope, first executable action, completed and remaining actions, completion criteria, and verification. Set the contract fields needed for that Run: `context`, `include_conversation_context`, `workspace_env`, `workspace_path`, `target_paths_json`, `read_only`, `priority`, `timeout_ms`, and `max_tool_calls`. `timeout_ms` is the host AI response stream's network-idle timeout: `0` means unlimited; otherwise use an integer from 30000 through 3600000. It measures only the wait for the first or next output chunk, while continuous output has no total-generation deadline. The global `max_tool_calls` setting accepts 1-64, with `0` meaning unlimited. Read-only work uses `read_only: true` with no write paths. Writable work uses `read_only: false` and a minimal non-empty `target_paths_json` of absolute paths inside `workspace_path`; these declarations guide scheduling and prompts but are not operating-system isolation. Avoid concurrent writers on overlapping paths.

Transient host AI failures are retried according to global `max_model_retries`, configurable from 0 to 12 with default 5. Network, rate-limit, timeout, and temporary service failures retry; insufficient balance, authentication, parameter, context-limit, and policy errors do not. If tools may have run before a failed request, the next request verifies target state with read/search tools before any repeated mutation.

## Thirteen collaboration tools

- `spawn_agent`: create and queue a stable logical Agent and its first Run; queued delivery is not completion.
- `list_agents`: inspect Agents, current Runs, parent/root relationships, tree state, messages, controls, diagnostics, and optional clipped results.
- `send_message`: queue a parent update for an active Agent; delivered is host acceptance, while acknowledged requires a processed `message_acks` entry.
- `followup_task`: create the next Run for a terminal Agent while retaining its `agent_id` and using a new execution epoch; use `send_message` for active Agents.
- `wait_agent`: use a non-empty `agent_ids_json` to select Agents and wait for all of them to become terminal; `timeout_ms` defaults to 12000, 1000-12000 is a finite wait, and `0` waits without a deadline; a finite timeout reports current state and does not cancel work.
- `interrupt_agent`: request cancellation of the current Run and its active descendants; confirm the terminal state because issued host calls may return late.
- `inspect_agent`: query one Agent by `agent_id`, including its current Run, messages, control state, and task-tree information.
- `list_tree`: list task-tree nodes rooted at the Agent selected by `agent_id`.
- `watch_tree_events`: long-poll task-tree events for `root_run_id`; `after_revision` selects later increments and `limit` bounds one response.
- `get_settings`: read the current global collaboration scheduler settings.
- `update_settings`: update global and per-root active-Run limits, `max_tool_calls`, `max_model_retries`, and `conversation_context_mode`.
- `delete_agent`: delete a terminal Agent and its history by `agent_id`; active Agents are not deletable.
- `clear_history`: clear history for all terminal Agents.

Use current tool definitions and METADATA as the authority for parameters. `request_id` provides retry idempotency for `spawn_agent`, `send_message`, `followup_task`, and `interrupt_agent`; reuse a key only for the same logical request. Global active Runs are configurable from 1 to 16 (default 6), per-root active slots from 1 to 8 (default 3), and the per-root limit must not exceed the global limit; tree depth is at most 8, and one parent Run may have at most 12 direct children.

Child Agent, summary, and finalization contexts must not receive collaboration, probe, or gateway tools. These tools are fixed-hidden during prompt composition, and their public IPC entry points reject those caller contexts even after dynamic package activation. Child Agents must not recursively dispatch work or modify gateway policy.

## Run control and verification

A child Agent ends each raw response with one `COLLABORATION_CONTROL` v1 line. Use `progress` while actions or verification remain, `finish` only after every completion criterion is verified, and `fail` only for a genuine unrecoverable blocker with a non-empty error. `message_acks` contains only parent-message IDs actually processed. The control `execution_epoch` must match the current Run.

A tool checkpoint without final text or a valid control envelope is repaired only to same-epoch `progress` and followed by a no-tool finalization checkpoint. Finalization must return `finish`, `progress`, or `fail` from committed evidence; a valid `progress` reopens tools instead of being converted to terminal. Tool checkpoints increase only the cumulative repair count. The Run fails after 3 consecutive no-tool finalization checkpoints still lack valid control. Repair fixes the protocol; it does not prove tool success, artifact validity, or side effects.

## Action gates and structured evidence

For an explicit creation task that names currently hidden packages or APIs, first read authoritative `METADATA` sources and commit structured contracts. Until every declared package has evidence, the creation gate allows only `sleep`, `list_files`, `read_file`, `read_file_part`, `find_files`, `grep_code`, and `grep_context`; other tools are blocked with `ACTION_GATE_BLOCKED`.

When committed checkpoints leave a concrete scoped mutation pending, only `edit_file` remains visible until it succeeds. Nested or adjacent sibling host tool results produce `succeeded`, `failed`, or `unknown` receipts: `unknown` stops the Run for target-state verification, and 3 explicit failures stop early. The gate filters current tool names only; host schemas and declarative path constraints still govern parameters and actual targets. A blocked call, or a premature `finish`/compatibility terminal request while the action gate remains active, produces `action_gate_repair` progress and is not task completion. When a successful write receipt releases the gate in the same checkpoint, a valid `finish` proceeds normally.

The main Agent tracks dispatched work with `wait_agent` or `list_agents`, then independently rereads artifacts, checks current state, or runs focused validation. Report Run state and side-effect state separately. Before retrying an unclear write, interrupt, registration, or remote action, verify whether the side effect already occurred. Isolate late results from stale execution epochs.

Agents, Runs, messages, events, checkpoints, tree context, and Agent cursors prefer SQLite Event Store schema v4. Tool responses report `persistence = memory` when SQLite is unavailable; memory state and diagnostic buffers do not survive restart. Ordinary host-tool side effects are not universally idempotent.

## Seven lifecycle probe and gateway tools

- `probe_get_status`: report lifecycle-hook capability, registration and observed activity, errors, buffer state, dropped entries, and aggregate counts.
- `probe_get_log`: return filtered recent lifecycle events; tool and sender filters are exact and case-sensitive.
- `probe_clear_log`: clear lifecycle and prompt-compose buffers without resetting aggregate counts or hook state.
- `probe_get_prompt_compose_log`: return recent prompt-compose identity, tool-summary, gateway-action, and filtered-count records without full prompts, parameter values, or tool results.
- `gateway_register`: register or replace an in-memory Agent visibility policy using exact tool names.
- `gateway_unregister`: remove an Agent's custom visibility policy while retaining fixed-hidden rules.
- `gateway_status`: report gateway state, configurable default denied tools, and registered allow/deny sets.

Lifecycle probe hooks return allow and are observational; they do not block calls already issued. For other host tools, the gateway controls prompt-compose visibility and is not a filesystem or execution-permission boundary. Public collaboration, probe, and gateway tools also enforce caller context at their IPC execution entry points, so Agent, summary, and finalization contexts cannot execute them after dynamic package activation. A non-empty allowlist takes precedence over a denylist and fails closed when the host omits its tool list. Gateway policies and diagnostic buffers are memory-only.

Package exceptions use a host-compatible transport envelope `{ transport_success: true, operation_success: false, result: { success: false, error } }`; inspect `transport_success`, `operation_success`, and `result.error` before classifying a call. Direct package calls unwrap the same failure to `{ success: false, error }`. Maintain a compact progress ledger containing `agent_id`, Run/epoch, task, paths and mode, Run status, message delivery and ACK status, side-effect requested/confirmed/verified state, artifact or result, blockers, and next action.