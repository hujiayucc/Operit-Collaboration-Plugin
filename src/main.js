"use strict";

const { CHANNELS } = require("./protocol.js");
const { SUMMARY_CHAT_PREFIX: COLLAB_SUMMARY_CHAT_PREFIX, AGENT_CHAT_PREFIX: COLLAB_AGENT_CHAT_PREFIX } = require("./collaboration/engine.js");
const { createCollaborationManager } = require("./collaboration/manager.js");

let ipcRegistered = false;
const collaboration = createCollaborationManager();

function cancelAllRuns() {
  collaboration.shutdown();
  return { ok: true };
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ToolPkg.ipc.on(CHANNELS.SPAWN_AGENT, async (payload) => collaboration.spawn(payload));
  ToolPkg.ipc.on(CHANNELS.LIST_AGENTS, async (payload) => collaboration.list(payload));
  ToolPkg.ipc.on(CHANNELS.SEND_MESSAGE, async (payload) => collaboration.sendMessage(payload));
  ToolPkg.ipc.on(CHANNELS.FOLLOWUP_TASK, async (payload) => collaboration.followup(payload));
  ToolPkg.ipc.on(CHANNELS.WAIT_AGENT, async (payload) => collaboration.wait(payload));
  ToolPkg.ipc.on(CHANNELS.INTERRUPT_AGENT, async (payload) => collaboration.interrupt(payload));
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_STATUS, async (payload) => probeGetStatus(payload));
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_LOG, async (payload) => probeGetLog(payload));
  ToolPkg.ipc.on(CHANNELS.PROBE_CLEAR_LOG, async (payload) => probeClearLog(payload));
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_PROMPT_COMPOSE_LOG, async (payload) => probeGetPromptComposeLog(payload));
  ToolPkg.ipc.on(CHANNELS.GATEWAY_REGISTER, async (payload) => {
    registerFileGateway(payload && payload.agent_id, payload || {});
    return fileGatewayStatus();
  });
  ToolPkg.ipc.on(CHANNELS.GATEWAY_UNREGISTER, async (payload) => {
    unregisterFileGateway(payload && payload.agent_id);
    return fileGatewayStatus();
  });
  ToolPkg.ipc.on(CHANNELS.GATEWAY_STATUS, async () => fileGatewayStatus());
}

registerIpc();

// File gateway: allows per-agent tool filtering via prompt compose hook.
// By default NO tools are denied — agents have access to the full toolset.
// Callers can register a policy with allowed_tools_json or denied_tools_json
// to restrict specific agents when needed.
const fileGatewayAgents = new Map(); // agentId -> { allowedTools: Set, deniedTools: Set }
const DEFAULT_DENIED_TOOLS = []; // empty: agents get all tools by default
const FILE_GATEWAY_AGENT_PREFIX = "CollaborationAgent:";

function registerFileGateway(agentId, config) {
  const id = String(agentId || "").trim();
  if (!id) return;
  const cfg = config || {};
  // Accept both array (allowed_tools/denied_tools) and JSON string (allowed_tools_json/denied_tools_json) forms
  let allowedRaw = cfg.allowed_tools;
  if (!Array.isArray(allowedRaw) && cfg.allowed_tools_json) {
    try { allowedRaw = JSON.parse(cfg.allowed_tools_json); } catch (_) { allowedRaw = []; }
  }
  let deniedRaw = cfg.denied_tools;
  if (!Array.isArray(deniedRaw) && cfg.denied_tools_json) {
    try { deniedRaw = JSON.parse(cfg.denied_tools_json); } catch (_) { deniedRaw = []; }
  }
  const allowed = new Set(Array.isArray(allowedRaw) ? allowedRaw.map(String) : []);
  const denied = new Set(Array.isArray(deniedRaw) ? deniedRaw.map(String) : []);
  fileGatewayAgents.set(id, { allowedTools: allowed, deniedTools: denied });
}

function unregisterFileGateway(agentId) {
  fileGatewayAgents.delete(String(agentId || "").trim());
}

