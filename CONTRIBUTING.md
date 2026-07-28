# Contributing

This guide covers development contributions to the Multi-Agent Collaboration Orchestrator. It focuses on code ownership, runtime contracts, validation, and packaging. User-facing behavior is documented in `README.md`.

## Project Structure

- `src/main.js`: main-runtime registration, IPC handlers, prompt-history capture, lifecycle diagnostics, and the Agent tool gateway.
- `src/protocol.js`: IPC channel names, parameter parsing, and host-compatible error envelopes.
- `src/collaboration/model.js`: Agent and Run data structures, validation, limits, public projections, and terminal-state rules.
- `src/collaboration/manager.js`: scheduling, task trees, messages, retries, checkpoints, action gates, recovery, interruption, and result publication.
- `src/collaboration/engine.js`: host AI calls, stream collection, system/task prompts, control parsing, summaries, and finalization handoff.
- `src/collaboration/helpers.js`: parsing, redaction, path handling, clipping, and shared result utilities.
- `src/collaboration/store.js`: SQLite Event Store schema v3, migrations, transactions, ledgers, and the explicit in-memory fallback.
- `src/packages/`: public ToolPkg metadata and wrappers for the six collaboration tools and seven probe/gateway tools.
- `src/ui/collaboration_dashboard/`: the native Compose DSL dashboard, main-runtime IPC client, validation, view models, components, and bilingual copy.
- `prompts/`: six source-only operating prompt templates. They are tested but are not packaged.
- `types/runtime.d.ts`: the ToolPkg host API surface used by this project.
- `test/`: unit, integration, persistence, recovery, metadata, packaging, probe, and UI regression tests.
- `scripts/build-toolpkg.js`: the reproducible ToolPkg builder and minified-stage verifier.

## Runtime Contracts

Treat the following behavior as compatibility-sensitive:

- Public tools, package exports, source `METADATA`, and `manifest.json` descriptions must agree.
- IPC names are centralized in `src/protocol.js`. Main-runtime handlers, package wrappers, and dashboard calls must stay aligned.
- Agent, Run, message, event, checkpoint, attempt, request-ledger, and side-effect-ledger behavior must preserve SQLite Event Store schema v3 semantics unless a tested atomic migration is included.
- SQLite failure is reported explicitly as `persistence: "memory"`; it must not be hidden as normal SQLite operation.
- `request_id` reuse is idempotent only for the same operation and identical normalized parameters. Conflicting reuse must remain an error.
- Execution epochs isolate recovery attempts, cancellation, and late model results. An old epoch must never advance the current Run.
- Parent-child relationships bind to an exact parent Run. A follow-up starts a new root Run.
- Declared write paths and `read_only` are scheduling and prompt constraints, not operating-system isolation.
- A `COLLABORATION_CONTROL` v1 envelope uses `progress`, `finish`, or `fail`; its `execution_epoch` and actual message acknowledgements must be validated.
- A tool-only checkpoint is repaired to `progress` and followed by a no-tool finalization checkpoint. The immediate tool-result handoff is complete, memory-only, consumed by that finalization flow, and excluded from persisted or public projections.
- `timeout_ms` is stream network-idle time: waiting for the first or next chunk may expire, while continuous generation has no total-duration deadline.
- Model retries cover transient failures only. Retries after a potentially executed tool must first verify the target state.
- The action gate filters tools at prompt composition. It is not a per-invocation operating-system guard and must not be described as one.
- Lifecycle diagnostics store names, identities, field names, and summaries, not complete tool arguments or result values.
- Summary and finalization chats expose no tools. Collaboration, probe, and gateway tools remain hidden from child Agents.
- The dashboard uses main-runtime IPC. It must not access SQLite directly, use a WebView, or implement permanent polling.

## Development Approach

1. Identify the behavioral contract and the module that owns it before editing code.
2. Make the smallest coherent change across that ownership boundary. Avoid unrelated refactors and silent fallback behavior.
3. Add a focused regression test that fails for the old behavior and verifies externally observable state, output, or events.
4. Update every synchronized surface affected by the change.
5. Run the focused tests first, then the complete suite.
6. Build the ToolPkg only after source tests pass, and verify the generated archive through the build script.

