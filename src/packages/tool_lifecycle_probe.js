"use strict";

/* METADATA
{
  "name": "tool_lifecycle_probe",
  "display_name": {
    "zh": "工具生命周期探针与文件网关",
    "en": "Tool Lifecycle Probe & File Gateway"
  },
  "description": {
    "zh": "工具生命周期探针与文件网关。探针注册工具生命周期 hook 和 prompt compose hook，记录工具调用事件（含 toolName、proxySenderName、chatId）和 prompt compose 事件用于诊断。文件网关通过 prompt compose hook 按 Agent 身份裁剪可用工具列表，默认不限制，可按需注册白名单或黑名单。探针从不写文件、从不阻断调用；网关仅在 AI 提示词阶段过滤工具列表，不拦截已发出的调用。所有状态仅存于内存，重启后丢失。",
    "en": "Tool lifecycle probe and file gateway. The probe registers tool-lifecycle and prompt-compose hooks, recording tool-call events (toolName, proxySenderName, chatId) and prompt-compose events for diagnostics. The file gateway filters the available-tools list per agent identity via the prompt-compose hook; by default no tools are restricted, with optional allow/deny list registration. The probe never writes files or blocks calls; the gateway only filters tool lists at prompt time, not intercepting already-dispatched calls. All state lives in memory and is lost on restart."
  },
  "enabledByDefault": true,
  "category": "System",
  "tools": [
    {
      "name": "probe_get_status",
      "description": {
        "zh": "返回工具生命周期探针注册状态、hook 是否可用、缓冲条目数和聚合计数。",
        "en": "Returns tool-lifecycle probe registration state, hook availability, buffered entry count, and aggregate counts."
      },
      "parameters": []
    },
    {
      "name": "probe_get_log",
      "description": {
        "zh": "返回最近记录的工具生命周期事件，可按工具名、发送者或拦截阶段过滤。",
        "en": "Returns recently recorded tool-lifecycle events, filterable by tool name, sender, or intercept phase."
      },
      "parameters": [
        { "name": "limit", "description": { "zh": "返回的最大条目数，默认 100，最大 500。", "en": "Maximum entries to return, default 100, maximum 500." }, "type": "number", "required": false },
        { "name": "tool_name", "description": { "zh": "可选，仅返回该工具名的事件。", "en": "Optional; return only events for this tool name." }, "type": "string", "required": false },
        { "name": "proxy_sender_name", "description": { "zh": "可选，仅返回该发送者标识的事件。", "en": "Optional; return only events for this sender identity." }, "type": "string", "required": false },
        { "name": "intercept_only", "description": { "zh": "为 true 时仅返回调用前拦截阶段的事件。", "en": "When true, return only pre-execution intercept-phase events." }, "type": "boolean", "required": false }
      ]
    },
    {
      "name": "probe_clear_log",
      "description": {
        "zh": "清空工具生命周期探针的事件缓冲，返回被清除的条目数。",
        "en": "Clears the tool-lifecycle probe event buffer and returns the number of cleared entries."
      },
      "parameters": []
    },
    {
      "name": "probe_get_prompt_compose_log",
      "description": {
        "zh": "返回 prompt compose hook 事件日志，含 chatId 和 proxySenderName，用于验证身份字段可用性。",
        "en": "Returns prompt-compose hook event logs, including chatId and proxySenderName, to verify identity field availability."
      },
      "parameters": []
    },
    {
      "name": "gateway_register",
      "description": {
        "zh": "为指定 Agent 注册文件网关策略，在 prompt compose 阶段裁剪其可用工具列表。",
        "en": "Register a file-gateway policy for an agent, filtering its available tools at prompt-compose time."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true },
        { "name": "allowed_tools_json", "description": { "zh": "允许的工具名 JSON 数组；提供后仅这些工具可用。", "en": "JSON array of allowed tool names; when provided, only these tools are available." }, "type": "string", "required": false },
        { "name": "denied_tools_json", "description": { "zh": "额外禁止的工具名 JSON 数组；与默认禁止列表合并。", "en": "JSON array of additionally denied tool names; merged with the default deny list." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "gateway_unregister",
      "description": {
        "zh": "移除指定 Agent 的文件网关策略。",
        "en": "Remove the file-gateway policy for an agent."
      },
      "parameters": [
        { "name": "agent_id", "description": { "zh": "Agent ID。", "en": "Agent ID." }, "type": "string", "required": true }
      ]
    },
    {
      "name": "gateway_status",
      "description": {
        "zh": "返回文件网关当前注册的 Agent 策略和默认禁止工具列表。",
        "en": "Returns the file gateway's currently registered agent policies and default denied tools list."
      },
      "parameters": []
    }
  ]
}
*/

// This subpackage runs in a "sandbox" JS context (TOOLPKG_FORMAT_GUIDE §3.2.5).
// All state lives in the "main" context (main.js). These sandbox tools are thin
// IPC forwarders: ToolPkg.ipc.call routes to the main context.

function probe_get_status(_params) {
  return ToolPkg.ipc.call("probe.get_status", {});
}

function probe_get_log(params) {
  return ToolPkg.ipc.call("probe.get_log", params || {});
}

function probe_clear_log(_params) {
  return ToolPkg.ipc.call("probe.clear_log", {});
}

function probe_get_prompt_compose_log(_params) {
  return ToolPkg.ipc.call("probe.get_prompt_compose_log", {});
}

function gateway_register(params) {
  const p = params || {};
  const payload = { agent_id: String(p.agent_id || "").trim() };
  if (p.allowed_tools_json) {
    try { payload.allowed_tools = JSON.parse(String(p.allowed_tools_json)); } catch (_) {}
  }
  if (p.denied_tools_json) {
    try { payload.denied_tools = JSON.parse(String(p.denied_tools_json)); } catch (_) {}
  }
  return ToolPkg.ipc.call("gateway.register", payload);
}

function gateway_unregister(params) {
  return ToolPkg.ipc.call("gateway.unregister", { agent_id: String((params || {}).agent_id || "").trim() });
}

function gateway_status(_params) {
  return ToolPkg.ipc.call("gateway.status", {});
}

module.exports = {
  probe_get_status,
  probe_get_log,
  probe_clear_log,
  probe_get_prompt_compose_log,
  gateway_register,
  gateway_unregister,
  gateway_status,
};