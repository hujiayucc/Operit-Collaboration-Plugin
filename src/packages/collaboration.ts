/* METADATA
{
  "name": "collaboration",
  "display_name": {
    "zh": "Agent 协作工具",
    "en": "Agent Collaboration Tools"
  },
  "description": {
    "zh": "提供十三个协作与控制工具，用于创建与跟踪 Agent、投递消息、续接终态 Run、等待、中断、详情与任务树查询、事件监听、设置和历史管理。Agent、Run、消息、检查点、树上下文和 Agent 游标优先持久化到 SQLite Event Store schema v4，SQLite 不可用时响应会标明内存回退。spawn、send、followup 和 interrupt 支持 request_id 幂等；执行 epoch 隔离恢复与迟到结果。全局活动 Run 可配置为 1–16 或 0（不限），单根任务树活动槽可配置为 1–8 或 0（不限）；两者有限时单根上限不高于全局上限。宿主 AI 瞬时故障自动重试 0–12 次，默认 5 次，-1 表示不限；余额、认证、参数和策略错误不重试。写路径和只读标记仅用于调度检查及提示约束，不构成操作系统权限隔离。",
    "en": "Provides thirteen collaboration and control tools for creating and tracking agents, messaging, continuing terminal Runs, waiting, interruption, detail and task-tree queries, event watching, settings, and history management. Agents, Runs, messages, checkpoints, tree context, and Agent cursors prefer SQLite Event Store schema v4, with responses reporting an in-memory fallback when SQLite is unavailable. Spawn, send, follow-up, and interrupt support request_id idempotency; execution epochs isolate recovery and late results. Global active Runs are configurable from 1 to 16 or 0 for unlimited, and per-root active slots from 1 to 8 or 0 for unlimited; when both are finite, the per-root limit cannot exceed the global limit. Transient host AI failures are retried 0-12 times, default 5, with -1 meaning unlimited; balance, authentication, parameter, and policy errors are not retried. Write paths and read-only flags are scheduling and prompt constraints, not OS permission isolation."
  },
  "enabledByDefault": true,
  "category": "System",
  "tools": [
    {
      "name": "spawn_agent",
      "description": {
        "zh": "创建稳定逻辑 Agent，并为 run_seq=1 创建和非阻塞排队首个 Run；返回 delivery=queued 只表示已创建/排队，不表示任务完成。未提供非空 target_paths_json 时自动只读；写路径仅做绝对路径、工作区边界和活动写任务冲突检查，不构成硬权限隔离。全局对话上下文模式为自动时，必须判断任务是否依赖当前对话并设置 include_conversation_context。",
        "en": "Creates a stable logical agent and non-blockingly queues its first Run with run_seq=1. A delivery=queued response means only that creation and queuing succeeded, not that the task is complete. Without a non-empty target_paths_json it is automatically read-only; write paths receive only absolute-path, workspace-boundary, and active-writer conflict checks, not hard permission isolation. When global conversation-context mode is auto, decide whether the task depends on the current conversation and set include_conversation_context accordingly."
      },
      "parameters": [
        { "name": "task", "description": { "zh": "首个任务。必须说明目标、范围、首个可执行动作、剩余步骤、完成判据和验证要求；创建并排队成功不等于任务完成。", "en": "Initial task. State the objective, scope, first executable action, remaining steps, completion criteria, and verification requirements; successful creation and queuing do not mean the task is complete." }, "type": "string", "required": true },
        { "name": "context", "description": { "zh": "任务补充上下文。若任务要求描述 Agent 当前不可见或被固定隐藏的工具、包、API、配置或运行时事实，应在此提供准确契约，或允许 Agent 读取明确的权威源文件；不得要求其凭记忆补全。", "en": "Additional task context. If the task asks the Agent to describe tools, packages, APIs, configuration, or runtime facts that are absent or fixed-hidden from its current tool definitions, provide the accurate contract here or allow access to an explicit authoritative source file; do not require reconstruction from memory." }, "type": "string", "required": false },
        { "name": "include_conversation_context", "description": { "zh": "仅在全局模式为“自动”时生效：由当前 AI 判断是否为任务树绑定主会话引用。启用后每个 Agent 检查点读取该主会话最新的用户/助手历史，不保存 Run 创建时快照；全局“开启/关闭”会覆盖此值。", "en": "Used only when the global mode is Auto: the current AI decides whether to bind the task tree to the main-chat reference. When enabled, every Agent checkpoint reads the latest user/assistant history from that chat instead of storing a Run-creation snapshot. Global On/Off overrides this value." }, "type": "boolean", "required": false },
        { "name": "name", "description": { "zh": "可选的 Agent 显示名。", "en": "Optional agent display name." }, "type": "string", "required": false },
        { "name": "request_id", "description": { "zh": "可选调用方幂等键，作用域为 spawn_agent，最多 200 字符；相同参数重试返回原 Agent，不重复创建；同键不同参数会被拒绝。", "en": "Optional caller idempotency key scoped to spawn_agent, at most 200 characters. Retrying with identical parameters returns the existing agent without duplication; reusing the key with different parameters is rejected." }, "type": "string", "required": false },
        { "name": "parent_agent_id", "description": { "zh": "可选父 Agent ID；必须引用具有活动当前 Run 的逻辑 Agent。子 Run 会绑定父 Run ID/epoch、根 Run 和树深度；父 Run 终态后拒绝挂接。", "en": "Optional parent agent ID; it must reference a logical agent with an active current Run. The child binds to that parent Run ID/epoch, root Run, and tree depth; attachment is rejected after the parent Run is terminal." }, "type": "string", "required": false },
        { "name": "workspace_path", "description": { "zh": "共享工作区绝对路径；提供后 target_paths_json 中每个路径都必须位于其内。", "en": "Absolute shared workspace path; when provided, every target_paths_json entry must be within it." }, "type": "string", "required": false },
        { "name": "workspace_env", "description": { "zh": "工作区环境 android 或 linux；省略或空值时为 android。", "en": "Workspace environment, android or linux; defaults to android when omitted or empty." }, "type": "string", "required": false },
        { "name": "target_paths_json", "description": { "zh": "允许写入的绝对路径 JSON 字符串数组；为空或省略时 Agent 自动只读。仅用于调度检查和提示约束。", "en": "JSON string array of assigned absolute write paths; omitted or empty means the agent is automatically read-only. Used only for scheduling checks and prompt constraints." }, "type": "string", "required": false },
        { "name": "read_only", "description": { "zh": "设为 true 时强制只读；无写路径时即使传 false 也会自动只读。", "en": "When true, forces read-only execution; without write paths the agent remains read-only even if false is supplied." }, "type": "boolean", "required": false },
        { "name": "priority", "description": { "zh": "调度优先级 high、normal 或 low；其他值及空值按 normal 处理。", "en": "Scheduling priority: high, normal, or low; other or empty values are treated as normal." }, "type": "string", "required": false },
        { "name": "timeout_ms", "description": { "zh": "宿主模型流的网络空闲超时：0 表示不限；其他值必须为 30000–3600000 范围内的整数，默认 900000。持续输出不受总生成时长限制。", "en": "Network-idle timeout for the host model stream: 0 means unlimited; otherwise it must be an integer from 30000 through 3600000 ms, default 900000. Continuous output has no total-generation deadline." }, "type": "number", "required": false },
        { "name": "max_tool_calls", "description": { "zh": "兼容参数，当前单次传入值会被全局 max_tool_calls 设置覆盖。请在控制台配置 1–64，或用 0 表示不限；该值只是提示预算，不是宿主工具循环硬上限。", "en": "Compatibility parameter overridden by the global max_tool_calls setting. Configure 1-64 in the dashboard or use 0 for unlimited; it is a prompt budget, not a hard host tool-loop limit." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "list_agents",
      "description": { "zh": "按 created_at + agent_id 稳定排序并用不透明游标分页列出全部或按条件筛选 Agent；指定 agent_ids_json 时忽略分页并返回匹配集合。响应包含 total、has_more、next_cursor、当前 Run、父/根 Run、树聚合、消息与控制状态、最近非敏感模型步骤诊断及可选限长结果。", "en": "Lists all or filtered agents in stable created_at + agent_id order using an opaque cursor. When agent_ids_json is provided, pagination is ignored and the matching set is returned. Responses include total, has_more, next_cursor, current and parent/root Runs, tree aggregation, message/control state, recent non-sensitive model-step diagnostics, and optional clipped results." },
      "parameters": [
        { "name": "agent_ids_json", "description": { "zh": "可选 Agent ID JSON 字符串数组；提供后忽略分页参数并返回当前存在的匹配 Agent，未知 ID 被忽略。", "en": "Optional JSON string array of agent IDs. When present, pagination is ignored and currently existing matches are returned; unknown IDs are ignored." }, "type": "string", "required": false },
        { "name": "status", "description": { "zh": "可选精确状态过滤；常见值为 queued、running、summarizing、cancelling、completed、failed、interrupted、interrupted_with_late_result、timed_out 或 orphaned。未知值不会报错，只会返回空集合。", "en": "Optional exact status filter. Common values are queued, running, summarizing, cancelling, completed, failed, interrupted, interrupted_with_late_result, timed_out, and orphaned. Unknown values do not error; they return an empty set." }, "type": "string", "required": false },
        { "name": "include_results", "description": { "zh": "是否包含限长结果。", "en": "Whether to include clipped results." }, "type": "boolean", "required": false },
        { "name": "limit", "description": { "zh": "每页数量，默认 20，最大 100；0 表示返回全部匹配项。仅普通列表查询有效。", "en": "Page size, default 20 and maximum 100; 0 returns all matching items. Used only for regular list queries." }, "type": "number", "required": false },
        { "name": "cursor", "description": { "zh": "上一页返回的 next_cursor；仅普通列表查询有效。", "en": "The next_cursor returned by the previous page; used only for regular list queries." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "send_message",
      "description": {
        "zh": "向活动 Agent 的持久邮箱排队消息，立即返回 queued_for_next_checkpoint。消息只能在当前宿主调用结束后的下一检查点进入新上下文；宿主接受后计为 delivered，模型返回 ACK 后才计为 acknowledged，未确认最多自动重投一次并返回告警。ACK 是处理证据但不能绝对证明模型理解；终态 Agent 应使用 followup_task。",
        "en": "Queues a message in an active agent's persistent inbox and immediately returns queued_for_next_checkpoint. It enters a new context only at the next checkpoint after the current host call returns. Host acceptance counts as delivered, while a model ACK is required for acknowledged; an unacknowledged message is redelivered at most once and then reported with a warning. An ACK is processing evidence, not absolute proof of understanding; use followup_task for terminal agents."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "message", "description": { "zh": "要投递的消息。", "en": "Message to deliver." }, "type": "string", "required": true },
        { "name": "request_id", "description": { "zh": "可选幂等键，作用域为 send_message，最多 200 字符；相同参数重试返回原 message_id，不重复排队；同键不同参数会被拒绝。", "en": "Optional idempotency key scoped to send_message, at most 200 characters. Identical retries return the original message_id without re-queuing; different parameters with the same key are rejected." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "followup_task",
      "description": {
        "zh": "仅在终态 Agent 上创建并排队新的 Run，保留 Agent ID、递增 run_seq，并使用新的 execution epoch 和根 Run；最近历史摘要会注入新上下文，未确认消息会为后续 Run 重新排队。活动 Agent 使用 send_message。成功只表示新 Run 已排队，不表示任务完成。工作区、写路径、只读、优先级和流网络空闲超时可继承或更新；省略写路径会继承，空数组会清空并自动只读。",
        "en": "Creates and queues a new Run only for a terminal agent, retaining the agent ID while incrementing run_seq and using a new execution epoch and root Run. Recent history summaries are injected into the new context, and unacknowledged messages are re-queued for the follow-up. Use send_message for active agents. Success means only that the new Run was queued, not that the task is complete. Workspace, write paths, read-only mode, priority, and stream network-idle timeout may be inherited or updated; omitted paths inherit, while an empty array clears them and makes the agent read-only."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "task", "description": { "zh": "后续任务。", "en": "Follow-up task." }, "type": "string", "required": true },
        { "name": "request_id", "description": { "zh": "可选幂等键，作用域为 followup_task，最多 200 字符；相同参数重试返回原 Run，不重复创建；同键不同参数会被拒绝。", "en": "Optional idempotency key scoped to followup_task, at most 200 characters. Identical retries return the original Run without creating another; different parameters with the same key are rejected." }, "type": "string", "required": false },
        { "name": "context", "description": { "zh": "补充上下文。若任务要求描述 Agent 当前不可见或被固定隐藏的工具、包、API、配置或运行时事实，应在此提供准确契约，或允许 Agent 读取明确的权威源文件；不得要求其凭记忆补全。", "en": "Additional context. If the task asks the Agent to describe tools, packages, APIs, configuration, or runtime facts that are absent or fixed-hidden from its current tool definitions, provide the accurate contract here or allow access to an explicit authoritative source file; do not require reconstruction from memory." }, "type": "string", "required": false },
        { "name": "include_conversation_context", "description": { "zh": "仅在全局模式为“自动”时生效：决定新根 Run 是否继续绑定主会话引用。启用后每个检查点读取该主会话最新的用户/助手历史，不保存快照；全局“开启/关闭”会覆盖此值。", "en": "Used only when the global mode is Auto: decides whether the new root Run keeps the main-chat reference. When enabled, every checkpoint reads the latest user/assistant history from that chat instead of storing a snapshot. Global On/Off overrides this value." }, "type": "boolean", "required": false },
        { "name": "workspace_path", "description": { "zh": "可选新工作区绝对路径；省略或空值时继承原值。提供后所有写路径必须位于其内。", "en": "Optional new absolute workspace path; omitted or empty inherits the prior value. All write paths must be within it when provided." }, "type": "string", "required": false },
        { "name": "workspace_env", "description": { "zh": "可选工作区环境 android 或 linux；省略或空值时继承原值。", "en": "Optional workspace environment, android or linux; omitted or empty inherits the prior value." }, "type": "string", "required": false },
        { "name": "target_paths_json", "description": { "zh": "可选新写入路径 JSON 字符串数组；省略时继承原路径，空数组时清空并自动只读。仅为声明式约束。", "en": "Optional JSON string array of new write paths; omitted inherits existing paths, while an empty array clears them and makes the agent read-only. Declarative only." }, "type": "string", "required": false },
        { "name": "read_only", "description": { "zh": "可选只读设置；省略时通常继承，但显式提供新路径时会按路径是否为空重新推导。", "en": "Optional read-only setting; normally inherited when omitted, but explicitly supplied new paths re-derive it from whether those paths are empty." }, "type": "boolean", "required": false },
        { "name": "priority", "description": { "zh": "可选 high、normal 或 low；省略或空值时继承原优先级，其他非空值按 normal。", "en": "Optional high, normal, or low; omitted or empty inherits the prior priority, while other non-empty values become normal." }, "type": "string", "required": false },
        { "name": "timeout_ms", "description": { "zh": "可选宿主模型流网络空闲超时：0 表示不限；其他值必须为 30000–3600000 范围内的整数；省略时继承。", "en": "Optional host model stream network-idle timeout: 0 means unlimited; otherwise it must be an integer from 30000 through 3600000 ms. Omission inherits the prior value." }, "type": "number", "required": false },
        { "name": "max_tool_calls", "description": { "zh": "兼容参数，由全局 max_tool_calls 覆盖；全局可配置 1–64 或 0（不限）。", "en": "Compatibility parameter overridden by global max_tool_calls; the global value may be 1-64 or 0 for unlimited." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "wait_agent",
      "description": { "zh": "等待所有指定 Agent 进入终态并返回结果。timeout_ms 默认 12000；1000–12000 为有限等待，0 表示不限时等待。timed_out=true 只表示本次有限等待到期。", "en": "Waits until all selected Agents are terminal and returns their results. timeout_ms defaults to 12000; 1000-12000 is a finite wait and 0 waits without a deadline. timed_out=true only means a finite wait expired." },
      "parameters": [
        { "name": "agent_ids_json", "description": { "zh": "非空 Agent ID JSON 字符串数组；等待所有指定 Agent 进入终态。", "en": "Non-empty JSON string array of agent IDs; waits for all specified agents to become terminal." }, "type": "string", "required": true },
        { "name": "timeout_ms", "description": { "zh": "0 表示不限时等待；其他值为 1000–12000，默认 12000。", "en": "0 waits without a deadline; otherwise use 1000-12000, default 12000." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "interrupt_agent",
      "description": {
        "zh": "请求中断 Agent 当前 Run，并仅向该 Run 的活动后代传播取消。queued 会立即变为 interrupted；running 可能先变为 cancelling，成功返回不代表底层调用已停止，应继续用 list_agents 或 wait_agent 确认终态。已发出的宿主调用可能迟到；迟到结果按 execution epoch 隔离并记录为 interrupted_with_late_result。终态 Agent 返回 already_terminal。",
        "en": "Requests interruption of the agent's current Run and propagates cancellation only to active descendants of that Run. Queued work becomes interrupted immediately; running work may first become cancelling. A successful request does not mean the underlying call has stopped; use list_agents or wait_agent to confirm the terminal state. An issued host call may return late; its result is isolated by execution epoch and recorded as interrupted_with_late_result. Terminal agents return already_terminal."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "request_id", "description": { "zh": "可选幂等键，作用域为 interrupt_agent，最多 200 字符；相同参数重试返回原中断结果，不重复产生取消事件；同键不同参数会被拒绝。", "en": "Optional idempotency key scoped to interrupt_agent, at most 200 characters. Identical retries return the original interruption result without duplicate cancellation events; different parameters with the same key are rejected." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "inspect_agent",
      "description": { "zh": "查询单个 Agent 的详细状态，包含当前 Run、消息与控制状态、树信息。", "en": "Queries detailed state of a single agent, including current Run, message and control state, and tree info." },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true }
      ]
    },
    {
      "name": "list_tree",
      "description": { "zh": "列出以指定 Agent 为根的任务树节点。", "en": "Lists task-tree nodes rooted at the specified agent." },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true }
      ]
    },
    {
      "name": "watch_tree_events",
      "description": { "zh": "长轮询：等待任务树事件，有新事件或超时后返回增量列表。", "en": "Long-poll: waits for task-tree events and returns an incremental list when new events arrive or the poll times out." },
      "parameters": [
        { "name": "root_run_id", "description": { "zh": "要监听的根 Run ID。", "en": "Root Run ID to watch." }, "type": "string", "required": true },
        { "name": "after_revision", "description": { "zh": "仅返回此修订号之后的事件。", "en": "Return only events after this revision number." }, "type": "number", "required": false },
        { "name": "limit", "description": { "zh": "单次最多返回的事件数。", "en": "Maximum number of events to return per poll." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "get_settings",
      "description": { "zh": "读取当前协作调度器全局设置。", "en": "Reads the current collaboration orchestrator global settings." },
      "parameters": []
    },
    {
      "name": "update_settings",
      "description": { "zh": "更新协作调度器全局设置。", "en": "Updates collaboration orchestrator global settings." },
      "parameters": [
        { "name": "max_concurrent_agents", "description": { "zh": "全局最大活动 Run 数，0 表示不限。", "en": "Global maximum active Runs; 0 means unlimited." }, "type": "number", "required": true },
        { "name": "max_active_runs_per_root", "description": { "zh": "单根任务树最大活动 Run 数，0 表示不限。", "en": "Maximum active Runs per root task tree; 0 means unlimited." }, "type": "number", "required": false },
        { "name": "max_tool_calls", "description": { "zh": "单次 Run 的最大工具调用数，0 表示不限。", "en": "Maximum tool calls per Run; 0 means unlimited." }, "type": "number", "required": true },
        { "name": "max_model_retries", "description": { "zh": "AI 服务瞬时失败的最大重试次数，-1 表示不限。", "en": "Maximum retries for transient AI service failures; -1 means unlimited." }, "type": "number", "required": false },
        { "name": "conversation_context_mode", "description": { "zh": "对话上下文模式：off、on 或 auto。", "en": "Conversation-context mode: off, on, or auto." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "delete_agent",
      "description": { "zh": "删除已终止的 Agent 及其历史记录。", "en": "Deletes a terminal agent and its history." },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true }
      ]
    },
    {
      "name": "clear_history",
      "description": { "zh": "清除所有已终止 Agent 的历史记录。", "en": "Clears history for all terminal agents." },
      "parameters": []
    }
  ]
}
*/

