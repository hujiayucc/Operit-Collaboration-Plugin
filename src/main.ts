import { CHANNELS } from "./protocol.js";
import {
  SUMMARY_CHAT_PREFIX as COLLAB_SUMMARY_CHAT_PREFIX,
  AGENT_CHAT_PREFIX as COLLAB_AGENT_CHAT_PREFIX,
  FINALIZATION_CHAT_PREFIX as COLLAB_FINALIZATION_CHAT_PREFIX,
  actionGateToolAllowed,
} from "./collaboration/engine.js";
import { createCollaborationManager } from "./collaboration/manager.js";
import * as dashboardModule from "./ui/collaboration_dashboard/index.ui.js";

type DynamicRecord = Record<string, unknown>;
type ConversationTurn = { kind: string; content: string };
type FileGatewayPolicy = { allowedTools: Set<string>; deniedTools: Set<string> };
type RuntimeActionGate = {
  kind: string;
  pendingMetadata: string[];
  allowedTools: string[];
  mutationCheckpointIndex?: number;
  failedAttempts?: number;
  unknownOutcome?: boolean;
};
type GatewayDecision = {
  result: { availableTools?: unknown[]; deniedTools?: string[] };
  action: string;
  count: number;
};
type ProbeAttribution = { kind: string; agent_id: string };
type ProbeEntry = {
  seq: number;
  at: number;
  event_name: string;
  tool_name: string;
  proxy_sender_name: string;
  proxy_sender_source: string;
  chat_id: string;
  invocation_id: string;
  identity_bearing: boolean;
  toolpkg_id: string;
  attribution_kind: string;
  attribution_source: string;
  attributed_agent_id: string;
  execution_epoch: string;
  is_intercept_phase: boolean;
  payload_keys: string[];
  event_keys: string[];
  nested_event_keys: string[];
};
type ProbeStatus = {
  registered: boolean;
  registration_error: string;
  hook_active: boolean;
  total_events: number;
  dropped_events: number;
  events_by_name: Record<string, number>;
  events_by_tool: Record<string, number>;
  agent_attributed_events: number;
  summary_attributed_events: number;
  unattributed_events: number;
  intercept_events: number;
  identity_bearing_events: number;
  identity_missing_events: number;
  host_lifecycle_events: number;
  host_identity_bearing_events: number;
  runtime_attributed_events: number;
  last_event_at: number;
};
type PromptComposeEntry = DynamicRecord & {
  at: number;
  chat_id: string;
  proxy_sender_name: string;
  metadata_proxy_sender: string;
  metadata_keys: string[];
  function_type: string;
  prompt_function_type: string;
  stage: string;
  sub_task: string;
  payload_keys: string[];
  has_available_tools: boolean;
  available_tools_count: number;
  available_tool_names: string[];
  first_tool_type: string;
  first_tool_keys: string[];
  gateway_action: string;
  gateway_returned_tools: number;
};

function asRecord(value: unknown): DynamicRecord {
  return value !== null && typeof value === "object" ? value as DynamicRecord : {};
}

let ipcRegistered = false;
let dashboardUiRegistered = false;
let dashboardUiRegistrationError = "";
const conversationHistoryByChat = new Map<string, ConversationTurn[]>();
const MAX_CONTEXT_CACHE_CHATS = 24;
const MAX_CONTEXT_CACHE_TURNS = 40;
const MAX_CONTEXT_CACHE_CHARS = 32000;

function snapshotConversationHistory(history: unknown): ConversationTurn[] {
  const source: unknown[] = Array.isArray(history) ? history.slice(-MAX_CONTEXT_CACHE_TURNS) : [];
  const reversed: ConversationTurn[] = [];
  let remaining = MAX_CONTEXT_CACHE_CHARS;
  for (let index = source.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const turn = asRecord(source[index]);
    const kind = String(turn.kind || "").trim().toUpperCase();
    if (kind !== "USER" && kind !== "ASSISTANT") continue;
    let content = String(turn.content || "").trim();
    if (!content) continue;
    if (content.length > remaining) content = content.slice(content.length - remaining);
    reversed.push({ kind, content });
    remaining -= content.length;
  }
  return reversed.reverse();
}

