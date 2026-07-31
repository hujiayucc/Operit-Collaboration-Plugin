export type DynamicValue = unknown;
export type JsonRecord = Record<string, DynamicValue>;
export type ToolReceipt = { name: string; hasResult: boolean; result: string };
export type OutboundControlMessage = { id: string; target: string; agentId: string; content: string };
export type CollaborationControl = {
  version: number;
  executionEpoch: string;
  action: string;
  messageAcks: string[];
  outboundMessages: OutboundControlMessage[];
  error: string;
};
export type ParsedControlEnvelope = {
  present: boolean;
  valid: boolean;
  control: CollaborationControl | null;
  error: string;
  stripped: string;
};
export type PublicStreamFilter = {
  push(value: unknown): string;
  finish(): string;
  readonly promptEchoSuppressed: boolean;
};

const TOOL_BLOCK = /<(tool(?:_[A-Za-z0-9]+)?)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const TOOL_SELF_CLOSING = /<tool(?:_[A-Za-z0-9]+)?\b[^>]*\/>/gi;
const TOOL_RESULT_BLOCK = /<(tool_result(?:_[A-Za-z0-9]+)?)\b[^>]*>([\s\S]*?)<\/\1>/gi;
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
const CONTROL_MARKER = /^[\t ]*COLLABORATION_CONTROL:[\t ]*/gim;
const CONTROL_ACTIONS = new Set(["progress", "finish", "fail"]);
const CONTROL_MESSAGE_TARGETS = new Set(["main", "parent", "root", "agent"]);
const MAX_OUTBOUND_MESSAGES = 32;
const MAX_OUTBOUND_MESSAGE_ID_CHARS = 128;
const MAX_OUTBOUND_MESSAGE_CHARS = 16384;
const CONTROL_VERSION = 1;
export const SUPPRESSED_PROMPT_ECHO_RESULT = "Agent output was suppressed because it reproduced internal instructions.";

export function now(): number {
  return Date.now();
}

export function createId(prefix: unknown): string {
  const stamp = now().toString(36);
  const random = Math.floor(Math.random() * 2176782336).toString(36).padStart(6, "0");
  return `${prefix}_${stamp}_${random}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clipText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function normalizePath(path: unknown): string {
  let value = String(path || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  const windows = /^[A-Za-z]:\//.test(value);
  if (!windows && !value.startsWith("/")) throw new Error(`target path must be absolute: ${value}`);
  const prefix = windows ? value.slice(0, 3) : "/";
  const rest = windows ? value.slice(3) : value.slice(1);
  const segments: string[] = [];
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

function comparablePath(path: unknown): string {
  const normalized = normalizePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameOrParent(parent: string, child: string): boolean {
  return parent === child || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

export function isPathWithin(path: unknown, root: unknown): boolean {
  const child = comparablePath(path);
  const parent = comparablePath(root);
  return !!child && !!parent && isSameOrParent(parent, child);
}

export function pathsOverlap(left: unknown, right: unknown): boolean {
  const a = comparablePath(left);
  const b = comparablePath(right);
  if (!a || !b) return false;
  return isSameOrParent(a, b) || isSameOrParent(b, a);
}

function toolAttribute(attributes: unknown, name: unknown): string {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+))`;
  const match = String(attributes || "").match(new RegExp(pattern, "i"));
  return match ? String(match[1] ?? match[2] ?? match[3] ?? "").trim() : "";
}

