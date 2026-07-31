type DynamicValue = unknown;
type DynamicRecord = Record<string, DynamicValue>;
type ResultRow = { label: unknown; value: unknown; tone: string };
type MarkdownBlock = {
  type: string;
  text?: string;
  marker?: string;
  level?: number;
  language?: string;
};

function asRecord(value: unknown): DynamicRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as DynamicRecord
    : {};
}

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
  WATCH_TREE_EVENTS: "collaboration.watch_tree_events",
  GET_SETTINGS: "collaboration.get_settings",
  UPDATE_SETTINGS: "collaboration.update_settings",
  DELETE_AGENT: "collaboration.delete_agent",
  CLEAR_HISTORY: "collaboration.clear_history",
});

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
  ["timed_out", "orphaned"],
]);
const TOOLPKG_UPDATE = Object.freeze({
  packageId: "com.operit.collaboration_orchestrator",
  targetDir: "/sdcard/Android/data/com.ai.assistance.operit/files/packages",
  action: "com.ai.assistance.operit.DEBUG_INSTALL_TOOLPKG",
  component: "com.ai.assistance.operit/.core.tools.packTool.ToolPkgDebugInstallReceiver",
});

function pickedFileName(fileValue: DynamicValue): string {
  const file = asRecord(fileValue);
  for (const candidateValue of [file.name, file.path, file.uri]) {
    const candidate = String(candidateValue || "").trim().split(/[?#]/, 1)[0];
    if (!candidate) continue;
    const segments = candidate.split(/[\\/]/);
    const name = segments[segments.length - 1];
    if (name) return name;
  }
  return "";
}

function isToolPkgArchive(fileValue: DynamicValue): boolean {
  return /\.toolpkg$/i.test(pickedFileName(fileValue));
}

function buildToolPkgUpdatePayload(fileValue: DynamicValue, timestamp = Date.now()): DynamicRecord {
  const file = asRecord(fileValue);
  const safeTimestamp = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : Date.now();
  return {
    source_path: String(file.path || "").trim(),
    source_name: String(file.name || pickedFileName(file)).trim(),
    source_size: typeof file.size === "number" ? file.size : null,
    target_path: `${TOOLPKG_UPDATE.targetDir}/${TOOLPKG_UPDATE.packageId}-${safeTimestamp}.toolpkg`,
  };
}

function buildToolPkgCopyParams(payloadValue: DynamicValue): DynamicRecord {
  const payload = asRecord(payloadValue);
  return {
    source: String(payload.source_path || ""),
    destination: String(payload.target_path || ""),
    recursive: "false",
    source_environment: "android",
    dest_environment: "android",
  };
}

function buildToolPkgBroadcastParams(payloadValue: DynamicValue): DynamicRecord {
  const payload = asRecord(payloadValue);
  return {
    action: TOOLPKG_UPDATE.action,
    component: TOOLPKG_UPDATE.component,
    extras: {
      package_name: TOOLPKG_UPDATE.packageId,
      file_path: String(payload.target_path || ""),
      reset_subpackage_states: true,
    },
  };
}

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
    running: "运行中",
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
    maxConcurrentAgentsHint: "范围 1–16；0 表示不限。降低后不会中断正在运行的 Agent，只限制后续启动。",
    maxActiveRunsPerRoot: "单根任务树并发上限",
    maxActiveRunsPerRootHint: "范围 1–8；0 表示不限。有限值不得高于有限的全局并发数。",
    maxToolCalls: "全局工具调用数",
    maxToolCallsHint: "范围 1–64；0 表示不限。统一应用到所有新运行，属于 Agent 提示预算。",
    maxModelRetries: "AI 调用重试次数",
    maxModelRetriesHint: "范围 0–12；-1 表示不限，0 表示禁用重试，默认 5。仅重试网络、限流和服务临时异常。",
    conversationContext: "共享主对话上下文",
    conversationContextHint: "每个检查点从同一主会话引用读取最新的用户/助手历史，不保存 Run 创建时快照；系统提示和工具轨迹不共享。自动模式由调用 AI 决定。",
    conversationContextOptions: { off: "关闭", on: "开启", auto: "自动" },
    saveSettings: "保存全局设置",
    settingsSaved: "全局设置已保存",
    packageUpdate: "更新当前 ToolPkg",
    packageUpdateHint: "选择 .toolpkg 安装包。确认后会复制到宿主包目录并请求重载；当前控制台可能立即关闭。",
    choosePackage: "选择安装包",
    packageSelected: "已选择安装包",
    packageUpdateWarning: "将更新当前 ToolPkg，宿主重载可能立即结束此控制台和正在进行的插件调用。请先完成需要保留的操作。",
    packageUpdateSubmitting: "正在复制安装包…",
    packageUpdateRequested: "更新请求已提交；宿主将在后台完成安装和重载",
    packagePickerCancelled: "已取消选择安装包",
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
    liveOutput: "实时输出",
    streamRevision: "上下文版本",
    taskTree: "任务树",
    permissions: "权限",
    messageBody: "消息内容",
    permissionMode: "权限模式",
    readOnlyToggle: "强制只读",
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
      model_delta: "AI 输出片段",
      model_stream_started: "AI 流已开始",
      model_stream_ended: "AI 流已结束",
      model_stream_recovered_interrupted: "AI 流恢复中断",
      tool_result: "工具结果已提交",
      tree_context_broadcast: "上下文已广播",
      tree_context_refresh_scheduled: "上下文刷新已安排",
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
      timeout_invalid: "超时必须为 0（不限）或 30000–3600000 毫秒",
      max_tool_calls_invalid: "全局工具调用数必须为 0（不限）或 1–64 的整数",
      max_concurrent_agents_invalid: "全局并发 Agent 数必须为 0（不限）或 1–16 的整数",
      max_active_runs_per_root_invalid: "单根任务树并发上限必须为 0（不限）或 1–8 的整数，有限值不得高于有限的全局并发数",
      max_model_retries_invalid: "AI 调用重试次数必须为 -1（不限）或 0–12 的整数",
      conversation_context_mode_invalid: "对话上下文模式必须为关闭、开启或自动",
      write_paths_required: "可写任务必须至少声明一个目标路径",
      path_not_absolute: "目标路径必须为绝对路径",
      path_outside_workspace: "目标路径位于工作区之外",
      workspace_not_absolute: "工作区路径必须为绝对路径",
      permission_mode_invalid: "权限模式无效",
      agent_required: "缺少 Agent",
      package_file_invalid: "请选择 .toolpkg 安装包",
      package_file_path_missing: "宿主没有返回可复制的安装包路径",
      package_update_unsupported: "当前宿主缺少 ToolPkg 更新所需的文件选择或工具调用能力",
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
    running: "Running",
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
    maxConcurrentAgentsHint: "Range 1-16; 0 is unlimited. Lowering this does not interrupt running Agents and only limits new starts.",
    maxActiveRunsPerRoot: "Per-root task-tree concurrency",
    maxActiveRunsPerRootHint: "Range 1-8; 0 is unlimited. A finite value cannot exceed finite global concurrency.",
    maxToolCalls: "Global tool calls",
    maxToolCallsHint: "Range 1-64; 0 is unlimited. Applied to every new Run as an Agent prompt budget.",
    maxModelRetries: "AI call retries",
    maxModelRetriesHint: "Range 0-12; -1 is unlimited, 0 disables retries, default 5. Only network, rate-limit, and temporary service failures are retried.",
    conversationContext: "Share main conversation context",
    conversationContextHint: "Every checkpoint reads the latest user/assistant history through the same main-chat reference instead of storing a Run-creation snapshot. System prompts and tool traces are excluded. Auto is decided by the calling AI.",
    conversationContextOptions: { off: "Off", on: "On", auto: "Auto" },
    saveSettings: "Save global settings",
    settingsSaved: "Global settings saved",
    packageUpdate: "Update current ToolPkg",
    packageUpdateHint: "Choose a .toolpkg archive. Confirmation copies it to the host package directory and requests a reload; this dashboard may close immediately.",
    choosePackage: "Choose package",
    packageSelected: "Selected package",
    packageUpdateWarning: "This updates the current ToolPkg. Host reload may immediately end this dashboard and in-flight plugin calls. Finish any work you need to retain first.",
    packageUpdateSubmitting: "Copying the package…",
    packageUpdateRequested: "Update request submitted; the host will install and reload it in the background",
    packagePickerCancelled: "Package selection cancelled",
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
    liveOutput: "Live output",
    streamRevision: "Context revision",
    taskTree: "Task tree",
    permissions: "Permissions",
    messageBody: "Message",
    permissionMode: "Permission mode",
    readOnlyToggle: "Force read-only",
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
      model_delta: "AI output chunk",
      model_stream_started: "AI stream started",
      model_stream_ended: "AI stream ended",
      model_stream_recovered_interrupted: "AI stream recovered as interrupted",
      tool_result: "Tool result committed",
      tree_context_broadcast: "Context broadcast",
      tree_context_refresh_scheduled: "Context refresh scheduled",
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
      timeout_invalid: "Timeout must be 0 (unlimited) or 30000-3600000 ms",
      max_tool_calls_invalid: "Global tool calls must be 0 (unlimited) or an integer between 1 and 64",
      max_concurrent_agents_invalid: "Global concurrent Agents must be 0 (unlimited) or an integer between 1 and 16",
      max_active_runs_per_root_invalid: "Per-root concurrency must be 0 (unlimited) or an integer between 1 and 8; a finite value cannot exceed finite global concurrency",
      max_model_retries_invalid: "AI call retries must be -1 (unlimited) or an integer between 0 and 12",
      conversation_context_mode_invalid: "Conversation context mode must be Off, On, or Auto",
      write_paths_required: "Writable tasks require at least one target path",
      path_not_absolute: "Target paths must be absolute",
      path_outside_workspace: "A target path is outside the workspace",
      workspace_not_absolute: "Workspace path must be absolute",
      permission_mode_invalid: "Permission mode is invalid",
      agent_required: "Agent is required",
      package_file_invalid: "Choose a .toolpkg archive",
      package_file_path_missing: "The host did not return a package path that can be copied",
      package_update_unsupported: "This host is missing the file picker or tool-call support required for ToolPkg updates",
      ipc_invalid_response: "Invalid IPC response",
      operation_failed: "Operation failed",
    },
  },
};