function rememberConversationHistory(
  chatId: unknown,
  chatHistory: unknown,
  preparedHistory: unknown,
  currentInput: unknown,
): void {
  const id = String(chatId || "").trim();
  if (!id || id.startsWith(COLLAB_AGENT_CHAT_PREFIX) || id.startsWith(COLLAB_SUMMARY_CHAT_PREFIX) ||
    id.startsWith(COLLAB_FINALIZATION_CHAT_PREFIX)) return;
  const preparedSnapshot = snapshotConversationHistory(preparedHistory);
  const combined = preparedSnapshot.length > 0
    ? preparedSnapshot
    : snapshotConversationHistory(chatHistory);
  const input = String(currentInput || "").trim();
  const last = combined[combined.length - 1];
  if (input && (!last || String(last.kind || "").toUpperCase() !== "USER" || String(last.content || "").trim() !== input)) {
    combined.push({ kind: "USER", content: input });
  }
  const snapshot = snapshotConversationHistory(combined);
  if (snapshot.length === 0) return;
  conversationHistoryByChat.delete(id);
  conversationHistoryByChat.set(id, snapshot);
  while (conversationHistoryByChat.size > MAX_CONTEXT_CACHE_CHATS) {
    const oldestChatId = conversationHistoryByChat.keys().next().value;
    if (oldestChatId === undefined) break;
    conversationHistoryByChat.delete(oldestChatId);
  }
}

function getConversationHistory(chatId: unknown): ConversationTurn[] {
  const snapshot = conversationHistoryByChat.get(String(chatId || "").trim()) || [];
  return snapshot.map((turn: ConversationTurn) => ({ ...turn }));
}

const collaboration = createCollaborationManager({
  getConversationContext: getConversationHistory,
  onAgentToolInvocation(details: unknown) {
    if (typeof probeRecordAgentToolInvocation === "function") probeRecordAgentToolInvocation(details);
  },
});

function cancelAllRuns() {
  collaboration.shutdown();
  return { ok: true };
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ToolPkg.ipc.on(CHANNELS.SPAWN_AGENT, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.spawn(payload);
  });
  ToolPkg.ipc.on(CHANNELS.LIST_AGENTS, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.list(payload);
  });
  ToolPkg.ipc.on(CHANNELS.SEND_MESSAGE, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.sendMessage(payload);
  });
  ToolPkg.ipc.on(CHANNELS.FOLLOWUP_TASK, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.followup(payload);
  });
  ToolPkg.ipc.on(CHANNELS.WAIT_AGENT, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.wait(payload);
  });
  ToolPkg.ipc.on(CHANNELS.INTERRUPT_AGENT, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return collaboration.interrupt(payload);
  });
  ToolPkg.ipc.on(CHANNELS.INSPECT_AGENT, async (payload) => collaboration.inspect(payload));
  ToolPkg.ipc.on(CHANNELS.LIST_TREE, async (payload) => collaboration.listTree(payload));
  ToolPkg.ipc.on(CHANNELS.WATCH_TREE_EVENTS, async (payload) => collaboration.watchTreeEvents(payload));
  ToolPkg.ipc.on(CHANNELS.GET_SETTINGS, async () => collaboration.getSettings());
  ToolPkg.ipc.on(CHANNELS.UPDATE_SETTINGS, async (payload) => collaboration.updateSettings(payload));
  ToolPkg.ipc.on(CHANNELS.DELETE_AGENT, async (payload) => collaboration.deleteAgent(payload));
  ToolPkg.ipc.on(CHANNELS.CLEAR_HISTORY, async () => collaboration.clearHistory());
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_STATUS, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return probeGetStatus(payload);
  });
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_LOG, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return probeGetLog(payload);
  });
  ToolPkg.ipc.on(CHANNELS.PROBE_CLEAR_LOG, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return probeClearLog(payload);
  });
  ToolPkg.ipc.on(CHANNELS.PROBE_GET_PROMPT_COMPOSE_LOG, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return probeGetPromptComposeLog(payload);
  });
  ToolPkg.ipc.on<DynamicRecord>(CHANNELS.GATEWAY_REGISTER, async (payload) => {
    assertPublicPluginToolCaller(payload);
    registerFileGateway(payload.agent_id, payload);
    return fileGatewayStatus();
  });
  ToolPkg.ipc.on<DynamicRecord>(CHANNELS.GATEWAY_UNREGISTER, async (payload) => {
    assertPublicPluginToolCaller(payload);
    unregisterFileGateway(payload.agent_id);
    return fileGatewayStatus();
  });
  ToolPkg.ipc.on(CHANNELS.GATEWAY_STATUS, async (payload) => {
    assertPublicPluginToolCaller(payload);
    return fileGatewayStatus();
  });
}

registerIpc();

