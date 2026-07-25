"use strict";

const CHANNELS = Object.freeze({
  SPAWN_AGENT: "collaboration.spawn_agent",
  LIST_AGENTS: "collaboration.list_agents",
  SEND_MESSAGE: "collaboration.send_message",
  FOLLOWUP_TASK: "collaboration.followup_task",
  WAIT_AGENT: "collaboration.wait_agent",
  INTERRUPT_AGENT: "collaboration.interrupt_agent",
  PROBE_GET_STATUS: "probe.get_status",
  PROBE_GET_LOG: "probe.get_log",
  PROBE_CLEAR_LOG: "probe.clear_log",
  PROBE_GET_PROMPT_COMPOSE_LOG: "probe.get_prompt_compose_log",
  GATEWAY_REGISTER: "gateway.register",
  GATEWAY_UNREGISTER: "gateway.unregister",
  GATEWAY_STATUS: "gateway.status",
});

const IPC_OPTIONS = Object.freeze({ targetRuntime: "main" });

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function parseJson(value, fieldName) {
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

function parseOptionalStringArray(value, fieldName) {
  const text = asText(value).trim();
  if (!text) return undefined;
  const parsed = parseJson(text, fieldName);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
  return parsed.map((item) => item.trim()).filter(Boolean);
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

module.exports = {
  CHANNELS,
  IPC_OPTIONS,
  asText,
  parseJson,
  parseOptionalStringArray,
  formatJson,
};