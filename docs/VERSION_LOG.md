# Version Log

Last Updated: 2026-02-26

## v0.3.0 — Epics 6 & 7: Session Management + HTTP Server (2026-02-26)

### Added
- `src/errors/handler.ts` — Centralized error handler with:
  - `ModeRouterError`, `ApiError` classes
  - `mapErrorToResponse()`: maps all error types to OpenAI schema
  - `registerErrorHandler()`: Fastify `setErrorHandler` integration
  - Handles streaming errors (headersSent check for SSE)
- `src/routes/chat-completions.ts` — POST /v1/chat/completions with:
  - Mode-based backend dispatch (claude-code / openai-passthrough)
  - SSE streaming with eager header write
  - AbortController for client disconnect detection
  - `data: [DONE]` termination, `reply.hijack()` for raw ownership
- `src/routes/models.ts` — GET /v1/models (static Claude model list)
- `tests/unit/error-handler.test.ts` — 19 tests covering all error paths
- `tests/integration/chat-completions.test.ts` — 30 tests (routing,
  streaming, CORS, request context, error handling)
- `tests/integration/models.test.ts` — 8 tests (model list, headers)

### Changed
- `src/server.ts` — Major rewrite:
  - Backend instantiation (OpenAIPassthroughBackend + ClaudeCodeBackend)
  - Session manager lifecycle (decorate + onClose cleanup)
  - CORS hooks (configurable origin allowlist, preflight handling)
  - Security headers onSend hook (nosniff, no-store, DENY, CSP)
  - X-Request-ID onRequest hook (echo or generate UUID)
  - 1 MB body limit (§8.4)
  - Centralized error handler registration
- `src/routes/health.ts` — Rewritten for §4.4 schema:
  - Real `healthCheck()` calls to both backends
  - `version`, `checks` (claude_cli, anthropic_key,
    openai_passthrough, capacity) response structure
  - 200 if any backend ok, 503 if none
- `src/types/fastify.d.ts` — Added `claudeCodeBackend` and
  `openaiPassthroughBackend` to FastifyInstance declaration
- `tests/integration/health.test.ts` — 11 tests (rewritten for §4.4)
- `vitest.config.ts` — Exclude `.direnv/**` from test discovery

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