// Agent tool gateway: filters prompt-time tools and protects its own controls.
// Ordinary non-plugin tools are unrestricted unless a per-agent policy narrows them.
const fileGatewayAgents = new Map<string, FileGatewayPolicy>();
const DEFAULT_DENIED_TOOLS: string[] = []; // empty: agents get all non-plugin tools by default
const FILE_GATEWAY_AGENT_PREFIX = "CollaborationAgent:";
const AGENT_HIDDEN_TOOL_NAMES = new Set([
  "spawn_agent",
  "list_agents",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "inspect_agent",
  "list_tree",
  "watch_tree_events",
  "get_settings",
  "update_settings",
  "delete_agent",
  "clear_history",
  "probe_get_status",
  "probe_get_log",
  "probe_clear_log",
  "probe_get_prompt_compose_log",
  "gateway_register",
  "gateway_unregister",
  "gateway_status",
]);
const AGENT_HIDDEN_TOOL_PREFIXES = ["collaboration:", "tool_lifecycle_probe:"];

function gatewayCallerIsAgent(callerChatId: unknown): boolean {
  const caller = String(callerChatId || "").trim();
  return caller.startsWith(COLLAB_AGENT_CHAT_PREFIX) || caller.startsWith(COLLAB_SUMMARY_CHAT_PREFIX) ||
    caller.startsWith(COLLAB_FINALIZATION_CHAT_PREFIX);
}

function assertPublicPluginToolCaller(payload: unknown): void {
  if (gatewayCallerIsAgent(asRecord(payload).caller_chat_id)) {
    throw new Error("collaboration, probe and gateway tools cannot be called from collaboration agent, summary or finalization contexts");
  }
}

function toolNameOf(tool: unknown): string {
  return typeof tool === "string" ? tool : String(asRecord(tool).name || "");
}

function isAgentHiddenTool(name: unknown): boolean {
  const toolName = String(name || "");
  return AGENT_HIDDEN_TOOL_NAMES.has(toolName) ||
    AGENT_HIDDEN_TOOL_PREFIXES.some((prefix: string) => toolName.startsWith(prefix));
}

function filterAgentTools(
  tools: unknown[],
  policy: FileGatewayPolicy | undefined,
  actionGate: RuntimeActionGate | null = null,
): unknown[] {
  return tools.filter((tool) => {
    const name = toolNameOf(tool);
    if (isAgentHiddenTool(name)) return false;
    if (!actionGateToolAllowed(actionGate, name)) return false;
    if (policy && policy.allowedTools.size > 0) return policy.allowedTools.has(name);
    if (policy && policy.deniedTools.has(name)) return false;
    return !DEFAULT_DENIED_TOOLS.includes(name);
  });
}

function agentHiddenToolNames(): string[] {
  const names = [...AGENT_HIDDEN_TOOL_NAMES];
  return names.concat(names.map((name: string) =>
    `${name.startsWith("probe_") || name.startsWith("gateway_") ? "tool_lifecycle_probe" : "collaboration"}:${name}`
  ));
}

function gatewayDecision(
  currentTools: unknown,
  policy: FileGatewayPolicy | undefined,
  actionGate: RuntimeActionGate | null = null,
): GatewayDecision {
  if (Array.isArray(currentTools)) {
    const filtered = filterAgentTools(currentTools, policy, actionGate);
    return {
      result: { availableTools: filtered },
      action: policy ? "filter" : "hide_plugin_tools",
      count: filtered.length,
    };
  }
  if (actionGate) {
    return { result: { availableTools: [] }, action: `action_gate_${actionGate.kind}_unenforceable`, count: 0 };
  }
  if (policy && policy.allowedTools.size > 0) {
    return { result: { availableTools: [] }, action: "allowlist_unenforceable", count: 0 };
  }
  const denied = new Set([
    ...agentHiddenToolNames(),
    ...DEFAULT_DENIED_TOOLS,
    ...(policy ? policy.deniedTools : []),
  ]);
  return {
    result: { deniedTools: [...denied] },
    action: policy ? "deny" : "hide_plugin_tools",
    count: -1,
  };
}

function parseFileGatewayTools(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`${fieldName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a string array`);
  }
  return Array.from(new Set(parsed.map((item) => item.trim()).filter(Boolean)));
}

