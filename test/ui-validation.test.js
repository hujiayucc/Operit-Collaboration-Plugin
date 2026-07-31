"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isAbsolutePath,
  isWithinWorkspace,
  parseTargetPaths,
  validateFollowup,
  validateSpawn,
} = require("../dist/ui/collaboration_dashboard/validation.js");

test("dashboard path parsing trims, filters and deduplicates", () => {
  assert.deepEqual(parseTargetPaths("/repo/src\n\n/repo/src\n/repo/test"), ["/repo/src", "/repo/test"]);
  assert.equal(isAbsolutePath("/repo/src"), true);
  assert.equal(isAbsolutePath("C:\\repo\\src"), true);
  assert.equal(isAbsolutePath("relative/src"), false);
  assert.equal(isWithinWorkspace("/repo/src/file.js", "/repo"), true);
  assert.equal(isWithinWorkspace("/repo-other/file.js", "/repo"), false);
});

test("spawn validation enforces explicit write paths", () => {
  const base = {
    task: "write",
    workspace_env: "android",
    priority: "normal",
    timeout_ms: 900000,
    max_tool_calls: 16,
    workspace_path: "/repo",
  };
  assert.equal(validateSpawn({ ...base, read_only: true, target_paths_text: "/other" }).valid, true);
  assert.equal(validateSpawn({ ...base, read_only: true, timeout_ms: 0, max_tool_calls: 0 }).valid, true);
  assert.equal(validateSpawn({ ...base, read_only: true, max_tool_calls: 64 }).valid, true);
  assert.match(validateSpawn({ ...base, read_only: true, max_tool_calls: 65 }).errors.join(","), /max_tool_calls_invalid/);
  assert.match(validateSpawn({ ...base, read_only: false, target_paths_text: "" }).errors.join(","), /write_paths_required/);
  assert.match(validateSpawn({ ...base, read_only: false, target_paths_text: "/other" }).errors.join(","), /path_outside_workspace/);
  const valid = validateSpawn({ ...base, read_only: false, target_paths_text: "/repo/src" });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.target_paths, ["/repo/src"]);
});

test("follow-up permission modes are explicit", () => {
  const agent = { read_only: false, target_paths: ["/repo/src"] };
  const inherit = validateFollowup({ task: "next", permission_mode: "inherit" }, agent);
  assert.equal(inherit.valid, true);
  assert.equal(inherit.target_paths, undefined);
  const readOnly = validateFollowup({ task: "next", permission_mode: "readonly" }, agent);
  assert.equal(readOnly.read_only, true);
  assert.deepEqual(readOnly.target_paths, []);
  const write = validateFollowup({
    task: "next",
    permission_mode: "write",
    target_paths_text: "/repo/src",
    workspace_path: "/repo",
    workspace_env: "android",
  }, agent);
  assert.equal(write.valid, true);
  assert.equal(write.read_only, false);
});