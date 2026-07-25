"use strict";

const TOOL_BLOCK = /<(tool(?:_[A-Za-z0-9]+)?)\b[\s\S]*?<\/\1>/gi;
const TOOL_SELF_CLOSING = /<tool(?:_[A-Za-z0-9]+)?\b[^>]*\/>/gi;
const TOOL_RESULT_BLOCK = /<(tool_result(?:_[A-Za-z0-9]+)?)\b[\s\S]*?<\/\1>/gi;
const TOOL_RESULT_SELF = /<tool_result(?:_[A-Za-z0-9]+)?\b[^>]*\/>/gi;
const UNMATCHED_TOOL_LIKE_TAG = /<tool(?:_result)?(?:_[A-Za-z0-9]+)?\b/i;
const TOOL_BLOCK_MARKER = "\u0000OPERIT_TOOL_BLOCK\u0000";
const THINK_TAG = /<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi;
const SEARCH_TAG = /<search>[\s\S]*?(<\/search>|$)/gi;
const PROMPT_ECHO_MARKERS = Object.freeze([
  "COLLABORATION_AGENT_CONSTRAINTS:",
  "思考过程指南：",
  "在提供最终答案之前，你必须使用",
]);
const MESSAGE_ACK_LINE = /^\s*COLLABORATION_MESSAGE_ACKS:\s*(\[[^\r\n]*\])\s*$/gim;
const CONTROL_MARKER = /^\s*COLLABORATION_CONTROL:\s*/gim;
const CONTROL_ACTIONS = new Set(["progress", "finish", "fail"]);
const CONTROL_VERSION = 1;
const SUPPRESSED_PROMPT_ECHO_RESULT = "Agent output was suppressed because it reproduced internal instructions.";

function now() {
  return Date.now();
}