import {
  CHANNELS,
  asText,
  parseOptionalStringArray,
  toolFailure,
} from "../protocol.js";

type ToolParams = Record<string, unknown>;
interface TransportFailure {
  success: false;
  error: string;
  [key: string]: unknown;
}

type TransportSuccess = Record<string, unknown> & {
  success?: true;
};

type ToolResult = TransportFailure | TransportSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callerChatId(params: ToolParams): string {
  return asText(params.__operit_package_chat_id).trim();
}

function callMain(channel: string, payload: ToolParams, params: ToolParams): Promise<ToolResult> {
  return ToolPkg.ipc.call(channel, {
    ...payload,
    caller_chat_id: callerChatId(params || {}),
  });
}

function toolOutcome(result: ToolResult): unknown {
  return result && result.transport_success === true && result.operation_success === false
    ? result.result
    : result;
}

async function safely(operation: string, action: () => Promise<ToolResult>): Promise<unknown> {
  try {
    return toolOutcome(await action());
  } catch (error) {
    return toolFailure(error, operation);
  }
}

function executionOptions(params: ToolParams): ToolParams {
  const payload: ToolParams = {
    context: asText(params.context).trim(),
    include_conversation_context: params.include_conversation_context === true,
    workspace_path: asText(params.workspace_path).trim(),
    workspace_env: asText(params.workspace_env).trim(),
    read_only: params.read_only,
    priority: asText(params.priority).trim(),
    timeout_ms: params.timeout_ms,
    max_tool_calls: params.max_tool_calls,
  };
  const paths = parseOptionalStringArray(params.target_paths_json, "target_paths_json");
  if (paths !== undefined) payload.target_paths = paths;
  return payload;
}