### Synchronization Rules

When changing a public collaboration or probe/gateway tool, review all of these surfaces:

- `manifest.json`
- The subpackage `METADATA` block and exported wrapper in `src/packages/`
- `src/protocol.js`
- Handler registration in `src/main.js`
- The collaboration manager operation
- Dashboard API, validation, forms, and result rendering where applicable
- English and Chinese descriptions
- Metadata, package, protocol, UI, and integration tests
- `README.md`, `README.zh-CN.md`, and relevant prompt templates

When changing runtime limits, status fields, settings, events, or controls, update the model, manager, persistence projections, public projections, dashboard copy/rendering, documentation, and tests together.

When changing fixed dashboard copy, keep `src/ui/collaboration_dashboard/i18n.js` and the host-required inline copy in `index.ui.js` synchronized. Preserve the standalone Compose DSL registration path.

When changing collaboration instructions or public tool semantics, review all six files under `prompts/`. Full, read-only, mini, Chinese, and English variants must describe the same ToolPkg contract at their intended level of detail.

When adding a runtime file, update `RUNTIME_FILES` in `scripts/build-toolpkg.js` and the packaging tests. Source-only prompts, tests, and contributor documentation should remain outside the archive unless runtime behavior genuinely requires them.

## Testing

The tests use Node's built-in test runner and project-local host stubs. There is no application Gradle build in this repository.

Use the narrowest relevant suite while developing:

- `test/collaboration-unit.test.js`: normalization, parsing, retry classification, gates, settings, and scheduler units.
- `test/collaboration.test.js`: end-to-end manager and engine behavior, controls, messages, retries, finalization, and task trees.
- `test/store.test.js`: schema v3, migrations, transactions, append-only data, requests, effects, and deletion.
- `test/recovery.test.js`: restart and attempt recovery behavior.
- `test/probe.test.js`: lifecycle observation, attribution, prompt composition, and gateway filtering.
- `test/metadata.test.js`, `test/package.test.js`, `test/build-toolpkg.test.js`: public metadata, wrappers, runtime file lists, prompt contracts, and packaging.
- `test/ui-*.test.js`: dashboard API, copy, validation, rendering, registration, and interaction behavior.
- `test/integration.test.js`: main runtime, subpackage, and host-service integration.

Check each changed JavaScript file with Node, then run the full suite:

```bash
node --check src/collaboration/engine.js
node --check src/collaboration/manager.js
node --check src/main.js
node --test test/*.test.js
```

Adjust the `node --check` file list to match the files changed. The complete test count is expected to evolve; success is defined by zero failures, not a fixed count.

Tests should be deterministic, close all managers and stores they create, release held asynchronous work, and verify both Run state and any real side effect. A successful Agent Run does not substitute for checking a modified file or persisted projection.

## Packaging

Build from the project root:

```bash
node scripts/build-toolpkg.js
```

If the expected archive already exists, the no-argument command reports a skipped result and exits successfully without replacing it. To rebuild after validation:

```bash
node scripts/build-toolpkg.js --replace
```

The builder:

- stages the explicit runtime file list;
- minifies every packaged JavaScript file with pinned `terser@5.31.6`;
- requires each minified JavaScript file to be exactly one non-empty line;
- syntax-checks the staged JavaScript;
- runs the full test suite against the minified stage;
- verifies that source JavaScript was not modified;
- writes the archive and reports its size, entry count, and SHA-256.

Do not edit the generated `.toolpkg` directly. Fix source files or the runtime manifest and rebuild it.

## Contribution Checklist

Before presenting a development contribution, confirm that:

- the change belongs to the modules edited and does not broaden unrelated behavior;
- public metadata, exports, IPC, UI, prompts, and documentation are synchronized where applicable;
- persistence and execution-epoch behavior remain explicit and tested;
- sensitive tool payloads and transient finalization handoffs are not added to persistent or public state;
- focused regression tests and the complete suite pass;
- changed JavaScript files pass syntax checks;
- a packaging-related change passes the minified-stage build;
- user-visible behavior is documented accurately in both supported UI languages where applicable.