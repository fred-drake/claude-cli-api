# Data Flow

Last Updated: 2026-02-26 | Version: 0.2.0

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
