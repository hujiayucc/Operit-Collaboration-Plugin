"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

function javaProxy(path = "Java") {
  const callable = function () {};
  return new Proxy(callable, {
    get(_target, property) {
      if (property === "toString") return () => path;
      return javaProxy(`${path}.${String(property)}`);
    },
    apply() { return javaProxy(`${path}()`); },
    construct() { return {}; },
  });
}

global.Java = javaProxy();
global.Java.getApplicationContext = () => ({});

const handlers = new Map();
let promptHistoryHookRegistered = false;
let toolPromptHookRegistered = false;
let lifecycleRegistered = false;
global.ToolPkg = {
  ipc: {
    on(channel, handler) { handlers.set(channel, handler); },
  },
  registerPromptHistoryHook() { promptHistoryHookRegistered = true; },
  registerToolPromptComposeHook() { toolPromptHookRegistered = true; },
  registerAppLifecycleHook() { lifecycleRegistered = true; },
};

const main = require("../dist/main.js");

test("missing toolbox UI capability degrades without blocking core registration", () => {
  assert.equal(main.registerToolPkg(), true);
  assert.equal(main.dashboardUiStatus().registered, false);
  assert.match(main.dashboardUiStatus().registration_error, /unavailable/);
  assert.equal(promptHistoryHookRegistered, true);
  assert.equal(toolPromptHookRegistered, true);
  assert.equal(lifecycleRegistered, true);
  assert.equal(typeof handlers.get("collaboration.spawn_agent"), "function");
  assert.equal(typeof handlers.get("collaboration.inspect_agent"), "function");
  main.cancelAllRuns();
});