export async function spawn_agent(params: ToolParams): Promise<unknown> {
  return safely("spawn_agent", () => callMain(CHANNELS.SPAWN_AGENT, {
    task: asText(params.task).trim(),
    name: asText(params.name).trim(),
    request_id: asText(params.request_id).trim(),
    parent_agent_id: asText(params.parent_agent_id).trim(),
    parent_chat_id: callerChatId(params),
    ...executionOptions(params),
  }, params));
}

export async function list_agents(params: ToolParams): Promise<unknown> {
  return safely("list_agents", () => callMain(CHANNELS.LIST_AGENTS, {
    agent_ids: parseOptionalStringArray(params.agent_ids_json, "agent_ids_json"),
    status: asText(params.status).trim(),
    include_results: params.include_results === true,
    limit: params.limit,
    cursor: asText(params.cursor).trim(),
  }, params));
}

export async function send_message(params: ToolParams): Promise<unknown> {
  return safely("send_message", () => callMain(CHANNELS.SEND_MESSAGE, {
    agent_id: asText(params.agent_id).trim(),
    message: asText(params.message).trim(),
    request_id: asText(params.request_id).trim(),
  }, params));
}

export async function followup_task(params: ToolParams): Promise<unknown> {
  return safely("followup_task", () => callMain(CHANNELS.FOLLOWUP_TASK, {
    agent_id: asText(params.agent_id).trim(),
    task: asText(params.task).trim(),
    request_id: asText(params.request_id).trim(),
    parent_chat_id: callerChatId(params),
    ...executionOptions(params),
  }, params));
}

