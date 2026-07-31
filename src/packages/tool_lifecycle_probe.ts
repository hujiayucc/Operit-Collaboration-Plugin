/* METADATA
{
  "name": "tool_lifecycle_probe",
  "display_name": {
    "zh": "工具生命周期探针与 Agent 工具网关",
    "en": "Tool Lifecycle Probe & Agent Tool Gateway"
  },
  "description": {
    "zh": "提供七个诊断与 Agent 工具网关工具。生命周期探针记录宿主 hook 字段和协作运行时明确绑定的 Agent 工具调用；诊断缓冲仅存内存，重启丢失。网关在 prompt compose 阶段过滤可见工具，并在公开插件工具的 IPC 执行入口校验调用上下文，阻止 Agent、summary 和 finalization 通过动态包激活调用固定隐藏工具。非空白名单优先，宿主缺少工具列表时关闭式返回空列表。",
    "en": "Provides seven diagnostic and Agent tool-gateway tools. The lifecycle probe records host-hook fields and Agent tool invocations explicitly attributed by the collaboration runtime; diagnostic buffers are in memory and lost on restart. The gateway filters visible tools at prompt-compose time and validates caller context at public plugin-tool IPC entry points, preventing Agent, summary, and finalization contexts from invoking fixed-hidden tools through dynamic package activation. A non-empty allow list takes precedence and fails closed when the host omits the tool list."
  },
  "enabledByDefault": true,
  "category": "System",
  "tools": [
    {
      "name": "probe_get_status",
      "description": {
        "zh": "返回工具生命周期 hook 的宿主能力、显式注册结果、实际事件活跃状态和注册错误，以及最多 500 条生命周期缓冲、当前条目数、丢弃数和累计聚合计数。registration_state 区分 registered、active_without_local_registration 与 not_registered。attribution_capability 区分 no_events_observed、host_identity_fields_observed、host_identity_fields_missing 与 runtime_agent_callbacks_observed。host_lifecycle_events/host_identity_bearing_events 描述宿主 hook；runtime_attributed_events 统计协作运行时明确绑定的 Agent 工具调用。只有事件实际归因到 Agent 或 summary 后 attribution_available 才为 true。",
        "en": "Returns host capability, explicit registration result, observed hook activity, registration errors, buffer limits, and cumulative counters. registration_state distinguishes registered, active_without_local_registration, and not_registered. attribution_capability distinguishes no_events_observed, host_identity_fields_observed, host_identity_fields_missing, and runtime_agent_callbacks_observed. host_lifecycle_events and host_identity_bearing_events describe the host hook; runtime_attributed_events counts Agent tool invocations explicitly bound by the collaboration runtime. attribution_available becomes true only after an event is actually attributed to an Agent or summary."
      },
      "parameters": []
    },
    {
      "name": "probe_get_log",
      "description": {
        "zh": "返回当前内存缓冲中经过过滤的最近生命周期事件（按时间升序），包含 returned、缓冲内 matched 和进程累计 total_events；清空缓冲后 matched 可为 0 而 total_events 保持不变。事件记录 chat_id、proxy_sender_name、invocation_id 和 identity_bearing，但不保存完整工具参数或结果值。可按工具名、发送者精确匹配，或仅保留调用前拦截阶段。",
        "en": "Returns recent filtered lifecycle events in chronological order with returned, buffer-local matched, and process-cumulative total_events. After clearing the buffer, matched may be zero while total_events remains unchanged. Entries record chat_id, proxy_sender_name, invocation_id, and identity_bearing without retaining complete tool parameter or result values. Tool-name and sender filters are exact; intercept_only limits results to the pre-execution phase."
      },
      "parameters": [
        { "name": "limit", "description": { "zh": "返回的最大条目数；0 表示返回缓冲中全部匹配项（最多 500），正数向下取整并封顶 500，省略或无效值回退为 100。", "en": "Maximum entries to return. 0 returns every matching buffered entry, up to 500; positive values are floored and capped at 500, while omitted or invalid values default to 100." }, "type": "number", "required": false },
        { "name": "tool_name", "description": { "zh": "可选，仅返回该工具名的事件。", "en": "Optional; return only events for this tool name." }, "type": "string", "required": false },
        { "name": "proxy_sender_name", "description": { "zh": "可选，仅返回该发送者标识的事件。", "en": "Optional; return only events for this sender identity." }, "type": "string", "required": false },
        { "name": "intercept_only", "description": { "zh": "为 true 时仅返回调用前拦截阶段的事件。", "en": "When true, return only pre-execution intercept-phase events." }, "type": "boolean", "required": false }
      ]
    },
    {
      "name": "probe_clear_log",
      "description": {
        "zh": "清空当前内存中的工具生命周期和 prompt compose 事件缓冲，返回 cleared 总数及分项数量；这是会丢弃当前诊断记录的操作，但不会重置累计 total_events、聚合计数或 hook 状态。",
        "en": "Clears the current in-memory tool-lifecycle and prompt-compose event buffers and returns the total and subtotals. This discards current diagnostic records but does not reset cumulative total_events, aggregate counters, or hook state."
      },
      "parameters": []
    },
    {
      "name": "probe_get_prompt_compose_log",
      "description": {
        "zh": "从最多 100 条的内存缓冲中返回最近 50 条 prompt compose hook 事件，包含 chatId、proxySenderName、输入工具名/字段名摘要、网关动作和过滤后工具数量，用于诊断身份与网关行为；不返回完整系统提示、工具参数值或工具结果。pending mutation 只有在已提交检查点留下具体待编辑动作后才会记录 action_gate_pending_mutation_by_chatid；action_gate_repair 是违反已生效动作门，或在动作门仍活动时请求 finish/兼容终态时写入 Run 的 control_source，不是 gateway_action，也不是每个成功写入流程的必现事件。",
        "en": "Returns the newest 50 prompt-compose hook events from an in-memory buffer of up to 100, including chatId, proxySenderName, input tool-name/key summaries, gateway action, and filtered tool count for identity and gateway diagnostics. It does not return complete system prompts, tool parameter values, or tool results. A pending mutation is recorded as action_gate_pending_mutation_by_chatid only after a committed checkpoint leaves a concrete edit pending. action_gate_repair is the Run control_source written when an active action gate is violated or when finish/compatibility completion is requested while the gate remains active; it is not a gateway_action and is not expected for every successful write flow."
      },
      "parameters": []
    },
    {
      "name": "gateway_register",
      "description": {
        "zh": "为指定 Agent 注册或替换内存中的工具网关策略，在 prompt compose 阶段按大小写敏感的精确工具名裁剪可见工具，不支持通配符；未知工具名会被保存但不会匹配。Agent 和 summary 上下文无权调用本工具，固定隐藏的 collaboration、probe 和 gateway 工具始终不可见。可提供白名单、黑名单或两者；非空白名单优先，宿主缺少工具列表时关闭式返回空列表；空白名单不启用白名单模式，两者均省略时仅应用固定隐藏规则。",
        "en": "Registers or replaces an in-memory tool-gateway policy for an agent and filters visible tools at prompt-compose time by exact, case-sensitive tool names; wildcards are not supported, and unknown names are stored but never match. Agent and summary contexts cannot call this tool. Collaboration, probe, and gateway tools remain fixed-hidden. You may provide an allow list, a deny list, or both; a non-empty allow list takes precedence and fails closed to an empty list when the host omits its tool list. An empty allow list does not enable allow-list mode; omitting both applies only the fixed hidden-tool rule."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "allowed_tools_json", "description": { "zh": "可选工具名 JSON 字符串数组。非空时启用白名单模式，仅保留这些工具，并优先于 denied_tools_json；宿主缺少 availableTools 时关闭式返回空列表；空数组等同未启用白名单。非法 JSON 或非字符串数组返回宿主兼容传输信封：transport_success=true、operation_success=false，错误位于 result.error。", "en": "Optional JSON string array of tool names. A non-empty array enables allow-list mode, keeps only these tools, and takes precedence over denied_tools_json; when the host omits availableTools, the gateway fails closed to an empty tool list; an empty array does not enable allow-list mode. Invalid JSON or non-string arrays return a host-compatible transport envelope with transport_success=true, operation_success=false, and the error in result.error." }, "type": "string", "required": false },
        { "name": "denied_tools_json", "description": { "zh": "可选工具名 JSON 字符串数组；在未启用非空白名单时，与默认禁止列表合并。Agent/summary 上下文不能修改策略。非法 JSON 或非字符串数组返回宿主兼容传输信封：transport_success=true、operation_success=false，错误位于 result.error。", "en": "Optional JSON string array of tool names. When no non-empty allow list is active, it is merged with the default deny list. Agent/summary contexts cannot modify policies. Invalid JSON or non-string arrays return a host-compatible transport envelope with transport_success=true, operation_success=false, and the error in result.error." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "gateway_unregister",
      "description": {
        "zh": "移除指定 Agent 的自定义内存网关策略；Agent 和 summary 上下文无权调用。策略不存在时仍成功返回当前 gateway_status。移除后只恢复默认可见性，collaboration、probe 和 gateway 工具的固定隐藏规则仍生效。",
        "en": "Removes the specified agent's custom in-memory gateway policy; agent and summary contexts cannot call it. If no policy exists, the operation still succeeds and returns the current gateway status. Removal restores default visibility only; the fixed hiding of collaboration, probe, and gateway tools remains active."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true }
      ]
    },
    {
      "name": "gateway_status",
      "description": {
        "zh": "返回内存 Agent 工具网关的 success、gateway 名称、default_denied_tools、fixed_hidden_tools、execution_guard 和各 Agent 排序后的 allowed_tools/denied_tools。default_denied_tools 仅是可配置默认拒绝集合；fixed_hidden_tools 列出始终隐藏且受 caller_chat_id IPC 执行守卫保护的 collaboration、probe 和 gateway 工具。",
        "en": "Returns the in-memory Agent tool gateway's success flag, gateway name, default_denied_tools, fixed_hidden_tools, execution_guard, and each agent's sorted allowed_tools/denied_tools. default_denied_tools is only the configurable default deny set; fixed_hidden_tools lists collaboration, probe, and gateway tools that are always hidden and protected by the caller_chat_id IPC execution guard."
      },
      "parameters": []
    }
  ]
}
*/

