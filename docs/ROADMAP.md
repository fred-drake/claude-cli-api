# Roadmap

Last Updated: 2026-02-26 | Version: 0.3.0

## Completed Epics

### Epic 1: Project Scaffold
Full build toolchain, types, config, health endpoint, CI.

### Epic 2: Mode Router & Backend Abstraction
Header-driven routing (`X-Claude-Code`, `X-Claude-Session-ID`),
`CompletionBackend` interface, `BackendStreamCallbacks` contract.

### Epic 3: OpenAI Passthrough Backend
Full non-streaming and streaming passthrough to OpenAI API
with key management, error mapping, and usage tracking.

### Epic 5: Claude Code Streaming
Stream transformer pipeline for Claude CLI NDJSON output:
- `NdjsonLineBuffer` — partial line buffering across chunks
- `StreamAdapter` — stateful event mapper (Claude → OpenAI chunks)
- `ClaudeCodeBackend.completeStream()` — CLI spawning with
  NDJSON wiring, abort signal, and `close` event finalization
- Client disconnect → `SIGTERM` child process cancellation
- Mid-stream error handling with finish chunk + error callback

### Epic 6: Session Management
Session persistence with TTL/max-age eviction, periodic cleanup.
- `SessionManager` with `resolve()`, `release()`, `destroy()`
- `SessionError` class for session-related failures
- `X-Claude-Session-ID` header handling for session resumption

### Epic 7: HTTP Server & Route Integration
Fastify HTTP server integrating all components:
- `POST /v1/chat/completions` — streaming + non-streaming
- `GET /v1/models` — static Claude model list
- `GET /health` — backend health checks per §4.4 schema
- Centralized error handler mapping all error types to
  OpenAI-compatible JSON schema
- CORS hooks (configurable origin allowlist)
- Security headers (`nosniff`, `no-store`, `DENY`, CSP)
- `X-Request-ID` generation/echo
- SSE streaming with eager header write and `data: [DONE]`
- AbortController for client disconnect detection
- 1 MB body limit

## In Progress

### Epic 4: Claude Code Non-Streaming
Model mapper, request transformer, CLI spawning, response
transformer for non-streaming `complete()`.

## Planned

### Epic 8: Auth Middleware
API key validation, rate limiting.

### Epic 9: Process Pool
Concurrency management, graceful shutdown.

## Architecture

```
Client → Fastify HTTP Server
           ├── onRequest hooks (X-Request-ID, CORS)
           ├── onSend hook (security headers)
           ├── Route Handler
           │     ├── Mode Router (header inspection)
           │     ├── Backend Selection
           │     │     ├── OpenAI Passthrough
           │     │     └── Claude Code
           │     │          ├── Session Manager
           │     │          ├── CLI Spawner
           │     │          └── Stream Transformer
           │     └── Response (JSON or SSE)
           └── Error Handler (OpenAI schema)
```