function fileGatewayStatus() {
  const agents = {};
  for (const [id, config] of fileGatewayAgents) {
    agents[id] = {
      allowed_tools: [...config.allowedTools].sort(),
      denied_tools: [...config.deniedTools].sort(),
    };
  }
  return JSON.stringify({
    success: true,
    gateway: "file_gateway",
    default_denied_tools: [...DEFAULT_DENIED_TOOLS].sort(),
    registered_agents: agents,
  }, null, 2);
}

function onToolPromptCompose(event) {
  const payload = event && event.eventPayload ? event.eventPayload : {};
  const chatId = String(payload.chatId || "");
  const meta = (payload.metadata && typeof payload.metadata === "object") ? payload.metadata : {};
  const proxySender = String(
    payload.proxySenderName || payload.proxy_sender_name ||
    meta.proxySenderName || meta.proxy_sender_name || ""
  );

  // Also record this event in the probe log for diagnostic purposes.
  try { probeRecordPromptComposeEvent(payload); } catch (_) {}

  // Strip all tools for summary chats.
  if (chatId.startsWith(COLLAB_SUMMARY_CHAT_PREFIX)) {
    try { probeUpdateLastPromptComposeEntry({ gateway_action: "summary_strip", gateway_returned_tools: 0 }); } catch (_) {}
    return { availableTools: [] };
  }

  // File gateway: identify collaboration agent calls by the AGENT_CHAT_PREFIX
  // in chatId. The engine sets chatId = "collaboration_agent:<agent_id>" for
  // agent task calls, making them distinguishable from user chats without
  // relying on proxySenderName (which the host does not expose to JS hooks).
  if (chatId.startsWith(COLLAB_AGENT_CHAT_PREFIX)) {
    const agentId = chatId.slice(COLLAB_AGENT_CHAT_PREFIX.length);
    const policy = fileGatewayAgents.get(agentId);
    if (policy) {
      const currentTools = Array.isArray(payload.availableTools) ? payload.availableTools : null;
      if (currentTools) {
        const filtered = currentTools.filter((tool) => {
          const name = typeof tool === "string" ? tool : String(tool && tool.name || "");
          if (policy.allowedTools.size > 0) return policy.allowedTools.has(name);
          if (policy.deniedTools.has(name)) return false;
          return !DEFAULT_DENIED_TOOLS.includes(name);
        });
        try { probeUpdateLastPromptComposeEntry({ gateway_action: "filter_by_chatid", gateway_returned_tools: filtered.length }); } catch (_) {}
        return { availableTools: filtered };
      }
      const denied = new Set([...policy.deniedTools, ...DEFAULT_DENIED_TOOLS]);
      try { probeUpdateLastPromptComposeEntry({ gateway_action: "deny_by_chatid", gateway_returned_tools: -1 }); } catch (_) {}
      return { deniedTools: [...denied] };
    }
    try { probeUpdateLastPromptComposeEntry({ gateway_action: "agent_no_policy", gateway_returned_tools: -1 }); } catch (_) {}
  }

  // Fallback: if proxySenderName is available (future host versions), use it.
  if (proxySender.startsWith(FILE_GATEWAY_AGENT_PREFIX)) {
    const agentId = proxySender.slice(FILE_GATEWAY_AGENT_PREFIX.length);
    const policy = fileGatewayAgents.get(agentId);
    if (policy) {
      const currentTools = Array.isArray(payload.availableTools) ? payload.availableTools : null;
      if (currentTools) {
        const filtered = currentTools.filter((tool) => {
          const name = typeof tool === "string" ? tool : String(tool && tool.name || "");
          if (policy.allowedTools.size > 0) return policy.allowedTools.has(name);
          if (policy.deniedTools.has(name)) return false;
          return !DEFAULT_DENIED_TOOLS.includes(name);
        });
        try { probeUpdateLastPromptComposeEntry({ gateway_action: "filter_by_proxy", gateway_returned_tools: filtered.length }); } catch (_) {}
        return { availableTools: filtered };
      }
      const denied = new Set([...policy.deniedTools, ...DEFAULT_DENIED_TOOLS]);
      try { probeUpdateLastPromptComposeEntry({ gateway_action: "deny_by_proxy", gateway_returned_tools: -1 }); } catch (_) {}
      return { deniedTools: [...denied] };
    }
  }
  return null;
}