import { toolFailure } from "../protocol.js";

type ToolParams = Record<string, unknown>;

type TransportFailure = {
  success: false;
  error?: unknown;
  [key: string]: unknown;
};

type TransportSuccess = {
  success?: true;
  transport_success?: boolean;
  operation_success?: boolean;
  result?: unknown;
  [key: string]: unknown;
};

type ToolResult = TransportFailure | TransportSuccess;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolOutcome(result: ToolResult): unknown {
  return result && result.transport_success === true && result.operation_success === false
    ? result.result
    : result;
}

// This subpackage runs in a "sandbox" JS context (TOOLPKG_FORMAT_GUIDE §3.2.5).
// All state lives in the "main" context (main.js). These sandbox tools are thin
// IPC forwarders: ToolPkg.ipc.call routes to the main context.

async function safely(operation: string, action: () => Promise<ToolResult>): Promise<unknown> {
  try {
    return toolOutcome(await action());
  } catch (error) {
    return toolFailure(error, operation);
  }
}

function callerChatId(params: ToolParams): string {
  return String((params || {}).__operit_package_chat_id || "").trim();
}

function callMain(channel: string, payload: ToolParams, params: ToolParams): Promise<ToolResult> {
  return ToolPkg.ipc.call(channel, {
    ...(payload || {}),
    caller_chat_id: callerChatId(params),
  });
}

