"use strict";

// Compose DSL runtime dependencies are intentionally inlined: loading another
// script from this entry makes the host treat that script as a render entry.
const CHANNELS = Object.freeze({
  SPAWN_AGENT: "collaboration.spawn_agent",
  LIST_AGENTS: "collaboration.list_agents",
  SEND_MESSAGE: "collaboration.send_message",
  FOLLOWUP_TASK: "collaboration.followup_task",
  WAIT_AGENT: "collaboration.wait_agent",
  INTERRUPT_AGENT: "collaboration.interrupt_agent",
  INSPECT_AGENT: "collaboration.inspect_agent",
  LIST_TREE: "collaboration.list_tree",
  GET_SETTINGS: "collaboration.get_settings",
  UPDATE_SETTINGS: "collaboration.update_settings",
  DELETE_AGENT: "collaboration.delete_agent",
  CLEAR_HISTORY: "collaboration.clear_history",
});

const IPC_OPTIONS = Object.freeze({ targetRuntime: "main" });
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);
const ACTIVE_STATUSES = new Set(["queued", "running", "summarizing"]);
const STATUS_FILTER_VALUES = Object.freeze([
  "",
  "queued",
  "running",
  "summarizing",
  "cancelling",
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);
const SHAPE_SMALL = Object.freeze({ type: "rounded", cornerRadius: 6 });
const SHAPE_MEDIUM = Object.freeze({ type: "rounded", cornerRadius: 8 });
const SHAPE_LARGE = Object.freeze({ type: "rounded", cornerRadius: 8 });
const SHAPE_PILL = Object.freeze({ type: "pill" });
const CARD_BORDER = Object.freeze({ width: 1, color: "outlineVariant" });
const STATUS_FILTER_ROWS = Object.freeze([
  ["", "queued"],
  ["running", "summarizing"],
  ["cancelling", "completed"],
  ["failed", "interrupted"],
  ["interrupted_with_late_result"],
  ["timed_out"],
]);

const TEXT = {
  zh: {
    title: "多 Agent 控制台",
    subtitle: "查看任务树、创建 Agent、发送消息、等待、续接和中断运行。",
    refresh: "刷新",
    create: "创建 Agent",
    back: "返回",
    loadMore: "加载更多",
    allStatuses: "全部状态",
    active: "活动",
    queued: "排队",
    total: "总计",
    noAgents: "暂无 Agent",
    details: "详情",
    message: "发送消息",
    wait: "等待更新",
    followup: "后续运行",
    interrupt: "中断",
    clearHistory: "清理历史",
    delete: "删除",
    clearHistoryWarning: "将永久删除所有不属于活动任务树的终态 Agent 及其运行、消息、事件和本地账本记录。此操作无法撤销。",
    deleteAgentWarning: "将永久删除此终态 Agent 及其运行、消息、事件和本地账本记录。此操作无法撤销。",
    confirm: "确认执行",
    cancel: "取消",
    submit: "提交",
    readOnly: "只读",
    writable: "可写",
    inherit: "继承上次权限",
    forceReadOnly: "强制只读",
    specifyWrite: "重新指定可写路径",
    pathsHint: "每行一个绝对路径",
    writeWarning: "路径限制是声明式约束，不是操作系统级隔离。",
    interruptWarning: "中断会传播到当前运行的活动后代；底层网络请求可能不会立即停止。",
    inheritedWriteWarning: "此次后续运行将继承可写权限，请确认工作区与目标路径。",
    queuedMessage: "消息已排队，等待下一检查点；已送达不代表已确认。",
    waitTimeout: "此次等待超时，Agent 仍可能继续运行。",
    loading: "处理中…",
    name: "名称",
    task: "任务",
    context: "补充上下文",
    parentAgentId: "父 Agent ID（可选）",
    workspacePath: "工作区绝对路径",
    workspaceEnv: "工作区环境",
    targetPaths: "目标路径",
    priority: "优先级",
    timeoutMs: "流网络空闲超时（毫秒）",
    globalSettings: "全局运行设置",
    maxConcurrentAgents: "全局最大并发 Agent 数",
    maxConcurrentAgentsHint: "范围 1–16；降低后不会中断正在运行的 Agent，只限制后续启动。",
    maxActiveRunsPerRoot: "单根任务树并发上限",
    maxActiveRunsPerRootHint: "范围 1–8，且不高于全局并发数；降低后只限制后续启动。",
    maxToolCalls: "全局工具调用数",
    maxToolCallsHint: "范围 1–64；统一应用到所有新运行，属于 Agent 提示预算。",
    maxModelRetries: "AI 调用重试次数",
    maxModelRetriesHint: "范围 0–12，默认 5；仅重试网络、限流和服务临时异常，余额、认证、参数和策略错误直接结束。",
    conversationContext: "传递当前对话上下文",
    conversationContextHint: "仅复制最近的用户/助手对话，不包含系统提示和工具轨迹；自动模式由调用 AI 决定，控制台直接创建时不传递。",
    conversationContextOptions: { off: "关闭", on: "开启", auto: "自动" },
    saveSettings: "保存全局设置",
    settingsSaved: "全局设置已保存",
    statusFilter: "状态筛选",
    statusOptions: {
      "": "全部状态",
      queued: "排队中",
      running: "运行中",
      cancelling: "取消中",
      summarizing: "生成摘要中",
      completed: "已完成",
      failed: "失败",
      interrupted: "已中断",
      interrupted_with_late_result: "已中断（收到迟到结果）",
      timed_out: "已超时",
      orphaned: "孤立",
    },
    priorityOptions: { high: "高", normal: "普通", low: "低" },
    controlStatusOptions: {
      not_received: "未收到",
      invalid: "无效",
      accepted: "已接受",
      repaired: "已修复",
      epoch_mismatch: "执行周期不匹配",
    },
    controlSourceOptions: { none: "无", agent_response: "Agent 响应", summary_repair: "摘要修复", continuation_repair: "自动续作修复", action_gate_repair: "动作门修复" },
    unknown: "未知",
    yes: "是",
    no: "否",
    agentId: "Agent 标识",
    status: "状态",
    run: "运行",
    currentTool: "当前工具",
    toolCalls: "工具调用次数",
    modelRequestAttempts: "AI 请求次数",
    modelRetryCount: "AI 重试次数",
    pendingMessages: "待处理消息",
    checkpointTurns: "检查点轮次",
    currentActionGate: "当前动作门",
    actionGateActivations: "动作门激活次数",
    actionGateBlocks: "动作门阻断次数",
    actionGateNone: "无",
    control: "控制协议",
    messages: "消息",
    queuedMessages: "排队",
    deliveredMessages: "已送达",
    acknowledgedMessages: "已确认",
    result: "结果",
    resultSuccess: "执行成功",
    resultFailure: "执行失败",
    resultStructured: "结构化结果",
    resultEmpty: "暂无结果数据",
    resultMore: "还有更多字段未显示",
    resultFields: {
      success: "成功",
      ok: "成功",
      status: "状态",
      message: "消息",
      error: "错误",
      data: "数据",
      result: "结果",
      output: "输出",
      path: "路径",
      file: "文件",
      files: "文件",
      count: "数量",
      total: "总计",
      code: "代码",
      exitCode: "退出码",
      duration: "耗时",
      duration_ms: "耗时毫秒",
      sha256: "SHA-256",
    },
    events: "最近事件",
    taskTree: "任务树",
    permissions: "权限",
    messageBody: "消息内容",
    permissionMode: "权限模式",
    readOnlyToggle: "强制只读",
    showResult: "显示结果",
    hideResult: "隐藏结果",
    recentEventsEmpty: "暂无最近事件",
    eventTypes: {
      agent_created: "Agent 已创建",
      run_queued: "运行已排队",
      attempt_started: "执行尝试已开始",
      run_started: "运行已开始",
      model_request_started: "AI 请求已开始",
      model_request_failed: "AI 请求失败",
      model_request_retry_scheduled: "AI 请求已安排重试",
      tool_started: "工具调用已开始",
      summary_started: "摘要生成已开始",
      summary_finished: "摘要生成已完成",
      model_step_classified: "模型步骤已分类",
      checkpoint: "检查点已提交",
      run_terminal: "运行已结束",
      followup_created: "后续运行已创建",
      message_queued: "消息已排队",
      message_staged: "消息待送达",
      message_delivered: "消息已送达",
      message_acknowledged: "消息已确认",
      message_requeued: "消息已重新排队",
      message_requeued_unacknowledged: "未确认消息已重试",
      message_acknowledgement_exhausted: "消息确认重试已耗尽",
      message_requeued_for_followup: "消息已转入后续运行",
      cancel_requested: "已请求中断",
      descendant_cancel_requested: "已请求中断后代",
      late_result_ignored: "迟到结果已隔离",
      control_epoch_mismatch: "控制执行周期不匹配",
      run_recovery_started: "运行恢复已开始",
      context_replayed: "上下文已重放",
      run_orphaned: "运行已孤立",
      action_gate_activated: "动作门已激活",
      action_gate_released: "动作门已解除",
      action_gate_blocked: "动作门已阻断工具",
    },
    eventFields: {
      status: "状态",
      tool_name: "工具",
      step: "步骤",
      attempt: "尝试",
      request_attempt: "AI 请求尝试",
      failed_request_attempt: "失败请求尝试",
      next_request_attempt: "下次请求尝试",
      max_retries: "最大重试次数",
      delay_ms: "重试等待毫秒",
      retryable: "可重试",
      tool_outcome_unknown: "工具结果未知",
      action: "动作",
      kind: "类型",
      tools: "工具",
      allowed_tools: "允许工具",
      pending_metadata: "待读取元数据",
      mutation_checkpoint_index: "变更检查点",
      control_action: "控制动作",
      control_status: "控制状态",
      control_source: "控制来源",
      summary_status: "摘要状态",
      reason: "原因",
      error: "错误",
      acknowledged_messages: "已确认消息",
      requeued_messages: "重新排队消息",
      message_id: "消息标识",
      propagated_descendants: "传播到后代",
      prior_run_seq: "上次运行",
      recovered: "恢复运行",
      epoch: "执行周期",
      expected_epoch: "预期执行周期",
      received_epoch: "收到执行周期",
      tool_count: "工具调用数",
      checkpoint_turns: "检查点轮次",
      continuation_required: "需要续作",
      prompt_echo_detected: "检测到提示词回显",
    },
    eventDetails: "详细数据",
    treeEmpty: "暂无任务树数据",
    operationSucceeded: "操作已完成",
    errors: {
      task_required: "任务不能为空",
      workspace_env_invalid: "工作区环境必须为 android 或 linux",
      priority_invalid: "优先级无效",
      timeout_invalid: "超时必须在 30000–3600000 毫秒",
      max_tool_calls_invalid: "全局工具调用数必须为 1–64 的整数",
      max_concurrent_agents_invalid: "全局并发 Agent 数必须为 1–16 的整数",
      max_active_runs_per_root_invalid: "单根任务树并发上限必须为 1–8 的整数，且不高于全局并发数",
      max_model_retries_invalid: "AI 调用重试次数必须为 0–12 的整数",
      conversation_context_mode_invalid: "对话上下文模式必须为关闭、开启或自动",
      write_paths_required: "可写任务必须至少声明一个目标路径",
      path_not_absolute: "目标路径必须为绝对路径",
      path_outside_workspace: "目标路径位于工作区之外",
      workspace_not_absolute: "工作区路径必须为绝对路径",
      permission_mode_invalid: "权限模式无效",
      agent_required: "缺少 Agent",
      ipc_invalid_response: "IPC 响应格式无效",
      operation_failed: "操作失败",

    },
  },
  en: {
    title: "Collaboration Dashboard",
    subtitle: "Inspect task trees and manage Agent runs through main-runtime IPC.",
    refresh: "Refresh",
    create: "Create Agent",
    back: "Back",
    loadMore: "Load more",
    allStatuses: "All statuses",
    active: "Active",
    queued: "Queued",
    total: "Total",
    noAgents: "No agents",
    details: "Details",
    message: "Send message",
    wait: "Wait for update",
    followup: "Follow-up run",
    interrupt: "Interrupt",
    clearHistory: "Clear history",
    delete: "Delete",
    clearHistoryWarning: "This permanently deletes every terminal Agent outside an active task tree, including its runs, messages, events, and local ledger records. This cannot be undone.",
    deleteAgentWarning: "This permanently deletes this terminal Agent, including its runs, messages, events, and local ledger records. This cannot be undone.",
    confirm: "Confirm",
    cancel: "Cancel",
    submit: "Submit",
    readOnly: "Read-only",
    writable: "Writable",
    inherit: "Inherit previous permission",
    forceReadOnly: "Force read-only",
    specifyWrite: "Specify writable paths",
    pathsHint: "One absolute path per line",
    writeWarning: "Path isolation is declarative, not operating-system enforcement.",
    interruptWarning: "Interrupt propagates to active descendants; network requests may not stop immediately.",
    inheritedWriteWarning: "This follow-up inherits writable permission. Verify workspace and target paths.",
    queuedMessage: "Message queued for the next checkpoint; delivered does not mean acknowledged.",
    waitTimeout: "This wait timed out; the Agent may still be running.",
    loading: "Working…",
    name: "Name",
    task: "Task",
    context: "Context",
    parentAgentId: "Parent Agent ID (optional)",
    workspacePath: "Absolute workspace path",
    workspaceEnv: "Workspace environment",
    targetPaths: "Target paths",
    priority: "Priority",
    timeoutMs: "Stream network idle timeout (ms)",
    globalSettings: "Global runtime settings",
    maxConcurrentAgents: "Global maximum concurrent Agents",
    maxConcurrentAgentsHint: "Range 1–16; lowering this does not interrupt running Agents and only limits new starts.",
    maxActiveRunsPerRoot: "Per-root task-tree concurrency",
    maxActiveRunsPerRootHint: "Range 1–8 and no higher than global concurrency; lowering it only limits new starts.",
    maxToolCalls: "Global tool calls",
    maxToolCallsHint: "Range 1–64; applied to every new Run as an Agent prompt budget.",
    maxModelRetries: "AI call retries",
    maxModelRetriesHint: "Range 0–12, default 5. Only network, rate-limit, and temporary service failures are retried; balance, authentication, parameter, and policy errors stop immediately.",
    conversationContext: "Pass current conversation context",
    conversationContextHint: "Copies only recent user/assistant turns, excluding system prompts and tool traces. Auto is decided by the calling AI; dashboard-created Agents do not include it in Auto mode.",
    conversationContextOptions: { off: "Off", on: "On", auto: "Auto" },
    saveSettings: "Save global settings",
    settingsSaved: "Global settings saved",
    statusFilter: "Status filter",
    statusOptions: {
      "": "All statuses",
      queued: "Queued",
      running: "Running",
      cancelling: "Cancelling",
      summarizing: "Summarizing",
      completed: "Completed",
      failed: "Failed",
      interrupted: "Interrupted",
      interrupted_with_late_result: "Interrupted (late result)",
      timed_out: "Timed out",
      orphaned: "Orphaned",
    },
    priorityOptions: { high: "High", normal: "Normal", low: "Low" },
    controlStatusOptions: {
      not_received: "Not received",
      invalid: "Invalid",
      accepted: "Accepted",
      repaired: "Repaired",
      epoch_mismatch: "Epoch mismatch",
    },
    controlSourceOptions: { none: "None", agent_response: "Agent response", summary_repair: "Summary repair", continuation_repair: "Continuation repair", action_gate_repair: "Action-gate repair" },
    unknown: "Unknown",
    yes: "Yes",
    no: "No",
    agentId: "Agent ID",
    status: "Status",
    run: "Run",
    currentTool: "Current tool",
    toolCalls: "Tool calls",
    modelRequestAttempts: "AI requests",
    modelRetryCount: "AI retries",
    pendingMessages: "Pending messages",
    checkpointTurns: "Checkpoint turns",
    currentActionGate: "Current action gate",
    actionGateActivations: "Action-gate activations",
    actionGateBlocks: "Action-gate blocks",
    actionGateNone: "None",
    control: "Control",
    messages: "Messages",
    queuedMessages: "Queued",
    deliveredMessages: "Delivered",
    acknowledgedMessages: "Acknowledged",
    result: "Result",
    resultSuccess: "Execution succeeded",
    resultFailure: "Execution failed",
    resultStructured: "Structured result",
    resultEmpty: "No result data",
    resultMore: "More fields were omitted",
    resultFields: {
      success: "Success",
      ok: "Success",
      status: "Status",
      message: "Message",
      error: "Error",
      data: "Data",
      result: "Result",
      output: "Output",
      path: "Path",
      file: "File",
      files: "Files",
      count: "Count",
      total: "Total",
      code: "Code",
      exitCode: "Exit code",
      duration: "Duration",
      duration_ms: "Duration (ms)",
      sha256: "SHA-256",
    },
    events: "Recent events",
    taskTree: "Task tree",
    permissions: "Permissions",
    messageBody: "Message",
    permissionMode: "Permission mode",
    readOnlyToggle: "Force read-only",
    showResult: "Show result",
    hideResult: "Hide result",
    recentEventsEmpty: "No recent events",
    eventTypes: {
      agent_created: "Agent created",
      run_queued: "Run queued",
      attempt_started: "Execution attempt started",
      run_started: "Run started",
      model_request_started: "AI request started",
      model_request_failed: "AI request failed",
      model_request_retry_scheduled: "AI request retry scheduled",
      tool_started: "Tool call started",
      summary_started: "Summary started",
      summary_finished: "Summary finished",
      model_step_classified: "Model step classified",
      checkpoint: "Checkpoint committed",
      run_terminal: "Run finished",
      followup_created: "Follow-up run created",
      message_queued: "Message queued",
      message_staged: "Message staged",
      message_delivered: "Message delivered",
      message_acknowledged: "Message acknowledged",
      message_requeued: "Message requeued",
      message_requeued_unacknowledged: "Unacknowledged message retried",
      message_acknowledgement_exhausted: "Message acknowledgement retries exhausted",
      message_requeued_for_followup: "Message moved to follow-up",
      cancel_requested: "Interruption requested",
      descendant_cancel_requested: "Descendant interruption requested",
      late_result_ignored: "Late result isolated",
      control_epoch_mismatch: "Control epoch mismatch",
      run_recovery_started: "Run recovery started",
      context_replayed: "Context replayed",
      run_orphaned: "Run orphaned",
      action_gate_activated: "Action gate activated",
      action_gate_released: "Action gate released",
      action_gate_blocked: "Action gate blocked tools",
    },
    eventFields: {
      status: "Status",
      tool_name: "Tool",
      step: "Step",
      attempt: "Attempt",
      request_attempt: "AI request attempt",
      failed_request_attempt: "Failed request attempt",
      next_request_attempt: "Next request attempt",
      max_retries: "Maximum retries",
      delay_ms: "Retry delay (ms)",
      retryable: "Retryable",
      tool_outcome_unknown: "Tool outcome unknown",
      action: "Action",
      kind: "Kind",
      tools: "Tools",
      allowed_tools: "Allowed tools",
      pending_metadata: "Pending metadata",
      mutation_checkpoint_index: "Mutation checkpoint",
      control_action: "Control action",
      control_status: "Control status",
      control_source: "Control source",
      summary_status: "Summary status",
      reason: "Reason",
      error: "Error",
      acknowledged_messages: "Acknowledged messages",
      requeued_messages: "Requeued messages",
      message_id: "Message ID",
      propagated_descendants: "Propagated descendants",
      prior_run_seq: "Previous run",
      recovered: "Recovered run",
      epoch: "Execution epoch",
      expected_epoch: "Expected epoch",
      received_epoch: "Received epoch",
      tool_count: "Tool calls",
      checkpoint_turns: "Checkpoint turns",
      continuation_required: "Continuation required",
      prompt_echo_detected: "Prompt echo detected",
    },
    eventDetails: "Additional data",
    treeEmpty: "No task-tree data",
    operationSucceeded: "Operation completed",
    errors: {
      task_required: "Task is required",
      workspace_env_invalid: "Workspace environment must be android or linux",
      priority_invalid: "Priority is invalid",
      timeout_invalid: "Timeout must be between 30000 and 3600000 ms",
      max_tool_calls_invalid: "Global tool calls must be an integer between 1 and 64",
      max_concurrent_agents_invalid: "Global concurrent Agents must be an integer between 1 and 16",
      max_active_runs_per_root_invalid: "Per-root concurrency must be an integer between 1 and 8 and no higher than global concurrency",
      max_model_retries_invalid: "AI call retries must be an integer between 0 and 12",
      conversation_context_mode_invalid: "Conversation context mode must be Off, On, or Auto",
      write_paths_required: "Writable tasks require at least one target path",
      path_not_absolute: "Target paths must be absolute",
      path_outside_workspace: "A target path is outside the workspace",
      workspace_not_absolute: "Workspace path must be absolute",
      permission_mode_invalid: "Permission mode is invalid",
      agent_required: "Agent is required",
      ipc_invalid_response: "Invalid IPC response",
      operation_failed: "Operation failed",
    },
  },
};

function resolveText(ctx) {
  let language = "zh";
  try {
    const locale = String(ctx && typeof ctx.getEnv === "function" ? ctx.getEnv("LANG") || "" : "").toLowerCase();
    if (locale.startsWith("en")) language = "en";
  } catch (_) {}
  return TEXT[language];
}

function runtime() {
  if (typeof ToolPkg === "undefined" || !ToolPkg || !ToolPkg.ipc ||
      typeof ToolPkg.ipc.call !== "function") {
    throw new Error("ToolPkg IPC is unavailable");
  }
  return ToolPkg;
}

function ipcError(code, message, details) {
  const error = new Error(String(message || ""));
  error.name = "DashboardIpcError";
  error.code = String(code || "operation_failed");
  if (details !== undefined) error.details = details;
  return error;
}

function failedResponseError(result) {
  const errorObject = result && result.error && typeof result.error === "object" ? result.error : null;
  const code = String(result && result.code || errorObject && errorObject.code || "operation_failed");
  const message = typeof result.error === "string"
    ? result.error
    : String(errorObject && errorObject.message || result.message || "");
  const details = result.details !== undefined
    ? result.details
    : (errorObject && errorObject.details !== undefined ? errorObject.details : undefined);
  return ipcError(code, message, details);
}

async function callMain(channel, payload) {
  const result = await runtime().ipc.call(channel, payload || {}, IPC_OPTIONS);
  if (!result || typeof result !== "object") {
    throw ipcError("ipc_invalid_response", "", { channel, response: result ?? null });
  }
  if (result.success === false) throw failedResponseError(result);
  return result;
}

const api = {
  listAgents: (payload) => callMain(CHANNELS.LIST_AGENTS, payload),
  inspectAgent: (agentId) => callMain(CHANNELS.INSPECT_AGENT, { agent_id: agentId }),
  listTree: (payload) => callMain(CHANNELS.LIST_TREE, payload),
  getSettings: () => callMain(CHANNELS.GET_SETTINGS, {}),
  updateSettings: (payload) => callMain(CHANNELS.UPDATE_SETTINGS, payload),
  deleteAgent: (agentId) => callMain(CHANNELS.DELETE_AGENT, { agent_id: agentId }),
  clearHistory: () => callMain(CHANNELS.CLEAR_HISTORY, {}),
  spawnAgent: (payload) => callMain(CHANNELS.SPAWN_AGENT, payload),
  sendMessage: (payload) => callMain(CHANNELS.SEND_MESSAGE, payload),
  followupTask: (payload) => callMain(CHANNELS.FOLLOWUP_TASK, payload),
  waitAgent: (agentId, timeoutMs = 5000) => callMain(CHANNELS.WAIT_AGENT, {
    agent_ids: [agentId],
    timeout_ms: timeoutMs,
  }),
  interruptAgent: (payload) => callMain(CHANNELS.INTERRUPT_AGENT, payload),
};

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || ""));
}