type DashboardText = typeof TEXT.zh;
type DashboardAgent = DynamicRecord & {
  id: string;
  name?: string;
  status?: string;
  priority?: string;
  execution?: DynamicRecord;
  run_seq?: number;
  read_only?: boolean;
  pending_messages?: number;
  delivered_messages?: number;
  acknowledged_messages?: number;
  target_paths?: string[];
  workspace_path?: string;
  workspace_env?: string;
  result?: DynamicValue;
  error?: DynamicValue;
  recent_events?: DynamicRecord[];
};
type DashboardSummary = { active: number; running: number; queued: number; total: number; counts: DynamicRecord };
type RequestEntry = { requestId: string; fingerprint: string; status: string };
type RequestLedger = Record<string, RequestEntry | null>;
type ConfirmAction = { kind: string; payload: DynamicRecord; warning: string; returnView?: string };
type ValidationResult = { valid: boolean; errors: string[]; target_paths?: string[]; read_only?: boolean };
type StateValue<T> = { value: T; set: (value: T) => void };
type AllowedActions = { message: boolean; wait: boolean; followup: boolean; interrupt: boolean };
type PageHeaderTitle = { back?: string; label: string };
type UiContext = ToolPkg.ComposeDslContext;
type UiNode = ToolPkg.ComposeNode;

function resolveText(ctx: UiContext): DashboardText {
  let language: keyof typeof TEXT = "zh";
  try {
    const locale = String(ctx && typeof ctx.getEnv === "function" ? ctx.getEnv("LANG") || "" : "").toLowerCase();
    if (locale.startsWith("en")) language = "en";
  } catch (_) {}
  return TEXT[language];
}

function runtime(): ToolPkg.Registry {
  if (typeof ToolPkg === "undefined" || !ToolPkg || !ToolPkg.ipc ||
      typeof ToolPkg.ipc.call !== "function") {
    throw new Error("ToolPkg IPC is unavailable");
  }
  return ToolPkg;
}

function ipcError(code: unknown, message: unknown, details?: DynamicValue): Error & { code?: string; details?: DynamicValue } {
  const error: Error & { code?: string; details?: DynamicValue } = new Error(String(message || ""));
  error.name = "DashboardIpcError";
  error.code = String(code || "operation_failed");
  if (details !== undefined) error.details = details;
  return error;
}

function failedResponseError(resultValue: DynamicValue): Error {
  const result = asRecord(resultValue);
  const errorObject = asRecord(result.error);
  const code = String(result.code || errorObject.code || "operation_failed");
  const message = typeof result.error === "string"
    ? result.error
    : String(errorObject.message || result.message || "");
  const details = result.details !== undefined
    ? result.details
    : (errorObject.details !== undefined ? errorObject.details : undefined);
  return ipcError(code, message, details);
}

type DashboardIpcCall = (
  channel: string,
  payload: DynamicRecord,
) => Promise<DynamicRecord>;

function captureIpcCall(): DashboardIpcCall {
  const call = runtime().ipc.call;
  return async (channel, payload) => {
    const result = await call<DynamicRecord, DynamicRecord>(channel, payload || {});
    if (!result || typeof result !== "object") {
      throw ipcError("ipc_invalid_response", "", { channel, response: result ?? null });
    }
    if (result.success === false) throw failedResponseError(result);
    return result;
  };
}

const api = {
  listAgents: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.LIST_AGENTS, payload),
  inspectAgent: (agentId: string, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.INSPECT_AGENT, { agent_id: agentId }),
  listTree: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.LIST_TREE, payload),
  watchTreeEvents: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.WATCH_TREE_EVENTS, payload),
  getSettings: (ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.GET_SETTINGS, {}),
  updateSettings: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.UPDATE_SETTINGS, payload),
  deleteAgent: (agentId: string, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.DELETE_AGENT, { agent_id: agentId }),
  clearHistory: (ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.CLEAR_HISTORY, {}),
  spawnAgent: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.SPAWN_AGENT, payload),
  sendMessage: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.SEND_MESSAGE, payload),
  followupTask: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.FOLLOWUP_TASK, payload),
  waitAgent: (agentId: string, timeoutMs = 5000, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.WAIT_AGENT, {
      agent_ids: [agentId],
      timeout_ms: timeoutMs,
    }),
  interruptAgent: (payload: DynamicRecord, ipcCall: DashboardIpcCall = captureIpcCall()) =>
    ipcCall(CHANNELS.INTERRUPT_AGENT, payload),
};