function registerFileGateway(agentId: unknown, config: unknown): void {
  const id = String(agentId || "").trim();
  if (!id) throw new Error("agent_id is required");
  const cfg = asRecord(config);
  const allowedRaw = cfg.allowed_tools !== undefined ? cfg.allowed_tools : cfg.allowed_tools_json;
  const deniedRaw = cfg.denied_tools !== undefined ? cfg.denied_tools : cfg.denied_tools_json;
  const allowed = new Set<string>(parseFileGatewayTools(allowedRaw, "allowed_tools"));
  const denied = new Set<string>(parseFileGatewayTools(deniedRaw, "denied_tools"));
  fileGatewayAgents.set(id, { allowedTools: allowed, deniedTools: denied });
}

function unregisterFileGateway(agentId: unknown): void {
  fileGatewayAgents.delete(String(agentId || "").trim());
}

function fileGatewayStatus() {
  const agents: Record<string, { allowed_tools: string[]; denied_tools: string[] }> = {};
  for (const [id, config] of fileGatewayAgents) {
    agents[id] = {
      allowed_tools: [...config.allowedTools].sort(),
      denied_tools: [...config.deniedTools].sort(),
    };
  }
  return {
    success: true,
    gateway: "file_gateway",
    default_denied_tools: [...DEFAULT_DENIED_TOOLS].sort(),
    fixed_hidden_tools: agentHiddenToolNames().sort(),
    execution_guard: "caller_chat_id",
    registered_agents: agents,
  };
}

function onPromptHistory(event: ToolPkg.PromptHistoryHookEvent | unknown): null {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord.eventPayload);
  rememberConversationHistory(
    payload.chatId,
    payload.chatHistory,
    payload.preparedHistory,
    payload.processedInput || payload.rawInput
  );
  return null;
}

function applyAgentGateway(agentId: string, currentTools: unknown, source: string): GatewayDecision["result"] {
  const policy = fileGatewayAgents.get(agentId);
  const actionGate = collaboration.getActionGate(agentId) as RuntimeActionGate | null;
  const decision = gatewayDecision(currentTools, policy, actionGate);
  try {
    probeUpdateLastPromptComposeEntry({
      gateway_action: actionGate
        ? `action_gate_${actionGate.kind}_by_${source}`
        : `${decision.action}_by_${source}`,
      gateway_returned_tools: decision.count,
    });
  } catch (_) {}
  return decision.result;
}

function onToolPromptCompose(event: ToolPkg.ToolPromptComposeHookEvent | unknown): GatewayDecision["result"] | null {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord.eventPayload);
  const chatId = String(payload.chatId || "");
  const meta = asRecord(payload.metadata);
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

  // Agent calls are identified by chatId when available, with proxySenderName as fallback.
  if (chatId.startsWith(COLLAB_FINALIZATION_CHAT_PREFIX)) {
    try { probeUpdateLastPromptComposeEntry({ gateway_action: "finalization_strip", gateway_returned_tools: 0 }); } catch (_) {}
    return { availableTools: [] };
  }

  if (chatId.startsWith(COLLAB_AGENT_CHAT_PREFIX)) {
    const agentId = chatId.slice(COLLAB_AGENT_CHAT_PREFIX.length);
    return applyAgentGateway(
      agentId,
      payload.availableTools,
      "chatid"
    );
  }

  if (proxySender.startsWith(FILE_GATEWAY_AGENT_PREFIX)) {
    return applyAgentGateway(
      proxySender.slice(FILE_GATEWAY_AGENT_PREFIX.length),
      payload.availableTools,
      "proxy"
    );
  }
  return null;
}

// Tool-lifecycle probe — ALL state lives in the main context (this file).
// Per TOOLPKG_FORMAT_GUIDE §3.2.5, subpackage scripts run in a separate
// "sandbox" JS context with its own globalThis; module instances and
// Top-level variables are not shared across contexts, and globalThis bridges
// do not provide cross-context state. The correct cross-context channel
// is ToolPkg.ipc: the probe subpackage's query tools call
// ToolPkg.ipc.call(channel, params) which routes here (main context) where the
// in-memory log and status live.
const PROBE_MAX_LOG_ENTRIES = 500;
const PROBE_AGENT_PREFIX = "CollaborationAgent:";
const PROBE_SUMMARY_PREFIX = "CollaborationSummary:";
const probeLog: ProbeEntry[] = [];
const probeStatus: ProbeStatus = {
  registered: false,
  registration_error: "",
  hook_active: false,
  total_events: 0,
  dropped_events: 0,
  events_by_name: {},
  events_by_tool: {},
  agent_attributed_events: 0,
  summary_attributed_events: 0,
  unattributed_events: 0,
  intercept_events: 0,
  identity_bearing_events: 0,
  identity_missing_events: 0,
  host_lifecycle_events: 0,
  host_identity_bearing_events: 0,
  runtime_attributed_events: 0,
  last_event_at: 0,
};
let probeSequence = 0;