function allowedActions(status) {
  const value = String(status || "");
  return {
    message: ACTIVE_STATUSES.has(value),
    wait: ACTIVE_STATUSES.has(value) || value === "cancelling",
    followup: isTerminal(value),
    interrupt: ACTIVE_STATUSES.has(value),
  };
}

function mergeAgents(current, incoming) {
  const map = new Map();
  for (const agent of Array.isArray(current) ? current : []) map.set(agent.id, agent);
  for (const agent of Array.isArray(incoming) ? incoming : []) map.set(agent.id, agent);
  return Array.from(map.values());
}

function shortId(value, size = 12) {
  const text = String(value || "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function statusColor(status) {
  if (status === "failed" || status === "orphaned") return "errorContainer";
  if (status === "running") return "primaryContainer";
  if (status === "queued" || status === "cancelling") return "secondaryContainer";
  if (status === "timed_out" || status === "interrupted" || status === "interrupted_with_late_result") {
    return "tertiaryContainer";
  }
  return "surfaceVariant";
}

function countSummary(result) {
  const counts = result && result.status_counts && typeof result.status_counts === "object"
    ? result.status_counts
    : {};
  return {
    active: Number(result && result.active) || 0,
    queued: Number(result && result.queued) || 0,
    total: Number(result && result.total) || 0,
    counts,
  };
}

function parseTargetPaths(text) {
  return Array.from(new Set(
    String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function isAbsolutePath(value) {
  const path = String(value || "").trim();
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeForCompare(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWithinWorkspace(path, workspace) {
  const child = normalizeForCompare(path);
  const root = normalizeForCompare(workspace);
  if (!root) return true;
  const left = /^[A-Za-z]:\//.test(root) ? child.toLowerCase() : child;
  const right = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
  return left === right || left.startsWith(`${right}/`);
}

function validateCommon(input) {
  const errors = [];
  if (!String(input.task || "").trim()) errors.push("task_required");
  if (!["android", "linux"].includes(String(input.workspace_env || "android"))) errors.push("workspace_env_invalid");
  if (!["high", "normal", "low"].includes(String(input.priority || "normal"))) errors.push("priority_invalid");
  const timeout = Number(input.timeout_ms);
  if (!Number.isInteger(timeout) || timeout < 30000 || timeout > 3600000) errors.push("timeout_invalid");
  const maxTools = Number(input.max_tool_calls);
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 64) errors.push("max_tool_calls_invalid");
  return errors;
}

function validatePaths(input, paths) {
  const errors = [];
  if (input.read_only !== true && paths.length === 0) errors.push("write_paths_required");
  for (const path of paths) {
    if (!isAbsolutePath(path)) errors.push("path_not_absolute");
    if (input.workspace_path && !isWithinWorkspace(path, input.workspace_path)) errors.push("path_outside_workspace");
  }
  return Array.from(new Set(errors));
}

function validateSpawn(input) {
  const paths = input.read_only === true ? [] : parseTargetPaths(input.target_paths_text);
  const errors = [...validateCommon(input), ...validatePaths(input, paths)];
  if (input.workspace_path && !isAbsolutePath(input.workspace_path)) errors.push("workspace_not_absolute");
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), target_paths: paths };
}

function validateFollowup(input, currentAgent) {
  const errors = [];
  if (!String(input.task || "").trim()) errors.push("task_required");
  const mode = String(input.permission_mode || "readonly");
  if (!["inherit", "readonly", "write"].includes(mode)) errors.push("permission_mode_invalid");
  let targetPaths;
  let readOnly;
  if (mode === "readonly") {
    targetPaths = [];
    readOnly = true;
  } else if (mode === "write") {
    targetPaths = parseTargetPaths(input.target_paths_text);
    readOnly = false;
    if (input.workspace_path && !isAbsolutePath(input.workspace_path)) errors.push("workspace_not_absolute");
    if (!["android", "linux"].includes(String(input.workspace_env || "android"))) errors.push("workspace_env_invalid");
    errors.push(...validatePaths({ ...input, read_only: false }, targetPaths));
  } else {
    targetPaths = undefined;
    readOnly = undefined;
    if (!currentAgent) errors.push("agent_required");
  }
  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    target_paths: targetPaths,
    read_only: readOnly,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = stableValue(value[key]);
    }
    return output;
  }
  return value;
}

function fingerprint(payload) {
  return JSON.stringify(stableValue(payload || {}));
}

function generateRequestId(operation) {
  return `ui:${String(operation || "operation")}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function nextRequest(previous, operation, payload) {
  const nextFingerprint = fingerprint(payload);
  if (previous && previous.status !== "succeeded" && previous.fingerprint === nextFingerprint) return previous;
  return { requestId: generateRequestId(operation), fingerprint: nextFingerprint, status: "pending" };
}

function markRequest(entry, status) {
  return entry ? { ...entry, status } : null;
}

function sectionTitle(ctx, text) {
  return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
    ctx.UI.Surface({ width: 4, height: 18, containerColor: "primary", shape: SHAPE_PILL }, []),
    ctx.UI.Text({ text, style: "titleMedium", fontWeight: "semiBold", weight: 1 }),
  ]);
}

function errorCard(ctx, message) {
  if (!String(message || "").trim()) return null;
  return ctx.UI.Card({
    fillMaxWidth: true,
    containerColor: "errorContainer",
    shape: SHAPE_MEDIUM,
    border: { width: 1, color: "error" },
  }, [
    ctx.UI.Row({ padding: 14, verticalAlignment: "center" }, [
      ctx.UI.Icon({ name: "error", tint: "onErrorContainer", size: 20 }),
      ctx.UI.Spacer({ width: 10 }),
      ctx.UI.Text({ text: String(message), color: "onErrorContainer", weight: 1, style: "bodyMedium" }),
    ]),
  ]);
}

function noticeCard(ctx, message, color = "secondaryContainer") {
  if (!String(message || "").trim()) return null;
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: color, shape: SHAPE_MEDIUM }, [
    ctx.UI.Text({ text: String(message), padding: 14, style: "bodyMedium", softWrap: true }),
  ]);
}

function loadingRow(ctx, text) {
  return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_MEDIUM }, [
    ctx.UI.Row({
      padding: { horizontal: 14, vertical: 12 },
      verticalAlignment: "center",
      horizontalArrangement: "center",
      fillMaxWidth: true,
    }, [
      ctx.UI.CircularProgressIndicator({ width: 18, height: 18, strokeWidth: 2 }),
      ctx.UI.Spacer({ width: 10 }),
      ctx.UI.Text({ text, style: "bodyMedium", color: "onSurfaceVariant" }),
    ]),
  ]);
}

function statCard(ctx, label, value, color = "surfaceVariant") {
  return ctx.UI.Card({
    weight: 1,
    containerColor: color,
    shape: SHAPE_MEDIUM,
    border: CARD_BORDER,
  }, [
    ctx.UI.Column({ padding: { horizontal: 12, vertical: 10 }, spacing: 1 }, [
      ctx.UI.Text({ text: String(value), style: "titleLarge", fontWeight: "bold" }),
      ctx.UI.Text({ text: label, style: "labelMedium", color: "onSurfaceVariant", maxLines: 1, overflow: "ellipsis" }),
    ]),
  ]);
}

function keyValue(ctx, label, value) {
  if (value === undefined || value === null || String(value) === "") return null;
  return ctx.UI.Row({
    fillMaxWidth: true,
    verticalAlignment: "start",
    padding: { vertical: 4 },
    spacing: 10,
  }, [
    ctx.UI.Text({ text: `${label}:`, width: 112, style: "labelMedium", fontWeight: "semiBold", color: "onSurfaceVariant" }),
    ctx.UI.Text({ text: String(value), weight: 1, style: "bodySmall", softWrap: true }),
  ]);
}

function localizedOption(options, value, fallback) {
  const key = String(value || "");
  return options && options[key] || fallback || key;
}

function statusBadge(ctx, label, status) {
  return ctx.UI.Surface({
    containerColor: statusColor(status),
    shape: SHAPE_PILL,
  }, [
    ctx.UI.Text({
      text: label,
      style: "labelMedium",
      fontWeight: "semiBold",
      padding: { horizontal: 10, vertical: 5 },
      maxLines: 1,
      overflow: "ellipsis",
    }),
  ]);
}

function agentCard(ctx, agent, text, onOpen) {
  const execution = agent.execution || {};
  const status = localizedOption(text.statusOptions, agent.status, text.unknown);
  const priority = localizedOption(text.priorityOptions, agent.priority || "normal", agent.priority || "normal");
  const active = ["queued", "running", "summarizing", "cancelling"].includes(String(agent.status || ""));
  return ctx.UI.Card({
    fillMaxWidth: true,
    containerColor: "surface",
    shape: SHAPE_LARGE,
    border: CARD_BORDER,
    elevation: active ? 2 : 0,
  }, [
    ctx.UI.Row({ fillMaxWidth: true }, [
      ctx.UI.Surface({ width: 5, height: active ? 148 : 132, containerColor: statusColor(agent.status), shape: SHAPE_PILL }, []),
      ctx.UI.Column({ padding: 14, spacing: 9, weight: 1 }, compact([
        ctx.UI.Text({
          text: agent.name || shortId(agent.id),
          style: "titleMedium",
          fontWeight: "semiBold",
          maxLines: 1,
          overflow: "ellipsis",
        }),
        ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
          statusBadge(ctx, status, agent.status),
          ctx.UI.Spacer({ weight: 1 }),
          ctx.UI.Text({ text: shortId(agent.id, 10), style: "labelSmall", color: "onSurfaceVariant" }),
        ]),
        ctx.UI.Text({ text: execution.task_excerpt || "-", style: "bodyMedium", maxLines: 2, overflow: "ellipsis" }),
        ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
          ctx.UI.Text({
            text: `${text.run} ${agent.run_seq || 0} · ${agent.read_only ? text.readOnly : text.writable} · ${priority}`,
            style: "bodySmall",
            color: "onSurfaceVariant",
            weight: 1,
          }),
        ]),
        ctx.UI.Text({
          text: `${text.currentTool}=${execution.current_tool || "-"} · ${text.toolCalls}=${execution.tool_count || 0} · ${text.pendingMessages}=${agent.pending_messages || 0}`,
          style: "bodySmall",
          color: "onSurfaceVariant",
          maxLines: 1,
          overflow: "ellipsis",
        }),
        active ? ctx.UI.LinearProgressIndicator({ fillMaxWidth: true }) : null,
        ctx.UI.Button({
          text: text.details,
          fillMaxWidth: true,
          shape: SHAPE_SMALL,
          contentPadding: { horizontal: 12, vertical: 7 },
          onClick: () => onOpen(agent.id),
        }),
      ])),
    ]),
  ]);
}

function textField(ctx, label, state, options) {
  return ctx.UI.TextField({
    label,
    value: state.value,
    onValueChange: state.set,
    fillMaxWidth: true,
    ...(options || {}),
  });
}

function panel(ctx, children, options = {}) {
  return ctx.UI.Surface({
    fillMaxWidth: true,
    containerColor: options.containerColor || "surface",
    shape: SHAPE_LARGE,
  }, [
    ctx.UI.Column({ padding: options.padding || 14, spacing: options.spacing || 10 }, compact(children)),
  ]);
}

function pageHeader(ctx, title, onBack, trailing) {
  return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surface", shape: SHAPE_LARGE }, [
    ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: { horizontal: 8, vertical: 6 }, spacing: 8 }, compact([
      onBack ? ctx.UI.Button({ text: title.back, shape: SHAPE_SMALL, onClick: onBack }) : null,
      ctx.UI.Text({ text: title.label, style: "titleLarge", fontWeight: "bold", weight: 1, maxLines: 1, overflow: "ellipsis" }),
      trailing || null,
    ])),
  ]);
}

function emptyState(ctx, text) {
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_LARGE, border: CARD_BORDER }, [
    ctx.UI.Column({ fillMaxWidth: true, padding: { horizontal: 18, vertical: 24 }, spacing: 8 }, [
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center" }, [
        ctx.UI.Icon({ name: "accountTree", tint: "onSurfaceVariant", size: 28 }),
      ]),
      ctx.UI.Row({ fillMaxWidth: true, horizontalArrangement: "center" }, [
        ctx.UI.Text({ text, style: "bodyMedium", color: "onSurfaceVariant" }),
      ]),
    ]),
  ]);
}

function resultJson(value) {
  if (value && typeof value === "object") return value;
  const source = String(value || "").trim();
  if (!source) return null;
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : source;
  if (!/^[\[{]/.test(candidate)) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function readableResultField(value) {
  return String(value || "value")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function resultFieldLabel(field, text) {
  return text.resultFields[field] || readableResultField(field);
}

function resultScalar(value, text) {
  if (value === true) return text.yes;
  if (value === false) return text.no;
  if (value === null || value === undefined) return "-";
  return String(value);
}

function resultFieldValue(field, value, text) {
  if (field === "status") return localizedOption(text.statusOptions, value, String(value || ""));
  return resultScalar(value, text);
}

function flattenResult(value, text, path = [], depth = 0, output = []) {
  if (output.length >= 16) return output;
  const field = path[path.length - 1] || "result";
  const label = path.map((part) => resultFieldLabel(part, text)).join(" · ") || text.result;
  if (value === null || value === undefined || typeof value !== "object") {
    output.push({ label, value: resultFieldValue(field, value, text), tone: field === "error" ? "error" : "normal" });
    return output;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      output.push({ label, value: "0", tone: "normal" });
      return output;
    }
    const primitive = value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item));
    if (primitive) {
      const preview = value.slice(0, 6).map((item) => resultScalar(item, text)).join(" · ");
      output.push({ label, value: value.length > 6 ? `${preview} · … (+${value.length - 6})` : preview, tone: "normal" });
      return output;
    }
    output.push({ label, value: `${value.length}`, tone: "normal" });
    if (depth < 2) {
      value.slice(0, 3).forEach((item, index) => flattenResult(item, text, [...path, `#${index + 1}`], depth + 1, output));
    }
    return output;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    output.push({ label, value: text.resultEmpty, tone: "normal" });
    return output;
  }
  if (depth >= 2) {
    output.push({ label, value: `${text.eventDetails} (${entries.length})`, tone: "normal" });
    return output;
  }
  for (const [key, child] of entries.slice(0, 12)) flattenResult(child, text, [...path, key], depth + 1, output);
  if (entries.length > 12 && output.length < 16) output.push({ label, value: `${text.resultMore}: ${entries.length - 12}`, tone: "normal" });
  return output;
}

