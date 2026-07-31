"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { allowedActions, mergeAgents } = require("../dist/ui/collaboration_dashboard/model.js");
const { fingerprint, generateRequestId, markRequest, nextRequest } = require("../dist/ui/collaboration_dashboard/request-id.js");

test("dashboard operation matrix follows collaboration states", () => {
  assert.deepEqual(allowedActions("queued"), { message: true, wait: true, followup: false, interrupt: true });
  assert.deepEqual(allowedActions("summarizing"), { message: true, wait: true, followup: false, interrupt: true });
  assert.deepEqual(allowedActions("cancelling"), { message: false, wait: true, followup: false, interrupt: false });
  assert.deepEqual(allowedActions("completed"), { message: false, wait: false, followup: true, interrupt: false });
});

test("dashboard pagination merges by stable agent id", () => {
  assert.deepEqual(mergeAgents([{ id: "a", status: "queued" }], [
    { id: "a", status: "running" },
    { id: "b", status: "queued" },
  ]), [
    { id: "a", status: "running" },
    { id: "b", status: "queued" },
  ]);
});

test("request id entries are reused only for identical unresolved parameters", () => {
  assert.match(generateRequestId("spawn", 123, "abc"), /^ui:spawn:123:abc$/);
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  const first = nextRequest(null, "spawn", { task: "one" });
  assert.equal(nextRequest(first, "spawn", { task: "one" }), first);
  const changed = nextRequest(first, "spawn", { task: "two" });
  assert.notEqual(changed.requestId, first.requestId);
  const succeeded = markRequest(first, "succeeded");
  assert.notEqual(nextRequest(succeeded, "spawn", { task: "one" }).requestId, first.requestId);
});