// Tool-lifecycle probe — ALL state lives in the main context (this file).
// Per TOOLPKG_FORMAT_GUIDE §3.2.5, subpackage scripts run in a separate
// "sandbox" JS context with its own globalThis; module instances and
// top-level variables are NOT shared across contexts. globalThis bridges and
// require()-based state sharing both fail. The correct cross-context channel
// is ToolPkg.ipc: the probe subpackage's query tools call
// ToolPkg.ipc.call(channel, params) which routes here (main context) where the
// in-memory log and status live.
const PROBE_MAX_LOG_ENTRIES = 500;
const PROBE_AGENT_PREFIX = "CollaborationAgent:";
const PROBE_SUMMARY_PREFIX = "CollaborationSummary:";
const probeLog = [];
const probeStatus = {
  registered: false,
  registration_error: "",
  total_events: 0,
  dropped_events: 0,
  events_by_name: {},
  events_by_tool: {},
  agent_attributed_events: 0,
  summary_attributed_events: 0,
  unattributed_events: 0,
  intercept_events: 0,
  last_event_at: 0,
};
let probeSequence = 0;

function probeReadField(payload, keys) {
  if (!payload || typeof payload !== "object") return "";
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return String(value);
    }
  }
  return "";
}

function probeAttributionFor(sender, chatId) {
  const source = String(sender || "");
  if (source.startsWith(PROBE_AGENT_PREFIX)) {
    return { kind: "collaboration_agent", agent_id: source.slice(PROBE_AGENT_PREFIX.length) };
  }
  if (source.startsWith(PROBE_SUMMARY_PREFIX)) {
    return { kind: "collaboration_summary", agent_id: source.slice(PROBE_SUMMARY_PREFIX.length) };
  }
  if (chatId) return { kind: "chat", agent_id: "" };
  return { kind: "unattributed", agent_id: "" };
}

function probeRecordEvent(eventName, eventTop, payload) {
  const timestamp = Date.now();
  // The host nests identity fields inside event.event (a sub-object).
  // Search event.event, eventTop, and payload for proxySenderName/chatId.
  const nestedEvent = (eventTop && eventTop.event && typeof eventTop.event === "object") ? eventTop.event : null;
  const toolName = probeReadField(payload, ["toolName", "tool_name", "name"]) ||
    probeReadField(eventTop, ["toolName", "tool_name", "name"]);
  const eventPhase = probeReadField(payload, ["eventName", "event_name", "phase"]);
  const proxySender = probeReadField(nestedEvent, ["proxySenderName", "proxy_sender_name"]) ||
    probeReadField(eventTop, ["proxySenderName", "proxy_sender_name"]) ||
    probeReadField(payload, ["proxySenderName", "proxy_sender_name"]);
  const chatId = probeReadField(nestedEvent, ["chatId", "chat_id"]) ||
    probeReadField(eventTop, ["chatId", "chat_id"]) ||
    probeReadField(payload, ["chatId", "chat_id"]);
  const toolPkgId = probeReadField(eventTop, ["toolPkgId", "toolpkg_id", "containerPackageName"]) ||
    probeReadField(nestedEvent, ["toolPkgId", "toolpkg_id", "containerPackageName"]) ||
    probeReadField(payload, ["toolPkgId", "toolpkg_id", "containerPackageName"]);
  const attribution = probeAttributionFor(proxySender, chatId);
  const isIntercept = String(eventName || "").toLowerCase().includes("intercept") ||
    String(eventPhase || "").toLowerCase().includes("intercept");

  let senderSource = "none";
  if (proxySender) {
    if (probeReadField(nestedEvent, ["proxySenderName", "proxy_sender_name"])) senderSource = "nested_event";
    else if (probeReadField(eventTop, ["proxySenderName", "proxy_sender_name"])) senderSource = "event_top";
    else senderSource = "payload";
  }

  const entry = {
    seq: (probeSequence += 1),
    at: timestamp,
    event_name: eventName || eventPhase || "unknown",
    tool_name: toolName,
    proxy_sender_name: proxySender,
    proxy_sender_source: senderSource,
    chat_id: chatId,
    toolpkg_id: toolPkgId,
    attribution_kind: attribution.kind,
    attributed_agent_id: attribution.agent_id,
    is_intercept_phase: isIntercept,
    payload_keys: payload && typeof payload === "object" ? Object.keys(payload).sort() : [],
    event_keys: eventTop && typeof eventTop === "object" ? Object.keys(eventTop).sort() : [],
    nested_event_keys: nestedEvent ? Object.keys(nestedEvent).sort() : [],
    event_values: eventTop && typeof eventTop === "object"
      ? Object.keys(eventTop).reduce((acc, k) => {
          const v = eventTop[k];
          acc[k] = (typeof v === "string") ? v.slice(0, 200)
            : (v && typeof v === "object") ? "[" + (Array.isArray(v) ? "array:" + v.length : "object:" + Object.keys(v).length) + "]"
            : String(v);
          return acc;
        }, {})
      : {},
  };

  probeLog.push(entry);
  if (probeLog.length > PROBE_MAX_LOG_ENTRIES) {
    probeLog.splice(0, probeLog.length - PROBE_MAX_LOG_ENTRIES);
    probeStatus.dropped_events += 1;
  }

  probeStatus.total_events += 1;
  probeStatus.last_event_at = timestamp;
  const en = entry.event_name;
  if (en) probeStatus.events_by_name[en] = (probeStatus.events_by_name[en] || 0) + 1;
  const tn = toolName || "(none)";
  probeStatus.events_by_tool[tn] = (probeStatus.events_by_tool[tn] || 0) + 1;
  if (attribution.kind === "collaboration_agent") probeStatus.agent_attributed_events += 1;
  else if (attribution.kind === "collaboration_summary") probeStatus.summary_attributed_events += 1;
  else probeStatus.unattributed_events += 1;
  if (isIntercept) probeStatus.intercept_events += 1;
  return entry;
}