function structuredResultCard(ctx, value, text) {
  const parsed = resultJson(value);
  if (!parsed) return null;
  const success = parsed.success === true || parsed.ok === true;
  const failure = parsed.success === false || parsed.ok === false || !!parsed.error;
  const title = success ? text.resultSuccess : failure ? text.resultFailure : text.resultStructured;
  const color = failure ? "errorContainer" : success ? "primaryContainer" : "surfaceVariant";
  const icon = failure ? "error" : success ? "checkCircle" : "dataObject";
  const rows = flattenResult(parsed, text);
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: color, shape: SHAPE_LARGE, border: CARD_BORDER }, [
    ctx.UI.Column({ padding: 14, spacing: 8 }, compact([
      ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
        ctx.UI.Icon({ name: icon, size: 20 }),
        ctx.UI.Text({ text: title, style: "titleMedium", fontWeight: "semiBold", weight: 1 }),
      ]),
      ...rows.map((row) => ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "start", spacing: 10 }, [
        ctx.UI.Text({ text: `${row.label}:`, width: 112, style: "labelMedium", color: "onSurfaceVariant", fontWeight: "semiBold" }),
        ctx.UI.Text({
          text: row.value,
          weight: 1,
          style: "bodySmall",
          color: row.tone === "error" ? "error" : undefined,
          softWrap: true,
          maxLines: 6,
          overflow: "ellipsis",
        }),
      ])),
    ])),
  ]);
}

