"use strict";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = stableValue(value[key]);
    }
    return output;
  }
  return value;
}

function fingerprint(payload) {
  return JSON.stringify(stableValue(payload || {}));
}

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

function generateRequestId(operation, timestamp = Date.now(), token = randomToken()) {
  return `ui:${String(operation || "operation")}:${timestamp}:${token}`;
}

function nextRequest(previous, operation, payload) {
  const nextFingerprint = fingerprint(payload);
  if (previous && previous.status !== "succeeded" && previous.fingerprint === nextFingerprint) {
    return previous;
  }
  return {
    requestId: generateRequestId(operation),
    fingerprint: nextFingerprint,
    status: "pending",
  };
}

function markRequest(entry, status) {
  return entry ? { ...entry, status } : null;
}

module.exports = {
  fingerprint,
  generateRequestId,
  markRequest,
  nextRequest,
  stableValue,
};