function probeReadField(payload: unknown, keys: string[]): string {
  const record = asRecord(payload);
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).length > 0) {
      return String(value);
    }
  }
  return "";
}

function probeAttributionFor(sender: unknown, chatId: unknown): ProbeAttribution {
  const source = String(sender || "");
  const id = String(chatId || "");
  if (source.startsWith(PROBE_AGENT_PREFIX)) {
    return { kind: "collaboration_agent", agent_id: source.slice(PROBE_AGENT_PREFIX.length) };
  }
  if (source.startsWith(PROBE_SUMMARY_PREFIX)) {
    return { kind: "collaboration_summary", agent_id: source.slice(PROBE_SUMMARY_PREFIX.length) };
  }
  if (id.startsWith(COLLAB_AGENT_CHAT_PREFIX)) {
    return { kind: "collaboration_agent", agent_id: id.slice(COLLAB_AGENT_CHAT_PREFIX.length) };
  }
  if (id.startsWith(COLLAB_SUMMARY_CHAT_PREFIX)) {
    return { kind: "collaboration_summary", agent_id: id.slice(COLLAB_SUMMARY_CHAT_PREFIX.length).split(":")[0] };
  }
  if (id.startsWith(COLLAB_FINALIZATION_CHAT_PREFIX)) {
    return { kind: "collaboration_finalization", agent_id: id.slice(COLLAB_FINALIZATION_CHAT_PREFIX.length).split(":")[0] };
  }
  if (id) return { kind: "chat", agent_id: "" };
  return { kind: "unattributed", agent_id: "" };
}

function probeRecordAgentToolInvocation(details: unknown): ProbeEntry | null {
  const data = asRecord(details);
  const agentId = String(data.agent_id || "").trim();
  const toolName = String(data.tool_name || "").trim();
  if (!agentId || !toolName) return null;
  const timestamp = Date.now();
  const entry = {
    seq: (probeSequence += 1),
    at: timestamp,
    event_name: "agent_tool_invocation",
    tool_name: toolName,
    proxy_sender_name: `${PROBE_AGENT_PREFIX}${agentId}`,
    proxy_sender_source: "runtime_callback",
    chat_id: `${COLLAB_AGENT_CHAT_PREFIX}${agentId}`,
    invocation_id: "",
    identity_bearing: true,
    toolpkg_id: "",
    attribution_kind: "collaboration_agent",
    attribution_source: "runtime_callback",
    attributed_agent_id: agentId,
    execution_epoch: String(data.execution_epoch || ""),
    is_intercept_phase: false,
    payload_keys: [],
    event_keys: [],
    nested_event_keys: [],
  };
  probeLog.push(entry);
  if (probeLog.length > PROBE_MAX_LOG_ENTRIES) {
    probeLog.splice(0, probeLog.length - PROBE_MAX_LOG_ENTRIES);
    probeStatus.dropped_events += 1;
  }
  probeStatus.total_events += 1;
  probeStatus.runtime_attributed_events += 1;
  probeStatus.agent_attributed_events += 1;
  probeStatus.identity_bearing_events += 1;
  probeStatus.events_by_name[entry.event_name] = (probeStatus.events_by_name[entry.event_name] || 0) + 1;
  probeStatus.events_by_tool[toolName] = (probeStatus.events_by_tool[toolName] || 0) + 1;
  probeStatus.last_event_at = timestamp;
  return entry;
}