function createId(prefix) {
  const stamp = now().toString(36);
  const random = Math.floor(Math.random() * 2176782336).toString(36).padStart(6, "0");
  return `${prefix}_${stamp}_${random}`;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function clipText(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizePath(path) {
  let value = String(path || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  const windows = /^[A-Za-z]:\//.test(value);
  if (!windows && !value.startsWith("/")) throw new Error(`target path must be absolute: ${value}`);
  const prefix = windows ? value.slice(0, 3) : "/";
  const rest = windows ? value.slice(3) : value.slice(1);
  const segments = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) throw new Error(`target path escapes its root: ${value}`);
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  value = `${prefix}${segments.join("/")}`;
  while (value.length > prefix.length && value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function comparablePath(path) {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameOrParent(parent, child) {
  return parent === child || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function isPathWithin(path, root) {
  const child = comparablePath(path);
  const parent = comparablePath(root);
  return !!child && !!parent && isSameOrParent(parent, child);
}

function pathsOverlap(left, right) {
  const a = comparablePath(left);
  const b = comparablePath(right);
  if (!a || !b) return false;
  return isSameOrParent(a, b) || isSameOrParent(b, a);
}

function cleanAgentResult(raw) {
  const source = String(raw || "").replace(THINK_TAG, "").replace(SEARCH_TAG, "");
  const marked = source
    .replace(TOOL_RESULT_BLOCK, TOOL_BLOCK_MARKER)
    .replace(TOOL_RESULT_SELF, TOOL_BLOCK_MARKER)
    .replace(TOOL_BLOCK, TOOL_BLOCK_MARKER)
    .replace(TOOL_SELF_CLOSING, TOOL_BLOCK_MARKER);
  const segments = marked.split(TOOL_BLOCK_MARKER);
  const tail = segments[segments.length - 1].trim();
  if (tail && !UNMATCHED_TOOL_LIKE_TAG.test(tail)) return tail.replace(/\n{3,}/g, "\n\n");
  const unmatched = tail.match(UNMATCHED_TOOL_LIKE_TAG);
  if (unmatched && unmatched.index !== undefined) {
    const prefix = tail.slice(0, unmatched.index).trim();
    return [...segments.slice(0, -1), prefix].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
  }
  return segments.join("").trim().replace(/\n{3,}/g, "\n\n");
}

function hasFinalTextAfterTool(raw) {
  const source = String(raw || "").replace(THINK_TAG, "").replace(SEARCH_TAG, "");
  const marked = source
    .replace(TOOL_RESULT_BLOCK, TOOL_BLOCK_MARKER)
    .replace(TOOL_RESULT_SELF, TOOL_BLOCK_MARKER)
    .replace(TOOL_BLOCK, TOOL_BLOCK_MARKER)
    .replace(TOOL_SELF_CLOSING, TOOL_BLOCK_MARKER);
  const segments = marked.split(TOOL_BLOCK_MARKER);
  if (segments.length < 2) return false;
  const tail = segments[segments.length - 1].trim();
  return !!tail && !UNMATCHED_TOOL_LIKE_TAG.test(tail);
}

function looksLikePromptEcho(value) {
  const text = String(value || "").trim();
  return !!text && PROMPT_ECHO_MARKERS.some((marker) => text.includes(marker));
}

function redactPromptEcho(value) {
  let text = String(value || "");
  for (const marker of PROMPT_ECHO_MARKERS) text = text.split(marker).join("[internal instructions removed]");
  return text;
}

function controlMarkers(value) {
  const matches = [];
  const text = String(value || "");
  CONTROL_MARKER.lastIndex = 0;
  let match;
  while ((match = CONTROL_MARKER.exec(text)) !== null) {
    matches.push({ start: match.index, jsonStart: CONTROL_MARKER.lastIndex });
  }
  CONTROL_MARKER.lastIndex = 0;
  return matches;
}

function normalizeControlEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "control envelope must be a JSON object" };
  }
  const version = Number(value.version);
  if (version !== CONTROL_VERSION) {
    return { valid: false, error: `unsupported control version: ${value.version}` };
  }
  const executionEpoch = String(value.execution_epoch || "").trim();
  if (!executionEpoch) return { valid: false, error: "control execution_epoch is required" };
  const action = String(value.action || "").trim().toLowerCase();
  if (!CONTROL_ACTIONS.has(action)) {
    return { valid: false, error: `unsupported control action: ${action || "missing"}` };
  }
  const messageAcks = [];
  if (value.message_acks !== undefined && !Array.isArray(value.message_acks)) {
    return { valid: false, error: "control message_acks must be an array" };
  }
  for (const item of value.message_acks || []) {
    const id = String(item || "").trim();
    if (id && !messageAcks.includes(id)) messageAcks.push(id);
  }
  const error = String(value.error || "").trim();
  if (action === "fail" && !error) return { valid: false, error: "fail control requires error" };
  return {
    valid: true,
    control: {
      version,
      executionEpoch,
      action,
      messageAcks,
      error,
    },
  };
}

function parseControlEnvelope(raw) {
  const text = String(raw || "");
  const markers = controlMarkers(text);
  if (markers.length === 0) {
    return { present: false, valid: false, control: null, error: "", stripped: text.trim() };
  }
  const last = markers[markers.length - 1];
  const candidate = text.slice(last.jsonStart).trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return {
      present: true,
      valid: false,
      control: null,
      error: `invalid control JSON: ${error instanceof Error ? error.message : String(error)}`,
      stripped: text.slice(0, last.start).trim().replace(/\n{3,}/g, "\n\n"),
    };
  }
  const normalized = normalizeControlEnvelope(parsed);
  return {
    present: true,
    valid: normalized.valid,
    control: normalized.control || null,
    error: normalized.error || "",
    stripped: text.slice(0, last.start).trim().replace(/\n{3,}/g, "\n\n"),
  };
}

function stripControlEnvelopes(value) {
  const text = String(value || "");
  const markers = controlMarkers(text);
  if (markers.length === 0) return text.trim();
  return text.slice(0, markers[0].start).trim().replace(/\n{3,}/g, "\n\n");
}

function stripTransportControls(value) {
  return stripMessageAcks(stripControlEnvelopes(value));
}

function safePublicResult(value) {
  const text = stripTransportControls(String(value || "")).trim();
  if (!text) return "";
  return looksLikePromptEcho(text) ? SUPPRESSED_PROMPT_ECHO_RESULT : text;
}

function parseMessageAcks(raw) {
  const ids = new Set();
  const text = String(raw || "");
  MESSAGE_ACK_LINE.lastIndex = 0;
  let match;
  while ((match = MESSAGE_ACK_LINE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (!Array.isArray(parsed)) continue;
      for (const id of parsed) {
        const value = String(id || "").trim();
        if (value) ids.add(value);
      }
    } catch (_) {}
  }
  MESSAGE_ACK_LINE.lastIndex = 0;
  return Array.from(ids);
}

function stripMessageAcks(value) {
  MESSAGE_ACK_LINE.lastIndex = 0;
  const text = String(value || "").replace(MESSAGE_ACK_LINE, "").trim().replace(/\n{3,}/g, "\n\n");
  MESSAGE_ACK_LINE.lastIndex = 0;
  return text;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function sqliteLiteral(value) {
  return `'${String(value || "").replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

module.exports = {
  SUPPRESSED_PROMPT_ECHO_RESULT,
  cleanAgentResult,
  clipText,
  createId,
  errorText,
  hasFinalTextAfterTool,
  isPathWithin,
  looksLikePromptEcho,
  normalizePath,
  now,
  parseControlEnvelope,
  parseMessageAcks,
  pathsOverlap,
  redactPromptEcho,
  safePublicResult,
  sqliteLiteral,
  stripControlEnvelopes,
  stripMessageAcks,
  stripTransportControls,
  withTimeout,
};