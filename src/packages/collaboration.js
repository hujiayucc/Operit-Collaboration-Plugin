/* METADATA
{
  "name": "collaboration",
  "display_name": {
    "zh": "Agent 协作工具",
    "en": "Agent Collaboration Tools"
  },
  "description": {
    "zh": "提供六个独立实现的协作接口，基于 SQLite Event Store schema v3 持久化。支持多 Agent 并行调度、父子任务委托、消息传递、中断和后续任务，含 request_id 幂等、副作用幂等和执行 epoch 恢复。全局最多 6 个活动 Run，单根最多 3 个。",
    "en": "Provides six independently-implemented collaboration APIs with SQLite Event Store schema v3 persistence. Supports parallel multi-agent scheduling, parent-child task delegation, messaging, interruption, and follow-up tasks, with request_id idempotency, side-effect idempotency, and execution-epoch recovery. Global concurrency six, per-root three."
  },
  "enabledByDefault": true,
  "category": "System",
  "tools": [
    {
      "name": "spawn_agent",
      "description": {
        "zh": "创建稳定逻辑 Agent，创建 run_seq=1 的首个 Run 并非阻塞排队，立即返回 Agent/Run 状态。未提供非空 target_paths_json 时自动只读；写路径仅做绝对路径、工作区边界和活动写任务冲突检查，不构成硬权限隔离。",
        "en": "Creates a stable logical agent, creates its first run with run_seq=1, queues it without blocking, and immediately returns agent/run status. Without a non-empty target_paths_json it is automatically read-only; write paths receive only absolute-path, workspace-boundary, and active-writer conflict checks, not hard permission isolation."
      },
      "parameters": [
        { "name": "task", "description": { "zh": "首个任务。", "en": "Initial task." }, "type": "string", "required": true },
        { "name": "context", "description": { "zh": "任务补充上下文。", "en": "Additional task context." }, "type": "string", "required": false },
        { "name": "name", "description": { "zh": "可选的 Agent 显示名。", "en": "Optional agent display name." }, "type": "string", "required": false },
        { "name": "request_id", "description": { "zh": "可选调用方幂等键；相同参数重试返回原 Agent，不重复创建；同键不同参数会被拒绝。", "en": "Optional caller idempotency key. Retrying with identical parameters returns the existing agent without duplication; reusing the key with different parameters is rejected." }, "type": "string", "required": false },
        { "name": "parent_agent_id", "description": { "zh": "可选父 Agent ID；必须引用具有活动当前 Run 的逻辑 Agent。子 Run 会绑定父 Run ID/epoch、根 Run 和树深度；父 Run 终态后拒绝挂接。", "en": "Optional parent agent ID; it must reference a logical agent with an active current Run. The child binds to that parent Run ID/epoch, root Run, and tree depth; attachment is rejected after the parent Run is terminal." }, "type": "string", "required": false },
        { "name": "workspace_path", "description": { "zh": "共享工作区绝对路径；提供后 target_paths_json 中每个路径都必须位于其内。", "en": "Absolute shared workspace path; when provided, every target_paths_json entry must be within it." }, "type": "string", "required": false },
        { "name": "workspace_env", "description": { "zh": "工作区环境 android 或 linux；省略或空值时为 android。", "en": "Workspace environment, android or linux; defaults to android when omitted or empty." }, "type": "string", "required": false },
        { "name": "target_paths_json", "description": { "zh": "允许写入的绝对路径 JSON 字符串数组；为空或省略时 Agent 自动只读。仅用于调度检查和提示约束。", "en": "JSON string array of assigned absolute write paths; omitted or empty means the agent is automatically read-only. Used only for scheduling checks and prompt constraints." }, "type": "string", "required": false },
        { "name": "read_only", "description": { "zh": "设为 true 时强制只读；无写路径时即使传 false 也会自动只读。", "en": "When true, forces read-only execution; without write paths the agent remains read-only even if false is supplied." }, "type": "boolean", "required": false },
        { "name": "priority", "description": { "zh": "调度优先级 high、normal 或 low；其他值及空值按 normal 处理。", "en": "Scheduling priority: high, normal, or low; other or empty values are treated as normal." }, "type": "string", "required": false },
        { "name": "timeout_ms", "description": { "zh": "每次宿主模型调用的超时，范围 30000–3600000 毫秒，默认 900000。", "en": "Timeout for each host model call, clamped to 30000-3600000 ms; default 900000." }, "type": "number", "required": false },
        { "name": "max_tool_calls", "description": { "zh": "写入提示词的建议工具调用数，范围 1–50，默认 16；不是宿主工具循环的硬上限。", "en": "Suggested tool-call count written into the prompt, clamped to 1-50; default 16. It is not a hard host tool-loop limit." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "list_agents",
      "description": { "zh": "按稳定游标分页列出全部或按条件筛选 Agent；指定 agent_ids_json 时完整返回指定集合。响应包含 total、has_more、next_cursor、当前 Run、父/根 Run、树聚合、消息与控制状态及可选限长结果。", "en": "Lists all or filtered agents with stable cursor pagination; agent_ids_json returns the complete selected set. Responses include total, has_more, next_cursor, current and parent/root Runs, tree aggregation, message/control state, and optional clipped results." },
      "parameters": [
        { "name": "agent_ids_json", "description": { "zh": "可选 Agent ID JSON 字符串数组；提供后忽略分页参数并完整返回指定集合。", "en": "Optional JSON string array of agent IDs; when present, pagination is ignored and the complete selected set is returned." }, "type": "string", "required": false },
        { "name": "status", "description": { "zh": "可选状态过滤。", "en": "Optional status filter." }, "type": "string", "required": false },
        { "name": "include_results", "description": { "zh": "是否包含限长结果。", "en": "Whether to include clipped results." }, "type": "boolean", "required": false },
        { "name": "limit", "description": { "zh": "每页数量，默认 20，最大 100；仅普通列表查询有效。", "en": "Page size, default 20 and maximum 100; used only for regular list queries." }, "type": "number", "required": false },
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
        { "name": "request_id", "description": { "zh": "可选幂等键；相同参数重试返回原 message_id，不重复排队。", "en": "Optional idempotency key; identical retries return the original message_id without re-queuing." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "followup_task",
      "description": {
        "zh": "仅在 completed、failed、interrupted、interrupted_with_late_result、timed_out 或 orphaned 等终态 Agent 上创建下一 Run；保留同一 Agent ID，run_seq 加一，并向新上下文注入最近历史 Run 摘要。活动 Agent 应使用 send_message。可选参数用于继承或更新工作区、写路径、只读、优先级和提示限制。",
        "en": "Creates the next run only for terminal agents such as completed, failed, interrupted, interrupted_with_late_result, timed_out, or orphaned. It retains the same agent ID, increments run_seq, and injects recent run summaries into the new context. Use send_message for active agents. Optional parameters inherit or update workspace, write paths, read-only mode, priority, and prompt limits."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "task", "description": { "zh": "后续任务。", "en": "Follow-up task." }, "type": "string", "required": true },
        { "name": "request_id", "description": { "zh": "可选幂等键；相同参数重试返回原 Run，不重复创建 follow-up。", "en": "Optional idempotency key; identical retries return the original Run without creating another follow-up." }, "type": "string", "required": false },
        { "name": "context", "description": { "zh": "补充上下文。", "en": "Additional context." }, "type": "string", "required": false },
        { "name": "workspace_path", "description": { "zh": "可选新工作区绝对路径；省略或空值时继承原值。提供后所有写路径必须位于其内。", "en": "Optional new absolute workspace path; omitted or empty inherits the prior value. All write paths must be within it when provided." }, "type": "string", "required": false },
        { "name": "workspace_env", "description": { "zh": "可选工作区环境 android 或 linux；省略或空值时继承原值。", "en": "Optional workspace environment, android or linux; omitted or empty inherits the prior value." }, "type": "string", "required": false },
        { "name": "target_paths_json", "description": { "zh": "可选新写入路径 JSON 字符串数组；省略时继承原路径，空数组时清空并自动只读。仅为声明式约束。", "en": "Optional JSON string array of new write paths; omitted inherits existing paths, while an empty array clears them and makes the agent read-only. Declarative only." }, "type": "string", "required": false },
        { "name": "read_only", "description": { "zh": "可选只读设置；省略时通常继承，但显式提供新路径时会按路径是否为空重新推导。", "en": "Optional read-only setting; normally inherited when omitted, but explicitly supplied new paths re-derive it from whether those paths are empty." }, "type": "boolean", "required": false },
        { "name": "priority", "description": { "zh": "可选 high、normal 或 low；省略或空值时继承原优先级，其他非空值按 normal。", "en": "Optional high, normal, or low; omitted or empty inherits the prior priority, while other non-empty values become normal." }, "type": "string", "required": false },
        { "name": "timeout_ms", "description": { "zh": "可选每次宿主模型调用超时，范围 30000–3600000 毫秒；省略时继承。", "en": "Optional timeout for each host model call, clamped to 30000-3600000 ms; omitted inherits the prior value." }, "type": "number", "required": false },
        { "name": "max_tool_calls", "description": { "zh": "可选提示用建议工具调用数，范围 1–50；省略时继承，不是硬上限。", "en": "Optional suggested prompt tool-call count, clamped to 1-50; omitted inherits the prior value and it is not a hard limit." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "wait_agent",
      "description": { "zh": "等待一个或多个 Agent 进入终态并返回各自限长结果和当前精确根 Run 的树状态聚合。单次阻塞 1000–12000 毫秒，默认 12000；超时返回 timed_out=true 和当前状态，不会取消任务，可重复调用。", "en": "Waits for one or more agents to become terminal and returns each clipped result plus tree aggregation for its exact current root Run. A call blocks for 1000-12000 ms, default 12000; timeout returns timed_out=true with current status, does not cancel work, and may be repeated." },
      "parameters": [
        { "name": "agent_ids_json", "description": { "zh": "Agent ID JSON 字符串数组。", "en": "JSON string array of agent IDs." }, "type": "string", "required": true },
        { "name": "timeout_ms", "description": { "zh": "1000-12000，默认 12000。", "en": "1000-12000; defaults to 12000." }, "type": "number", "required": false }
      ]
    },
    {
      "name": "interrupt_agent",
      "description": {
        "zh": "请求中断指定 Agent 的当前 Run，并仅向该 Run 的活动后代传播取消。queued Run/后代立即转为 interrupted；running Run/后代先转为 cancelling 并释放 AI service，但宿主请求可能不可立即取消。终态后代、历史 Run 和其他根树不受影响。若旧调用随后返回，结果会按 execution epoch 隔离并记录为 interrupted_with_late_result；已处于终态时返回 already_terminal。",
        "en": "Requests interruption of the agent's current Run and propagates cancellation only to active descendants of that Run. Queued Runs/descendants immediately become interrupted; running Runs/descendants first become cancelling and release their AI services, but host requests may not stop immediately. Terminal descendants, historical Runs, and other root trees are unaffected. If an old call later returns, its result is isolated by execution epoch and recorded as interrupted_with_late_result; an already terminal agent returns already_terminal."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "request_id", "description": { "zh": "可选幂等键；相同参数重试返回原中断结果，不重复产生取消事件。", "en": "Optional idempotency key; identical retries return the original interruption result without duplicate cancellation events." }, "type": "string", "required": false }
      ]
    }
  ]
}
*/

