<div align="center">

# Multi-Agent Collaboration Orchestrator

Background multi-agent orchestration for Operit

[Project Repository](https://github.com/hujiayucc/Operit-Collaboration-Plugin)

---

**English | [简体中文](README.zh-CN.md)**

</div>

A ToolPkg plugin that provides background multi-agent orchestration for the current parent conversation. It supports analysis, development, review, testing, and background tracking through parent-child delegation, messaging, waiting, follow-up Runs, interruption, a native dashboard, lifecycle diagnostics, and prompt-compose tool filtering. State prefers a SQLite Event Store and explicitly reports an in-memory fallback when SQLite is unavailable. The tool gateway filters Agent-visible tools; it is not an operating-system sandbox and does not intercept calls that have already been issued.

## Subpackages

The plugin contains two subpackages, both enabled by default. Version 1.0.1 also registers the native Compose DSL Multi-Agent Dashboard for inspecting status and task trees and for performing collaboration operations with explicit confirmation where required.

## Native Dashboard (v1.0.1)

The Multi-Agent Dashboard uses `ToolPkg.ipc.call(..., { targetRuntime: "main" })` to operate on the same collaboration manager as the main runtime:

- View status totals, paginated Agents, Agent details, results, recent events, and exact task trees. Structured JSON results render as field cards. Markdown results show a three-line preview and expand into native headings, paragraphs, lists, quotes, separators, and code blocks.
- Create read-only Agents. Writable Agents require both `read_only: false` and non-empty absolute target paths, followed by a confirmation screen.
- Send messages to active Agents while distinguishing queued, delivered, and acknowledged states.
- Perform one bounded wait for an active Agent without permanent polling.
- Start a follow-up Run for a terminal Agent by inheriting permissions, forcing read-only mode, or assigning new write paths. Inherited write permission requires confirmation.
- Show interruption impact before cancelling the current Run, including propagation to active descendants and late-result isolation.
- Configure global active Agents, per-root task-tree concurrency, the tool-call prompt budget, AI retry count, and conversation-context delivery. Global concurrency ranges from 1 to 16; per-root concurrency ranges from 1 to 8 and cannot exceed the global value; the tool-call prompt budget ranges from 1 to 64; AI retries range from 0 to 12. Defaults are 6, 3, 16, and 5. AI retries cover only network, rate-limit, timeout, and temporary service failures, using exponential backoff capped at 16 seconds with jitter. Balance, authentication, parameter, context-limit, and policy failures terminate directly. Lowering concurrency does not interrupt active Agents. Conversation context supports Off, On, and Auto; in Auto mode the caller supplies `include_conversation_context`, while direct dashboard creation conservatively omits context. Only recent user and assistant turns are copied, with at most 40 turns and 32000 characters; system prompts and tool traces are excluded.
- Display checkpoint counts, control status and source, and queued, delivered, and acknowledged message counts. `action_gate_repair` is localized as Action-gate repair.
- Delete only terminal Agents. Clear History removes only terminal Agents outside active task trees. Both operations permanently delete the owned Runs, messages, events, and local ledger records after an irreversible-action confirmation screen.
- Localize fixed UI copy and internal enum values in Chinese and English while preserving actual Agent names, tasks, tool names, paths, and IDs.

The dashboard does not use a WebView, route operations through AI tool calls, access SQLite directly, or use `setInterval`. Unsupported or failed UI registration does not prevent the core collaboration tools from registering.

### Agent Collaboration Tools (`collaboration`)

The subpackage exposes six collaboration interfaces. Agents, Runs, messages, and checkpoints prefer SQLite Event Store schema v3. When SQLite is unavailable, responses explicitly report `persistence: "memory"`.

- `spawn_agent`: Create a stable logical Agent and non-blockingly queue its first Run. Success means only that creation and queuing succeeded. The task should state the objective, scope, first action, remaining work, completion criteria, and verification. Optional `request_id` is a persistent idempotency key scoped to `spawn_agent`, with a maximum of 200 characters. Retrying the same normalized parameters returns the original Agent; conflicting reuse is rejected. Optional `parent_agent_id` binds the child to the parent's current active Run.
- `list_agents`: List Agents in stable `created_at + agent_id` order with opaque cursor pagination. The default page size is 20 and the maximum is 100. Responses include `total`, `has_more`, and `next_cursor`. Supplying `agent_ids_json` ignores pagination and returns existing matches; unknown IDs are ignored.
- `send_message`: Queue a message in an active Agent's persistent inbox. Success means `queued_for_next_checkpoint` only. A message is delivered at the next model checkpoint and becomes acknowledged only when the model returns a control ACK. An unacknowledged message is redelivered at most once. Optional `request_id` prevents duplicate queuing after a caller retry.
- `followup_task`: Create a later Run on a terminal Agent while retaining the `agent_id`, incrementing `run_seq`, and assigning a new execution epoch and root Run. Recent history summaries are injected and unacknowledged messages are requeued. Success means only that the new Run was queued. Omitted write paths inherit prior permissions; an empty array clears them and forces read-only mode.
- `wait_agent`: Wait for all specified Agents to become terminal. The ID array must be non-empty. One call blocks for 1000 to 12000 milliseconds, default 12000. `timed_out=true` means only that the wait expired; it neither fails nor cancels the task.
- `interrupt_agent`: Request cancellation of the current Run and propagate only to its active descendants. Queued Runs stop immediately; running Runs may first enter `cancelling`. A successful response does not prove that the underlying request has stopped, so callers must continue to inspect terminal state. Late results are isolated by execution epoch.

**Control protocol:** A child Agent reports status through a trailing `COLLABORATION_CONTROL` v1 envelope with `progress`, `finish`, or `fail`. `message_acks` may contain only parent message IDs that were actually processed and incorporated into the result. The plugin accepts only the last complete valid envelope and enforces `execution_epoch`. A wrong epoch is isolated as a late result; a damaged or absent envelope is recorded as `invalid` or `not_received` and enters compatibility handling. If a tool checkpoint returns neither final text nor a valid envelope, the runtime repairs it to same-epoch `progress` and opens a no-tool finalization checkpoint. That finalization receives a one-time complete handoff of the immediately preceding raw tool results. The handoff is not character-truncated, exists only in current runtime memory, is excluded from Runs, checkpoints, events, SQLite, and public projections, and is cleared after the finalization request. A safe summary does not prove tool success or task completion. Tool checkpoints increment the cumulative repair count but do not consume the finalization failure budget. A Run fails only after three consecutive no-tool finalization checkpoints still lack a valid envelope. Valid `progress` reopens tools; valid `finish`, or an ordinary final response with no pending tool continuation, completes the Run.

**Persistence:** Agent, Run, and message state is stored as relational projections in the application-private SQLite Event Store schema v3. Events and checkpoints append above a persistent watermark. `run_attempts` retains independent epoch audit projections keyed by Run and attempt, and every commit increments the revision. Each model step stores non-sensitive classification diagnostics such as tool names, character counts, final-text and control-envelope decisions, summary status, and continuation requirements. Raw model responses, tool parameters, and tool-result contents are not persisted. The normal hot path updates only affected Agents, current Runs, and messages in one transaction. `request_ledger` keys entries by operation and `request_id`, committing the business projection and idempotent result together. The store also exposes a side-effect ledger keyed by execution epoch, checkpoint step, operation, and request hash. Recovery blocks automatic retries for `prepared` or `unknown` effects. Host-managed ordinary tool calls are not yet automatically attached to this ledger, so it is not complete idempotency protection for every side effect.

**Model retries:** A host AI request retries transient failures within the same checkpoint. Global `max_model_retries` ranges from 0 to 12 and defaults to 5, counting retries after the initial request. Retryable failures include network or stream interruption, stream network-idle timeout, HTTP 408/409/425/429/5xx, and temporary service unavailability. Backoff starts at one second, caps at 16 seconds, adds 20 percent jitter, and prefers a parseable `Retry-After`. Stream network-idle timeout measures only the wait for the first or next output chunk; continuous output has no total-generation deadline. Balance, authentication, permission, parameter, context-limit, and policy failures are not retried. Each request uses a distinct service key, and retries do not increment action checkpoint count. If tools may have run before failure, the next request first enters a read-only verification gate. Interruption cancels both the current service and any pending backoff wait.

**Scheduling:** Global active Runs are configurable from 1 to 16, default 6. Per-root task-tree slots are configurable from 1 to 8, default 3, and cannot exceed the global limit. Lowering either value affects only future starts. Scheduling rotates across root trees and applies bounded priority aging for high, normal, and low work.

**Task trees:** `parent_agent_id` binds to the parent's exact current Run and persists the parent Run ID, parent epoch, root Agent, root Run ID, and tree depth. Children cannot attach after the parent Run becomes terminal. Maximum tree depth is 8, and each parent Run may have at most 12 direct child Runs. Every follow-up Run becomes a new root tree. Interruption propagates to all active descendants of the current Run: queued descendants become interrupted, running descendants enter cancelling, and terminal descendants and unrelated roots remain unchanged. `list_agents` and `wait_agent` return root-tree, direct-child, total-Run, active-Run, and status aggregation.

**Recovery:** On runtime restart, queued Runs that never started retain their attempt and are requeued. An active read-only Run creates attempt + 1 on the same Run ID and replays context only when its old epoch has no `prepared` or `unknown` effects. Active writable Runs and Runs with unresolved effects are not retried automatically and become `orphaned`. Recovering `cancelling` Runs converge to `interrupted`.

### Tool Lifecycle Probe and Agent Tool Gateway (`tool_lifecycle_probe`)

The subpackage exposes seven diagnostic and management tools:

- `probe_get_status`: Return lifecycle-hook host capability, registration state and errors, a maximum lifecycle buffer of 500 entries, current entry and dropped counts, and process-lifetime aggregate counters. `registration_state` distinguishes `registered`, `active_without_local_registration`, and `not_registered`. `attribution_capability` distinguishes `no_events_observed`, `host_identity_fields_observed`, `host_identity_fields_missing`, and `runtime_agent_callbacks_observed`. `host_lifecycle_events` and `host_identity_bearing_events` describe the host hook, while `runtime_attributed_events` counts Agent tool calls explicitly bound by the collaboration runtime. `attribution_available` is true only after an event has actually been attributed to an Agent or summary; an isolated `invocation_id` does not establish attribution. The plugin does not infer identity from tool names, timing, or the most recent conversation.
- `probe_get_log`: Return recent lifecycle events in chronological order while distinguishing buffer-local `matched` from process-lifetime `total_events`. Entries retain `chat_id`, `proxy_sender_name`, `invocation_id`, and `identity_bearing`, but not complete tool argument or result values.
- `probe_clear_log`: Clear current lifecycle and prompt-compose buffers and return total and per-buffer cleared counts. Aggregate `total_events`, counters, and hook state are preserved.
- `probe_get_prompt_compose_log`: Return up to the latest 50 entries from a 100-entry prompt-compose buffer. Entries include chat ID, identity, input tool names and field summaries, gateway action, and filtered tool count, but not complete system prompts, tool values, or tool results.
- `gateway_register`: Register or replace an in-memory tool policy for one Agent. Filtering uses exact case-sensitive names and does not support wildcards. Unknown names are retained but do not match. Agent and summary contexts cannot call this tool. A non-empty allow list takes precedence; when the host omits `availableTools`, it fails closed to an empty list. An empty allow list does not activate allow-list mode. Invalid JSON returns a structured error.
- `gateway_unregister`: Remove an Agent's custom in-memory policy. Removing a missing policy still succeeds. Default visibility is restored, while fixed hiding of collaboration, probe, and gateway tools remains in effect.
- `gateway_status`: Return the in-memory gateway name, `default_denied_tools`, `fixed_hidden_tools`, `execution_guard`, and sorted allow and deny lists for each registered Agent. `default_denied_tools` is the configurable default deny set; `fixed_hidden_tools` lists plugin tools protected by prompt-compose filtering and the `caller_chat_id` IPC execution guard.

**Probe behavior:** The probe registers tool-lifecycle and prompt-compose hooks and records only tool names, identities, field names, and prompt-composition summaries. It never writes files and never blocks a call. `probe_clear_log` clears both in-memory buffers. All probe state is lost on main-runtime restart. Failures use the host-compatible transport envelope: inspect `transport_success` and `operation_success`, then read the machine-readable error from `result.error`.

**Gateway behavior:** The prompt-compose hook filters available tools for Agent identities recognized by this collaboration runtime. Agent task calls use the `collaboration_agent:<agent_id>` chat ID prefix; summary calls use `collaboration_summary:`; finalization calls use `collaboration_finalize:`; user chats retain UUIDs. Agent, summary, and finalization contexts never see this plugin's collaboration, lifecycle-probe, or gateway tools. Every public plugin-tool wrapper also forwards the host-injected caller chat ID to an IPC execution guard, so dynamically activating a package does not make a fixed-hidden plugin tool executable from those contexts. Agents otherwise receive all host-available non-plugin tools by default because `DEFAULT_DENIED_TOOLS` is empty. A non-empty allow list takes precedence. When the host omits `availableTools`, allow-list mode fails closed to an empty set. Summary and finalization calls receive no tools. User chats are unaffected. The gateway does not provide OS-level isolation for other host tools.

## Task Format

Example `spawn_agent` inputs:

```text
task: "Implement the user endpoint and run the relevant tests"
context: "Preserve the existing response format"
include_conversation_context: true  # In Auto mode, decided by the current AI
workspace_path: "/workspace"
target_paths_json: "[\"/workspace/server\"]"
read_only: false
priority: "normal"
timeout_ms: 900000
```

`timeout_ms` is the host model stream's network-idle timeout. It measures only the wait for the first or next output chunk; continuous output has no total-generation deadline. The value must be an integer from `30000` through `3600000`. `spawn_agent` defaults to `900000`; `followup_task` inherits it when omitted. Out-of-range, fractional, and non-finite values return `timeout_invalid`. `max_tool_calls` is a global dashboard setting from 1 to 64 and applies to every new Run. The same-named spawn and follow-up parameters remain for compatibility but do not override the global value.

Example `target_paths_json`:

```json
["/workspace/server"]
```

Parallel development can assign different modules to separate Agents:

```text
# Agent 1: backend module
task: "Implement the user endpoint and run relevant tests"
target_paths_json: "[\"/workspace/server\"]"
read_only: false

# Agent 2: frontend module
task: "Integrate the user endpoint and verify the build"
target_paths_json: "[\"/workspace/client\"]"
read_only: false

# Agent 3: review
task: "Review the current implementation and report high-risk findings"
target_paths_json: "[\"/workspace\"]"
read_only: true
```

Writable tasks must provide a non-empty `target_paths_json` and set `read_only: false`. Without declared write paths, or with an empty array, the runtime forces read-only mode even when false was requested. Path conflicts are checked during scheduling. Path ownership is then enforced through child-Agent instructions, not operating-system isolation.

## System Prompt Templates

The repository maintains six optional host system-prompt templates:

- `prompts/prompt-full-zh.md`: full Chinese mode with local writes allowed within the assigned scope.
- `prompts/prompt-full-en.md`: full English mode with local writes allowed within the assigned scope.
- `prompts/prompt-read-only-zh.md`: Chinese local read-only mode with local analysis and explicitly permitted remote operations.
- `prompts/prompt-read-only-en.md`: English local read-only mode with local analysis and explicitly permitted remote operations.
- `prompts/prompt-mini-zh.md`: compact Chinese mode containing only this ToolPkg's dispatch, Run/message lifecycle, control envelope, persistence, probe, gateway, and verification rules.
- `prompts/prompt-mini-en.md`: compact English mode covering the same ToolPkg boundaries as its Chinese counterpart.

The two mini templates contain the exact names of all 6 current collaboration tools and all 7 current probe/gateway tools, without legacy aliases or unrelated role, general coding, file, Git, network, or memory-routing instructions.

These templates are for host configuration or manual use. The builder does not package `prompts/`. The archive includes both README files. Actual child-Agent prompts combine the host-provided `SystemPromptConfig.SUBTASK_AGENT_PROMPT_TEMPLATE` with collaboration constraints appended by packaged `src/collaboration/engine.js`; neither README nor the source prompt templates are automatically read or injected at runtime.

Important appended runtime instructions include:

- Use all currently available tools needed to complete the task.
- Read the complete current tool definition and parameter schema before calling a tool.
- Treat currently visible definitions as the authoritative source for tool names, parameters, and behavior; do not rely on hard-coded parameter inventories.
- When describing tools, packages, APIs, configuration, or runtime facts that are absent or fixed-hidden, use only contracts explicitly supplied by the task/context or an accessible authoritative source. Mark missing evidence as unverified instead of reconstructing it from memory.
- A file read-back proves only persisted content; it does not prove an external API name, parameter schema, package contract, configuration fact, or runtime behavior.
- For explicit creation tasks that declare currently unavailable packages or APIs, first commit structured contracts from authoritative `METADATA` sources. Until all declared package contracts are committed, the action gate exposes only `sleep`, `list_files`, `read_file`, `read_file_part`, `find_files`, `grep_code`, and `grep_context`, and blocks creation or other persistent mutation.
- A next-checkpoint pending-mutation gate exposes only `edit_file` when a committed checkpoint contains one concrete pending edit. `inspect_agent` and `list_agents` expose `current_action_gate`, `action_gate_activation_count`, and `action_gate_block_count`; recent events expose `action_gate_activated`, `action_gate_released`, and `action_gate_blocked`. Repeated prompt-compose polling must not duplicate transition events.
- The action gate narrows visible tools only during a new prompt-compose stage. A host call whose tools are already assembled may complete `read_file -> edit_file -> read_file` without an intermediate gate event. Per-invocation enforcement depends on host lifecycle-intercept capability. After the result returns, `action_gate_repair` repairs a violating tool set or premature completion while a gate remains active. The gate filters tool names only; parameter and path rules remain host and prompt contracts.
- Nested or adjacent host results for `edit_file` produce structured `succeeded`, `failed`, or `unknown` receipts. Success releases verification tools; unknown requires target-state verification; three explicit failures terminate early.
- A gate violation or premature `finish` or compatibility completion produces `ACTION_GATE_BLOCKED` with `action_gate_repair`. Normal compliance, or a successful receipt that releases the gate in the current checkpoint, should not produce this repair.
- Correct invalid tool parameters and retry with the corrected call.
- Read back created or edited files for verification.
- Do not call collaboration tools from child Agents.
- Do not stop, restart, force-stop, or kill the Operit host process.
- End responses with a `COLLABORATION_CONTROL` envelope.
- When a tool checkpoint lacks final text, the immediately following no-tool finalization receives a complete, non-character-truncated, memory-only handoff of raw tool results that never enters SQLite, checkpoints, events, or public projections.

## Usage Flow

1. Import the project directory as a ToolPkg or install the `.toolpkg` generated from the project root. Before installing a new build with the same `toolpkg_id` and version, remove or refresh the old package so the host does not retain cached code.
2. Run `node scripts/build-toolpkg.js` to generate `<project-directory>-v<manifest.version>.toolpkg` in the project root. The script minifies only a temporary staged copy and does not rewrite `src/`. Its first invocation may obtain pinned `terser@5.31.6` through `npx`. If the archive already exists, the command reports `skipped: true` and exits successfully without replacing it; after intentional replacement is confirmed, use `node scripts/build-toolpkg.js --replace`.
3. Both subpackages are enabled by default. If they are changed manually, enable at least Agent Collaboration Tools; enable the lifecycle probe and gateway when diagnostics or filtering are required.
4. Call `spawn_agent` from the parent conversation and use `send_message` to provide information at a later checkpoint.
5. Track work with `list_agents` or `wait_agent`.
6. Use `followup_task` after an Agent becomes terminal, or `interrupt_agent` to stop active work.
7. Use `gateway_register` when an Agent requires a narrower visible tool set.

## Runtime Boundaries

- Collaboration state uses the application-private SQLite Event Store schema v3. A legacy snapshot database migrates without deleting `collaboration_snapshot`. Schema v2 atomically gains `run_attempts` and current-attempt projections. Migration failure does not clear the database.
- The six collaboration tools return structured objects on success. Failures use `{ transport_success: true, operation_success: false, result: { success: false, error: { code, message, details } } }` so the host does not collapse details into a generic step error. Direct package calls unwrap the same failure to `{ success: false, error }`.
- Successful collaboration responses report `persistence_model: "event_store"`, `persistence_schema`, `persistence_revision`, and optional `persistence_migration`. Parameter-validation and IPC errors live under `result.error` and do not necessarily include persistence fields.
- Internal prompt echoes are suppressed before storage or public return. At most two independent result summaries run concurrently. A summary uses the same stream network-idle timeout as its Run; a failed or idle-timed-out summary returns the runtime's deterministic report while preserving its status and error diagnostics.
- `EnhancedAIService.sendMessage` is a host-managed complete tool loop. The plugin cannot force one tool per model response. Messages can enter only after the current host call returns at the next checkpoint. A message ACK proves only that the marker was emitted, not absolute comprehension.
- `registerToolLifecycleHook` currently observes events but does not provide an atomic pre-execution reservation and post-execution commit tied to an Agent execution epoch. Ordinary host-managed tools therefore do not automatically enter the side-effect ledger.
- Actual cloud concurrency is subject to provider limits and device resources; concurrent local models may increase memory use.
- The plugin rejects declared overlapping paths between active writable Agents but does not prevent host file or shell tools from accessing undeclared paths.
- `interrupt_agent` releases the corresponding AI service. Immediate cancellation of the underlying network request depends on the provider and host. A late old-epoch result cannot advance the new Run.
- Conversation context is captured by `PromptHistoryHook` during history preparation. The tool prompt-compose hook is responsible only for summary tool removal, the Agent gateway, and diagnostics.
- ToolPkg code and child Agents must not stop, restart, force-stop, kill, or clear the Operit host process or its data.

## Verification

Run these commands from the project root. `node --test test/*.test.js` runs the complete current regression suite; its total test count changes as cases are added.

```bash
node --check scripts/build-toolpkg.js
node --check src/main.js
node --check src/packages/collaboration.js
node --check src/packages/tool_lifecycle_probe.js
node --check src/ui/collaboration_dashboard/index.ui.js
node --check src/ui/collaboration_dashboard/api.js
node --check src/ui/collaboration_dashboard/model.js
node --check src/ui/collaboration_dashboard/components.js
node --check src/ui/collaboration_dashboard/validation.js
node --check src/ui/collaboration_dashboard/request-id.js
node --check src/ui/collaboration_dashboard/i18n.js
node --check src/collaboration/manager.js
node --check src/collaboration/engine.js
node --test test/*.test.js
```

## License

This project is licensed under [GPL-3.0](LICENSE).