function onToolLifecycle(event) {
  try {
    const payload = event && event.eventPayload ? event.eventPayload : (event || {});
    const eventName = probeReadField(event, ["eventName", "event_name"]) ||
      probeReadField(payload, ["eventName", "event_name", "phase"]);
    probeRecordEvent(eventName, event || {}, payload);
  } catch (_) {
    // Swallow: observation only, never throw from a host hook.
  }
  return { decision: "allow" };
}

function probeGetStatus(_params) {
  return JSON.stringify({
    success: true,
    probe: "tool_lifecycle",
    capability_hook_available: typeof ToolPkg !== "undefined" && ToolPkg &&
      typeof ToolPkg.registerToolLifecycleHook === "function",
    registered: probeStatus.registered,
    registration_error: probeStatus.registration_error || undefined,
    max_entries: PROBE_MAX_LOG_ENTRIES,
    buffered_entries: probeLog.length,
    total_events: probeStatus.total_events,
    dropped_events: probeStatus.dropped_events,
    intercept_events: probeStatus.intercept_events,
    agent_attributed_events: probeStatus.agent_attributed_events,
    summary_attributed_events: probeStatus.summary_attributed_events,
    unattributed_events: probeStatus.unattributed_events,
    events_by_name: { ...probeStatus.events_by_name },
    events_by_tool: { ...probeStatus.events_by_tool },
    last_event_at: probeStatus.last_event_at || undefined,
  }, null, 2);
}

function probeGetLog(params) {
  const p = params || {};
  const limit = Number.isFinite(p.limit) && p.limit > 0
    ? Math.min(PROBE_MAX_LOG_ENTRIES, Math.floor(p.limit))
    : Math.min(PROBE_MAX_LOG_ENTRIES, 100);
  const toolFilter = String(p.tool_name || "").trim();
  const senderFilter = String(p.proxy_sender_name || "").trim();
  const interceptOnly = p.intercept_only === true;
  const filtered = probeLog.filter((entry) => {
    if (toolFilter && entry.tool_name !== toolFilter) return false;
    if (senderFilter && entry.proxy_sender_name !== senderFilter) return false;
    if (interceptOnly && !entry.is_intercept_phase) return false;
    return true;
  });
  const page = filtered.slice(-limit);
  return JSON.stringify({
    success: true,
    probe: "tool_lifecycle",
    returned: page.length,
    matched: filtered.length,
    total_events: probeStatus.total_events,
    entries: page.map((entry) => ({ ...entry, payload_keys: [...entry.payload_keys] })),
  }, null, 2);
}