export function extractToolReceipts(value: unknown): ToolReceipt[] {
  const source = String(value || "");
  const tools: Array<ToolReceipt & { start: number; end: number }> = [];
  const results: Array<{ start: number; end: number; result: string; used: boolean }> = [];
  TOOL_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_BLOCK.exec(source)) !== null) {
    const name = toolAttribute(match[2], "name");
    if (!name) continue;
    TOOL_RESULT_BLOCK.lastIndex = 0;
    const nested = TOOL_RESULT_BLOCK.exec(match[3]);
    tools.push({
      name,
      start: match.index,
      end: TOOL_BLOCK.lastIndex,
      hasResult: !!nested,
      result: nested ? String(nested[2] || "").trim() : "",
    });
  }
  TOOL_RESULT_BLOCK.lastIndex = 0;
  while ((match = TOOL_RESULT_BLOCK.exec(source)) !== null) {
    results.push({
      start: match.index,
      end: TOOL_RESULT_BLOCK.lastIndex,
      result: String(match[2] || "").trim(),
      used: false,
    });
  }
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (tool.hasResult) {
      const nestedResult = results.find((result) => result.start >= tool.start && result.end <= tool.end);
      if (nestedResult) nestedResult.used = true;
      continue;
    }
    const nextToolStart = tools[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const adjacent = results.find((result) => !result.used && result.start >= tool.end && result.start < nextToolStart);
    if (!adjacent) continue;
    adjacent.used = true;
    tool.hasResult = true;
    tool.result = adjacent.result;
  }
  TOOL_BLOCK.lastIndex = 0;
  TOOL_RESULT_BLOCK.lastIndex = 0;
  return tools.map(({ name, hasResult, result }) => ({ name, hasResult, result }));
}

export function cleanAgentResult(raw: unknown): string {
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

export function hasFinalTextAfterTool(raw: unknown): boolean {
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

export function looksLikePromptEcho(value: unknown): boolean {
  const text = String(value || "").trim();
  return !!text && PROMPT_ECHO_MARKERS.some((marker) => text.includes(marker));
}

export function redactPromptEcho(value: unknown): string {
  let text = String(value || "");
  for (const marker of PROMPT_ECHO_MARKERS) text = text.split(marker).join("[internal instructions removed]");
  return text;
}

export function createPublicStreamFilter(): PublicStreamFilter {
  const controlMarker = "COLLABORATION_CONTROL:";
  const ackMarker = "COLLABORATION_MESSAGE_ACKS:";
  const transportMarkers = [controlMarker, ackMarker];
  const hiddenTagName = /^(?:think(?:ing)?|search|tool(?:_result)?(?:_[A-Za-z0-9]+)?)$/i;
  const hiddenTagPrefix = /^<\/?(?:think(?:ing)?|search|tool(?:_result)?(?:_[A-Za-z0-9]+)?)\b/i;
  let pending = "";
  let hiddenTag = "";
  let hideLine = false;
  let hideRemainder = false;
  let atLineStart = true;
  let suppressed = false;


  function isPartialPrefix(value: string, candidates: readonly string[]): boolean {
    if (!value) return true;
    const lower = value.toLowerCase();
    return candidates.some((candidate) => candidate.toLowerCase().startsWith(lower));
  }

  function drain(final: boolean): string {
    let output = "";
    while (pending) {
      if (suppressed || hideRemainder) {
        pending = "";
        break;
      }
      if (hiddenTag) {
        const close = `</${hiddenTag}>`;
        const index = pending.toLowerCase().indexOf(close.toLowerCase());
        if (index >= 0) {
          pending = pending.slice(index + close.length);
          hiddenTag = "";
          continue;
        }
        if (final) {
          pending = "";
          hiddenTag = "";
        } else {
          pending = pending.slice(Math.max(0, pending.length - close.length + 1));
        }
        break;
      }
      if (hideLine) {
        const newline = pending.indexOf("\n");
        if (newline >= 0) {
          pending = pending.slice(newline + 1);
          hideLine = false;
          atLineStart = true;
          continue;
        }
        pending = "";
        if (final) hideLine = false;
        break;
      }
      if (atLineStart) {
        const whitespace = pending.match(/^[\t ]*/)?.[0] || "";
        const candidate = pending.slice(whitespace.length);
        const marker = transportMarkers.find((value) =>
          candidate.toLowerCase().startsWith(value.toLowerCase())
        );
        if (marker) {
          pending = candidate.slice(marker.length);
          if (marker === controlMarker) hideRemainder = true;
          else hideLine = true;
          continue;
        }
        if (isPartialPrefix(candidate, transportMarkers)) {
          if (final) {
            output += pending;
            pending = "";
          }
          break;
        }
      }
      const promptMarker = PROMPT_ECHO_MARKERS.find((marker) => pending.startsWith(marker));
      if (promptMarker) {
        suppressed = true;
        pending = "";
        break;
      }
      if (!final && isPartialPrefix(pending, PROMPT_ECHO_MARKERS)) break;
      if (pending.startsWith("<")) {
        const closeIndex = pending.indexOf(">");
        if (closeIndex < 0) {
          if (!final || hiddenTagPrefix.test(pending)) break;
        } else {
          const tag = pending.slice(0, closeIndex + 1);
          const match = tag.match(/^<\s*(\/?)\s*([A-Za-z0-9_]+)\b[^>]*>$/);
          const name = String(match?.[2] || "");
          if ((match && hiddenTagName.test(name)) || hiddenTagPrefix.test(tag)) {
            pending = pending.slice(closeIndex + 1);
            const closing = match?.[1] === "/";
            const selfClosing = /\/\s*>$/.test(tag);
            if (!closing && !selfClosing) hiddenTag = name.toLowerCase();
            continue;
          }
        }
      }
      const character = pending[0];
      pending = pending.slice(1);
      output += character;
      atLineStart = character === "\n";
    }
    return output;
  }

  return {
    push(value: unknown): string {
      pending += String(value || "");
      return drain(false);
    },
    finish(): string {
      return drain(true);
    },
    get promptEchoSuppressed(): boolean {
      return suppressed;
    },
  };
}

function maskToolBlocks(value: unknown): string {
  return String(value || "")
    .replace(TOOL_RESULT_BLOCK, (match) => " ".repeat(match.length))
    .replace(TOOL_RESULT_SELF, (match) => " ".repeat(match.length))
    .replace(TOOL_BLOCK, (match) => " ".repeat(match.length))
    .replace(TOOL_SELF_CLOSING, (match) => " ".repeat(match.length));
}

function controlMarkers(value: unknown): Array<{ start: number; jsonStart: number }> {
  const matches: Array<{ start: number; jsonStart: number }> = [];
  const text = maskToolBlocks(value);
  CONTROL_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTROL_MARKER.exec(text)) !== null) {
    matches.push({ start: match.index, jsonStart: CONTROL_MARKER.lastIndex });
  }
  CONTROL_MARKER.lastIndex = 0;
  return matches;
}