function probeRecordEvent(eventName: unknown, eventTop: unknown, payload: unknown): ProbeEntry {
  const timestamp = Date.now();
  // The host nests identity fields inside event.event (a sub-object).
  // Search event.event, eventTop, and payload for proxySenderName/chatId.
  const eventRecord = asRecord(eventTop);
  const payloadRecord = asRecord(payload);
  const nestedEventValue = eventRecord.event;
  const nestedEvent = nestedEventValue !== null && typeof nestedEventValue === "object"
    ? asRecord(nestedEventValue)
    : null;
  const toolName = probeReadField(payload, ["toolName", "tool_name", "name"]) ||
    probeReadField(eventTop, ["toolName", "tool_name", "name"]);
  const eventPhase = probeReadField(payload, ["eventName", "event_name", "phase"]);
  const proxySender = probeReadField(nestedEvent, ["proxySenderName", "proxy_sender_name"]) ||
    probeReadField(eventTop, ["proxySenderName", "proxy_sender_name"]) ||
    probeReadField(payload, ["proxySenderName", "proxy_sender_name"]);
  const chatId = probeReadField(nestedEvent, ["chatId", "chat_id"]) ||
    probeReadField(eventTop, ["chatId", "chat_id"]) ||
    probeReadField(payload, ["chatId", "chat_id"]);
  const effectiveChatId = chatId || probeReadField(eventTop, ["__operit_package_chat_id"]) ||
    probeReadField(payload, ["__operit_package_chat_id"]);
  const invocationId = probeReadField(nestedEvent, ["invocationId", "invocation_id"]) ||
    probeReadField(eventTop, ["invocationId", "invocation_id"]) ||
    probeReadField(payload, ["invocationId", "invocation_id"]);
  const identityBearing = !!(proxySender || effectiveChatId || invocationId);
  const toolPkgId = probeReadField(eventTop, ["toolPkgId", "toolpkg_id", "containerPackageName"]) ||
    probeReadField(nestedEvent, ["toolPkgId", "toolpkg_id", "containerPackageName"]) ||
    probeReadField(payload, ["toolPkgId", "toolpkg_id", "containerPackageName"]);
  const attribution = probeAttributionFor(proxySender, effectiveChatId);
  const isIntercept = String(eventName || "").toLowerCase().includes("intercept") ||
    String(eventPhase || "").toLowerCase().includes("intercept");

  let senderSource = "none";
  if (proxySender) {
    if (probeReadField(nestedEvent, ["proxySenderName", "proxy_sender_name"])) senderSource = "nested_event";
    else if (probeReadField(eventTop, ["proxySenderName", "proxy_sender_name"])) senderSource = "event_top";
    else senderSource = "payload";
  }

  const entry: ProbeEntry = {
    seq: (probeSequence += 1),
    at: timestamp,
    event_name: String(eventName || eventPhase || "unknown"),
    tool_name: toolName,
    proxy_sender_name: proxySender,
    proxy_sender_source: senderSource,
    chat_id: effectiveChatId,
    invocation_id: invocationId,
    identity_bearing: identityBearing,
    toolpkg_id: toolPkgId,
    attribution_kind: attribution.kind,
    attribution_source: proxySender ? "host_sender" : (effectiveChatId ? "host_chat" : "none"),
    attributed_agent_id: attribution.agent_id,
    execution_epoch: "",
    is_intercept_phase: isIntercept,
    payload_keys: payload && typeof payload === "object" ? Object.keys(payload).sort() : [],
    event_keys: eventTop && typeof eventTop === "object" ? Object.keys(eventTop).sort() : [],
    nested_event_keys: nestedEvent ? Object.keys(nestedEvent).sort() : [],
  };

  probeLog.push(entry);
  if (probeLog.length > PROBE_MAX_LOG_ENTRIES) {
    probeLog.splice(0, probeLog.length - PROBE_MAX_LOG_ENTRIES);
    probeStatus.dropped_events += 1;
  }

  probeStatus.total_events += 1;
  probeStatus.host_lifecycle_events += 1;
  if (identityBearing) probeStatus.host_identity_bearing_events += 1;
  probeStatus.last_event_at = timestamp;
  const en = entry.event_name;
  if (en) probeStatus.events_by_name[en] = (probeStatus.events_by_name[en] || 0) + 1;
  const tn = toolName || "(none)";
  probeStatus.events_by_tool[tn] = (probeStatus.events_by_tool[tn] || 0) + 1;
  if (attribution.kind === "collaboration_agent") probeStatus.agent_attributed_events += 1;
  else if (attribution.kind === "collaboration_summary") probeStatus.summary_attributed_events += 1;
  else probeStatus.unattributed_events += 1;
  if (identityBearing) probeStatus.identity_bearing_events += 1;
  else probeStatus.identity_missing_events += 1;
  if (isIntercept) probeStatus.intercept_events += 1;
  return entry;
}

