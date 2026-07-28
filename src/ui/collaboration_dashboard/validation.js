"use strict";

function parseTargetPaths(text) {
  return Array.from(new Set(
    String(text || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function isAbsolutePath(value) {
  const path = String(value || "").trim();
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function normalizeForCompare(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWithinWorkspace(path, workspace) {
  const child = normalizeForCompare(path);
  const root = normalizeForCompare(workspace);
  if (!root) return true;
  const left = /^[A-Za-z]:\//.test(root) ? child.toLowerCase() : child;
  const right = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
  return left === right || left.startsWith(`${right}/`);
}

function validateCommon(input) {
  const errors = [];
  if (!String(input.task || "").trim()) errors.push("task_required");
  if (!["android", "linux"].includes(String(input.workspace_env || "android"))) errors.push("workspace_env_invalid");
  if (!["high", "normal", "low"].includes(String(input.priority || "normal"))) errors.push("priority_invalid");
  const timeout = Number(input.timeout_ms);
  if (!Number.isInteger(timeout) || timeout < 30000 || timeout > 3600000) errors.push("timeout_invalid");
  const maxTools = Number(input.max_tool_calls);
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 64) errors.push("max_tool_calls_invalid");
  return errors;
}

function validatePaths(input, paths) {
  const errors = [];
  if (input.read_only !== true && paths.length === 0) errors.push("write_paths_required");
  for (const path of paths) {
    if (!isAbsolutePath(path)) errors.push("path_not_absolute");
    if (input.workspace_path && !isWithinWorkspace(path, input.workspace_path)) errors.push("path_outside_workspace");
  }
  return Array.from(new Set(errors));
}

function validateSpawn(input) {
  const paths = input.read_only === true ? [] : parseTargetPaths(input.target_paths_text);
  const errors = [...validateCommon(input), ...validatePaths(input, paths)];
  if (input.workspace_path && !isAbsolutePath(input.workspace_path)) errors.push("workspace_not_absolute");
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), target_paths: paths };
}

function validateFollowup(input, currentAgent) {
  const errors = [];
  if (!String(input.task || "").trim()) errors.push("task_required");
  const mode = String(input.permission_mode || "readonly");
  if (!["inherit", "readonly", "write"].includes(mode)) errors.push("permission_mode_invalid");
  let targetPaths;
  let readOnly;
  if (mode === "readonly") {
    targetPaths = [];
    readOnly = true;
  } else if (mode === "write") {
    targetPaths = parseTargetPaths(input.target_paths_text);
    readOnly = false;
    if (input.workspace_path && !isAbsolutePath(input.workspace_path)) errors.push("workspace_not_absolute");
    if (!["android", "linux"].includes(String(input.workspace_env || "android"))) errors.push("workspace_env_invalid");
    errors.push(...validatePaths({ ...input, read_only: false }, targetPaths));
  } else {
    targetPaths = undefined;
    readOnly = undefined;
    if (!currentAgent) errors.push("agent_required");
  }
  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), target_paths: targetPaths, read_only: readOnly };
}

module.exports = {
  isAbsolutePath,
  isWithinWorkspace,
  parseTargetPaths,
  validateFollowup,
  validateSpawn,
};