const {
  CHANNELS,
  IPC_OPTIONS,
  asText,
  formatJson,
  parseOptionalStringArray,
} = require("../protocol.js");

function callerChatId(params) {
  return asText(params.__operit_package_chat_id).trim();
}

async function callMain(channel, payload) {
  return ToolPkg.ipc.call(channel, payload, IPC_OPTIONS);
}

async function safely(action) {
  try {
    return formatJson(await action());
  } catch (error) {
    return formatJson({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function executionOptions(params) {
  const payload = {
    context: asText(params.context).trim(),
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

async function spawn_agent(params) {
  return safely(() => callMain(CHANNELS.SPAWN_AGENT, {
    task: asText(params.task).trim(),
    name: asText(params.name).trim(),
    request_id: asText(params.request_id).trim(),
    parent_agent_id: asText(params.parent_agent_id).trim(),
    parent_chat_id: callerChatId(params),
    ...executionOptions(params),
  }));
}

async function list_agents(params) {
  return safely(() => callMain(CHANNELS.LIST_AGENTS, {
    agent_ids: parseOptionalStringArray(params.agent_ids_json, "agent_ids_json"),
    status: asText(params.status).trim(),
    include_results: params.include_results === true,
    limit: params.limit,
    cursor: asText(params.cursor).trim(),
  }));
}

async function send_message(params) {
  return safely(() => callMain(CHANNELS.SEND_MESSAGE, {
    agent_id: asText(params.agent_id).trim(),
    message: asText(params.message).trim(),
    request_id: asText(params.request_id).trim(),
  }));
}

async function followup_task(params) {
  return safely(() => callMain(CHANNELS.FOLLOWUP_TASK, {
    agent_id: asText(params.agent_id).trim(),
    task: asText(params.task).trim(),
    request_id: asText(params.request_id).trim(),
    ...executionOptions(params),
  }));
}

async function wait_agent(params) {
  return safely(() => callMain(CHANNELS.WAIT_AGENT, {
    agent_ids: parseOptionalStringArray(params.agent_ids_json, "agent_ids_json"),
    timeout_ms: params.timeout_ms,
  }));
}

async function interrupt_agent(params) {
  return safely(() => callMain(CHANNELS.INTERRUPT_AGENT, {
    agent_id: asText(params.agent_id).trim(),
    request_id: asText(params.request_id).trim(),
  }));
}

module.exports = {
  followup_task,
  interrupt_agent,
  list_agents,
  send_message,
  spawn_agent,
  wait_agent,
};