function probeClearLog(_params) {
  const cleared = probeLog.length;
  probeLog.length = 0;
  return JSON.stringify({ success: true, probe: "tool_lifecycle", cleared });
}

// Record prompt-compose events to verify proxySenderName availability.
const promptComposeLog = [];
const PROMPT_COMPOSE_MAX_LOG = 100;

function probeRecordPromptComposeEvent(payload) {
  const meta = (payload && payload.metadata && typeof payload.metadata === "object") ? payload.metadata : null;
  const tools = Array.isArray(payload.availableTools) ? payload.availableTools : [];
  const toolNames = tools.map((tool) => {
    if (typeof tool === "string") return tool;
    if (tool && typeof tool === "object") return String(tool.name || tool.toolName || tool.id || "?");
    return String(tool);
  });
  const firstToolSample = tools.length > 0 ? tools[0] : null;
  const firstToolType = firstToolSample === null ? "null" : typeof firstToolSample;
  const firstToolKeys = firstToolSample && typeof firstToolSample === "object"
    ? Object.keys(firstToolSample).sort()
    : [];
  const entry = {
    at: Date.now(),
    chat_id: String(payload.chatId || payload.chat_id || ""),
    proxy_sender_name: String(payload.proxySenderName || payload.proxy_sender_name || ""),
    metadata_proxy_sender: meta ? String(meta.proxySenderName || meta.proxy_sender_name || "") : "",
    metadata_keys: meta ? Object.keys(meta).sort() : [],
    function_type: String(payload.functionType || payload.function_type || ""),
    prompt_function_type: String(payload.promptFunctionType || payload.prompt_function_type || ""),
    stage: String(payload.stage || ""),
    sub_task: String(payload.subTask || payload.sub_task || ""),
    payload_keys: payload && typeof payload === "object" ? Object.keys(payload).sort() : [],
    has_available_tools: Array.isArray(payload.availableTools),
    available_tools_count: tools.length,
    available_tool_names: toolNames,
    first_tool_type: firstToolType,
    first_tool_keys: firstToolKeys,
    gateway_action: "none",
    gateway_returned_tools: -1,
  };
  promptComposeLog.push(entry);
  if (promptComposeLog.length > PROMPT_COMPOSE_MAX_LOG) {
    promptComposeLog.splice(0, promptComposeLog.length - PROMPT_COMPOSE_MAX_LOG);
  }
  return entry;
}

function probeUpdateLastPromptComposeEntry(updates) {
  if (promptComposeLog.length === 0) return;
  const last = promptComposeLog[promptComposeLog.length - 1];
  for (const k in updates) last[k] = updates[k];
}

function probeGetPromptComposeLog(_params) {
  return JSON.stringify({
    success: true,
    probe: "prompt_compose",
    buffered_entries: promptComposeLog.length,
    entries: promptComposeLog.slice(-50),
  }, null, 2);
}

function registerToolPkg() {
  ToolPkg.registerToolPromptComposeHook({
    id: "collaboration_prompt_compose_gateway",
    function: onToolPromptCompose,
  });
  ToolPkg.registerAppLifecycleHook({
    id: "collaboration_shutdown",
    event: "application_on_terminate",
    function: cancelAllRuns,
  });
  if (!probeStatus.registered &&
      typeof ToolPkg !== "undefined" && ToolPkg &&
      typeof ToolPkg.registerToolLifecycleHook === "function") {
    try {
      ToolPkg.registerToolLifecycleHook({
        id: "collaboration_tool_lifecycle_probe",
        function: onToolLifecycle,
      });
      probeStatus.registered = true;
      probeStatus.registration_error = "";
    } catch (error) {
      probeStatus.registration_error =
        error instanceof Error ? error.message : String(error);
    }
  }
  return true;
}

module.exports = {
  registerToolPkg,
  onToolPromptCompose,
  onToolLifecycle,
  probeGetStatus,
  probeGetLog,
  probeClearLog,
  probeGetPromptComposeLog,
  registerFileGateway,
  unregisterFileGateway,
  fileGatewayStatus,
  cancelAllRuns,
};