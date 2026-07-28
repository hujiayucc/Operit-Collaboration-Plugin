"use strict";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "interrupted_with_late_result",
  "timed_out",
  "orphaned",
]);

const ACTIVE_STATUSES = new Set(["queued", "running", "summarizing"]);

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

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  allowedActions,
  countSummary,
  isTerminal,
  mergeAgents,
  shortId,
  statusColor,
};