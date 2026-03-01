# Roadmap

Last Updated: 2026-02-28 | Version: 0.4.0

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

### Epic 8: Security & Authentication
API key validation, rate limiting, key masking, HMAC-based keys.

### Epic 9: Process Management & Operational Readiness
- `ProcessPool` — semaphore-based concurrency control with
  acquire/release, wait queue with timeout, tracked child
  processes, idempotent `drainAll()`, `destroy()` for cleanup
- `killWithEscalation()` — SIGTERM → SIGKILL escalation with
  unref'd timers for stuck process handling
- Stderr size limiting (1 MB) in both `spawnCli()` and
  direct `spawn()` streaming paths
- `OutputLimitError` (502) for stderr/stdout limit violations
- Secret scanner — regex-based credential redaction for
  Anthropic keys, OpenAI keys, Bearer tokens, AWS keys,
  PEM private key blocks in both streaming and non-streaming
- Stderr sanitizer — strips file paths, env vars, stack traces
  from error responses before sending to clients
- Per-request timeout with `killWithEscalation` on expiry
- Graceful shutdown — SIGTERM/SIGINT handlers, `drainAll()`,
  503 rejection of new requests during shutdown
- HTTP connection timeouts (headers, request, keep-alive)
- Health endpoint reports live pool capacity

## Architecture

```
Client → Fastify HTTP Server
           ├── onRequest hooks (X-Request-ID, CORS, shutdown guard)
           ├── onRequest hook: Auth middleware (API key validation)
           ├── onRequest hook: Rate limiter
           ├── onSend hook (security headers)
           ├── Route Handler
           │     ├── Mode Router (header inspection)
           │     ├── Backend Selection
           │     │     ├── OpenAI Passthrough
           │     │     └── Claude Code
           │     │          ├── Process Pool (acquire/release)
           │     │          ├── Session Manager (lock/unlock)
           │     │          ├── CLI Spawner (tracked, timeout)
           │     │          ├── Stream Transformer
           │     │          └── Secret Scanner (redaction)
           │     └── Response (JSON or SSE)
           └── Error Handler (OpenAI schema)
```