function markdownInlineText(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function parseMarkdownBlocks(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let quote = [];
  let code = null;
  let codeLanguage = "";
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length > 0) blocks.push({ type: "quote", text: quote.join("\n") });
    quote = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^\s{0,3}```/.test(line)) {
        blocks.push({ type: "code", text: code.join("\n"), language: codeLanguage });
        code = null;
        codeLanguage = "";
      } else {
        code.push(line);
      }
      continue;
    }
    const fence = line.match(/^\s{0,3}```\s*([A-Za-z0-9_+.-]*)\s*$/);
    if (fence) {
      flushParagraph();
      flushQuote();
      code = [];
      codeLanguage = fence[1] || "";
      continue;
    }
    const quoteLine = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoteLine) {
      flushParagraph();
      quote.push(quoteLine[1]);
      continue;
    }
    flushQuote();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ type: "divider" });
      continue;
    }
    const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      blocks.push({ type: "list", marker: "•", text: unordered[1] });
      continue;
    }
    const ordered = line.match(/^\s{0,3}(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      blocks.push({ type: "list", marker: `${ordered[1]}.`, text: ordered[2] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushQuote();
  if (code) blocks.push({ type: "code", text: code.join("\n"), language: codeLanguage });
  return blocks;
}

function markdownBlockView(ctx, block) {
  if (block.type === "heading") {
    const styles = ["titleLarge", "titleLarge", "titleMedium", "titleSmall", "bodyLarge", "bodyLarge"];
    return ctx.UI.Text({
      text: markdownInlineText(block.text),
      style: styles[Math.max(0, Math.min(5, block.level - 1))],
      fontWeight: "bold",
      softWrap: true,
    });
  }
  if (block.type === "list") {
    return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "start", spacing: 6 }, [
      ctx.UI.Text({ text: block.marker, width: 22, style: "bodyMedium", color: "primary", fontWeight: "semiBold" }),
      ctx.UI.Text({ text: markdownInlineText(block.text), weight: 1, style: "bodyMedium", softWrap: true }),
    ]);
  }
  if (block.type === "quote") {
    return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surface", shape: SHAPE_MEDIUM }, [
      ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "start" }, [
        ctx.UI.Surface({ width: 4, height: 44, containerColor: "secondary", shape: SHAPE_PILL }, []),
        ctx.UI.Text({
          text: markdownInlineText(block.text),
          padding: { horizontal: 12, vertical: 10 },
          weight: 1,
          style: "bodyMedium",
          color: "onSurfaceVariant",
          softWrap: true,
        }),
      ]),
    ]);
  }
  if (block.type === "code") {
    return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surface", shape: SHAPE_MEDIUM, border: CARD_BORDER }, [
      ctx.UI.Column({ padding: 12, spacing: 6 }, compact([
        block.language ? ctx.UI.Text({ text: block.language, style: "labelSmall", color: "primary", fontWeight: "semiBold" }) : null,
        ctx.UI.Text({ text: block.text, style: "bodySmall", softWrap: true }),
      ])),
    ]);
  }
  if (block.type === "divider") {
    return ctx.UI.Surface({ fillMaxWidth: true, height: 1, containerColor: "outlineVariant" }, []);
  }
  return ctx.UI.Text({ text: markdownInlineText(block.text), style: "bodyMedium", softWrap: true });
}

function markdownPreviewText(value) {
  return parseMarkdownBlocks(value)
    .filter((block) => block.type !== "divider")
    .map((block) => {
      const content = markdownInlineText(block.text);
      if (block.type === "list") return `${block.marker} ${content}`;
      if (block.type === "quote") return `> ${content}`;
      return content;
    })
    .filter(Boolean)
    .join("\n");
}