function normalizeControlEnvelope(value: unknown): {
  valid: boolean;
  error?: string;
  control?: CollaborationControl;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "control envelope must be a JSON object" };
  }
  const record = value as JsonRecord;
  const version = Number(record.version);
  if (version !== CONTROL_VERSION) {
    return { valid: false, error: `unsupported control version: ${record.version}` };
  }
  const executionEpoch = String(record.execution_epoch || "").trim();
  if (!executionEpoch) return { valid: false, error: "control execution_epoch is required" };
  const action = String(record.action || "").trim().toLowerCase();
  if (!CONTROL_ACTIONS.has(action)) {
    return { valid: false, error: `unsupported control action: ${action || "missing"}` };
  }
  const messageAcks: string[] = [];
  const rawMessageAcks = record.message_acks;
  if (rawMessageAcks !== undefined && !Array.isArray(rawMessageAcks)) {
    return { valid: false, error: "control message_acks must be an array" };
  }
  for (const item of Array.isArray(rawMessageAcks) ? rawMessageAcks : []) {
    const id = String(item || "").trim();
    if (id && !messageAcks.includes(id)) messageAcks.push(id);
  }
  if (Object.prototype.hasOwnProperty.call(record, "sender") ||
      Object.prototype.hasOwnProperty.call(record, "sender_agent_id") ||
      Object.prototype.hasOwnProperty.call(record, "source_agent_id")) {
    return { valid: false, error: "control envelope must not declare a sender" };
  }
  const rawOutboundMessages = record.outbound_messages;
  if (rawOutboundMessages !== undefined && !Array.isArray(rawOutboundMessages)) {
    return { valid: false, error: "control outbound_messages must be an array" };
  }
  const outboundMessageItems = Array.isArray(rawOutboundMessages) ? rawOutboundMessages : [];
  if (outboundMessageItems.length > MAX_OUTBOUND_MESSAGES) {
    return { valid: false, error: `control outbound_messages must contain at most ${MAX_OUTBOUND_MESSAGES} items` };
  }
  const outboundMessages: OutboundControlMessage[] = [];
  const outboundIds = new Set<string>();
  for (const item of outboundMessageItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { valid: false, error: "each outbound message must be a JSON object" };
    }
    const message = item as JsonRecord;
    const id = String(message.message_id || "").trim();
    const target = String(message.target || "").trim().toLowerCase();
    const agentId = String(message.agent_id || "").trim();
    const content = String(message.content || "").trim();
    if (!id || id.length > MAX_OUTBOUND_MESSAGE_ID_CHARS || !/^[\x20-\x7E]+$/.test(id)) {
      return { valid: false, error: `outbound message_id must contain 1-${MAX_OUTBOUND_MESSAGE_ID_CHARS} printable ASCII characters` };
    }
    if (Object.prototype.hasOwnProperty.call(message, "sender") ||
        Object.prototype.hasOwnProperty.call(message, "sender_agent_id") ||
        Object.prototype.hasOwnProperty.call(message, "source_agent_id")) {
      return { valid: false, error: "outbound messages must not declare a sender" };
    }
    if (outboundIds.has(id)) return { valid: false, error: `duplicate outbound message_id: ${id}` };
    if (!CONTROL_MESSAGE_TARGETS.has(target)) {
      return { valid: false, error: `unsupported outbound message target: ${target || "missing"}` };
    }
    if ((target === "agent") !== !!agentId) {
      return { valid: false, error: "outbound agent_id is required only when target is agent" };
    }
    if (!content || content.length > MAX_OUTBOUND_MESSAGE_CHARS) {
      return { valid: false, error: `outbound content must contain 1-${MAX_OUTBOUND_MESSAGE_CHARS} characters` };
    }
    outboundIds.add(id);
    outboundMessages.push({ id, target, agentId, content });
  }
  const error = String(record.error || "").trim();
  if (action === "fail" && !error) return { valid: false, error: "fail control requires error" };
  return {
    valid: true,
    control: {
      version,
      executionEpoch,
      action,
      messageAcks,
      outboundMessages,
      error,
    },
  };
}