function onToolLifecycle(event: ToolPkg.ToolLifecycleHookEvent | unknown): { decision: "allow" } {
  try {
    const eventRecord = asRecord(event);
    const payload = eventRecord.eventPayload === undefined
      ? eventRecord
      : asRecord(eventRecord.eventPayload);
    const eventName = probeReadField(eventRecord, ["eventName", "event_name"]) ||
      probeReadField(payload, ["eventName", "event_name", "phase"]);
    probeStatus.hook_active = true;
    const entry = probeRecordEvent(eventName, eventRecord, payload);
    if (entry.attribution_kind === "collaboration_agent" && entry.attributed_agent_id &&
        (entry.event_name === "tool_execution_started" ||
         entry.event_name === "tool_execution_result" ||
         entry.event_name === "tool_execution_error")) {
      collaboration.recordToolLifecycle({
        phase: entry.event_name,
        agent_id: entry.attributed_agent_id,
        tool_name: entry.tool_name,
        invocation_id: entry.invocation_id,
        success: payload.success,
        result_text: payload.resultText,
        result_json: payload.resultJson,
        error_message: payload.errorMessage,
      });
    }
  } catch (_) {
    // Swallow: observation only, never throw from a host hook.
  }
  return { decision: "allow" };
}

function probeGetStatus(_params: unknown) {
  const capabilityHookAvailable = typeof ToolPkg !== "undefined" && ToolPkg &&
    typeof ToolPkg.registerToolLifecycleHook === "function";
  const registrationState = probeStatus.registered
    ? "registered"
    : (probeStatus.hook_active ? "active_without_local_registration" : "not_registered");
  const attributionCapability = probeStatus.runtime_attributed_events > 0
    ? "runtime_agent_callbacks_observed"
    : (probeStatus.host_lifecycle_events === 0
      ? "no_events_observed"
      : (probeStatus.host_identity_bearing_events > 0
        ? "host_identity_fields_observed"
        : "host_identity_fields_missing"));
  return {
    success: true,
    probe: "tool_lifecycle",
    capability_hook_available: capabilityHookAvailable,
    registered: probeStatus.registered,
    registration_state: registrationState,
    hook_active: probeStatus.hook_active,
    registration_error: probeStatus.registration_error || undefined,
    max_entries: PROBE_MAX_LOG_ENTRIES,
    buffered_entries: probeLog.length,
    total_events: probeStatus.total_events,
    dropped_events: probeStatus.dropped_events,
    intercept_events: probeStatus.intercept_events,
    host_lifecycle_events: probeStatus.host_lifecycle_events,
    host_identity_bearing_events: probeStatus.host_identity_bearing_events,
    runtime_attributed_events: probeStatus.runtime_attributed_events,
    identity_bearing_events: probeStatus.identity_bearing_events,
    identity_missing_events: probeStatus.identity_missing_events,
    attribution_capability: attributionCapability,
    attribution_available: probeStatus.agent_attributed_events > 0 || probeStatus.summary_attributed_events > 0,
    agent_attributed_events: probeStatus.agent_attributed_events,
    summary_attributed_events: probeStatus.summary_attributed_events,
    unattributed_events: probeStatus.unattributed_events,
    events_by_name: { ...probeStatus.events_by_name },
    events_by_tool: { ...probeStatus.events_by_tool },
    last_event_at: probeStatus.last_event_at || undefined,
  };
}