function isTerminal(status: unknown): boolean {
  return TERMINAL_STATUSES.has(String(status || ""));
}

function allowedActions(status: unknown): AllowedActions {
  const value = String(status || "");
  return {
    message: ACTIVE_STATUSES.has(value),
    wait: ACTIVE_STATUSES.has(value) || value === "cancelling",
    followup: isTerminal(value),
    interrupt: ACTIVE_STATUSES.has(value),
  };
}

function mergeAgents(current: DashboardAgent[], incoming: DashboardAgent[]): DashboardAgent[] {
  const map = new Map<string, DashboardAgent>();
  for (const agent of Array.isArray(current) ? current : []) map.set(agent.id, agent);
  for (const agent of Array.isArray(incoming) ? incoming : []) map.set(agent.id, agent);
  return Array.from(map.values());
}

function shortId(value: unknown, size = 12): string {
  const text = String(value || "");
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

function statusColor(status: unknown): string {
  if (status === "failed" || status === "orphaned") return "errorContainer";
  if (status === "running") return "primaryContainer";
  if (status === "queued" || status === "cancelling") return "secondaryContainer";
  if (status === "timed_out" || status === "interrupted" || status === "interrupted_with_late_result") {
    return "tertiaryContainer";
  }
  return "surfaceVariant";
}

function countSummary(resultValue: DynamicValue): DashboardSummary {
  const result = asRecord(resultValue);
  const counts = asRecord(result.status_counts);
  return {
    active: Number(result.active) || 0,
    running: Number(counts.running) || 0,
    queued: Number(result.queued) || 0,
    total: Number(result.total) || 0,
    counts,
  };
}

function parseTargetPaths(text: unknown): string[] {
  return Array.from(new Set(
    String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function isAbsolutePath(value: unknown): boolean {
  const path = String(value || "").trim();
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeForCompare(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWithinWorkspace(path: unknown, workspace: unknown): boolean {
  const child = normalizeForCompare(path);
  const root = normalizeForCompare(workspace);
  if (!root) return true;
  const left = /^[A-Za-z]:\//.test(root) ? child.toLowerCase() : child;
  const right = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
  return left === right || left.startsWith(`${right}/`);
}

function validateCommon(input: DynamicRecord): string[] {
  const errors: string[] = [];
  if (!String(input.task || "").trim()) errors.push("task_required");
  if (!["android", "linux"].includes(String(input.workspace_env || "android"))) errors.push("workspace_env_invalid");
  if (!["high", "normal", "low"].includes(String(input.priority || "normal"))) errors.push("priority_invalid");
  const timeout = Number(input.timeout_ms);
  if (!Number.isInteger(timeout) || (timeout !== 0 && (timeout < 30000 || timeout > 3600000))) {
    errors.push("timeout_invalid");
  }
  const maxTools = Number(input.max_tool_calls);
  if (!Number.isInteger(maxTools) || (maxTools !== 0 && (maxTools < 1 || maxTools > 64))) {
    errors.push("max_tool_calls_invalid");
  }
  return errors;
}

function validatePaths(input: DynamicRecord, paths: string[]): string[] {
  const errors: string[] = [];
  if (input.read_only !== true && paths.length === 0) errors.push("write_paths_required");
  for (const path of paths) {
    if (!isAbsolutePath(path)) errors.push("path_not_absolute");
    if (input.workspace_path && !isWithinWorkspace(path, input.workspace_path)) errors.push("path_outside_workspace");
  }
  return Array.from(new Set(errors));
}

function validateSpawn(input: DynamicRecord): ValidationResult {
  const paths = input.read_only === true ? [] : parseTargetPaths(input.target_paths_text);
  const errors = [...validateCommon(input), ...validatePaths(input, paths)];
  if (input.workspace_path && !isAbsolutePath(input.workspace_path)) errors.push("workspace_not_absolute");
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), target_paths: paths };
}

function validateFollowup(input: DynamicRecord, currentAgent: DashboardAgent | null): ValidationResult {
  const errors: string[] = [];
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

function stableValue(value: DynamicValue): DynamicValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = asRecord(value);
    const output: DynamicRecord = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) output[key] = stableValue(input[key]);
    }
    return output;
  }
  return value;
}

function fingerprint(payload: DynamicValue): string {
  return JSON.stringify(stableValue(payload || {}));
}

function generateRequestId(operation: unknown): string {
  return `ui:${String(operation || "operation")}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function nextRequest(previous: RequestEntry | null | undefined, operation: string, payload: DynamicRecord): RequestEntry {
  const nextFingerprint = fingerprint(payload);
  if (previous && previous.status !== "succeeded" && previous.fingerprint === nextFingerprint) return previous;
  return { requestId: generateRequestId(operation), fingerprint: nextFingerprint, status: "pending" };
}

function markRequest(entry: RequestEntry | null | undefined, status: string): RequestEntry | null {
  return entry ? { ...entry, status } : null;
}

function sectionTitle(ctx: UiContext, text: string): UiNode {
  return ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
    ctx.UI.Surface({ width: 4, height: 18, containerColor: "primary", shape: SHAPE_PILL }, []),
    ctx.UI.Text({ text, style: "titleMedium", fontWeight: "semiBold", weight: 1 }),
  ]);
}

function errorCard(ctx: UiContext, message: unknown): UiNode | null {
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

function noticeCard(ctx: UiContext, message: unknown, color = "secondaryContainer"): UiNode | null {
  if (!String(message || "").trim()) return null;
  return ctx.UI.Card({ fillMaxWidth: true, containerColor: color, shape: SHAPE_MEDIUM }, [
    ctx.UI.Text({ text: String(message), padding: 14, style: "bodyMedium", softWrap: true }),
  ]);
}

function loadingRow(ctx: UiContext, text: string): UiNode {
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

function statCard(ctx: UiContext, label: string, value: unknown, color = "surfaceVariant"): UiNode {
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

function keyValue(ctx: UiContext, label: string, value: unknown): UiNode | null {
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

function localizedOption(options: DynamicValue, value: unknown, fallback: unknown): string {
  const key = String(value || "");
  const optionMap = asRecord(options);
  return String(optionMap[key] || fallback || key);
}

function statusBadge(ctx: UiContext, label: string, status: unknown): UiNode {
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

function agentCard(
  ctx: UiContext,
  agent: DashboardAgent,
  text: DashboardText,
  onOpen: (agentId: string) => void,
): UiNode {
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

function textField<T>(ctx: UiContext, label: string, state: StateValue<T>, options: DynamicRecord = {}): UiNode {
  return ctx.UI.TextField({
    label,
    value: state.value,
    onValueChange: state.set,
    fillMaxWidth: true,
    ...(options || {}),
  });
}

function panel(ctx: UiContext, children: unknown[], options: DynamicRecord = {}): UiNode {
  return ctx.UI.Surface({
    fillMaxWidth: true,
    containerColor: options.containerColor || "surface",
    shape: SHAPE_LARGE,
  }, [
    ctx.UI.Column({ padding: options.padding || 14, spacing: options.spacing || 10 }, compact(children)),
  ]);
}

function pageHeader(
  ctx: UiContext,
  title: PageHeaderTitle,
  onBack: (() => void) | null = null,
  trailing: unknown = null,
): UiNode {
  return ctx.UI.Surface({ fillMaxWidth: true, containerColor: "surface", shape: SHAPE_LARGE }, [
    ctx.UI.Row({ fillMaxWidth: true, verticalAlignment: "center", padding: { horizontal: 8, vertical: 6 }, spacing: 8 }, compact([
      onBack ? ctx.UI.Button({ text: title.back, shape: SHAPE_SMALL, onClick: onBack }) : null,
      ctx.UI.Text({ text: title.label, style: "titleLarge", fontWeight: "bold", weight: 1, maxLines: 1, overflow: "ellipsis" }),
      trailing || null,
    ])),
  ]);
}

function emptyState(ctx: UiContext, text: string): UiNode {
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

function resultJson(value: DynamicValue): DynamicRecord | unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return asRecord(value);
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

function readableResultField(value: unknown): string {
  return String(value || "value")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function resultFieldLabel(field: string, text: DashboardText): string {
  return asRecord(text.resultFields)[field] as string || readableResultField(field);
}

function resultScalar(value: DynamicValue, text: DashboardText): string {
  if (value === true) return text.yes;
  if (value === false) return text.no;
  if (value === null || value === undefined) return "-";
  return String(value);
}

function resultFieldValue(field: string, value: DynamicValue, text: DashboardText): string {
  if (field === "status") return localizedOption(text.statusOptions, value, String(value || ""));
  return resultScalar(value, text);
}

function flattenResult(value: DynamicValue, text: DashboardText, path: string[] = [], depth = 0, output: ResultRow[] = []): ResultRow[] {
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

function structuredResultCard(ctx: UiContext, value: DynamicValue, text: DashboardText): UiNode | null {
  const parsed = resultJson(value);
  if (!parsed) return null;
  const record = asRecord(parsed);
  const success = record.success === true || record.ok === true;
  const failure = record.success === false || record.ok === false || !!record.error;
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

function markdownInlineText(value: unknown): string {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function parseMarkdownBlocks(value: unknown): MarkdownBlock[] {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;
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

function markdownBlockView(ctx: UiContext, block: MarkdownBlock): UiNode {
  if (block.type === "heading") {
    const styles = ["titleLarge", "titleLarge", "titleMedium", "titleSmall", "bodyLarge", "bodyLarge"];
    return ctx.UI.Text({
      text: markdownInlineText(block.text),
      style: styles[Math.max(0, Math.min(5, Number(block.level || 1) - 1))],
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

function markdownPreviewText(value: unknown): string {
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

function resultView(
  ctx: UiContext,
  value: DynamicValue,
  text: DashboardText,
  expanded = false,
  onToggle: (() => void) | null = null,
): UiNode {
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

function formatEventTime(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  try {
    return new Date(timestamp).toLocaleString();
  } catch (_) {
    return String(timestamp);
  }
}

function readableEventType(value: unknown): string {
  return String(value || "unknown")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function eventValue(value: DynamicValue, text: DashboardText): string {
  if (value === true) return text.yes;
  if (value === false) return text.no;
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length > 0 ? `${text.eventDetails} (${value.length})` : "";
  if (typeof value === "object") return `${text.eventDetails} (${Object.keys(value).length})`;
  return String(value);
}

function eventFieldValue(field: string, value: DynamicValue, text: DashboardText): string {
  if (field === "status") return localizedOption(text.statusOptions, value, String(value || ""));
  if (field === "control_status") return localizedOption(text.controlStatusOptions, value, String(value || ""));
  if (field === "control_source") return localizedOption(text.controlSourceOptions, value, String(value || ""));
  return eventValue(value, text);
}

function eventSummary(event: DynamicRecord, text: DashboardText): string[] {
  const data = asRecord(event.data);
  const preferredFields = [
    "status", "tool_name", "step", "attempt", "action", "kind", "tools",
    "allowed_tools", "pending_metadata", "mutation_checkpoint_index", "control_action",
    "control_status", "control_source", "summary_status", "reason", "error",
    "acknowledged_messages", "requeued_messages", "message_id", "propagated_descendants",
    "prior_run_seq", "recovered", "epoch", "expected_epoch", "received_epoch",
    "tool_count", "checkpoint_turns", "continuation_required", "prompt_echo_detected",
  ];
  const lines: string[] = [];
  const used = new Set<string>();
  for (const field of preferredFields) {
    const value = eventFieldValue(field, data[field], text);
    if (!value) continue;
    const label = String(asRecord(text.eventFields)[field] || readableEventType(field));
    lines.push(`${label}: ${value}`);
    used.add(field);
    if (lines.length >= 4) break;
  }
  const remaining = Object.keys(data).filter((field) => !used.has(field) && eventValue(data[field], text));
  if (remaining.length > 0 && lines.length < 4) lines.push(`${text.eventDetails}: ${remaining.length}`);
  return lines;
}

function eventCard(ctx: UiContext, event: DynamicRecord, text: DashboardText): UiNode {
  const type = String(event && event.type || "unknown");
  const title = String(asRecord(text.eventTypes)[type] || readableEventType(type));
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

function useStateValue<T>(ctx: UiContext, key: string, initialValue: T): StateValue<T> {
  const pair = ctx.useState(key, initialValue);
  return { value: pair[0], set: pair[1] };
}

function stringifyErrorDetails(details: DynamicValue): string {
  if (details === undefined || details === null || details === "") return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch (_) {
    return String(details);
  }
}

function formatErrorText(error: DynamicValue, text: DynamicValue = null) {
  const errorRecord = asRecord(error);
  const textRecord = asRecord(text);
  const localizedErrors = asRecord(textRecord.errors);
  const code = String(errorRecord.code || "");
  const localized = code ? localizedErrors[code] : "";
  const message = error instanceof Error ? error.message : String(error || "");
  const details = stringifyErrorDetails(errorRecord.details);
  const parts = [localized || message || textRecord.unknown || "unknown error"];
  if (localized && message && message !== localized) parts.push(message);
  if (details && details !== message) parts.push(details);
  return parts.join(": ");
}

function errorText(error: DynamicValue): string {
  return formatErrorText(error);
}

function waitFor(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => resolve(), ms));
}

function shouldRetryInitialLoad(error: DynamicValue): boolean {
  return asRecord(error).code === "ipc_invalid_response" ||
    /ipc|runtime|channel|unavailable|not registered|not initialized/i.test(errorText(error));
}

function compact<T>(nodes: Array<T | null | undefined | false | "">): T[] {
  return nodes.filter(Boolean) as T[];
}

function validationText(text: DashboardText, errors: string[]): string {
  const localizedErrors = asRecord(text.errors);
  return errors.map((code) => String(localizedErrors[code] || code)).join("\n");
}

function permissionSummary(agent: DashboardAgent, text: DashboardText): string {
  const paths: string[] = Array.isArray(agent.target_paths) ? agent.target_paths : [];
  return [
    `${text.readOnly}: ${agent && agent.read_only ? text.yes : text.no}`,
    `${text.workspacePath}: ${agent && agent.workspace_path || "-"}`,
    `${text.workspaceEnv}: ${agent && agent.workspace_env || "android"}`,
    `${text.targetPaths}:\n${paths.length ? paths.join("\n") : "-"}`,
  ].join("\n");
}
type UnknownRecord = Record<string, unknown>;
type IpcError = {
  code?: string;
  message: string;
  details?: unknown;
};
type IpcResponse<T> = {
  success: boolean;
  data?: T;
  error?: IpcError | string;
};

type ComposeDslScreenResult = ToolPkg.ComposeNode | Promise<ToolPkg.ComposeNode>;

type ValueState<T> = {
  value: T;
};


function Screen(ctx: ToolPkg.ComposeDslContext): ComposeDslScreenResult {
  const text = resolveText(ctx);
  const errorText = (cause: DynamicValue): string => formatErrorText(cause, text);
  const view = useStateValue(ctx, "dashboard.view", VIEW_LIST);
  const listLoading = useStateValue(ctx, "dashboard.listLoading", false);
  const loadMoreLoading = useStateValue(ctx, "dashboard.loadMoreLoading", false);
  const detailLoading = useStateValue(ctx, "dashboard.detailLoading", false);
  const mutationLoading = useStateValue(ctx, "dashboard.mutationLoading", false);
  const waitLoading = useStateValue(ctx, "dashboard.waitLoading", false);
  const error = useStateValue(ctx, "dashboard.error", "");
  const notice = useStateValue(ctx, "dashboard.notice", "");
  const agents = useStateValue<DashboardAgent[]>(ctx, "dashboard.agents", []);
  const summary = useStateValue<DashboardSummary>(ctx, "dashboard.summary", { active: 0, running: 0, queued: 0, total: 0, counts: {} });
  const cursor = useStateValue<string>(ctx, "dashboard.cursor", "");
  const hasMore = useStateValue<boolean>(ctx, "dashboard.hasMore", false);
  const statusFilter = useStateValue<string>(ctx, "dashboard.statusFilter", "");
  const listRequestGuard = useStateValue<{ generation: number }>(ctx, "dashboard.listRequestGuard", { generation: 0 });
  const detailRequestGuard = useStateValue<{ generation: number }>(ctx, "dashboard.detailRequestGuard", { generation: 0 });
  const treeWatchGuard = useStateValue<{ generation: number; revision: number; rootRunId: string; agentId: string }>(
    ctx,
    "dashboard.treeWatchGuard",
    { generation: 0, revision: 0, rootRunId: "", agentId: "" },
  );
  const selectedAgent = useStateValue<DashboardAgent | null>(ctx, "dashboard.selectedAgent", null);
  const treeNodes = useStateValue<DynamicRecord[]>(ctx, "dashboard.treeNodes", []);
  const expandedTreeTasks = useStateValue<Record<string, boolean>>(ctx, "dashboard.expandedTreeTasks", {});
  const resultExpanded = useStateValue<boolean>(ctx, "dashboard.resultExpanded", false);
  const confirmAction = useStateValue<ConfirmAction | null>(ctx, "dashboard.confirmAction", null);
  const requestLedger = useStateValue<RequestLedger>(ctx, "dashboard.requestLedger", {});
  const settingsLoading = useStateValue(ctx, "dashboard.settings.loading", false);
  const packageUpdateLoading = useStateValue(ctx, "dashboard.packageUpdate.loading", false);
  const packageUpdatePhase = useStateValue(ctx, "dashboard.packageUpdate.phase", "idle");
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

  function toast(message: string): void {
    if (ctx && typeof ctx.showToast === "function") ctx.showToast(message);
  }

  function requestEntry(operation: string, payload: DynamicRecord): RequestEntry {
    const entry = nextRequest(requestLedger.value[operation], operation, payload);
    requestLedger.set({ ...requestLedger.value, [operation]: entry });
    return entry;
  }

  function requestStatus(operation: string, entry: RequestEntry | null, status: string): void {
    requestLedger.set({ ...requestLedger.value, [operation]: markRequest(entry, status) });
  }

  async function loadGlobalSettings(
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ) {
    const result = await api.getSettings(ipcCall);
    const value = asRecord(result.settings);
    globalMaxAgents.set(String(value.max_concurrent_agents ?? 6));
    globalMaxActiveRunsPerRoot.set(String(value.max_active_runs_per_root ?? 3));
    globalMaxTools.set(String(value.max_tool_calls ?? 16));
    globalMaxModelRetries.set(String(value.max_model_retries ?? 5));
    const contextMode = String(value.conversation_context_mode || "");
    conversationContextMode.set(["off", "on", "auto"].includes(contextMode)
      ? contextMode
      : "auto");
    return value;
  }

  async function saveGlobalSettings(
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ) {
    clearFeedback();
    const maxAgents = Number(globalMaxAgents.value);
    const maxActiveRunsPerRoot = Number(globalMaxActiveRunsPerRoot.value);
    const maxTools = Number(globalMaxTools.value);
    const maxModelRetries = Number(globalMaxModelRetries.value);
    const errors: string[] = [];
    if (!Number.isInteger(maxAgents) || (maxAgents !== 0 && (maxAgents < 1 || maxAgents > 16))) {
      errors.push("max_concurrent_agents_invalid");
    }
    if (!Number.isInteger(maxActiveRunsPerRoot) ||
        (maxActiveRunsPerRoot !== 0 && (maxActiveRunsPerRoot < 1 || maxActiveRunsPerRoot > 8)) ||
        (maxAgents > 0 && maxActiveRunsPerRoot > maxAgents)) {
      errors.push("max_active_runs_per_root_invalid");
    }
    if (!Number.isInteger(maxTools) || (maxTools !== 0 && (maxTools < 1 || maxTools > 64))) {
      errors.push("max_tool_calls_invalid");
    }
    if (!Number.isInteger(maxModelRetries) || maxModelRetries < -1 || maxModelRetries > 12) {
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
      }, ipcCall);
      const value = asRecord(result.settings);
      globalMaxAgents.set(String(value.max_concurrent_agents ?? maxAgents));
      globalMaxActiveRunsPerRoot.set(String(value.max_active_runs_per_root ?? maxActiveRunsPerRoot));
      globalMaxTools.set(String(value.max_tool_calls ?? maxTools));
      globalMaxModelRetries.set(String(value.max_model_retries ?? maxModelRetries));
      const contextMode = String(value.conversation_context_mode || "");
      conversationContextMode.set(["off", "on", "auto"].includes(contextMode)
        ? contextMode
        : conversationContextMode.value);
      notice.set(text.settingsSaved);
      toast(text.settingsSaved);
      await refresh(true, undefined, {}, ipcCall);
      return true;
    } catch (cause) {
      error.set(errorText(cause));
      return false;
    } finally {
      settingsLoading.set(false);
    }
  }

  async function refresh(
    reset = true,
    statusOverride: string | undefined = undefined,
    options: DynamicRecord = {},
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<boolean> {
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
      let result: DynamicRecord | null = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          result = await api.listAgents({
            limit: 20,
            cursor: requestedCursor,
            status: requestedStatus,
            include_results: false,
          }, ipcCall);
          break;
        } catch (cause) {
          if (attempt >= attempts || !shouldRetryInitialLoad(cause)) throw cause;
          await waitFor(150 * attempt);
        }
      }
      if (guard.generation !== generation) return false;
      const response = result || {};
      const incoming = Array.isArray(response.agents)
        ? response.agents.map((agent) => asRecord(agent) as DashboardAgent)
        : [];
      agents.set(reset ? incoming : mergeAgents(agents.value, incoming));
      summary.set(countSummary(response));
      cursor.set(String(response.next_cursor || ""));
      hasMore.set(response.has_more === true);
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

  function stopTreeWatch(): void {
    const guard = treeWatchGuard.value;
    guard.generation = (Number(guard.generation) || 0) + 1;
    guard.revision = 0;
    guard.rootRunId = "";
    guard.agentId = "";
  }

  function eventIdentity(eventValue: DynamicValue): string {
    const event = asRecord(eventValue);
    return fingerprint({
      execution_id: event.execution_id,
      run_seq: event.run_seq,
      type: event.type,
      created_at: event.created_at,
      data: asRecord(event.data),
    });
  }

  function setSelectedAgent(value: DashboardAgent | null): void {
    selectedAgent.value = value;
    selectedAgent.set(value);
  }

  function mergeRecentEvents(currentValue: DynamicValue, incomingValue: DynamicValue): DynamicRecord[] {
    const merged = new Map<string, DynamicRecord>();
    const current = Array.isArray(currentValue) ? currentValue : [];
    const incoming = Array.isArray(incomingValue) ? incomingValue : [];
    for (const eventValue of [...current, ...incoming]) {
      const event = asRecord(eventValue);
      const key = eventIdentity(event);
      if (!merged.has(key)) merged.set(key, event);
    }
    return Array.from(merged.values()).slice(-100);
  }

  async function refreshDetailSnapshot(
    agentId: string,
    isCurrent: () => boolean,
    ipcCall: DashboardIpcCall,
  ): Promise<{ loaded: boolean; rootRunId: string }> {
    const detail = await ipcCall(CHANNELS.INSPECT_AGENT, { agent_id: agentId });
    if (!isCurrent()) return { loaded: false, rootRunId: "" };
    const nextAgent = detail.agent ? asRecord(detail.agent) as DashboardAgent : null;
    const currentAgent = selectedAgent.value;
    if (nextAgent && currentAgent && currentAgent.id === nextAgent.id) {
      nextAgent.recent_events = mergeRecentEvents(currentAgent.recent_events, nextAgent.recent_events);
    }
    setSelectedAgent(nextAgent);
    const tree = await ipcCall(CHANNELS.LIST_TREE, { agent_id: agentId });
    if (!isCurrent()) return { loaded: false, rootRunId: "" };
    const nextTreeNodes = Array.isArray(tree.nodes) ? tree.nodes.map(asRecord) : [];
    treeNodes.set(nextTreeNodes);
    const validExecutionIds = new Set(nextTreeNodes.map((node) => String(node && node.execution_id || "")).filter(Boolean));
    expandedTreeTasks.set(Object.fromEntries(
      Object.entries(expandedTreeTasks.value || {}).filter(([executionId, expanded]) => expanded === true && validExecutionIds.has(executionId))
    ));
    return { loaded: true, rootRunId: String(tree.root_run_id || "") };
  }

  async function watchDetailTree(
    agentId: string,
    rootRunId: string,
    generation: number,
    ipcCall: DashboardIpcCall,
  ): Promise<void> {
    const guard = treeWatchGuard.value;
    const isCurrent = () => guard.generation === generation && guard.agentId === agentId && guard.rootRunId === rootRunId;
    while (isCurrent()) {
      try {
        const result = await ipcCall(CHANNELS.WATCH_TREE_EVENTS, {
          root_run_id: rootRunId,
          after_revision: guard.revision,
          limit: 100,
          timeout_ms: 12000,
        });
        if (!isCurrent()) return;
        const revision = Number(result.revision);
        const nextRevision = Number(result.next_revision);
        if (!Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(nextRevision) || nextRevision < 0) return;
        guard.revision = result.snapshot_required === true ? revision : nextRevision;
        const events = Array.isArray(result.events) ? result.events.map(asRecord) : [];
        const currentAgent = selectedAgent.value;
        if (currentAgent && currentAgent.id === agentId && events.length > 0) {
          selectedAgent.set({
            ...currentAgent,
            recent_events: mergeRecentEvents(
              currentAgent.recent_events,
              events.filter((event) => String(event.agent_id || "") === agentId),
            ),
          });
        }
        if (result.snapshot_required === true || events.length > 0) {
          await refreshDetailSnapshot(agentId, isCurrent, ipcCall);
        }
        if (!isCurrent() || result.shutdown === true) return;
      } catch (cause) {
        if (!isCurrent()) return;
        error.set(errorText(cause));
        await waitFor(1000);
      }
    }
  }

  async function loadDetail(
    agentId: string,
    switchView = true,
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<boolean> {
    detailLoading.set(true);
    error.set("");
    const currentAgentId = selectedAgent.value && selectedAgent.value.id;
    if (currentAgentId && currentAgentId !== agentId) {
      expandedTreeTasks.set({});
      resultExpanded.set(false);
    }
    stopTreeWatch();
    if (switchView) view.set(VIEW_DETAIL);
    const guard = detailRequestGuard.value;
    const generation = (Number(guard.generation) || 0) + 1;
    guard.generation = generation;
    try {
      const snapshot = await refreshDetailSnapshot(agentId, () => guard.generation === generation, ipcCall);
      if (!snapshot.loaded) return false;
      const watchGuard = treeWatchGuard.value;
      const watchGeneration = (Number(watchGuard.generation) || 0) + 1;
      watchGuard.generation = watchGeneration;
      watchGuard.revision = 0;
      watchGuard.rootRunId = snapshot.rootRunId;
      watchGuard.agentId = agentId;
      detailLoading.set(false);
      await watchDetailTree(agentId, snapshot.rootRunId, watchGeneration, ipcCall);
      return true;
    } catch (cause) {
      if (guard.generation === generation) error.set(errorText(cause));
      return false;
    } finally {
      if (guard.generation === generation) detailLoading.set(false);
    }
  }

  async function refreshAfterMutation(
    agentId: unknown,
    ipcCall: DashboardIpcCall,
  ): Promise<void> {
    await refresh(true, undefined, {}, ipcCall);
    if (agentId) {
      mutationLoading.set(false);
      waitLoading.set(false);
      await loadDetail(String(agentId), true, ipcCall);
    }
  }

  async function executeSpawn(
    payload: DynamicRecord,
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<void> {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("spawn", payload);
    try {
      const result = await api.spawnAgent({ ...payload, request_id: entry.requestId }, ipcCall);
      requestStatus("spawn", entry, "succeeded");
      notice.set(text.operationSucceeded);
      toast(text.operationSucceeded);
      await refreshAfterMutation(asRecord(result.agent).id, ipcCall);
    } catch (cause) {
      requestStatus("spawn", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  async function submitSpawn(): Promise<void> {
    const ipcCall = captureIpcCall();
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
        warning: `${text.writeWarning}\n\n${(payload.target_paths || []).join("\n")}`,
      });
      view.set(VIEW_CONFIRM);
      return;
    }
    await executeSpawn(payload, ipcCall);
  }

  async function executeMessage(
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ) {
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
      await api.sendMessage({ ...payload, request_id: entry.requestId }, ipcCall);
      requestStatus("message", entry, "succeeded");
      messageBody.set("");
      notice.set(text.queuedMessage);
      await refreshAfterMutation(agent.id, ipcCall);
    } catch (cause) {
      requestStatus("message", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  function buildFollowup() {
    const agent = selectedAgent.value;
    if (!agent) {
      error.set(text.errors.agent_required);
      return null;
    }
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
    const payload: DynamicRecord = { agent_id: agent.id, task: input.task.trim(), context: input.context.trim() };
    if (validated.read_only !== undefined) payload.read_only = validated.read_only;
    if (validated.target_paths !== undefined) payload.target_paths = validated.target_paths;
    if (followMode.value === "write") {
      payload.workspace_path = input.workspace_path.trim();
      payload.workspace_env = input.workspace_env;
    }
    return payload;
  }

  async function executeFollowup(
    payload: DynamicRecord,
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<void> {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("followup", payload);
    try {
      const result = await api.followupTask({ ...payload, request_id: entry.requestId }, ipcCall);
      requestStatus("followup", entry, "succeeded");
      notice.set(text.operationSucceeded);
      await refreshAfterMutation(asRecord(result.agent).id || payload.agent_id, ipcCall);
    } catch (cause) {
      requestStatus("followup", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  async function submitFollowup(): Promise<void> {
    const ipcCall = captureIpcCall();
    clearFeedback();
    const payload = buildFollowup();
    if (!payload) return;
    const selected = selectedAgent.value;
    const inheritsWrite = followMode.value === "inherit" && !!selected && !selected.read_only;
    const specifiesWrite = followMode.value === "write";
    if (inheritsWrite || specifiesWrite) {
      const rawPaths = specifiesWrite ? payload.target_paths : selected?.target_paths;
      const paths = Array.isArray(rawPaths) ? rawPaths.map((path) => String(path)) : [];
      confirmAction.set({
        kind: "followup",
        payload,
        warning: `${inheritsWrite ? text.inheritedWriteWarning : text.writeWarning}\n\n${(paths || []).join("\n")}`,
      });
      view.set(VIEW_CONFIRM);
      return;
    }
    await executeFollowup(payload, ipcCall);
  }

  async function executeInterrupt(
    payload: DynamicRecord,
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<void> {
    mutationLoading.set(true);
    clearFeedback();
    const entry = requestEntry("interrupt", payload);
    try {
      await api.interruptAgent({ ...payload, request_id: entry.requestId }, ipcCall);
      requestStatus("interrupt", entry, "succeeded");
      notice.set(text.operationSucceeded);
      await refreshAfterMutation(payload.agent_id, ipcCall);
    } catch (cause) {
      requestStatus("interrupt", entry, "unknown");
      error.set(errorText(cause));
    } finally {
      mutationLoading.set(false);
    }
  }

  async function waitForSelected(
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ) {
    const agent = selectedAgent.value;
    if (!agent) return;
    waitLoading.set(true);
    clearFeedback();
    try {
      const result = await api.waitAgent(agent.id, 5000, ipcCall);
      if (result.timed_out === true) notice.set(text.waitTimeout);
      await refreshAfterMutation(agent.id, ipcCall);
    } catch (cause) {
      error.set(errorText(cause));
    } finally {
      waitLoading.set(false);
    }
  }

  async function executeClearHistory(
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ) {
    mutationLoading.set(true);
    clearFeedback();
    try {
      const result = await api.clearHistory(ipcCall);
      notice.set(`${text.operationSucceeded} (${Number(result.deleted) || 0})`);
      toast(text.operationSucceeded);
      view.set(VIEW_LIST);
      await refresh(true, undefined, {}, ipcCall);
    } catch (cause) {
      error.set(errorText(cause));
      view.set(VIEW_LIST);
    } finally {
      mutationLoading.set(false);
    }
  }

  async function executeDeleteAgent(
    agentId: string,
    ipcCall: DashboardIpcCall = captureIpcCall(),
  ): Promise<void> {
    mutationLoading.set(true);
    clearFeedback();
    try {
      await api.deleteAgent(agentId, ipcCall);
      const detailGuard = detailRequestGuard.value;
      detailGuard.generation = (Number(detailGuard.generation) || 0) + 1;
      selectedAgent.set(null);
      treeNodes.set([]);
      expandedTreeTasks.set({});
      resultExpanded.set(false);
      notice.set(text.operationSucceeded);
      toast(text.operationSucceeded);
      view.set(VIEW_LIST);
      await refresh(true, undefined, {}, ipcCall);
    } catch (cause) {
      error.set(errorText(cause));
      view.set(VIEW_DETAIL);
    } finally {
      mutationLoading.set(false);
    }
  }

  async function chooseToolPkgUpdate(): Promise<void> {
    clearFeedback();
    if (typeof ctx.openFilePicker !== "function" || typeof ctx.callTool !== "function") {
      toast(text.errors.package_update_unsupported);
      return;
    }
    packageUpdateLoading.set(true);
    try {
      const result = await ctx.openFilePicker({
        mimeTypes: ["application/zip", "application/octet-stream", "*/*"],
        allowMultiple: false,
        persistPermission: false,
      });
      if (!result || result.cancelled === true || !Array.isArray(result.files) || result.files.length === 0) {
        toast(text.packagePickerCancelled);
        return;
      }
      const file = result.files[0];
      if (!isToolPkgArchive(file)) {
        toast(text.errors.package_file_invalid);
        return;
      }
      const payload = buildToolPkgUpdatePayload(file);
      if (!payload.source_path) {
        toast(text.errors.package_file_path_missing);
        return;
      }
      const sizeText = typeof payload.source_size === "number" ? ` (${payload.source_size} B)` : "";
      confirmAction.set({
        kind: "updateToolPkg",
        payload,
        warning: `${text.packageUpdateWarning}\n\n${text.packageSelected}: ${payload.source_name}${sizeText}`,
        returnView: VIEW_LIST,
      });
      view.set(VIEW_CONFIRM);
    } catch (cause) {
      toast(errorText(cause));
    } finally {
      packageUpdateLoading.set(false);
    }
  }

  async function executeToolPkgUpdate(payload: DynamicRecord): Promise<void> {
    if (typeof ctx.callTool !== "function") {
      toast(text.errors.package_update_unsupported);
      view.set(VIEW_LIST);
      return;
    }
    packageUpdateLoading.set(true);
    packageUpdatePhase.set("copying");
    clearFeedback();
    view.set(VIEW_LIST);
    try {
      await ctx.callTool("copy_file", buildToolPkgCopyParams(payload));
      packageUpdateLoading.set(false);
      packageUpdatePhase.set("idle");
      notice.set("");
      await waitFor(0);
      await ctx.callTool("send_broadcast", buildToolPkgBroadcastParams(payload));
      toast(text.packageUpdateRequested);
    } catch (cause) {
      toast(errorText(cause));
      notice.set("");
      packageUpdatePhase.set("idle");
      packageUpdateLoading.set(false);
    }
  }

  async function confirmPending(): Promise<void> {
    const action = confirmAction.value;
    if (!action) return;
    confirmAction.set(null);
    if (action.kind === "updateToolPkg") {
      await executeToolPkgUpdate(action.payload);
      return;
    }
    const ipcCall = captureIpcCall();
    if (action.kind === "spawn") await executeSpawn(action.payload, ipcCall);
    else if (action.kind === "followup") await executeFollowup(action.payload, ipcCall);
    else if (action.kind === "interrupt") await executeInterrupt(action.payload, ipcCall);
    else if (action.kind === "clearHistory") await executeClearHistory(ipcCall);
    else if (action.kind === "deleteAgent") await executeDeleteAgent(String(action.payload.agent_id || ""), ipcCall);
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

  async function selectStatusFilter(value: string): Promise<void> {
    const ipcCall = captureIpcCall();
    const nextStatus: string = STATUS_FILTER_VALUES.includes(value) ? value : "";
    statusFilter.set(nextStatus);
    await refresh(true, nextStatus, {}, ipcCall);
  }

  function statusFilterControl() {
    const rows = STATUS_FILTER_ROWS.map((values) => ctx.UI.Row({
      fillMaxWidth: true,
      spacing: 6,
    }, values.map((value) => ctx.UI.Button({
      text: `${value === statusFilter.value ? "✓ " : ""}${String(asRecord(text.statusOptions)[value] || value)}`,
      weight: 1,
      shape: SHAPE_PILL,
      contentPadding: { horizontal: 8, vertical: 7 },
      onClick: () => selectStatusFilter(value),
    }))));
    return panel(ctx, [
      components.sectionTitle(ctx, text.statusFilter),
      ...rows,
      ctx.UI.Button({
        text: text.clearHistory,
        fillMaxWidth: true,
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
    ], { containerColor: "surfaceVariant", border: false, spacing: 8 });
  }

  function globalSettingsControl() {
    return panel(ctx, [
      components.sectionTitle(ctx, text.globalSettings),
      components.textField(ctx, text.maxConcurrentAgents, globalMaxAgents, {
        singleLine: true,
        placeholder: "0 / 1-16",
      }),
      ctx.UI.Text({ text: text.maxConcurrentAgentsHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxActiveRunsPerRoot, globalMaxActiveRunsPerRoot, {
        singleLine: true,
        placeholder: "0 / 1-8",
      }),
      ctx.UI.Text({ text: text.maxActiveRunsPerRootHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxToolCalls, globalMaxTools, {
        singleLine: true,
        placeholder: "0 / 1-64",
      }),
      ctx.UI.Text({ text: text.maxToolCallsHint, style: "bodySmall", color: "onSurfaceVariant" }),
      components.textField(ctx, text.maxModelRetries, globalMaxModelRetries, {
        singleLine: true,
        placeholder: "-1 / 0-12",
      }),
      ctx.UI.Text({ text: text.maxModelRetriesHint, style: "bodySmall", color: "onSurfaceVariant" }),
      ctx.UI.Text({ text: text.conversationContext, style: "labelLarge", fontWeight: "semiBold" }),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 6 }, ["off", "on", "auto"].map((mode) => ctx.UI.Button({
        text: `${mode === conversationContextMode.value ? "✓ " : ""}${String(asRecord(text.conversationContextOptions)[mode] || mode)}`,
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

  function packageUpdateControl() {
    return panel(ctx, [
      components.sectionTitle(ctx, text.packageUpdate),
      ctx.UI.Text({ text: text.packageUpdateHint, style: "bodySmall", color: "onSurfaceVariant", softWrap: true }),
      packageUpdateLoading.value
        ? components.loadingRow(ctx, text.packageUpdateSubmitting)
        : ctx.UI.Button({
          text: text.choosePackage,
          fillMaxWidth: true,
          shape: SHAPE_SMALL,
          enabled: !mutationLoading.value,
          onClick: chooseToolPkgUpdate,
        }),
    ], { spacing: 9, containerColor: "surfaceVariant" });
  }

  function listView() {
    const nodes = [
      ...header(),
      ctx.UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        components.statCard(ctx, text.running, summary.value.running, "primaryContainer"),
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
      packageUpdateLoading.value ? null : components.noticeCard(ctx, notice.value),
      globalSettingsControl(),
      packageUpdateControl(),
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
    const execution = asRecord(agent?.execution);
    const actions = allowedActions(agent?.status);
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
      }, () => { clearFeedback(); stopTreeWatch(); view.set(VIEW_LIST); }, deleteButton),
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
        components.keyValue(ctx, text.currentActionGate, (() => {
          const gate = asRecord(execution.current_action_gate);
          const allowedTools = Array.isArray(gate.allowed_tools) ? gate.allowed_tools.map(String) : [];
          return execution.current_action_gate
            ? `${String(gate.kind || "")}${allowedTools.length > 0 ? ` / ${allowedTools.join(", ")}` : ""}`
            : text.actionGateNone;
        })()),
        components.keyValue(ctx, text.actionGateActivations, execution.action_gate_activation_count || 0),
        components.keyValue(ctx, text.actionGateBlocks, execution.action_gate_block_count || 0),
        components.keyValue(ctx, text.control, `${localizedOption(text.controlStatusOptions, execution.control_status, execution.control_status || "-")} / ${localizedOption(text.controlSourceOptions, execution.control_source, execution.control_source || "-")}`),
        components.keyValue(ctx, text.messages, `${text.queuedMessages}=${agent.pending_messages || 0}, ${text.deliveredMessages}=${agent.delivered_messages || 0}, ${text.acknowledgedMessages}=${agent.acknowledged_messages || 0}`),
        (() => {
          const watchRev = treeWatchGuard.value.revision;
          return watchRev > 0
            ? components.keyValue(ctx, text.streamRevision, watchRev)
            : null;
        })(),
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
                text: `${"  ".repeat(Number(node.tree_depth) || 0)}${node.name || shortId(node.agent_id)}`,
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
      components.sectionTitle(ctx, text.result),
      resultView(
        ctx,
        agent.result || execution.result || agent.error || "",
        text,
        resultExpanded.value,
        () => resultExpanded.set(!resultExpanded.value)
      )
    );
    const streamState = asRecord(execution.stream_state);
    const streamStatus = String(streamState.status || "idle");
    const streamPublicText = String(streamState.public_text || "").trim();
    if (streamStatus === "streaming" && streamPublicText) {
      nodes.push(
        components.sectionTitle(ctx, text.liveOutput),
        panel(ctx, [
          ctx.UI.Text({
            text: streamPublicText,
            style: "bodySmall",
            color: "onSurface",
            softWrap: true,
          }),
          ctx.UI.LinearProgressIndicator({ fillMaxWidth: true }),
        ], { containerColor: "surfaceVariant", spacing: 6 }),
      );
    }
    nodes.push(components.sectionTitle(ctx, text.events));
    const recentEvents = Array.isArray(agent.recent_events) ? agent.recent_events : [];
    if (recentEvents.length === 0) nodes.push(emptyState(ctx, text.recentEventsEmpty));
    else for (const event of [...recentEvents].reverse()) nodes.push(eventCard(ctx, event, text));
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
      const ipcCall = captureIpcCall();
      const loadSettingsPromise = loadGlobalSettings(ipcCall);
      const refreshPromise = refresh(true, undefined, { initial: true }, ipcCall);
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

const __test = {
  TEXT,
  TOOLPKG_UPDATE,
  buildToolPkgBroadcastParams,
  buildToolPkgCopyParams,
  buildToolPkgUpdatePayload,
  failedResponseError,
  formatErrorText,
  isToolPkgArchive,
  markdownInlineText,
  parseMarkdownBlocks,
  pickedFileName,
};

export { Screen, __test };
// Compose DSL discovers this self-contained dashboard through the default export.
export default Screen;