export function parseControlEnvelope(raw: unknown): ParsedControlEnvelope {
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

export function stripControlEnvelopes(value: unknown): string {
  const text = String(value || "");
  const markers = controlMarkers(text);
  if (markers.length === 0) return text.trim();
  return text.slice(0, markers[0].start).trim().replace(/\n{3,}/g, "\n\n");
}

export function stripTransportControls(value: unknown): string {
  return stripMessageAcks(stripControlEnvelopes(value));
}

export function safePublicResult(value: unknown): string {
  const text = stripTransportControls(String(value || "")).trim();
  if (!text) return "";
  return looksLikePromptEcho(text) ? SUPPRESSED_PROMPT_ECHO_RESULT : text;
}

export function parseMessageAcks(raw: unknown): string[] {
  const ids = new Set<string>();
  const text = String(raw || "");
  MESSAGE_ACK_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
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

export function stripMessageAcks(value: unknown): string {
  MESSAGE_ACK_LINE.lastIndex = 0;
  const text = String(value || "").replace(MESSAGE_ACK_LINE, "").trim().replace(/\n{3,}/g, "\n\n");
  MESSAGE_ACK_LINE.lastIndex = 0;
  return text;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: unknown = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

export function sqliteLiteral(value: unknown): string {
  return `'${String(value || "").replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}