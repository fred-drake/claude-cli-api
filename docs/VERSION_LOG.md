# Version Log

Last Updated: 2026-02-26

## v0.2.0 — Epic 5: Claude Code Streaming (2026-02-26)

### Added
- `src/transformers/stream.ts` — Stream transformer with:
  - `NdjsonLineBuffer`: partial line buffering for NDJSON stdout
  - `mapStopReason`: Claude → OpenAI stop reason mapping
  - `StreamAdapter`: stateful Claude CLI event → OpenAI chunk mapper
- `src/backends/claude-code.ts` — Claude Code backend with:
  - `completeStream()`: CLI spawning, NDJSON wiring, abort signal
  - `buildCliArgs()`: request → CLI argument construction
  - `buildSanitizedEnv()`: allowlisted environment for CLI child
- `tests/helpers/callbacks.ts` — shared `collectCallbacks()` helper
- `tests/unit/stream-transformer.test.ts` — 38 tests
- `tests/unit/stream-disconnect.test.ts` — 4 tests
- `tests/unit/claude-code-streaming.test.ts` — 9 tests
- New fixtures: `sampleMultiBlockNdjsonStream`,
  `sampleMaxTokensNdjsonStream`

### Changed
- `RequestContext.signal?: AbortSignal` added (non-breaking)
- `createStreamingMockChildProcess` delays exit/close by one tick
  to match real Node.js child_process `close` behavior
- `collectCallbacks()` extracted from passthrough test to shared helper

## v0.1.0 — Epics 1–3 (initial)

Project scaffold, mode router, OpenAI passthrough backend.