export async function probe_get_status(params: ToolParams): Promise<unknown> {
  return safely("probe_get_status", () => callMain("probe.get_status", {}, params));
}

export async function probe_get_log(params: ToolParams): Promise<unknown> {
  return safely("probe_get_log", () => callMain("probe.get_log", params || {}, params));
}

export async function probe_clear_log(params: ToolParams): Promise<unknown> {
  return safely("probe_clear_log", () => callMain("probe.clear_log", {}, params));
}

export async function probe_get_prompt_compose_log(params: ToolParams): Promise<unknown> {
  return safely("probe_get_prompt_compose_log", () => callMain("probe.get_prompt_compose_log", {}, params));
}

function parseOptionalToolNames(value: unknown, fieldName: string): string[] | undefined {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item: unknown) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
  return Array.from(new Set(parsed.map((item) => (item as string).trim()).filter(Boolean)));
}

export async function gateway_register(params: ToolParams): Promise<unknown> {
  return safely("gateway_register", () => {
    const p = params || {};
    const agentId = String(p.agent_id || "").trim();
    if (!agentId) throw new Error("agent_id is required");
    const payload: ToolParams = {
      agent_id: agentId,
      caller_chat_id: String(p.__operit_package_chat_id || "").trim(),
    };
    const allowedTools = parseOptionalToolNames(p.allowed_tools_json, "allowed_tools_json");
    const deniedTools = parseOptionalToolNames(p.denied_tools_json, "denied_tools_json");
    if (allowedTools !== undefined) payload.allowed_tools = allowedTools;
    if (deniedTools !== undefined) payload.denied_tools = deniedTools;
    return callMain("gateway.register", payload, p);
  });
}

export async function gateway_unregister(params: ToolParams): Promise<unknown> {
  return safely("gateway_unregister", () => {
    const agentId = String((params || {}).agent_id || "").trim();
    if (!agentId) throw new Error("agent_id is required");
    return callMain("gateway.unregister", {
      agent_id: agentId,
    }, params || {});
  });
}

export async function gateway_status(params: ToolParams): Promise<unknown> {
  return safely("gateway_status", () => callMain("gateway.status", {}, params));
}

export {};