function probeGetLog(params: unknown) {
  const p = asRecord(params);
  const requestedLimit = Number(p.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit === 0
    ? PROBE_MAX_LOG_ENTRIES
    : Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(PROBE_MAX_LOG_ENTRIES, Math.floor(requestedLimit))
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
  return {
    success: true,
    probe: "tool_lifecycle",
    returned: page.length,
    matched: filtered.length,
    total_events: probeStatus.total_events,
    entries: page.map((entry) => ({ ...entry, payload_keys: [...entry.payload_keys] })),
  };
}

function probeClearLog(_params: unknown) {
  const lifecycleCleared = probeLog.length;
  const promptComposeCleared = promptComposeLog.length;
  probeLog.length = 0;
  promptComposeLog.length = 0;
  return {
    success: true,
    probe: "tool_lifecycle",
    cleared: lifecycleCleared + promptComposeCleared,
    lifecycle_cleared: lifecycleCleared,
    prompt_compose_cleared: promptComposeCleared,
  };
}

// Record prompt-compose events to verify proxySenderName availability.
const promptComposeLog: PromptComposeEntry[] = [];
const PROMPT_COMPOSE_MAX_LOG = 100;

function probeRecordPromptComposeEvent(payload: unknown): PromptComposeEntry {
  const payloadRecord = asRecord(payload);
  const metaValue = payloadRecord.metadata;
  const meta = metaValue !== null && typeof metaValue === "object" ? asRecord(metaValue) : null;
  const tools: unknown[] = Array.isArray(payloadRecord.availableTools) ? payloadRecord.availableTools : [];
  const toolNames = tools.map((tool: unknown) => {
    if (typeof tool === "string") return tool;
    const toolRecord = asRecord(tool);
    if (Object.keys(toolRecord).length > 0) return String(toolRecord.name || toolRecord.toolName || toolRecord.id || "?");
    return String(tool);
  });
  const firstToolSample = tools.length > 0 ? tools[0] : null;
  const firstToolType = firstToolSample === null ? "null" : typeof firstToolSample;
  const firstToolKeys = firstToolSample && typeof firstToolSample === "object"
    ? Object.keys(asRecord(firstToolSample)).sort()
    : [];
  const entry: PromptComposeEntry = {
    at: Date.now(),
    chat_id: String(payloadRecord.chatId || payloadRecord.chat_id || ""),
    proxy_sender_name: String(payloadRecord.proxySenderName || payloadRecord.proxy_sender_name || ""),
    metadata_proxy_sender: meta ? String(meta.proxySenderName || meta.proxy_sender_name || "") : "",
    metadata_keys: meta ? Object.keys(meta).sort() : [],
    function_type: String(payloadRecord.functionType || payloadRecord.function_type || ""),
    prompt_function_type: String(payloadRecord.promptFunctionType || payloadRecord.prompt_function_type || ""),
    stage: String(payloadRecord.stage || ""),
    sub_task: String(payloadRecord.subTask || payloadRecord.sub_task || ""),
    payload_keys: Object.keys(payloadRecord).sort(),
    has_available_tools: Array.isArray(payloadRecord.availableTools),
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

function probeUpdateLastPromptComposeEntry(updates: DynamicRecord): void {
  if (promptComposeLog.length === 0) return;
  const last = promptComposeLog[promptComposeLog.length - 1];
  for (const [key, value] of Object.entries(updates)) last[key] = value;
}

function probeGetPromptComposeLog(_params: unknown) {
  return {
    success: true,
    probe: "prompt_compose",
    buffered_entries: promptComposeLog.length,
    entries: promptComposeLog.slice(-50),
  };
}
function resolveDashboardScreen(moduleRef: unknown): ToolPkg.ComposeDslScreen | null {
  // During ToolPkg registration, requiring a local *.ui.js returns a path-tagged
  // placeholder function. In normal CommonJS execution it returns the exports object.
  if (typeof moduleRef === "function") return moduleRef as ToolPkg.ComposeDslScreen;
  const exportsRecord = asRecord(moduleRef);
  if (typeof exportsRecord.default === "function") return exportsRecord.default as ToolPkg.ComposeDslScreen;
  if (typeof exportsRecord.Screen === "function") return exportsRecord.Screen as ToolPkg.ComposeDslScreen;
  return null;
}

function registerDashboardUi() {
  if (dashboardUiRegistered) return true;
  if (typeof ToolPkg === "undefined" || !ToolPkg ||
      typeof ToolPkg.registerToolboxUiModule !== "function") {
    dashboardUiRegistrationError = "registerToolboxUiModule is unavailable";
    return false;
  }
  try {
    const dashboardScreen = resolveDashboardScreen(dashboardModule);
    if (typeof dashboardScreen !== "function") {
      throw new Error("collaboration dashboard entry function is unavailable");
    }

    ToolPkg.registerToolboxUiModule({
      id: "collaboration_dashboard_v102",
      runtime: "compose_dsl",
      screen: dashboardScreen,
      params: {},
      keepAlive: true,
      title: {
        zh: "多 Agent 控制台",
        en: "Collaboration Dashboard",
      },
    });
    dashboardUiRegistered = true;
    dashboardUiRegistrationError = "";
    return true;
  } catch (error) {
    dashboardUiRegistrationError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function dashboardUiStatus() {
  return {
    registered: dashboardUiRegistered,
    registration_error: dashboardUiRegistrationError || undefined,
  };
}

function registerToolPkg() {
  registerDashboardUi();
  ToolPkg.registerPromptHistoryHook({
    id: "collaboration_conversation_history_snapshot",
    function: onPromptHistory,
  });
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

export {
  registerToolPkg,
  registerDashboardUi,
  resolveDashboardScreen,
  dashboardUiStatus,
  onPromptHistory,
  onToolPromptCompose,
  snapshotConversationHistory,
  getConversationHistory,
  onToolLifecycle,
  probeGetStatus,
  probeGetLog,
  probeClearLog,
  probeGetPromptComposeLog,
  probeRecordAgentToolInvocation,
  registerFileGateway,
  unregisterFileGateway,
  fileGatewayStatus,
  cancelAllRuns,
};