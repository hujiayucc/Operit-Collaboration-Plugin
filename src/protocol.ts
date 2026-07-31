export const CHANNELS = Object.freeze({
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
  PROBE_GET_STATUS: "probe.get_status",
  PROBE_GET_LOG: "probe.get_log",
  PROBE_CLEAR_LOG: "probe.clear_log",
  PROBE_GET_PROMPT_COMPOSE_LOG: "probe.get_prompt_compose_log",
  GATEWAY_REGISTER: "gateway.register",
  GATEWAY_UNREGISTER: "gateway.unregister",
  GATEWAY_STATUS: "gateway.status",
});

export type ToolFailureEnvelope = {
  transport_success: true;
  operation_success: false;
  result: {
    success: false;
    error: {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
  };
};

export function asText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export function parseJson(value: unknown, fieldName: unknown): unknown {
  const text = asText(value).trim();
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseOptionalStringArray(value: unknown, fieldName: unknown): string[] | undefined {
  const text = asText(value).trim();
  if (!text) return undefined;
  const parsed = parseJson(text, fieldName);
  if (!Array.isArray(parsed) || parsed.some((item: unknown) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
  return parsed.map((item) => (item as string).trim()).filter(Boolean);
}

export function classifyErrorCode(message: unknown): string {
  const text = String(message || "");
  if (/valid JSON|JSON string array|string array/i.test(text)) return "invalid_json";
  if (/request_id conflict/i.test(text)) return "request_id_conflict";
  if (/write path conflict/i.test(text)) return "path_conflict";
  if (/outside workspace/i.test(text)) return "path_outside_workspace";
  if (/workspace_env/i.test(text)) return "workspace_env_invalid";
  if (/timeout_ms/i.test(text)) return "timeout_invalid";
  if (/max_model_retries/i.test(text)) return "max_model_retries_invalid";
  if (/non-empty array|agent_ids/i.test(text)) return "agent_ids_invalid";
  if (/limit/i.test(text)) return "limit_invalid";
  if (/cursor/i.test(text)) return "cursor_invalid";
  if (/agent not found/i.test(text)) return "agent_not_found";
  if (/is (?:queued|running|summarizing|cancelling|completed|failed|interrupted|timed_out|orphaned)/i.test(text)) return "agent_state_invalid";
  if (/required/i.test(text)) return "parameter_required";
  return "operation_failed";
}

export function toolFailure(
  error: unknown,
  operation: unknown,
  details: Record<string, unknown> = {},
): ToolFailureEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  const failure: ToolFailureEnvelope["result"] = {
    success: false,
    error: {
      code: classifyErrorCode(message),
      message,
      details: { operation: String(operation || "tool_call"), ...details },
    },
  };
  return {
    transport_success: true,
    operation_success: false,
    result: failure,
  };
}

export function formatJson(value: unknown): string | undefined {
  return JSON.stringify(value, null, 2);
}