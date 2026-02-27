# Data Flow

Last Updated: 2026-02-26 | Version: 0.3.0

## HTTP Request Lifecycle

```
Client HTTP Request
  │
  ├── onRequest hook: X-Request-ID (echo or generate UUID)
  ├── onRequest hook: CORS (if origin in allowlist)
  │
  ▼
Route Handler (POST /v1/chat/completions)
  │
  ├── 1. resolveMode(headers) → claude-code | openai-passthrough
  │     (error → ModeRouterError → error handler → 400)
  │
  ├── 2. Select backend from app decorations
  │
  ├── 3. Create AbortController + wire request.raw "close"
  │
  ├── 4. Build RequestContext (requestId, sessionId, apiKey, signal)
  │
  ▼
  ┌─── stream: false ────────────────────────────────┐
  │ backend.complete(body, context)                   │
  │   → BackendResult { response, headers }           │
  │   → reply.header(backendHeaders)                  │
  │   → reply.send(response)                          │
  └───────────────────────────────────────────────────┘
  ┌─── stream: true ─────────────────────────────────┐
  │ reply.raw.writeHead(200, SSE headers)  ◄── eager  │
  │ backend.completeStream(body, ctx, callbacks)      │
  │   onChunk → reply.raw.write("data: ...\n\n")     │
  │   onDone  → reply.raw.write("data: [DONE]\n\n")  │
  │             reply.raw.end()                       │
  │   onError → reply.raw.write("data: {error}\n\n") │
  │             reply.raw.write("data: [DONE]\n\n")   │
  │             reply.raw.end()                       │
  │ reply.hijack()                                    │
  └───────────────────────────────────────────────────┘
  │
  ▼
onSend hook: Security headers (nosniff, no-store, DENY, CSP)
```

## Error Handler Flow

```
Thrown Error
  │
  ▼
mapErrorToResponse(err)
  ├── PassthroughError  → preserve status + body
  ├── SessionError      → preserve status + body
  ├── ModeRouterError   → 400, enrich to OpenAI schema
  ├── ApiError          → preserve status + body
  ├── FST_ERR_CTP_INVALID_MEDIA_TYPE → 415
  ├── FST_ERR_CTP_BODY_TOO_LARGE    → 413
  ├── Fastify 400 errors             → 400
  └── Unknown                        → 500 internal_error
  │
  ▼
reply.raw.headersSent?
  ├── Yes → write SSE error event + [DONE], end stream
  └── No  → reply.status(status).send(body)
```

## Health Endpoint

```
GET /health
  │
  ├── claudeCodeBackend.healthCheck()
  ├── openaiPassthroughBackend.healthCheck()  (parallel)
  │
  ▼
  { status: "ready"|"unavailable",
    version: "0.3.0",
    checks: {
      claude_cli: "ok"|"error"|"disabled"|"missing"|"no_key",
      anthropic_key: "ok"|"missing",
      openai_passthrough: "ok"|"error"|"disabled"|"missing"|"no_key",
      capacity: { active: 0, max: N }
    }
  }
  → 200 if any backend ok, 503 if none
```

## Claude Code Streaming Pipeline

```
POST /v1/chat/completions (stream: true, X-Claude-Code: true)
  │
  ▼
Mode Router → selects ClaudeCodeBackend
  │
  ▼
ClaudeCodeBackend.completeStream()
  │
  ├── 1. Build CLI args (--output-format stream-json, -p prompt)
  ├── 2. Spawn child_process with sanitized env
  ├── 3. Wire AbortSignal → child.kill("SIGTERM")
  │
  ▼
stdout (NDJSON lines) ──► NdjsonLineBuffer.feed()
  │                         │
  │                    complete lines
  │                         │
  │                         ▼
  │                    StreamAdapter.processLine()
  │                         │
  │                    ┌────┴────────────────────────┐
  │                    │ Event Mapping                │
  │                    │                              │
  │                    │ system         → capture sid  │
  │                    │ content_block  → role chunk   │
  │                    │   _start (1st)   (assistant)  │
  │                    │ content_block  → skip         │
  │                    │   _start (2+)                 │
  │                    │ content_block  → content chunk│
  │                    │   _delta                      │
  │                    │ content_block  → skip         │
  │                    │   _stop                       │
  │                    │ message_delta  → finish chunk │
  │                    │ message_stop   → skip         │
  │                    │ result (ok)    → onDone()     │
  │                    │ result (error) → handleError()│
  │                    └──────────────────────────────┘
  │
  ▼
child "close" event
  ├── Flush remaining buffer
  ├── Non-zero exit → handleError()
  └── Zero exit, no result → fallback onDone()
```

## Callback Contract

| Callback  | When                        | Payload                  |
|-----------|-----------------------------|--------------------------|
| `onChunk` | Each OpenAI chunk           | JSON string (not SSE)    |
| `onDone`  | Stream completed normally   | headers + optional usage |
| `onError` | Mid-stream or CLI error     | OpenAI error object      |

**Double-callback guard**: `StreamAdapter` tracks a `done` flag.
Once `onDone` or `onError` fires, all subsequent calls are no-ops.

## Stop Reason Mapping

| Claude CLI        | OpenAI `finish_reason` |
|-------------------|------------------------|
| `end_turn`        | `"stop"`               |
| `max_tokens`      | `"length"`             |
| `null` / unknown  | `"stop"`               |

## Client Disconnect

```
Client closes connection
  → AbortController.abort()
    → signal fires "abort" event
      → child.kill("SIGTERM")
        → child exits (exitCode null)
          → close handler: no handleError (null exit)
            → listener cleanup
```