export async function wait_agent(params: ToolParams): Promise<unknown> {
  return safely("wait_agent", () => callMain(CHANNELS.WAIT_AGENT, {
    agent_ids: parseOptionalStringArray(params.agent_ids_json, "agent_ids_json"),
    timeout_ms: params.timeout_ms,
  }, params));
}
export async function interrupt_agent(params: ToolParams): Promise<unknown> {
  return safely("interrupt_agent", () => callMain(CHANNELS.INTERRUPT_AGENT, {
    agent_id: asText(params.agent_id).trim(),
    request_id: asText(params.request_id).trim(),
  }, params));
}

export async function inspect_agent(params: ToolParams): Promise<unknown> {
  return safely("inspect_agent", () => callMain(CHANNELS.INSPECT_AGENT, {
    agent_id: asText(params.agent_id).trim(),
  }, params));
}

export async function list_tree(params: ToolParams): Promise<unknown> {
  return safely("list_tree", () => callMain(CHANNELS.LIST_TREE, {
    agent_id: asText(params.agent_id).trim(),
  }, params));
}

export async function watch_tree_events(params: ToolParams): Promise<unknown> {
  return safely("watch_tree_events", () => callMain(CHANNELS.WATCH_TREE_EVENTS, {
    root_run_id: asText(params.root_run_id).trim(),
    after_revision: params.after_revision,
    limit: params.limit,
  }, params));
}

export async function get_settings(params: ToolParams): Promise<unknown> {
  return safely("get_settings", () => callMain(CHANNELS.GET_SETTINGS, {}, params));
}

export async function update_settings(params: ToolParams): Promise<unknown> {
  return safely("update_settings", () => callMain(CHANNELS.UPDATE_SETTINGS, {
    max_concurrent_agents: params.max_concurrent_agents,
    max_active_runs_per_root: params.max_active_runs_per_root,
    max_tool_calls: params.max_tool_calls,
    max_model_retries: params.max_model_retries,
    conversation_context_mode: asText(params.conversation_context_mode).trim(),
  }, params));
}

export async function delete_agent(params: ToolParams): Promise<unknown> {
  return safely("delete_agent", () => callMain(CHANNELS.DELETE_AGENT, {
    agent_id: asText(params.agent_id).trim(),
  }, params));
}

export async function clear_history(params: ToolParams): Promise<unknown> {
  return safely("clear_history", () => callMain(CHANNELS.CLEAR_HISTORY, {}, params));
}


export {};