function resultView(ctx, value, text, expanded, onToggle) {
  const structured = structuredResultCard(ctx, value, text);
  if (structured) return structured;
  const content = String(value || "").trim();
  if (!content) return emptyState(ctx, text.resultEmpty);
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_LARGE }, [
    ctx.UI.Row({ fillMaxWidth: true, onClick: onToggle }, [
      expanded
        ? ctx.UI.Column({ padding: 14, spacing: 10, weight: 1 }, parseMarkdownBlocks(content).map((block) => markdownBlockView(ctx, block)))
        : ctx.UI.Text({
          text: markdownPreviewText(content),
          padding: 14,
          style: "bodyMedium",
          softWrap: true,
          weight: 1,
          maxLines: 3,
          overflow: "ellipsis",
        }),
    ]),
  ]);
}

function formatEventTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return new Date(timestamp).toLocaleString();
  } catch (_) {
    return String(timestamp);
  }
}

function readableEventType(value) {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eventValue(value, text) {
  if (value === true) return text.yes;
  if (value === false) return text.no;
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${text.eventDetails} (${value.length})` : "";
  if (typeof value === "object") return `${text.eventDetails} (${Object.keys(value).length})`;
  return String(value);
}

function eventFieldValue(field, value, text) {
  if (field === "status") return localizedOption(text.statusOptions, value, String(value || ""));
  if (field === "control_status") return localizedOption(text.controlStatusOptions, value, String(value || ""));
  if (field === "control_source") return localizedOption(text.controlSourceOptions, value, String(value || ""));
  return eventValue(value, text);
}

function eventSummary(event, text) {
  const data = event && event.data && typeof event.data === "object" ? event.data : {};
  const preferredFields = [
    "status", "tool_name", "step", "attempt", "action", "kind", "tools",
    "allowed_tools", "pending_metadata", "mutation_checkpoint_index", "control_action",
    "control_status", "control_source", "summary_status", "reason", "error",
    "acknowledged_messages", "requeued_messages", "message_id", "propagated_descendants",
    "prior_run_seq", "recovered", "epoch", "expected_epoch", "received_epoch",
    "tool_count", "checkpoint_turns", "continuation_required", "prompt_echo_detected",
  ];
  const lines = [];
  const used = new Set();
  for (const field of preferredFields) {
    const value = eventFieldValue(field, data[field], text);
    if (!value) continue;
    const label = text.eventFields[field] || readableEventType(field);
    lines.push(`${label}: ${value}`);
    used.add(field);
    if (lines.length >= 4) break;
  }
  const remaining = Object.keys(data).filter((field) => !used.has(field) && eventValue(data[field], text));
  if (remaining.length > 0 && lines.length < 4) lines.push(`${text.eventDetails}: ${remaining.length}`);
  return lines;
}

function eventCard(ctx, event, text) {
  const type = String(event && event.type || "unknown");
  const title = text.eventTypes[type] || readableEventType(type);
  const time = formatEventTime(event && event.created_at);
  const meta = compact([
    time,
    event && Number(event.run_seq) > 0 ? `${text.run} ${event.run_seq}` : "",
  ]).join(" · ");
  const lines = eventSummary(event, text);
  return ctx.UI.Card({
    fillMaxWidth: true,
    containerColor: "surface",
    shape: SHAPE_MEDIUM,
    border: CARD_BORDER,
  }, [
    ctx.UI.Row({ padding: { horizontal: 12, vertical: 10 }, spacing: 10, verticalAlignment: "start" }, [
      ctx.UI.Surface({ width: 4, height: 38, containerColor: "secondary", shape: SHAPE_PILL }, []),
      ctx.UI.Column({ weight: 1, spacing: 4 }, compact([
        ctx.UI.Text({ text: title, style: "bodyMedium", fontWeight: "semiBold" }),
        meta ? ctx.UI.Text({ text: meta, style: "labelSmall", color: "onSurfaceVariant" }) : null,
        ...lines.map((line) => ctx.UI.Text({ text: line, style: "bodySmall", color: "onSurfaceVariant", maxLines: 2, overflow: "ellipsis" })),
      ])),
    ]),
  ]);
}

const components = {
  agentCard,
  errorCard,
  keyValue,
  loadingRow,
  noticeCard,
  sectionTitle,
  statCard,
  textField,
};

const VIEW_LIST = "list";
const VIEW_DETAIL = "detail";
const VIEW_CREATE = "create";
const VIEW_MESSAGE = "message";
const VIEW_FOLLOWUP = "followup";
const VIEW_CONFIRM = "confirm";

function useStateValue(ctx, key, initialValue) {
  const pair = ctx.useState(key, initialValue);
  return { value: pair[0], set: pair[1] };
}

function stringifyErrorDetails(details) {
  if (details === undefined || details === null || details === "") return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return String(details);
  }
}

function formatErrorText(error, text = null) {
  const code = String(error && error.code || "");
  const localized = code && text && text.errors ? text.errors[code] : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const details = stringifyErrorDetails(error && error.details);
  const parts = [localized || message || (text && text.unknown) || "unknown error"];
  if (localized && message && message !== localized) parts.push(message);
  if (details && details !== message) parts.push(details);
  return parts.join(": ");
}

function errorText(error) {
  return formatErrorText(error);
}

function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryInitialLoad(error) {
  return error && error.code === "ipc_invalid_response" ||
    /ipc|runtime|channel|unavailable|not registered|not initialized/i.test(errorText(error));
}

function compact(nodes) {
  return nodes.filter(Boolean);
}

function validationText(text, errors) {
  return errors.map((code) => text.errors[code] || code).join("\n");
}

function permissionSummary(agent, text) {
  const paths = Array.isArray(agent && agent.target_paths) ? agent.target_paths : [];
  return [
    `${text.readOnly}: ${agent && agent.read_only ? text.yes : text.no}`,
    `${text.workspacePath}: ${agent && agent.workspace_path || "-"}`,
    `${text.workspaceEnv}: ${agent && agent.workspace_env || "android"}`,
    `${text.targetPaths}:\n${paths.length ? paths.join("\n") : "-"}`,
  ].join("\n");
}

function Screen(ctx) {
  const text = resolveText(ctx);
  const errorText = (cause) => formatErrorText(cause, text);
  const view = useStateValue(ctx, "dashboard.view", VIEW_LIST);
  const listLoading = useStateValue(ctx, "dashboard.listLoading", false);
  const loadMoreLoading = useStateValue(ctx, "dashboard.loadMoreLoading", false);
  const detailLoading = useStateValue(ctx, "dashboard.detailLoading", false);
  const mutationLoading = useStateValue(ctx, "dashboard.mutationLoading", false);
  const waitLoading = useStateValue(ctx, "dashboard.waitLoading", false);
  const error = useStateValue(ctx, "dashboard.error", "");
  const notice = useStateValue(ctx, "dashboard.notice", "");
  const agents = useStateValue(ctx, "dashboard.agents", []);
  const summary = useStateValue(ctx, "dashboard.summary", { active: 0, queued: 0, total: 0, counts: {} });
  const cursor = useStateValue(ctx, "dashboard.cursor", "");
  const hasMore = useStateValue(ctx, "dashboard.hasMore", false);
  const statusFilter = useStateValue(ctx, "dashboard.statusFilter", "");
  const listRequestGuard = useStateValue(ctx, "dashboard.listRequestGuard", { generation: 0 });
  const detailRequestGuard = useStateValue(ctx, "dashboard.detailRequestGuard", { generation: 0 });
  const selectedAgent = useStateValue(ctx, "dashboard.selectedAgent", null);
  const treeNodes = useStateValue(ctx, "dashboard.treeNodes", []);
  const expandedTreeTasks = useStateValue(ctx, "dashboard.expandedTreeTasks", {});
  const showResult = useStateValue(ctx, "dashboard.showResult", false);
  const resultExpanded = useStateValue(ctx, "dashboard.resultExpanded", false);
  const confirmAction = useStateValue(ctx, "dashboard.confirmAction", null);
  const requestLedger = useStateValue(ctx, "dashboard.requestLedger", {});
  const settingsLoading = useStateValue(ctx, "dashboard.settings.loading", false);
  const globalMaxAgents = useStateValue(ctx, "dashboard.settings.maxAgents", "6");
  const globalMaxActiveRunsPerRoot = useStateValue(ctx, "dashboard.settings.maxActiveRunsPerRoot", "3");
  const globalMaxTools = useStateValue(ctx, "dashboard.settings.maxTools", "16");
  const globalMaxModelRetries = useStateValue(ctx, "dashboard.settings.maxModelRetries", "5");
  const conversationContextMode = useStateValue(ctx, "dashboard.settings.conversationContextMode", "auto");

  const createName = useStateValue(ctx, "dashboard.create.name", "");
  const createTask = useStateValue(ctx, "dashboard.create.task", "");
  const createContext = useStateValue(ctx, "dashboard.create.context", "");
  const createParent = useStateValue(ctx, "dashboard.create.parent", "");
  const createWorkspace = useStateValue(ctx, "dashboard.create.workspace", "");
  const createEnv = useStateValue(ctx, "dashboard.create.env", "android");
  const createReadOnly = useStateValue(ctx, "dashboard.create.readOnly", true);
  const createPaths = useStateValue(ctx, "dashboard.create.paths", "");
  const createPriority = useStateValue(ctx, "dashboard.create.priority", "normal");
  const createTimeout = useStateValue(ctx, "dashboard.create.timeout", "900000");

  const messageBody = useStateValue(ctx, "dashboard.message.body", "");
  const followTask = useStateValue(ctx, "dashboard.follow.task", "");
  const followContext = useStateValue(ctx, "dashboard.follow.context", "");
  const followMode = useStateValue(ctx, "dashboard.follow.mode", "readonly");
  const followPaths = useStateValue(ctx, "dashboard.follow.paths", "");
  const followWorkspace = useStateValue(ctx, "dashboard.follow.workspace", "");
  const followEnv = useStateValue(ctx, "dashboard.follow.env", "android");

  function clearFeedback() {
    error.set("");
    notice.set("");
  }

  function toast(message) {
    if (ctx && typeof ctx.showToast === "function") ctx.showToast(message);
  }

  function requestEntry(operation, payload) {
    const entry = nextRequest(requestLedger.value[operation], operation, payload);
    requestLedger.set({ ...requestLedger.value, [operation]: entry });
    return entry;
  }

  function requestStatus(operation, entry, status) {
    requestLedger.set({ ...requestLedger.value, [operation]: markRequest(entry, status) });
  }

  async function loadGlobalSettings() {
    const result = await api.getSettings();
    const value = result.settings || {};
    globalMaxAgents.set(String(value.max_concurrent_agents ?? 6));
    globalMaxActiveRunsPerRoot.set(String(value.max_active_runs_per_root ?? 3));
    globalMaxTools.set(String(value.max_tool_calls ?? 16));
    globalMaxModelRetries.set(String(value.max_model_retries ?? 5));
    conversationContextMode.set(["off", "on", "auto"].includes(value.conversation_context_mode)
      ? value.conversation_context_mode
      : "auto");
    return value;
  }

  async function saveGlobalSettings() {
    clearFeedback();
    const maxAgents = Number(globalMaxAgents.value);
    const maxActiveRunsPerRoot = Number(globalMaxActiveRunsPerRoot.value);
    const maxTools = Number(globalMaxTools.value);
    const maxModelRetries = Number(globalMaxModelRetries.value);
    const errors = [];
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) {
      errors.push("max_concurrent_agents_invalid");
    }
    if (!Number.isInteger(maxActiveRunsPerRoot) || maxActiveRunsPerRoot < 1 ||
        maxActiveRunsPerRoot > 8 || maxActiveRunsPerRoot > maxAgents) {
      errors.push("max_active_runs_per_root_invalid");
    }
    if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 64) {
      errors.push("max_tool_calls_invalid");
    }
    if (!Number.isInteger(maxModelRetries) || maxModelRetries < 0 || maxModelRetries > 12) {
      errors.push("max_model_retries_invalid");
    }
    if (!["off", "on", "auto"].includes(conversationContextMode.value)) {
      errors.push("conversation_context_mode_invalid");
    }
    if (errors.length > 0) {
      error.set(validationText(text, errors));
      return false;
    }
    settingsLoading.set(true);
    try {
      const result = await api.updateSettings({
        max_concurrent_agents: maxAgents,
        max_active_runs_per_root: maxActiveRunsPerRoot,
        max_tool_calls: maxTools,
        max_model_retries: maxModelRetries,
        conversation_context_mode: conversationContextMode.value,
      });
      const value = result.settings || {};
      globalMaxAgents.set(String(value.max_concurrent_agents ?? maxAgents));
      globalMaxActiveRunsPerRoot.set(String(value.max_active_runs_per_root ?? maxActiveRunsPerRoot));
      globalMaxTools.set(String(value.max_tool_calls ?? maxTools));
      globalMaxModelRetries.set(String(value.max_model_retries ?? maxModelRetries));
      conversationContextMode.set(["off", "on", "auto"].includes(value.conversation_context_mode)
        ? value.conversation_context_mode
        : conversationContextMode.value);
      notice.set(text.settingsSaved);
      toast(text.settingsSaved);
      await refresh(true);
      return true;
    } catch (cause) {
      error.set(errorText(cause));
      return false;
    } finally {
      settingsLoading.set(false);
    }
  }

  async function refresh(reset = true, statusOverride, options = {}) {
    if (reset) listLoading.set(true);
    else loadMoreLoading.set(true);
    error.set("");
    const requestedStatus = statusOverride === undefined
      ? statusFilter.value.trim()
      : String(statusOverride).trim();
    const requestedCursor = reset ? "" : cursor.value;
    const guard = listRequestGuard.value;
    const generation = (Number(guard.generation) || 0) + 1;
    guard.generation = generation;
    try {
      const attempts = options.initial === true ? 3 : 1;
      let result;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          result = await api.listAgents({
            limit: 20,
            cursor: requestedCursor,
            status: requestedStatus,
            include_results: false,
          });
          break;
        } catch (cause) {
          if (attempt >= attempts || !shouldRetryInitialLoad(cause)) throw cause;
          await waitFor(150 * attempt);
        }
      }
      if (guard.generation !== generation) return false;
      const incoming = Array.isArray(result && result.agents) ? result.agents : [];
      agents.set(reset ? incoming : mergeAgents(agents.value, incoming));
      summary.set(countSummary(result));
      cursor.set(result.next_cursor || "");
      hasMore.set(result.has_more === true);
      return true;
    } catch (cause) {
      if (guard.generation === generation) {
        error.set(errorText(cause));
      }
      return false;
    } finally {
      if (guard.generation === generation) {
        listLoading.set(false);
        loadMoreLoading.set(false);
      }
    }
  }

  async function loadDetail(agentId, switchView = true) {
    detailLoading.set(true);
    error.set("");
    const currentAgentId = selectedAgent.value && selectedAgent.value.id;
    if (currentAgentId && currentAgentId !== agentId) {
      expandedTreeTasks.set({});
      resultExpanded.set(false);
    }
    if (switchView) view.set(VIEW_DETAIL);
    const guard = detailRequestGuard.value;
    const generation = (Number(guard.generation) || 0) + 1;
    guard.generation = generation;
    try {
      const detail = await api.inspectAgent(agentId);
      if (guard.generation !== generation) return false;
      selectedAgent.set(detail.agent || null);
      const tree = await api.listTree({ agent_id: agentId });
      if (guard.generation !== generation) return false;
      const nextTreeNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
      treeNodes.set(nextTreeNodes);
      const validExecutionIds = new Set(nextTreeNodes.map((node) => String(node && node.execution_id || "")).filter(Boolean));
      expandedTreeTasks.set(Object.fromEntries(
        Object.entries(expandedTreeTasks.value || {}).filter(([executionId, expanded]) => expanded === true && validExecutionIds.has(executionId))
      ));
      return true;
    } catch (cause) {
      if (guard.generation === generation) error.set(errorText(cause));
      return false;
    } finally {
      if (guard.generation === generation) detailLoading.set(false);
    }
  }

  async function refreshAfterMutation(agentId) {
    await refresh(true);
    if (agentId) await loadDetail(agentId, true);
  }

  async function executeSpawn(payload) {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("spawn", payload);
    try {
      const result = await api.spawnAgent({ ...payload, request_id: entry.requestId });
      requestStatus("spawn", entry, "succeeded");
      notice.set(text.operationSucceeded);
      toast(text.operationSucceeded);
      await refreshAfterMutation(result.agent && result.agent.id);
    } catch (cause) {
      requestStatus("spawn", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  function submitSpawn() {
    clearFeedback();
    const input = {
      task: createTask.value,
      name: createName.value,
      context: createContext.value,
      parent_agent_id: createParent.value,
      workspace_path: createWorkspace.value,
      workspace_env: createEnv.value.trim() || "android",
      read_only: createReadOnly.value,
      target_paths_text: createPaths.value,
      priority: createPriority.value.trim() || "normal",
      timeout_ms: Number(createTimeout.value),
      max_tool_calls: 16,
    };
    const validated = validateSpawn(input);
    if (!validated.valid) {
      error.set(validationText(text, validated.errors));
      return;
    }
    const payload = {
      task: input.task.trim(),
      name: input.name.trim(),
      context: input.context.trim(),
      parent_agent_id: input.parent_agent_id.trim(),
      workspace_path: input.workspace_path.trim(),
      workspace_env: input.workspace_env,
      read_only: input.read_only,
      target_paths: validated.target_paths,
      priority: input.priority,
      timeout_ms: input.timeout_ms,
    };
    if (!payload.read_only) {
      confirmAction.set({
        kind: "spawn",
        payload,
        warning: `${text.writeWarning}\n\n${payload.target_paths.join("\n")}`,
      });
      view.set(VIEW_CONFIRM);
      return;
    }
    return executeSpawn(payload);
  }

  async function executeMessage() {
    const agent = selectedAgent.value;
    const message = messageBody.value.trim();
    if (!agent || !message) {
      error.set(message ? "agent_required" : "message is required");
      return;
    }
    mutationLoading.set(true);
    clearFeedback();
    const payload = { agent_id: agent.id, message };
    const entry = requestEntry("message", payload);
    try {
      await api.sendMessage({ ...payload, request_id: entry.requestId });
      requestStatus("message", entry, "succeeded");
      messageBody.set("");
      notice.set(text.queuedMessage);
      await refreshAfterMutation(agent.id);
    } catch (cause) {
      requestStatus("message", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  function buildFollowup() {
    const agent = selectedAgent.value;
    const input = {
      task: followTask.value,
      context: followContext.value,
      permission_mode: followMode.value,
      target_paths_text: followPaths.value,
      workspace_path: followWorkspace.value,
      workspace_env: followEnv.value.trim() || "android",
    };
    const validated = validateFollowup(input, agent);
    if (!validated.valid) {
      error.set(validationText(text, validated.errors));
      return null;
    }
    const payload = { agent_id: agent.id, task: input.task.trim(), context: input.context.trim() };
    if (validated.read_only !== undefined) payload.read_only = validated.read_only;
    if (validated.target_paths !== undefined) payload.target_paths = validated.target_paths;
    if (followMode.value === "write") {
      payload.workspace_path = input.workspace_path.trim();
      payload.workspace_env = input.workspace_env;
    }
    return payload;
  }

  async function executeFollowup(payload) {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("followup", payload);
    try {
      const result = await api.followupTask({ ...payload, request_id: entry.requestId });
      requestStatus("followup", entry, "succeeded");
      notice.set(text.operationSucceeded);
      await refreshAfterMutation(result.agent && result.agent.id || payload.agent_id);
    } catch (cause) {
      requestStatus("followup", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  function submitFollowup() {
    clearFeedback();
    const payload = buildFollowup();
    if (!payload) return;
    const inheritsWrite = followMode.value === "inherit" && selectedAgent.value && !selectedAgent.value.read_only;
    const specifiesWrite = followMode.value === "write";
    if (inheritsWrite || specifiesWrite) {
      const paths = specifiesWrite ? payload.target_paths : selectedAgent.value.target_paths;
      confirmAction.set({
        kind: "followup",
        payload,
        warning: `${inheritsWrite ? text.inheritedWriteWarning : text.writeWarning}\n\n${(paths || []).join("\n")}`,
      });
      view.set(VIEW_CONFIRM);
      return;
    }
    executeFollowup(payload);
  }

  async function executeInterrupt(payload) {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("interrupt", payload);
    try {
      await api.interruptAgent({ ...payload, request_id: entry.requestId });
      requestStatus("interrupt", entry, "succeeded");
      notice.set(text.operationSucceeded);
      await refreshAfterMutation(payload.agent_id);
    } catch (cause) {
      requestStatus("interrupt", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  async function waitForSelected() {
    const agent = selectedAgent.value;
    if (!agent) return;
    waitLoading.set(true);
    clearFeedback();
    try {
      const result = await api.waitAgent(agent.id, 5000);
      if (result.timed_out === true) notice.set(text.waitTimeout);
      await refreshAfterMutation(agent.id);
    } catch (cause) {
      error.set(errorText(cause));
    } finally {
      waitLoading.set(false);
    }
  }

  async function executeClearHistory() {
    mutationLoading.set(true);
    clearFeedback();
    try {
      const result = await api.clearHistory();
      notice.set(`${text.operationSucceeded} (${Number(result.deleted) || 0})`);
      toast(text.operationSucceeded);
      view.set(VIEW_LIST);
      await refresh(true);
    } catch (cause) {
      error.set(errorText(cause));
      view.set(VIEW_LIST);
    } finally {
      mutationLoading.set(false);
    }
  }

  async function executeDeleteAgent(agentId) {
    mutationLoading.set(true);
    clearFeedback();
    try {
      await api.deleteAgent(agentId);
      const detailGuard = detailRequestGuard.value;
      detailGuard.generation = (Number(detailGuard.generation) || 0) + 1;
      selectedAgent.set(null);
      treeNodes.set([]);
      expandedTreeTasks.set({});
      showResult.set(false);
      resultExpanded.set(false);
      notice.set(text.operationSucceeded);
      toast(text.operationSucceeded);
      view.set(VIEW_LIST);
      await refresh(true);
    } catch (cause) {
      error.set(errorText(cause));
      view.set(VIEW_DETAIL);
    } finally {
      mutationLoading.set(false);
    }
  }

  function confirmPending() {
    const action = confirmAction.value;
    if (!action) return;
    confirmAction.set(null);
    if (action.kind === "spawn") return executeSpawn(action.payload);
    if (action.kind === "followup") return executeFollowup(action.payload);
    if (action.kind === "interrupt") return executeInterrupt(action.payload);
    if (action.kind === "clearHistory") return executeClearHistory();
    if (action.kind === "deleteAgent") return executeDeleteAgent(action.payload.agent_id);
    return undefined;
  }

  function header() {
    return [
      ctx.UI.Surface({ fillMaxWidth: true, containerColor: "primaryContainer", shape: SHAPE_LARGE }, [
        ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: 16, spacing: 12 }, [
          ctx.UI.Surface({ containerColor: "primary", shape: SHAPE_MEDIUM }, [
            ctx.UI.Icon({ name: "accountTree", tint: "onPrimary", size: 24, padding: 10 }),
          ]),
          ctx.UI.Column({ weight: 1, spacing: 3 }, [
            ctx.UI.Text({ text: text.title, style: "headlineSmall", fontWeight: "bold" }),
            ctx.UI.Text({ text: text.subtitle, style: "bodySmall", color: "onPrimaryContainer", maxLines: 2, overflow: "ellipsis" }),
          ]),
        ]),
      ]),
    ];
  }

  async function selectStatusFilter(value) {
    const nextStatus = STATUS_FILTER_VALUES.includes(value) ? value : "";
    statusFilter.set(nextStatus);
    await refresh(true, nextStatus);
  }

  function statusFilterControl() {
    const rows = STATUS_FILTER_ROWS.map((values) => ctx.UI.Row({
      fillMaxWidth: true,
      spacing: 6,
    }, values.map((value) => ctx.UI.Button({
      text: `${value === statusFilter.value ? "✓ " : ""}${text.statusOptions[value]}`,
      weight: 1,
      shape: SHAPE_PILL,
      contentPadding: { horizontal: 8, vertical: 7 },
      onClick: () => selectStatusFilter(value),
    }))));
    return panel(ctx, [
      components.sectionTitle(ctx, text.statusFilter),
      ...rows,
      ctx.UI.Row({ fillMaxWidth: true, spacing: 6 }, [
        ctx.UI.Button({
          text: `${statusFilter.value === "orphaned" ? "✓ " : ""}${text.statusOptions.orphaned}`,
          weight: 1,
          shape: SHAPE_PILL,
          contentPadding: { horizontal: 8, vertical: 7 },
          onClick: () => selectStatusFilter("orphaned"),
        }),
        ctx.UI.Button({
          text: text.clearHistory,
          weight: 1,
          shape: SHAPE_PILL,
          containerColor: "error",
          contentColor: "onError",
          contentPadding: { horizontal: 8, vertical: 7 },
          enabled: !mutationLoading.value,
          onClick: () => {
            clearFeedback();
            confirmAction.set({ kind: "clearHistory", payload: {}, warning: text.clearHistoryWarning, returnView: VIEW_LIST });
            view.set(VIEW_CONFIRM);
          },
        }),
      ]),
    ], { containerColor: "surfaceVariant", border: false, spacing: 8 });
  }

  function globalSettingsControl() {
    return panel(ctx, [
      components.sectionTitle(ctx, text.globalSettings),
      components.textField(ctx, text.maxConcurrentAgents, globalMaxAgents, {
        singleLine: true,
        placeholder: "1–16",
      }),
      ctx.UI.Text({ text: text.maxConcurrentAgentsHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxActiveRunsPerRoot, globalMaxActiveRunsPerRoot, {
        singleLine: true,
        placeholder: "1–8",
      }),
      ctx.UI.Text({ text: text.maxActiveRunsPerRootHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxToolCalls, globalMaxTools, {
        singleLine: true,
        placeholder: "1–64",
      }),
      ctx.UI.Text({ text: text.maxToolCallsHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxModelRetries, globalMaxModelRetries, {
        singleLine: true,
        placeholder: "0–12",
      }),
      ctx.UI.Text({ text: text.maxModelRetriesHint, style: "bodySmall", color: "onSurfaceVariant" }),
      ctx.UI.Text({ text: text.conversationContext, style: "labelLarge", fontWeight: "semiBold" }),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 6 }, ["off", "on", "auto"].map((mode) => ctx.UI.Button({
        text: `${mode === conversationContextMode.value ? "✓ " : ""}${text.conversationContextOptions[mode]}`,
        weight: 1,
        shape: SHAPE_PILL,
        contentPadding: { horizontal: 8, vertical: 7 },
        onClick: () => conversationContextMode.set(mode),
      }))),
      ctx.UI.Text({ text: text.conversationContextHint, style: "bodySmall", color: "onSurfaceVariant" }),
      settingsLoading.value
        ? components.loadingRow(ctx, text.loading)
        : ctx.UI.Button({ text: text.saveSettings, fillMaxWidth: true, shape: SHAPE_SMALL, onClick: saveGlobalSettings }),
    ], { spacing: 9 });
  }

  function listView() {
    const nodes = [
      ...header(),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        components.statCard(ctx, text.active, summary.value.active, "primaryContainer"),
        components.statCard(ctx, text.queued, summary.value.queued, "secondaryContainer"),
        components.statCard(ctx, text.total, summary.value.total),
      ]),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        ctx.UI.Button({
          text: text.refresh,
          weight: 1,
          shape: SHAPE_SMALL,
          enabled: !listLoading.value,
          onClick: () => refresh(true),
        }),
        ctx.UI.Button({
          text: text.create,
          weight: 1,
          shape: SHAPE_SMALL,
          onClick: () => { clearFeedback(); view.set(VIEW_CREATE); },
        }),
      ]),
      components.errorCard(ctx, error.value),
      components.noticeCard(ctx, notice.value),
      globalSettingsControl(),
      statusFilterControl(),
    ];
    if (listLoading.value) nodes.push(components.loadingRow(ctx, text.loading));
    else if (agents.value.length === 0) nodes.push(emptyState(ctx, text.noAgents));
    else for (const agent of agents.value) nodes.push(components.agentCard(ctx, agent, text, loadDetail));
    if (hasMore.value) {
      nodes.push(ctx.UI.Button({
        text: loadMoreLoading.value ? text.loading : text.loadMore,
        enabled: !loadMoreLoading.value,
        fillMaxWidth: true,
        shape: SHAPE_SMALL,
        onClick: () => refresh(false),
      }));
    }
    return compact(nodes);
  }

  function detailView() {
    const agent = selectedAgent.value;
    const execution = agent && agent.execution || {};
    const actions = allowedActions(agent && agent.status);
    const deleteButton = ctx.UI.Button({
      text: text.delete,
      shape: SHAPE_SMALL,
      enabled: !!agent && isTerminal(agent.status) && !mutationLoading.value,
      onClick: () => {
        if (!agent || !isTerminal(agent.status)) return;
        clearFeedback();
        confirmAction.set({
          kind: "deleteAgent",
          payload: { agent_id: agent.id },
          warning: `${text.deleteAgentWarning}\n\n${agent.name || agent.id}`,
          returnView: VIEW_DETAIL,
        });
        view.set(VIEW_CONFIRM);
      },
    });
    const nodes = [
      pageHeader(ctx, {
        back: text.back,
        label: agent && (agent.name || shortId(agent.id)) || text.details,
      }, () => { clearFeedback(); view.set(VIEW_LIST); }, deleteButton),
      components.errorCard(ctx, error.value),
      components.noticeCard(ctx, notice.value),
    ];
    if (detailLoading.value || !agent) {
      nodes.push(components.loadingRow(ctx, text.loading));
      return compact(nodes);
    }
    nodes.push(
      panel(ctx, [
        ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 10 }, [
          components.sectionTitle(ctx, agent.name || shortId(agent.id)),
          statusBadge(ctx, localizedOption(text.statusOptions, agent.status, text.unknown), agent.status),
        ]),
        components.keyValue(ctx, text.agentId, agent.id),
        components.keyValue(ctx, text.status, localizedOption(text.statusOptions, agent.status, text.unknown)),
        components.keyValue(ctx, text.run, agent.run_seq),
        components.keyValue(ctx, text.priority, localizedOption(text.priorityOptions, agent.priority || "normal", agent.priority || "normal")),
        components.keyValue(ctx, text.currentTool, execution.current_tool || "-"),
        components.keyValue(ctx, text.toolCalls, execution.tool_count || 0),
        components.keyValue(ctx, text.modelRequestAttempts, execution.model_request_attempts || 0),
        components.keyValue(ctx, text.modelRetryCount, execution.model_retry_count || 0),
        components.keyValue(ctx, text.checkpointTurns, execution.checkpoint_turns || 0),
        components.keyValue(ctx, text.currentActionGate,
          execution.current_action_gate
            ? `${execution.current_action_gate.kind}${Array.isArray(execution.current_action_gate.allowed_tools) && execution.current_action_gate.allowed_tools.length > 0 ? ` / ${execution.current_action_gate.allowed_tools.join(", ")}` : ""}`
            : text.actionGateNone),
        components.keyValue(ctx, text.actionGateActivations, execution.action_gate_activation_count || 0),
        components.keyValue(ctx, text.actionGateBlocks, execution.action_gate_block_count || 0),
        components.keyValue(ctx, text.control, `${localizedOption(text.controlStatusOptions, execution.control_status, execution.control_status || "-")} / ${localizedOption(text.controlSourceOptions, execution.control_source, execution.control_source || "-")}`),
        components.keyValue(ctx, text.messages, `${text.queuedMessages}=${agent.pending_messages || 0}, ${text.deliveredMessages}=${agent.delivered_messages || 0}, ${text.acknowledgedMessages}=${agent.acknowledged_messages || 0}`),
      ], { spacing: 3 }),
      components.sectionTitle(ctx, text.permissions),
      components.noticeCard(ctx, permissionSummary(agent, text), agent.read_only ? "surfaceVariant" : "tertiaryContainer"),
      components.sectionTitle(ctx, text.taskTree),
    );
    if (treeNodes.value.length === 0) nodes.push(emptyState(ctx, text.treeEmpty));
    else for (const node of treeNodes.value) {
      const taskKey = String(node.execution_id || `${node.agent_id || "agent"}:${node.run_seq || 0}`);
      const taskExpanded = expandedTreeTasks.value && expandedTreeTasks.value[taskKey] === true;
      nodes.push(ctx.UI.Card({
        fillMaxWidth: true,
        containerColor: "surface",
        shape: SHAPE_MEDIUM,
        border: CARD_BORDER,
      }, [
        ctx.UI.Row({ padding: { horizontal: 12, vertical: 10 }, spacing: 10, verticalAlignment: "center" }, [
          ctx.UI.Surface({
            width: 4,
            height: 36,
            containerColor: statusColor(node.status),
            shape: SHAPE_PILL,
          }, []),
          ctx.UI.Column({ weight: 1, spacing: 3 }, [
            ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
              ctx.UI.Text({
                text: `${"  ".repeat(node.tree_depth || 0)}${node.name || shortId(node.agent_id)}`,
                fontWeight: "semiBold",
                weight: 1,
                maxLines: 1,
                overflow: "ellipsis",
              }),
              statusBadge(ctx, localizedOption(text.statusOptions, node.status, text.unknown), node.status),
            ]),
            ctx.UI.Row({
              fillMaxWidth: true,
              onClick: () => expandedTreeTasks.set({
                ...(expandedTreeTasks.value || {}),
                [taskKey]: !taskExpanded,
              }),
            }, [
              ctx.UI.Text({
                text: taskExpanded ? (node.task || node.task_excerpt || "-") : (node.task_excerpt || node.task || "-"),
                style: "bodySmall",
                color: "onSurfaceVariant",
                softWrap: true,
                weight: 1,
                ...(taskExpanded ? {} : { maxLines: 2, overflow: "ellipsis" }),
              }),
            ]),
          ]),
        ]),
      ]));
    }
    nodes.push(
      ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, compact([
        actions.message ? ctx.UI.Button({ text: text.message, weight: 1, onClick: () => {
          clearFeedback();
          messageBody.set("");
          view.set(VIEW_MESSAGE);
        } }) : null,
        actions.wait ? ctx.UI.Button({ text: waitLoading.value ? text.loading : text.wait, weight: 1, enabled: !waitLoading.value, onClick: waitForSelected }) : null,
      ])),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, compact([
        actions.followup ? ctx.UI.Button({ text: text.followup, weight: 1, onClick: () => {
          clearFeedback();
          followTask.set("");
          followContext.set("");
          followMode.set("readonly");
          followPaths.set("");
          followWorkspace.set(agent.workspace_path || "");
          followEnv.set(agent.workspace_env || "android");
          view.set(VIEW_FOLLOWUP);
        } }) : null,
        actions.interrupt ? ctx.UI.Button({ text: text.interrupt, weight: 1, onClick: () => {
          confirmAction.set({ kind: "interrupt", payload: { agent_id: agent.id }, warning: text.interruptWarning });
          view.set(VIEW_CONFIRM);
        } }) : null,
      ])),
      ctx.UI.Button({
        text: showResult.value ? text.hideResult : text.showResult,
        fillMaxWidth: true,
        onClick: () => {
          const nextVisible = !showResult.value;
          showResult.set(nextVisible);
          if (nextVisible) resultExpanded.set(false);
        },
      })
    );
    if (showResult.value) {
      nodes.push(
        components.sectionTitle(ctx, text.result),
        resultView(
          ctx,
          agent.result || execution.result || agent.error || "",
          text,
          resultExpanded.value,
          () => resultExpanded.set(!resultExpanded.value)
        ),
        components.sectionTitle(ctx, text.events)
      );
      const recentEvents = Array.isArray(agent.recent_events) ? agent.recent_events : [];
      if (recentEvents.length === 0) nodes.push(emptyState(ctx, text.recentEventsEmpty));
      else for (const event of [...recentEvents].reverse()) nodes.push(eventCard(ctx, event, text));
    }
    return compact(nodes);
  }

  function createView() {
    return compact([
      pageHeader(ctx, { back: text.back, label: text.create }, () => { clearFeedback(); view.set(VIEW_LIST); }),
      panel(ctx, [
        components.textField(ctx, text.name, createName, { singleLine: true }),
        components.textField(ctx, text.task, createTask, { minLines: 3 }),
        components.textField(ctx, text.context, createContext, { minLines: 2 }),
        components.textField(ctx, text.parentAgentId, createParent, { singleLine: true }),
      ]),
      panel(ctx, [
        components.sectionTitle(ctx, text.permissions),
        components.textField(ctx, text.workspacePath, createWorkspace, { singleLine: true }),
        components.textField(ctx, text.workspaceEnv, createEnv, { singleLine: true }),
        ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surfaceVariant", shape: SHAPE_MEDIUM }, [
          ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: 12 }, [
            ctx.UI.Text({ text: text.readOnlyToggle, weight: 1, fontWeight: "semiBold" }),
            ctx.UI.Switch({ checked: createReadOnly.value, onCheckedChange: createReadOnly.set }),
          ]),
        ]),
        createReadOnly.value ? null : components.textField(ctx, text.targetPaths, createPaths, { minLines: 4, placeholder: text.pathsHint }),
        createReadOnly.value ? null : components.noticeCard(ctx, text.writeWarning, "tertiaryContainer"),
        components.textField(ctx, text.priority, createPriority, { singleLine: true }),
        components.textField(ctx, text.timeoutMs, createTimeout, { singleLine: true }),
      ]),
      components.errorCard(ctx, error.value),
      mutationLoading.value
        ? components.loadingRow(ctx, text.loading)
        : ctx.UI.Button({ text: text.submit, fillMaxWidth: true, shape: SHAPE_SMALL, onClick: submitSpawn }),
    ]);
  }

  function messageView() {
    return compact([
      pageHeader(ctx, { back: text.back, label: text.message }, () => { clearFeedback(); view.set(VIEW_DETAIL); }),
      panel(ctx, [
        components.textField(ctx, text.messageBody, messageBody, { minLines: 5 }),
        components.noticeCard(ctx, text.queuedMessage, "surfaceVariant"),
      ]),
      components.errorCard(ctx, error.value),
      mutationLoading.value
        ? components.loadingRow(ctx, text.loading)
        : ctx.UI.Button({ text: text.submit, fillMaxWidth: true, shape: SHAPE_SMALL, onClick: executeMessage }),
    ]);
  }

  function followupView() {
    const modeText = followMode.value === "inherit" ? text.inherit : followMode.value === "write" ? text.specifyWrite : text.forceReadOnly;
    return compact([
      pageHeader(ctx, { back: text.back, label: text.followup }, () => { clearFeedback(); view.set(VIEW_DETAIL); }),
      panel(ctx, [
        components.textField(ctx, text.task, followTask, { minLines: 3 }),
        components.textField(ctx, text.context, followContext, { minLines: 2 }),
      ]),
      panel(ctx, [
        components.sectionTitle(ctx, text.permissions),
        ctx.UI.Text({ text: `${text.permissionMode}: ${modeText}`, style: "bodyMedium", fontWeight: "semiBold" }),
        ctx.UI.Row({ fillMaxWidth: true, spacing: 6 }, [
          ctx.UI.Button({
            text: `${followMode.value === "inherit" ? "✓ " : ""}${text.inherit}`,
            weight: 1,
            shape: SHAPE_PILL,
            onClick: () => followMode.set("inherit"),
          }),
          ctx.UI.Button({
            text: `${followMode.value === "readonly" ? "✓ " : ""}${text.forceReadOnly}`,
            weight: 1,
            shape: SHAPE_PILL,
            onClick: () => followMode.set("readonly"),
          }),
        ]),
        ctx.UI.Button({
          text: `${followMode.value === "write" ? "✓ " : ""}${text.specifyWrite}`,
          fillMaxWidth: true,
          shape: SHAPE_PILL,
          onClick: () => followMode.set("write"),
        }),
        followMode.value === "write" ? components.textField(ctx, text.workspacePath, followWorkspace, { singleLine: true }) : null,
        followMode.value === "write" ? components.textField(ctx, text.workspaceEnv, followEnv, { singleLine: true }) : null,
        followMode.value === "write" ? components.textField(ctx, text.targetPaths, followPaths, { minLines: 4, placeholder: text.pathsHint }) : null,
        followMode.value === "write" ? components.noticeCard(ctx, text.writeWarning, "tertiaryContainer") : null,
        followMode.value === "inherit" && selectedAgent.value && !selectedAgent.value.read_only
          ? components.noticeCard(ctx, `${text.inheritedWriteWarning}\n\n${permissionSummary(selectedAgent.value, text)}`, "tertiaryContainer")
          : null,
      ]),
      components.errorCard(ctx, error.value),
      mutationLoading.value
        ? components.loadingRow(ctx, text.loading)
        : ctx.UI.Button({ text: text.submit, fillMaxWidth: true, shape: SHAPE_SMALL, onClick: submitFollowup }),
    ]);
  }

  function confirmView() {
    const action = confirmAction.value;
    const destructive = action && ["interrupt", "deleteAgent", "clearHistory"].includes(action.kind);
    return compact([
      pageHeader(ctx, { label: text.confirm }),
      ctx.UI.Card({
        fillMaxWidth: true,
        containerColor: destructive ? "errorContainer" : "tertiaryContainer",
        shape: SHAPE_LARGE,
        border: { width: 1, color: destructive ? "error" : "tertiary" },
      }, [
        ctx.UI.Column({ padding: 18, spacing: 12, horizontalAlignment: "center" }, [
          ctx.UI.Icon({ name: destructive ? "error" : "warning", tint: destructive ? "onErrorContainer" : "onTertiaryContainer", size: 28 }),
          ctx.UI.Text({
            text: action && action.warning || "-",
            style: "bodyMedium",
            color: destructive ? "onErrorContainer" : "onTertiaryContainer",
            softWrap: true,
          }),
        ]),
      ]),
      components.errorCard(ctx, error.value),
      mutationLoading.value ? components.loadingRow(ctx, text.loading) : ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        ctx.UI.Button({ text: text.cancel, weight: 1, shape: SHAPE_SMALL, onClick: () => {
          confirmAction.set(null);
          if (action && action.returnView) view.set(action.returnView);
          else if (action && action.kind === "spawn") view.set(VIEW_CREATE);
          else view.set(VIEW_DETAIL);
        } }),
        ctx.UI.Button({ text: text.confirm, weight: 1, shape: SHAPE_SMALL, onClick: confirmPending }),
      ]),
    ]);
  }

  let content;
  if (view.value === VIEW_DETAIL) content = detailView();
  else if (view.value === VIEW_CREATE) content = createView();
  else if (view.value === VIEW_MESSAGE) content = messageView();
  else if (view.value === VIEW_FOLLOWUP) content = followupView();
  else if (view.value === VIEW_CONFIRM) content = confirmView();
  else content = listView();

  return ctx.UI.LazyColumn({
    onLoad: async () => {
      const loadSettingsPromise = loadGlobalSettings();
      const refreshPromise = refresh(true, undefined, { initial: true });
      try {
        await loadSettingsPromise;
      } catch (cause) {
        error.set(errorText(cause));
      }
      await refreshPromise;
    },
    fillMaxSize: true,
    padding: 16,
    spacing: 12,
  }, content);
}

module.exports = {
  default: Screen,
  Screen,
  __test: { TEXT, failedResponseError, formatErrorText, markdownInlineText, parseMarkdownBlocks },
};