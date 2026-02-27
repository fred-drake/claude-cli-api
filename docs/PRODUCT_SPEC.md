# Product Specification: claude-cli-api

> Last Updated: 2026-02-25 | Version: 0.2.1 (Post-review amendments)
>
> Contributors: Architect, Software Engineer, DX Advocate, QA Lead,
> DevOps Engineer, Security Lead

---

## 1. Overview

**claude-cli-api** is a TypeScript REST API server that provides an
OpenAI-compatible Chat Completions interface with two operating modes:

1. **OpenAI Passthrough** (default) — forwards requests directly to the
   OpenAI API via the `openai` npm package. Acts as a transparent proxy.
2. **Claude Code** — spawns `claude` CLI processes to handle requests,
   with session persistence and Claude-specific features.

This dual-mode design enables the server to act as a **smart API router**:
existing OpenAI workflows work unchanged by default, while clients can
opt into Claude Code mode for session-persistent conversations powered by
the `claude` CLI.

### Goals

- **Drop-in compatibility** with OpenAI's Chat Completions API
- **Transparent OpenAI passthrough** by default — all models, all features
- **Opt-in Claude Code mode** via `X-Claude-Code` or `X-Claude-Session-ID`
  headers
- **Session persistence** across requests via `X-Claude-Session-ID` header
  (Claude Code mode)
- **Streaming support** via Server-Sent Events (SSE) in both modes
- **Backend strategy pattern** — clean extensibility for future backends

### Non-Goals

- Full OpenAI API coverage beyond Chat Completions (no Assistants,
  Embeddings, Fine-tuning, etc.)
- Function calling / tool use in Claude Code mode
- Vision / image inputs in Claude Code mode
- Multiple completions per request (`n > 1`) in Claude Code mode

---

## 2. System Architecture

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      HTTP Server (Fastify)                        │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ Auth Middleware │  │ Error Handler  │  │ Security Headers   │  │
│  └───────┬────────┘  └────────────────┘  └────────────────────┘  │
│          │                                                        │
│  ┌───────▼─────────────────────────────────────────────────────┐  │
│  │                    Route Handlers                            │  │
│  │  POST /v1/chat/completions                                  │  │
│  │  GET  /v1/models                                            │  │
│  │  GET  /health                                               │  │
│  └───────┬─────────────────────────────────────────────────────┘  │
│          │                                                        │
│  ┌───────▼─────────────────────────────────────────────────────┐  │
│  │                      Mode Router                             │  │
│  │                                                              │  │
│  │  Inspects: X-Claude-Code, X-Claude-Session-ID headers        │  │
│  │  Resolves: CLAUDE_CODE | OPENAI_PASSTHROUGH                  │  │
│  └───────┬──────────────────────────────┬──────────────────────┘  │
│          │                              │                         │
│          ▼                              ▼                         │
│  ┌──────────────────────┐    ┌───────────────────────────────┐   │
│  │  Claude Code Backend │    │  OpenAI Passthrough Backend   │   │
│  │                      │    │                               │   │
│  │  Request Transformer │    │  openai npm SDK client        │   │
│  │  Session Manager     │    │  (forwards request as-is)     │   │
│  │  Process Spawner     │    │                               │   │
│  │  Response Transformer│    │  Streaming: pipe SSE chunks   │   │
│  │  Stream Adapter      │    │  Errors: pass through as-is   │   │
│  │       │              │    │          │                     │   │
│  │       ▼              │    │          ▼                     │   │
│  │  claude CLI process  │    │  OpenAI API (api.openai.com)  │   │
│  └──────────────────────┘    └───────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Module Inventory

| Module | File | Responsibility |
|--------|------|---------------|
| Entry | `src/index.ts` | Bootstrap, startup validation |
| Server | `src/server.ts` | Fastify setup, route registration |
| Chat Route | `src/routes/chat-completions.ts` | POST /v1/chat/completions |
| Models Route | `src/routes/models.ts` | GET /v1/models |
| Health Route | `src/routes/health.ts` | GET /health |
| **Mode Router** | `src/services/mode-router.ts` | Header-based backend selection |
| **Backend Types** | `src/backends/types.ts` | `CompletionBackend` interface |
| **Claude Code Backend** | `src/backends/claude-code.ts` | Wraps CLI pipeline |
| **OpenAI Passthrough** | `src/backends/openai-passthrough.ts` | OpenAI SDK client |
| Request Transformer | `src/transformers/request.ts` | OpenAI request → CLI args |
| Response Transformer | `src/transformers/response.ts` | CLI output → OpenAI response |
| Stream Adapter | `src/transformers/stream.ts` | NDJSON → SSE assembly |
| Session Manager | `src/services/session-manager.ts` | Session lifecycle, mutex |
| Claude CLI Service | `src/services/claude-cli.ts` | Process spawning, cleanup |
| Model Mapper | `src/services/model-mapper.ts` | Model name resolution (Claude Code) |
| Error Handler | `src/errors/handler.ts` | Backend-aware error mapping |
| Types | `src/types/openai.ts` | OpenAI request/response types |
| Types | `src/types/claude-cli.ts` | Claude CLI output types |
| Config | `src/config.ts` | Env-based configuration |
| Auth Middleware | `src/middleware/auth.ts` | API key validation, timing-safe compare |
| Rate Limiter | `src/middleware/rate-limit.ts` | Per-IP, per-key, per-session limiting |

---

## 3. Mode Routing

### 3.1 Dual-Mode Design

Every request to `POST /v1/chat/completions` is routed to one of two
backends based on request headers. The default is OpenAI passthrough.

### 3.2 Mode Selection Logic

The mode router inspects headers in this priority order:

```
1. X-Claude-Code: false  → OPENAI_PASSTHROUGH (explicit override)
2. X-Claude-Code: true   → CLAUDE_CODE (explicit opt-in)
3. X-Claude-Session-ID present → CLAUDE_CODE (implicit opt-in)
4. Neither header         → OPENAI_PASSTHROUGH (default)
```

**Truthy values** for `X-Claude-Code`: `true`, `1`, `yes`, `True`, `YES`
(case-insensitive).

**Falsy values** for `X-Claude-Code`: `false`, `0`, `no`, `False`, `NO`
(case-insensitive).

**Invalid values**: If `X-Claude-Code` is present but not a recognized
truthy or falsy value (e.g., `"maybe"`, `"2"`), the server returns 400:
`{"error":{"message":"Invalid X-Claude-Code header value. Use true/1/yes
or false/0/no.","type":"invalid_request_error","code":"invalid_header_value"}}`

**Priority explanation**: `X-Claude-Code: false` takes highest priority so
clients can explicitly force passthrough even if a session ID is present.
This handles the case where a client library sends stale session headers.

### 3.3 Backend Strategy Interface

Both backends implement a common interface:

```typescript
export interface CompletionBackend {
  readonly name: BackendMode;

  complete(
    request: ChatCompletionRequest,
    context: RequestContext
  ): Promise<BackendResult>;

  completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks
  ): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
}

export interface BackendResult {
  response: ChatCompletionResponse;
  headers: Record<string, string>;
}

export interface BackendStreamCallbacks {
  onChunk: (chunk: string) => void;  // Raw JSON string; route handler wraps in SSE format
  onDone: (metadata: {
    headers: Record<string, string>;
    usage?: ChatCompletionUsage;
  }) => void;
  onError: (error: OpenAIError) => void;
}

export interface RequestContext {
  requestId: string;
  sessionId?: string;         // Only for Claude Code mode
  clientOpenAIKey?: string;   // Client's OpenAI key override
  apiKey?: string;            // For per-key rate limiting
  clientIp: string;
  method: string;
  path: string;
}
```

The route handler is backend-agnostic — it calls
`modeRouter.resolve(headers)` to get the backend, then delegates:

```typescript
const backend = modeRouter.resolve(request.headers);
if (request.body.stream) {
  await backend.completeStream(request.body, context, callbacks);
} else {
  const result = await backend.complete(request.body, context);
  reply.headers(result.headers).send(result.response);
}
```

---

## 4. API Specification

### 4.1 Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completion (dual-mode) |
| `/v1/models` | GET | List available models |
| `/health` | GET | Liveness / readiness check |

### 4.2 POST /v1/chat/completions

#### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | Must be `application/json` |
| `Authorization` | Conditional | `Bearer <key>` if server auth enabled |
| `X-Claude-Code` | No | `true`/`1`/`yes` to use Claude Code mode; `false`/`0`/`no` to force passthrough |
| `X-Claude-Session-ID` | No | UUID to resume a Claude Code session (implies Claude Code mode) |
| `X-OpenAI-API-Key` | No | Client-provided OpenAI key (overrides server default for passthrough) |

#### Request Body

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1024
}
```

#### Request Fields

| Field | Type | Required | Passthrough | Claude Code |
|-------|------|----------|-------------|-------------|
| `model` | string | Yes | Passed to OpenAI as-is | Mapped per §5.2 |
| `messages` | array | Yes | Passed to OpenAI as-is | Last user msg only (session handles history) |
| `stream` | boolean | No | Honored by OpenAI | Honored via `--output-format` |
| `temperature` | number | No | Honored by OpenAI | Accepted, ignored |
| `max_tokens` | integer | No | Honored by OpenAI | Accepted, ignored |
| `top_p` | number | No | Honored by OpenAI | Accepted, ignored |
| `stop` | string/array | No | Honored by OpenAI | Accepted, ignored |
| `tools` | array | No | Honored by OpenAI | Rejected with 400 |
| `tool_choice` | string/obj | No | Honored by OpenAI | Rejected with 400 |
| `response_format` | object | No | Honored by OpenAI | Rejected with 400 |
| `n` | integer | No | Honored by OpenAI | `n=1`: accepted, ignored. `n>1`: rejected with 400 |
| `seed` | integer | No | Honored by OpenAI | Accepted, ignored |
| `frequency_penalty` | number | No | Honored by OpenAI | Accepted, ignored |
| `presence_penalty` | number | No | Honored by OpenAI | Accepted, ignored |
| `functions` | array | No | Honored by OpenAI | Rejected with 400 |
| `function_call` | string/obj | No | Honored by OpenAI | Rejected with 400 |
| `logprobs` | boolean | No | Honored by OpenAI | Rejected with 400 |
| `top_logprobs` | integer | No | Honored by OpenAI | Rejected with 400 |
| `logit_bias` | object | No | Honored by OpenAI | Rejected with 400 |

**Key difference**: In passthrough mode, the full OpenAI feature set is
available (tools, function calling, structured output, etc.). In Claude Code
mode, only the subset listed in §5.4 is supported.

#### Response Headers (Always Present)

| Header | Value | Description |
|--------|-------|-------------|
| `X-Backend-Mode` | `claude-code` or `openai-passthrough` | Which backend handled the request |
| `X-Request-ID` | UUID | Unique request identifier |

#### Additional Response Headers (Claude Code Mode Only)

| Header | Value | Description |
|--------|-------|-------------|
| `X-Claude-Session-ID` | UUID | Session ID for this conversation |
| `X-Claude-Session-Created` | `true` | Only on first request (new session) |
| `X-Claude-Ignored-Params` | Comma-separated | Params accepted but not honored |

#### Non-Streaming Response (200)

```json
{
  "id": "chatcmpl-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "object": "chat.completion",
  "created": 1740500000,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 9,
    "total_tokens": 34
  }
}
```

#### Streaming Response (200)

Headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Backend-Mode: claude-code
X-Request-ID: <uuid>
```

Body (SSE):
```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1740500000,"model":"...","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1740500000,"model":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1740500000,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### 4.3 GET /v1/models

Lists Claude models that are available in Claude Code mode. In passthrough
mode, any valid OpenAI model name is accepted even if not listed here.

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-4-6",
      "object": "model",
      "created": 1700000000,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-sonnet-4-6",
      "object": "model",
      "created": 1700000000,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-haiku-4-5",
      "object": "model",
      "created": 1700000000,
      "owned_by": "anthropic"
    }
  ]
}
```

**Note**: This endpoint returns only Claude models available in Claude Code
mode. In passthrough mode, any valid OpenAI model name is accepted in
requests even if not listed here. To list OpenAI models, query the OpenAI
API directly. A future version may proxy to OpenAI's models endpoint when
passthrough is enabled.

### 4.4 GET /health

```json
{
  "status": "ready",
  "version": "0.2.0",
  "checks": {
    "claude_cli": "ok",
    "anthropic_key": "ok",
    "openai_passthrough": "ok",
    "capacity": { "active": 2, "max": 10 }
  }
}
```

- `claude_cli`: `"ok"` if claude binary is found, `"error"` otherwise
- `anthropic_key`: `"ok"` if `ANTHROPIC_API_KEY` is set and non-empty,
  `"missing"` otherwise. Claude Code mode requires this key.
- `openai_passthrough`: `"ok"` if `OPENAI_API_KEY` is configured or client
  keys are allowed, `"disabled"` if passthrough is disabled, `"no_key"` if
  no key source is available
- Returns 200 when at least one backend is functional, 503 otherwise

---

## 5. Backend: Claude Code

This section covers the Claude Code backend, activated when `X-Claude-Code`
is truthy or `X-Claude-Session-ID` is present.

### 5.1 How It Works

The Claude Code backend spawns `claude` CLI child processes to handle each
request. Claude CLI manages full conversation history in its session storage
(`~/.claude/` directory). The server translates between OpenAI request
format and claude CLI arguments/output.

**Key behavioral difference from OpenAI**: The client does NOT need to send
the full conversation history in every request. Only the latest user message
is forwarded. Claude CLI's session handles everything prior.

### 5.2 Model Mapping (Claude Code Only)

Model mapping applies only in Claude Code mode. In passthrough mode, model
names are forwarded to OpenAI unchanged.

| Input (from client) | Resolved Claude Model | Type |
|---------------------|----------------------|------|
| `claude-opus-4-6` | `claude-opus-4-6` | Native |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Native |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | Native |
| `opus` | `opus` | Short alias |
| `sonnet` | `sonnet` | Short alias |
| `haiku` | `haiku` | Short alias |
| `gpt-4` | `opus` | OpenAI alias |
| `gpt-4-turbo` | `sonnet` | OpenAI alias |
| `gpt-4o` | `sonnet` | OpenAI alias |
| `gpt-4o-mini` | `haiku` | OpenAI alias |
| `gpt-3.5-turbo` | `haiku` | OpenAI alias |
| `gpt-4-turbo-preview` | `sonnet` | OpenAI alias |
| `gpt-4-0125-preview` | `sonnet` | OpenAI alias |
| `gpt-4-1106-preview` | `sonnet` | OpenAI alias |
| `gpt-4o-2024-*` | `sonnet` | OpenAI alias (prefix match) |
| `gpt-4-turbo-2024-*` | `sonnet` | OpenAI alias (prefix match) |
| `gpt-3.5-turbo-*` | `haiku` | OpenAI alias (prefix match) |

**Prefix matching**: Model names with dated suffixes (e.g.,
`gpt-4o-2024-11-20`) are matched by prefix. The base model determines
the mapping.

**Unmapped models**: `o1`, `o1-mini`, `o1-preview`, `o3-mini` and other
reasoning models are not mapped. They return 400 with the list of valid
model names. These models have fundamentally different behavior that
doesn't map cleanly to Claude Code mode.

**Behavior**:
- The `model` field in the response echoes the **original requested name**.
- Unknown model names in Claude Code mode return `400` with an actionable
  error listing valid options.
- A `DEFAULT_MODEL` environment variable sets the fallback (default:
  `sonnet`).

**Session ID + GPT model name**: If a client sends `X-Claude-Session-ID`
with model `gpt-4`, the server enters Claude Code mode and remaps `gpt-4`
to `opus`. This is correct behavior — the session header implies Claude Code
intent.

### 5.3 Parameter Handling (Claude Code Only)

Three tiers for OpenAI parameters in Claude Code mode:

**Tier 1 — Supported**: `model`, `messages`, `stream` — fully honored.

**Tier 2 — Accepted, ignored**: `temperature`, `top_p`, `max_tokens`,
`stop`, `seed`, `frequency_penalty`, `presence_penalty` — accepted without
error. Server adds `X-Claude-Ignored-Params` response header listing them.

**Tier 3 — Rejected with error**: `tools`, `tool_choice`, `functions`,
`function_call`, `response_format`, `logprobs`, `top_logprobs`, `logit_bias`
— return 400. Error message explains what to remove and suggests using
passthrough mode or the direct Claude API.

**`n` parameter**: `n=1` or absent is Tier 2 (accepted, ignored — Claude
Code always produces exactly one completion). `n > 1` is Tier 3 (rejected
with 400).

**Note**: In passthrough mode, ALL parameters are forwarded to OpenAI as-is.
No tier system applies. OpenAI validates and honors them natively.

### 5.4 Session Management

#### How Sessions Work

Claude CLI manages full conversation history in its session storage. Our
server tracks session metadata in-memory for routing decisions.

#### Session Flow

```
1. Client sends request with X-Claude-Code: true (no session ID):
   → Server generates UUID via crypto.randomUUID()
   → Spawns: claude -p "prompt" --session-id <new-uuid> ...
   → Returns X-Claude-Session-ID: <new-uuid> in response

2. Client sends request with X-Claude-Session-ID: <uuid>:
   → Server validates UUID format
   → Spawns: claude -p "prompt" --resume <uuid> ...
   → If resume fails (session not found on disk), return 404:
     {"error":{"message":"Session <uuid> not found. The session may have
     expired or been deleted. Start a new session by omitting
     X-Claude-Session-ID or send the full conversation in
     messages.","type":"invalid_request_error","code":"session_not_found"}}
   → The client can then either: (a) start a new session by sending
     X-Claude-Code: true without a session ID, or (b) re-send the full
     conversation history in the messages array (server will use §5.5
     step 3 formatting for the new session).
   → Returns X-Claude-Session-ID: <uuid> in response

3. Client sends follow-up with the same session ID:
   → Same as step 2. Claude CLI remembers full conversation.
```

#### Session State Model

```typescript
interface SessionMetadata {
  id: string;           // UUID v4
  createdAt: number;    // epoch ms
  lastUsedAt: number;   // epoch ms, updated on each use
  model: string;        // model used in this session
  isActive: boolean;    // currently processing a request
}
```

Stored in an in-memory `Map<string, SessionMetadata>`. No database needed —
the actual session data lives in the claude CLI's own persistence.

#### Per-Session Mutex

Claude CLI does not support concurrent access to the same session. The server
enforces a per-session lock:

- If a session is busy (another request in flight), return 429 with:
  `{"error":{"message":"Session is busy. Wait for the current request to
  complete or start a new session.","type":"rate_limit_error",
  "code":"session_busy"}}`

#### Session Cleanup

- In-memory map entries expire after configurable TTL (default: 1 hour of
  inactivity).
- Claude CLI's own sessions persist on disk independently.
- On server restart, the map is empty but claude sessions still exist on
  disk. Clients can still resume — the server tries `--resume`, which
  succeeds if the session exists on disk.

### 5.5 Request Transformation: OpenAI → Claude CLI

**Algorithm**:

1. **Extract system messages** — concatenate all `system` role messages with
   `\n\n` separator into a single `--system-prompt` argument.

2. **Extract latest user message** — when a session ID is present (resume),
   only the last `user` message is sent as the prompt. Claude CLI's session
   handles prior context.

3. **First request (no session)** — if the messages array contains a
   multi-turn conversation, format all non-system messages into the prompt
   with role labels (`User:`, `Assistant:`).

4. **Map model name** — resolve to a claude CLI model identifier per §5.2.

5. **Build argument array** — assemble the full `string[]` for
   `child_process.spawn()`.

### 5.6 CLI Argument Construction

```
# New session (no resume)
claude -p "prompt text"
  --output-format json|stream-json
  --session-id <new-uuid>
  --model <model>
  --system-prompt "system text"   (if system messages present)
  --dangerously-skip-permissions
  --tools ""
  --verbose                       (if streaming)
  --include-partial-messages      (if streaming)

# Resume session
claude -p "latest user message"
  --output-format json|stream-json
  --resume <session-uuid>
  --model <model>
  --dangerously-skip-permissions
  --tools ""
  --verbose                       (if streaming)
  --include-partial-messages      (if streaming)
```

**Flags explained**:
- `--dangerously-skip-permissions` — required for non-interactive API mode.
- `--tools ""` — disables all Claude Code tools. Pure conversation only.
- `--verbose --include-partial-messages` — required for streaming to receive
  `content_block_delta` events with actual text tokens.

### 5.7 Response Transformation: Claude CLI → OpenAI

**Non-streaming** (`--output-format json`):

Claude CLI returns a JSON result object:
```json
{
  "type": "result",
  "result": "Hello! How can I help you?",
  "session_id": "abc-123",
  "is_error": false,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 9
  }
}
```

Mapped to OpenAI format:
- `id` → `"chatcmpl-"` + UUID
- `object` → `"chat.completion"`
- `created` → current Unix timestamp
- `model` → original requested model name
- `choices[0].message.content` → `result` field
- `choices[0].finish_reason` → `"stop"`
- If `is_error` is `true`, do NOT return a 200 chat completion. Instead,
  return an error response:
  - Exit code 0 + `is_error: true` → 500 with `code: "backend_error"`
  - The `result` field contains the error message from Claude CLI
- `usage.prompt_tokens` → `usage.input_tokens`
- `usage.completion_tokens` → `usage.output_tokens`
- `usage.total_tokens` → sum

### 5.8 Streaming Transformation: Claude stream-json → SSE

Claude CLI's `--output-format stream-json` emits newline-delimited JSON.
The stream adapter maps them to OpenAI SSE chunks:

| Claude Event | Action |
|---|---|
| `content_block_start` | Emit first chunk with `delta: { role: "assistant" }` |
| `content_block_delta` (text_delta) | Emit chunk with `delta: { content: text }` |
| `content_block_stop` | No action (wait for message_delta) |
| `message_delta` | Emit chunk with `finish_reason` based on `stop_reason` |
| `message_stop` | No action (wait for result) |
| `result` | Record usage/session info, call `onDone()` with headers |
| Other (system, tool_use) | Skip silently |

**`data: [DONE]` emission**: The route handler is solely responsible for
emitting `data: [DONE]\n\n`. Backends signal completion by calling
`callbacks.onDone()`. This prevents double-emission in passthrough mode
(where the OpenAI SDK stream already includes `[DONE]` — the passthrough
backend must NOT pipe this sentinel through `onChunk()`; instead it
detects the SDK stream end and calls `onDone()`).

**Stop reason mapping**:
- `end_turn` → `"stop"`
- `max_tokens` → `"length"`
- Everything else → `"stop"`

**Mid-stream error handling**: Once SSE headers (200) have been sent,
the HTTP status code cannot be changed. If an error occurs mid-stream
(CLI crash, timeout, unexpected output), the server emits an error
event before closing the stream:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"error":{"message":"Stream interrupted: <reason>","type":"server_error","code":"stream_error"}}

data: [DONE]
```

The error chunk uses the OpenAI error schema but is embedded in a `data:`
SSE line. Clients should check for the `error` key in each parsed chunk.
The stream always terminates with `data: [DONE]` even after errors.

---

## 6. Backend: OpenAI Passthrough

This section covers the OpenAI passthrough backend, which is the default
mode when no Claude Code headers are present.

### 6.1 How It Works

The passthrough backend uses the `openai` npm package to forward requests
directly to the OpenAI API. The server acts as a near-transparent proxy,
adding only response headers (`X-Backend-Mode`, `X-Request-ID`) and
enforcing server-level auth/rate-limiting.

### 6.2 Implementation

```typescript
import OpenAI from "openai";

class OpenAIPassthroughBackend implements CompletionBackend {
  readonly name = "openai-passthrough";
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async complete(request, context): Promise<BackendResult> {
    const response = await this.client.chat.completions.create({
      ...request,
      stream: false,
    });
    return {
      response,
      headers: { "X-Backend-Mode": "openai-passthrough" },
    };
  }

  async completeStream(request, context, callbacks): Promise<void> {
    const stream = await this.client.chat.completions.create({
      ...request,
      stream: true,
    });
    for await (const chunk of stream) {
      // onChunk receives raw JSON; the route handler (Epic 7) wraps
      // each chunk in SSE format (data: ...\n\n).
      callbacks.onChunk(JSON.stringify(chunk));
    }
    // SDK stream ends naturally — [DONE] is NOT piped through onChunk.
    // The route handler emits data: [DONE] after onDone().
    callbacks.onDone({
      headers: { "X-Backend-Mode": "openai-passthrough" },
      usage: lastUsage,  // from final chunk, if stream_options.include_usage
    });
  }
}
```

### 6.3 Why the `openai` npm Package

| Approach | Pros | Cons |
|----------|------|------|
| `openai` npm | Type-safe; handles auth, retries, error parsing; streaming built in | Adds a dependency |
| Raw HTTP fetch | Zero deps; full control | Manual SSE parsing, error handling, auth |
| Raw HTTP pipe | Maximum transparency | Cannot add headers, log, or handle errors |

The `openai` package is the right choice because:
- It speaks the exact protocol we need
- Streaming yields typed chunks we can pipe as SSE
- Errors are already in OpenAI format (no transformation)
- We need to add response headers, log, and enforce rate limits

### 6.4 No Transformation Needed

In passthrough mode:
- **Request body** is forwarded to OpenAI unchanged
- **Model names** are not mapped — sent to OpenAI as-is
- **All parameters** are honored by OpenAI natively (tools, temperature,
  response_format, etc.)
- **Streaming** chunks from OpenAI are already in SSE format — piped
  directly to the client
- **Errors** from OpenAI are returned to the client as-is (preserving
  HTTP status code and error body)

### 6.5 Authentication for Passthrough

The server needs an OpenAI API key for passthrough requests. Two sources:

1. **Server-side key** — `OPENAI_API_KEY` env var provides the default key.
   All passthrough requests use it unless overridden.

2. **Client-provided key** — optional `X-OpenAI-API-Key` header lets
   clients provide their own key per-request. This overrides the server
   default.

**Rules**:
- If neither source provides a key, passthrough returns 503:
  `"OpenAI passthrough is not configured. Set OPENAI_API_KEY on the server
  or provide X-OpenAI-API-Key header."`
- Client key override can be disabled via `ALLOW_CLIENT_OPENAI_KEY=false`
- The standard `Authorization` header authenticates the client to **our
  server** — it is never forwarded to OpenAI
- `X-OpenAI-API-Key` values must never be logged

**Security**: The `OPENAI_BASE_URL` is always server-configured. There
is no client header to override it. This prevents SSRF attacks where a
client could direct the server to send API keys to an arbitrary endpoint.

### 6.6 What Passthrough Does NOT Do

- No request validation beyond Content-Type — OpenAI validates the request
- No model name mapping — models pass through unchanged
- No session management — there is no Claude session in passthrough mode
- No `X-Claude-Session-ID` in response — not applicable

---

## 7. Process Management (Claude Code Only)

### 7.1 Spawning

All claude CLI processes are spawned with `child_process.spawn()` using
argument arrays (NEVER `exec()`). See Security §8 for details.

```typescript
const child = spawn(config.claudePath, args, {
  shell: false,                          // No shell interpretation
  env: buildSanitizedEnv(),              // Minimal env allowlist
  stdio: ["pipe", "pipe", "pipe"],       // Capture all I/O
});
```

### 7.2 Environment Sanitization

Child processes receive a minimal environment — NOT the server's full
`process.env`:

```typescript
function buildSanitizedEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    // CLAUDECODE is explicitly excluded — claude CLI refuses to run
    // inside another claude session. Our server may run under Claude
    // Code, so this must be stripped.
    // OPENAI_API_KEY is NOT included — only used by the Node.js
    // process for the passthrough backend, never by child processes.
  };
}
```

- `LANG` prevents encoding issues with non-ASCII/non-English content
- `TERM: "dumb"` explicitly signals non-interactive mode
- Warning logged if `HOME` falls back to `/tmp` (sessions may be lost)

### 7.3 Concurrency Control

A process pool limits concurrent `claude` CLI processes:

- **Default maximum**: 10 concurrent processes (configurable via
  `MAX_CONCURRENT_PROCESSES`)
- Requests exceeding the limit are queued briefly (configurable via
  `POOL_QUEUE_TIMEOUT_MS`, default: 5000ms)
- If no slot opens within the queue timeout, return 429 Too Many Requests
- Each process has a hard timeout (default: 5 minutes via
  `REQUEST_TIMEOUT_MS`)

Note: The process pool applies only to Claude Code mode. Passthrough
requests do not spawn child processes.

### 7.4 Process Lifecycle

| Event | Action |
|-------|--------|
| Client disconnects mid-stream | `child.kill('SIGTERM')` |
| Request timeout (5 min default) | `child.kill('SIGTERM')`, then `SIGKILL` after 5s |
| Process exits non-zero | Parse stderr, sanitize (strip file paths, env vars, stack traces), return generic OpenAI error. Full stderr logged server-side only. |
| Process exits zero | Collect output, transform response |
| Server shutdown (SIGTERM/SIGINT) | Kill all children, drain connections |
| Server in shutdown state | Refuse to spawn, return 503 |

The SIGKILL timer is cancelled if the process exits cleanly after
SIGTERM. Processes are `unref()`'d after SIGKILL and removed from the
`Set<ChildProcess>` via the `exit` event handler.

### 7.5 Graceful Shutdown

1. Stop accepting new requests
1.5. Set shutdown flag — new `spawn()` calls immediately return 503
2. Send SIGTERM to all active child processes
3. Wait up to `SHUTDOWN_TIMEOUT_MS` (default: 10s) for processes to exit
4. Force-kill remaining processes with SIGKILL
5. Exit

All active processes are tracked in a `Set<ChildProcess>` and cleaned up on
process exit or abort.

---

## 8. Security Model

The full security analysis is documented in `docs/SECURITY_MODEL.md`. Key
points summarized here, including passthrough-specific concerns.

### 8.1 Command Injection Prevention (Critical — Claude Code Only)

- **ALWAYS** use `child_process.spawn()` with argument arrays
- **NEVER** use `exec()`, `execSync()`, or `shell: true`
- CI grep check banning `exec`, `execSync`, and `shell: true` in source
  files. This is the primary enforcement mechanism. oxlint custom rules
  may provide additional compile-time checks if available.
- Session IDs validated as UUID v4 format before use
- Model names validated against an allowlist

### 8.2 Authentication

Authentication is **optional but recommended**:

- If `API_KEY` environment variable is set, all requests must include
  `Authorization: Bearer <key>` (applies to both modes)
- If `API_KEY` is not set, the server runs without auth (suitable for local
  development on localhost)
- Keys use the `sk-cca-` prefix to prevent accidental cross-use
- Multiple keys can be specified via `API_KEYS` (comma-separated)
- Key comparison uses `crypto.timingSafeEqual()` to prevent timing attacks
- If both `API_KEY` and `API_KEYS` are set, they are merged into a single
  set. `API_KEY` is treated as a single-item addition to the `API_KEYS`
  list. Duplicate values are deduplicated.

### 8.3 Rate Limiting

Rate limits apply equally to both backends:

| Layer | Default | Scope |
|-------|---------|-------|
| Per-IP request rate | 60/min | Connection-level |
| Per-key concurrency | 5 simultaneous | API key |
| Per-session request rate | 10/min | Session (Claude Code only) |
| Global process pool | 10 concurrent | Claude Code only |

**Implementation**: Rate limiting state is stored in-memory (per-process).
This is appropriate for single-instance deployments. Multi-instance
deployments behind a load balancer would need a shared store (e.g., Redis)
or sticky sessions. This is a known limitation for v0.2.0.

### 8.4 Input Validation

- Request body limit: 1 MB
- Messages array: max 100 items
- Content string: max 500,000 characters
- All validated fields use strict types (no `any`)
- Model field: max 256 characters
- `X-Claude-Session-ID` header: must be valid UUID v4 format, or 400
- `X-OpenAI-API-Key` header: max 256 characters
- Body size limit (1 MB) is the first validation gate and applies to
  both backends. Per-field limits are secondary checks within that budget.
- In Claude Code mode: Tier 3 params are rejected (§5.3)
- In passthrough mode: no parameter validation (OpenAI handles it)

### 8.5 Passthrough-Specific Security

| Threat | Severity | Mitigation |
|--------|----------|------------|
| OpenAI API key exposure via logs | High | Never log `X-OpenAI-API-Key` or `OPENAI_API_KEY` |
| Client exfiltrates key via error | Medium | Strip keys from all error responses |
| Passthrough bypasses rate limits | Low | Same rate limits regardless of mode |

### 8.6 Logging Security

- **Never log**: prompt content, response bodies, full API keys,
  `X-OpenAI-API-Key` header, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- **Always log**: request ID, session ID, backend mode, status code,
  duration, key prefix
- Structured JSON logging via Pino (Fastify's built-in logger)

---

## 9. Developer Experience

### 9.1 Drop-In Replacement (Passthrough Mode)

The simplest path — two environment variables, zero code changes:

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=not-needed
```

Existing OpenAI client code works immediately, with requests passing through
to the real OpenAI API.

**Note**: If the server has `API_KEY` configured, set `OPENAI_API_KEY`
to your server API key (with `sk-cca-` prefix) instead of `"not-needed"`.

### 9.2 Opting into Claude Code

Add one header to switch to Claude Code mode:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

# Passthrough to OpenAI (default)
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello from OpenAI!"}]
)

# Claude Code mode (explicit opt-in)
response = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "Hello from Claude!"}],
    extra_headers={"X-Claude-Code": "true"}
)
```

### 9.3 Multi-Turn Sessions with Claude Code

```python
# First message — creates a new Claude session
# Use with_raw_response to access response headers
raw = client.chat.completions.with_raw_response.create(
    model="sonnet",
    messages=[{"role": "user", "content": "My name is Alice"}],
    extra_headers={"X-Claude-Code": "true"}
)
response = raw.parse()
session_id = raw.headers.get("x-claude-session-id")

# Follow-up — Claude remembers the conversation
raw = client.chat.completions.with_raw_response.create(
    model="sonnet",
    messages=[{"role": "user", "content": "What's my name?"}],
    extra_headers={"X-Claude-Session-ID": session_id}
)
response = raw.parse()
# Response: "Your name is Alice."
```

**Important**: The standard `openai` SDK (both Python and Node.js)
does not expose response headers on the parsed response object. You
must use `with_raw_response` (Python) or access the raw response
(Node.js) to read custom headers like `X-Claude-Session-ID`.

**Node.js equivalent**:
```typescript
const raw = await client.chat.completions
  .create({ ... }, { headers: { "X-Claude-Code": "true" } })
  .__rawResponse;  // or use .withResponse()
```

**curl** (simplest approach for testing):
```bash
curl -sD- http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Claude-Code: true" \
  -d '{"model":"sonnet","messages":[...]}' \
  | grep -i x-claude-session-id
```

### 9.4 SDK Compatibility

| SDK | Language | Passthrough | Claude Code |
|-----|----------|-------------|-------------|
| `openai` (PyPI) | Python | Full | Via `extra_headers` |
| `openai` (npm) | Node/TS | Full | Via custom headers |
| `ruby-openai` | Ruby | Full | Via custom headers |
| `go-openai` | Go | Full | Via custom headers |
| curl / httpie | Any | Full | Via `-H` flag |
| LangChain | Python | Full | May need custom header support |
| Vercel AI SDK | TS | Full | Via custom headers |

**Passthrough mode** has full SDK compatibility — all OpenAI features work.

**Claude Code mode** breaks SDKs that use `tools`, `functions`,
`response_format`, or image content.

### 9.5 Response Header for Mode Detection

Every response includes `X-Backend-Mode`:

```bash
# Check which backend handled your request
curl -s -D- http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}' \
  | grep X-Backend-Mode

# X-Backend-Mode: openai-passthrough
```

### 9.6 Error Messages

Every error response matches OpenAI's error schema:

```json
{
  "error": {
    "message": "Human-readable explanation with actionable guidance",
    "type": "invalid_request_error",
    "param": "tools",
    "code": "unsupported_parameter"
  }
}
```

| Scenario | HTTP | type | code |
|----------|------|------|------|
| Missing required field | 400 | `invalid_request_error` | `missing_required_parameter` |
| Unsupported param in Claude Code | 400 | `invalid_request_error` | `unsupported_parameter` |
| Invalid model in Claude Code | 400 | `invalid_request_error` | `model_not_found` |
| Auth missing (when required) | 401 | `authentication_error` | `missing_api_key` |
| Claude CLI auth failure | 401 | `authentication_error` | `backend_auth_failed` |
| OpenAI auth failure (passthrough) | 401 | `authentication_error` | (from OpenAI) |
| Session busy | 429 | `rate_limit_error` | `session_busy` |
| Rate limited | 429 | `rate_limit_error` | `rate_limit_exceeded` |
| Claude Code at capacity | 429 | `rate_limit_error` | `capacity_exceeded` |
| OpenAI passthrough not configured | 503 | `server_error` | `passthrough_not_configured` |
| Claude CLI not found | 503 | `server_error` | `backend_unavailable` |
| Claude CLI crash | 500 | `server_error` | `internal_error` |
| Request timeout | 504 | `server_error` | `timeout` |
| Invalid `X-Claude-Code` header | 400 | `invalid_request_error` | `invalid_header_value` |
| Invalid session ID format | 400 | `invalid_request_error` | `invalid_session_id` |
| Session not found (resume failed) | 404 | `invalid_request_error` | `session_not_found` |
| Request body too large | 413 | `invalid_request_error` | `payload_too_large` |
| Wrong Content-Type | 415 | `invalid_request_error` | `unsupported_media_type` |
| Passthrough disabled | 503 | `server_error` | `passthrough_disabled` |
| Server shutting down | 503 | `server_error` | `server_shutting_down` |

**Passthrough errors** from OpenAI are returned as-is — same HTTP status,
same error body. No transformation.

### 9.7 Limitations (Claude Code Mode)

```
## What Works in Claude Code Mode
- Chat completions (single and multi-turn via session IDs)
- Streaming (SSE) and non-streaming responses
- Model selection (Claude native names + GPT aliases)
- System messages (forwarded as --system-prompt)
- Real token usage in response

## What Doesn't Work in Claude Code Mode
- Function calling / tool use
- Structured output / JSON mode
- Vision / image inputs
- Multiple completions (n > 1)
- temperature, top_p, stop (accepted but ignored — see
  `X-Claude-Ignored-Params` response header)

## Behavioral Differences from OpenAI (Claude Code Mode)
- Message history is managed server-side by Claude CLI. Only send
  the latest user message; prior messages are ignored when a session
  is active.
- Sessions do not survive server restarts by default (in-memory
  tracking), but claude CLI sessions persist on disk and can be
  resumed if the session ID is known.
- Response latency is higher than direct API calls due to subprocess
  overhead.

## Passthrough Mode
- Full OpenAI API compatibility — all features work as expected.
```

---

## 10. Configuration

All configuration via environment variables. No config file needed.

### 10.1 Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address (localhost by default) |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_FORMAT` | `json` | `json` for production, `pretty` for dev |
| `API_KEY` | (none) | If set, require this key for all requests |
| `API_KEYS` | (none) | Comma-separated list of valid API keys |
| `CORS_ALLOWED_ORIGINS` | (none) | Comma-separated CORS origins |

**Note**: If both `API_KEY` and `API_KEYS` are set, they are merged.
`API_KEY` is a convenience shorthand for single-key setups.

### 10.2 Claude Code Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (none) | **Required.** Anthropic API key for Claude CLI. Passed to child processes. |
| `CLAUDE_PATH` | `claude` | Path to claude CLI binary |
| `DEFAULT_MODEL` | `sonnet` | Default model for Claude Code mode |
| `REQUEST_TIMEOUT_MS` | `300000` | Max time per claude invocation (5 min) |
| `MAX_CONCURRENT_PROCESSES` | `10` | Max simultaneous claude processes |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period on server shutdown |
| `SESSION_TTL_MS` | `3600000` | Session inactivity timeout (1 hour) |
| `POOL_QUEUE_TIMEOUT_MS` | `5000` | Time to wait for a process pool slot (ms) |

### 10.3 OpenAI Passthrough Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (none) | Server-side OpenAI API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI API base URL (for Azure, proxies) |
| `OPENAI_PASSTHROUGH_ENABLED` | `true` | Set `false` to disable passthrough |
| `ALLOW_CLIENT_OPENAI_KEY` | `true` | Accept `X-OpenAI-API-Key` header |

**Note**: `OPENAI_API_KEY` and `OPENAI_BASE_URL` are used only by the
passthrough backend (the `openai` npm SDK in the Node.js process). They are
never passed to claude CLI child processes.

---

## 11. Data Flow

### 11.1 Mode Routing Flow

```
Client                    Server
  │                         │
  │  POST /v1/chat/         │
  │  completions            │
  │────────────────────────►│
  │                         │
  │                         │  1. Auth check (if configured)
  │                         │  2. Inspect headers:
  │                         │     X-Claude-Code? X-Claude-Session-ID?
  │                         │  3. Resolve backend mode
  │                         │
  │                         │  ┌─── CLAUDE_CODE ───┐
  │                         │  │  (see §11.2)      │
  │                         │  └───────────────────┘
  │                         │
  │                         │  ┌── OPENAI_PASSTHROUGH ──┐
  │                         │  │  (see §11.3)           │
  │                         │  └────────────────────────┘
```

### 11.2 Claude Code: Non-Streaming

```
Client                    Server                              claude CLI
  │                         │                                     │
  │  POST /v1/chat/         │                                     │
  │  X-Claude-Code: true    │                                     │
  │────────────────────────►│                                     │
  │                         │                                     │
  │                         │  1. Validate request body            │
  │                         │  2. Resolve session (new/resume)     │
  │                         │  3. Acquire process pool slot        │
  │                         │  4. Extract last user message        │
  │                         │  5. Map model, build CLI args        │
  │                         │                                     │
  │                         │  spawn: claude -p "msg"             │
  │                         │    --output-format json             │
  │                         │    --session-id|--resume <id>       │
  │                         │────────────────────────────────────►│
  │                         │                                     │
  │                         │         stdout: {JSON result}       │
  │                         │◄────────────────────────────────────│
  │                         │                                     │
  │                         │  6. Parse JSON, transform to OpenAI │
  │                         │  7. Release pool slot                │
  │                         │  8. Set session + mode headers       │
  │                         │                                     │
  │  200 + OpenAI JSON      │                                     │
  │  X-Backend-Mode:        │                                     │
  │    claude-code          │                                     │
  │◄────────────────────────│                                     │
```

### 11.3 OpenAI Passthrough: Non-Streaming

```
Client                    Server                              OpenAI API
  │                         │                                     │
  │  POST /v1/chat/         │                                     │
  │  (no Claude headers)    │                                     │
  │────────────────────────►│                                     │
  │                         │                                     │
  │                         │  1. Resolve OpenAI API key           │
  │                         │     (server default or client key)   │
  │                         │  2. Forward request via openai SDK   │
  │                         │                                     │
  │                         │  POST api.openai.com/v1/chat/...    │
  │                         │────────────────────────────────────►│
  │                         │                                     │
  │                         │         200 + JSON response          │
  │                         │◄────────────────────────────────────│
  │                         │                                     │
  │                         │  3. Add X-Backend-Mode header        │
  │                         │  4. Return response                  │
  │                         │                                     │
  │  200 + OpenAI JSON      │                                     │
  │  X-Backend-Mode:        │                                     │
  │    openai-passthrough   │                                     │
  │◄────────────────────────│                                     │
```

### 11.4 Streaming (Both Backends)

Both backends produce SSE output in the same format. The route handler
writes headers once, then delegates to the backend's `completeStream()`
which calls `onChunk()` for each SSE line.

The route handler writes each chunk to `reply.raw`. When the backend
calls `onDone()`, the handler emits `data: [DONE]\n\n` and closes the
stream. The handler is the sole owner of `[DONE]` emission — backends
must never emit it directly.

For passthrough, the `openai` SDK's stream termination signal is
detected by the async iterator completing (the `for await` loop ends).
The SDK's own `[DONE]` is consumed internally and NOT piped to the
client. The route handler emits its own `[DONE]` via `onDone()`.

- **Claude Code**: Transforms NDJSON from claude CLI into SSE chunks
- **Passthrough**: Iterates the `openai` SDK's async stream and pipes
  chunks directly (they're already in SSE format)

---

## 12. TypeScript Interfaces

### 12.1 Backend Types (`src/backends/types.ts`)

```typescript
export type BackendMode = "claude-code" | "openai-passthrough";

export interface CompletionBackend {
  readonly name: BackendMode;

  complete(
    request: ChatCompletionRequest,
    context: RequestContext
  ): Promise<BackendResult>;

  completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks
  ): Promise<void>;
}

export interface BackendResult {
  response: ChatCompletionResponse;
  headers: Record<string, string>;
}

export interface BackendStreamCallbacks {
  onChunk: (chunk: string) => void;
  onDone: (metadata: {
    headers: Record<string, string>;
    usage?: ChatCompletionUsage;
  }) => void;
  onError: (error: OpenAIError) => void;
}

export interface RequestContext {
  requestId: string;
  sessionId?: string;
  clientOpenAIKey?: string;
  clientIp: string;
  method: string;
  path: string;
}
```

### 12.2 OpenAI Types (`src/types/openai.ts`)

```typescript
export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  [key: string]: unknown;     // Allow passthrough of any OpenAI param
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[];
  // string for text content, array for multipart (images, etc.)
  // In Claude Code mode, only string content is supported.
  // In passthrough mode, array content is forwarded to OpenAI as-is.
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: "assistant"; content: string };
  finish_reason: "stop" | "length" | "content_filter";
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: { role?: "assistant"; content?: string };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}
```

### 12.3 Claude CLI Types (`src/types/claude-cli.ts`)

```typescript
export interface ClaudeCliResult {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  session_id: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface ClaudeCliStreamEvent {
  type: "stream_event";
  event:
    | { type: "content_block_start"; index: number;
        content_block: { type: "text"; text: string } }
    | { type: "content_block_delta"; index: number;
        delta: { type: "text_delta"; text: string } }
    | { type: "content_block_stop"; index: number }
    | { type: "message_delta";
        delta: { stop_reason: string | null };
        usage?: { output_tokens: number } }
    | { type: "message_stop" };
  session_id: string;
}

export interface ClaudeCliSystemMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
}

export type ClaudeCliMessage =
  | ClaudeCliSystemMessage
  | ClaudeCliStreamEvent
  | ClaudeCliResult
  | { type: string; [key: string]: unknown };
```

### 12.4 Internal Types

```typescript
interface BaseCliOptions {
  prompt: string;
  outputFormat: "json" | "stream-json";
  model: string;
  systemPrompt?: string;
}

type SessionStrategy =
  | { sessionId: string; resumeSessionId?: never }
  | { resumeSessionId: string; sessionId?: never }
  | { sessionId?: never; resumeSessionId?: never };

export type ClaudeCliOptions = BaseCliOptions & SessionStrategy;

export interface SessionMetadata {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
  isActive: boolean;
}

export interface ServerConfig {
  // Server
  port: number;
  host: string;
  logLevel: string;
  logFormat: "json" | "pretty";
  apiKeys: string[];
  corsOrigins: string[];

  // Claude Code
  claudePath: string;
  defaultModel: string;
  anthropicApiKey: string;
  requestTimeoutMs: number;
  maxConcurrentProcesses: number;
  poolQueueTimeoutMs: number;
  shutdownTimeoutMs: number;
  sessionTtlMs: number;

  // OpenAI Passthrough
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiPassthroughEnabled: boolean;
  allowClientOpenaiKey: boolean;
}
```

---

## 13. Infrastructure

### 13.1 Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 22 | LTS, ESM support, TypeScript strip |
| Language | TypeScript (strict) | Type safety, no `any` |
| HTTP Framework | Fastify | TypeScript-first, fast, built-in validation |
| Logging | Pino | Fastify-native, structured JSON |
| OpenAI Client | `openai` npm | Official SDK for passthrough backend |
| Package Manager | pnpm | Strict deps, fast installs |
| Test Framework | Vitest | ESM-native, fast, TDD watch mode |
| Linter | oxlint | 100x faster than ESLint |
| Formatter | Prettier | Industry standard |
| Module System | ESM | Modern, tree-shakeable |
| Dev Runner | `tsx` | TypeScript execution for dev server |

### 13.2 Project Structure

```
claude-cli-api/
├── src/
│   ├── index.ts                    # Entry point
│   ├── server.ts                   # Fastify setup
│   ├── config.ts                   # Env-based configuration
│   ├── backends/
│   │   ├── types.ts                # CompletionBackend interface
│   │   ├── claude-code.ts          # Claude CLI backend
│   │   └── openai-passthrough.ts   # OpenAI SDK backend
│   ├── routes/
│   │   ├── chat-completions.ts     # POST /v1/chat/completions
│   │   ├── models.ts               # GET /v1/models
│   │   └── health.ts               # GET /health
│   ├── services/
│   │   ├── mode-router.ts          # Header-based backend selection
│   │   ├── claude-cli.ts           # Process spawning
│   │   ├── session-manager.ts      # Session tracking + mutex
│   │   └── model-mapper.ts         # Model name resolution
│   ├── transformers/
│   │   ├── request.ts              # OpenAI → CLI args
│   │   ├── response.ts             # CLI output → OpenAI
│   │   └── stream.ts               # NDJSON → SSE
│   ├── errors/
│   │   └── handler.ts              # Backend-aware error mapping
│   └── types/
│       ├── openai.ts
│       └── claude-cli.ts
├── tests/
│   ├── unit/
│   │   ├── backends/
│   │   ├── services/
│   │   ├── transformers/
│   │   └── errors/
│   └── integration/
├── docs/
│   ├── PRODUCT_SPEC.md             # This file
│   └── SECURITY_MODEL.md           # Full security analysis
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── flake.nix
└── .envrc
```

### 13.3 Nix Flake

```nix
devShells = forAllSystems ({pkgs}: {
  default = pkgs.mkShell {
    packages = with pkgs; [
      nodejs_22
      pnpm
      typescript
      oxlint
      nodePackages.prettier
    ];
    shellHook = ''
      if ! command -v claude &>/dev/null; then
        echo "WARNING: 'claude' CLI not found on PATH"
        echo "Install: npm install -g @anthropic-ai/claude-code"
      fi
    '';
  };
});
```

`tsx` is installed via `pnpm` as a dev dependency, not via Nix.

### 13.4 npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/index.ts` | Dev server with hot reload |
| `build` | `tsc` | Compile to dist/ |
| `start` | `node dist/index.js` | Run production build |
| `test` | `vitest run` | Run tests once |
| `test:watch` | `vitest` | TDD watch mode |
| `test:coverage` | `vitest run --coverage` | Coverage report |
| `lint` | `oxlint src/` | Fast linting |
| `format` | `prettier --write 'src/**/*.ts'` | Format code |
| `format:check` | `prettier --check 'src/**/*.ts'` | Check formatting |
| `typecheck` | `tsc --noEmit` | Type check only |
| `clean` | `rm -rf dist/ .tsbuildinfo` | Remove build artifacts |
| `test:unit` | `vitest run tests/unit/` | Run unit tests only |
| `test:integration` | `vitest run tests/integration/` | Run integration tests only |
| `lint:fix` | `oxlint --fix src/` | Auto-fix lint issues |
| `preflight` | lint + format:check + typecheck + test | Full quality gate |

### 13.5 Build Configuration

**tsconfig.json**: Target ES2022, module NodeNext, strict mode, ESM output.

**package.json**: `"type": "module"`, engines `>=22.0.0`.

---

## 14. Testing Strategy

### 14.1 TDD Discipline

The project follows strict Red-Green-Refactor per
`.claude/tdd-guard/data/instructions.md`:
- One failing test at a time
- Minimal implementation to pass
- Refactor only when green
- Tests are the specification

### 14.2 Test Framework

Vitest with V8 coverage provider. Coverage thresholds: 90% lines, 85%
branches, 90% functions.

### 14.3 Mock Strategy

- **Claude Code**: Mock `child_process.spawn` to simulate the claude CLI
- **OpenAI Passthrough**: Mock the `openai` npm package via `vi.mock("openai")`
- **Integration tests**: Use Fastify's `inject()` for HTTP testing

Test fixtures include:
- Sample claude CLI JSON output (non-streaming)
- Sample claude CLI NDJSON stream (streaming)
- Sample OpenAI API responses (for passthrough mock)
- Error scenarios (non-zero exit, auth failure, timeout)
- Edge cases (empty response, very long response)

**Streaming mock utilities** (build in Phase 1):

*OpenAI SDK stream mock*: The `openai` SDK's `stream: true` returns an
async iterable (`Stream<ChatCompletionChunk>`). Mock with an async
generator:
```typescript
const mockStream = async function* () {
  yield { choices: [{ delta: { role: "assistant" }, ... }] };
  yield { choices: [{ delta: { content: "Hello" }, ... }] };
  yield { choices: [{ delta: {}, finish_reason: "stop", ... }] };
};
```

*Claude CLI spawn mock*: Return a mock `ChildProcess` with a readable
stdout that emits NDJSON lines. Build as a test utility early (Phase 1)
since both non-streaming and streaming tests depend on it.

### 14.4 TDD Execution Order

Build the system layer by layer:

```
Phase 1: Foundation
  1. Config loads env vars correctly
  2. Config merges API_KEY and API_KEYS
  3. Mode router: no headers → passthrough
  4. Mode router: X-Claude-Code: true → claude-code
  5. Mode router: X-Claude-Code: 1 → claude-code
  6. Mode router: X-Claude-Session-ID → claude-code
  7. Mode router: X-Claude-Code: false + session ID → passthrough
  8. Mode router: invalid X-Claude-Code value → 400

Phase 2: OpenAI Passthrough
  9. Passthrough: forwards request to OpenAI SDK
  10. Passthrough: returns OpenAI response as-is
  11. Passthrough: streaming pipes chunks directly
  12. Passthrough: streaming error from OpenAI
  13. Passthrough: OpenAI errors pass through
  14. Passthrough: uses server key by default
  15. Passthrough: client key override works
  16. Passthrough: no key → 503
  17. Passthrough: disabled via config → 503

Phase 3: Claude Code Pipeline
  18. Request validation — missing model → 400
  19. Request validation — missing messages → 400
  20. Request validation — Tier 3 params (tools) → 400
  21. Request validation — n > 1 → 400
  22. System message extraction → --system-prompt arg
  23. Request transformation — single user message → CLI args
  24. Request transformation — multi-turn first request formatting
  25. Model mapping — gpt-4 → opus
  26. Model mapping — unknown model → 400 with valid options
  27. Process spawning — spawn with correct args
  28. Response transformation — JSON output → OpenAI format
  29. Response transformation — is_error → error response (not 200)
  30. Integration — non-streaming happy path

Phase 4: Claude Code Streaming
  31. Streaming — content_block_start → role chunk
  32. Streaming — text delta → SSE content chunk
  33. Streaming — message_delta → finish_reason chunk
  34. Streaming — mid-stream error → SSE error event
  35. Streaming — client disconnect → SIGTERM child
  36. Integration — streaming happy path
  37. X-Claude-Ignored-Params header set correctly

Phase 5: Sessions
  38. No session → new session created
  39. Existing session → --resume used
  40. Session not found → 404 error (not silent new session)
  41. Session busy → 429
  42. Invalid session ID format → 400

Phase 6: Error Handling + Endpoints
  43. CLI not found → 503
  44. CLI exit non-zero → 500 (stderr sanitized)
  45. Request timeout → 504
  46. Process pool exhaustion → 429
  47. Health endpoint — both backends ok
  48. Health endpoint — one backend down
  49. Models endpoint — returns Claude model list
  50. Server shutting down → 503

Phase 7: Security + Auth
  51. Auth middleware — missing key → 401
  52. Auth middleware — wrong key → 401
  53. Auth middleware — valid key → pass
  54. Auth uses timing-safe comparison
  55. Command injection prevention
  56. Session ID sanitization
  57. Env sanitization (no OPENAI_API_KEY in child env, LANG present)
  58. Malformed JSON from Claude CLI → 500
```

### 14.5 Key Edge Cases

- Mode routing with contradictory headers
- Concurrent requests on same session → 429 (session busy)
- Client disconnect mid-stream → SIGTERM child process
- Claude CLI crashes mid-stream → SSE error event, stream closed
- Empty messages array → 400 error
- Very long prompt (>128KB) → pass via stdin, not argv
- Claude CLI not on PATH → 503 at request time
- Invalid session ID format → 400 before reaching CLI
- Server shutdown with active requests → graceful drain
- Passthrough with no OpenAI key → 503
- Passthrough with tools/functions → works (OpenAI handles it)
- Claude Code with tools/functions → 400 error
- Malformed JSON from Claude CLI (garbled stdout) → 500 with generic error
- CLI exits 0 but writes to stderr (warnings) → log warning, return success
- Multiple system messages in messages array → concatenated with \n\n
- Empty content in user message (`""`) → 400 error
- OpenAI API timeout in passthrough mode → error from SDK passed through
- Rapid session creation under load → in-memory Map bounded by TTL cleanup

---

## 15. Build Order (Critical Path)

```
Phase 1: Foundation
  ├── src/types/openai.ts
  ├── src/types/claude-cli.ts
  ├── src/config.ts
  ├── tests/helpers/ (mock utilities for spawn and OpenAI SDK)
  └── Project setup (package.json, tsconfig, vitest.config)

Phase 1.5: Backend Abstraction
  ├── src/backends/types.ts           (CompletionBackend interface)
  └── src/services/mode-router.ts     (header-based routing)

Phase 2: Claude Code Backend (including streaming)
  ├── src/backends/claude-code.ts
  ├── src/services/model-mapper.ts
  ├── src/transformers/request.ts
  ├── src/services/session-manager.ts
  ├── src/services/claude-cli.ts
  ├── src/transformers/response.ts
  └── src/transformers/stream.ts      (NDJSON → SSE)

Phase 2.5: OpenAI Passthrough Backend (including streaming)
  └── src/backends/openai-passthrough.ts  (parallel with Phase 2)

Phase 3: HTTP Layer
  ├── src/server.ts
  ├── src/routes/chat-completions.ts   (uses mode router + backends)
  ├── src/errors/handler.ts            (backend-aware)
  └── src/index.ts

Phase 4: Endpoints
  ├── src/routes/models.ts
  └── src/routes/health.ts             (dual backend health)

Phase 5: Operational
  ├── src/middleware/auth.ts            (API key auth)
  ├── src/middleware/rate-limit.ts      (all rate limit layers)
  ├── Process pool / concurrency control
  └── Graceful shutdown (with shutdown flag)
```

**Phases 2 and 2.5 can be developed in parallel** since they share only
the Phase 1.5 interface. This is by design.

---

## 16. Resolved Design Decisions

| Topic | Tension | Resolution |
|-------|---------|------------|
| **Default mode** | All-Claude vs passthrough default | **Passthrough default** — existing OpenAI workflows work unchanged. Opt-in to Claude Code via headers. |
| **OpenAI SDK vs raw HTTP** | Dependency weight vs convenience | **`openai` npm package** — typed, handles streaming/errors, speaks exact protocol. Worth the dependency. |
| **Passthrough auth** | Server key vs client key | **Both** — server-side `OPENAI_API_KEY` as default, optional client override via `X-OpenAI-API-Key`. |
| **Validation asymmetry** | Strict vs permissive | **Accept asymmetry** — Claude Code validates strictly, passthrough lets OpenAI validate. Different backends, different contracts. |
| **Model mapping scope** | Global vs backend-specific | **Backend-specific** — Claude Code maps `gpt-4` → `opus`. Passthrough sends `gpt-4` to OpenAI as-is. |
| Model mapping | Architect: passthrough only. DX: accept both. | **Accept both** in Claude Code mode. GPT aliases and Claude names. |
| System prompt flag | Architect: `--append-system-prompt`. Engineer: `--system-prompt`. | **`--system-prompt`** — client expects full control. |
| Unknown params | Security: reject. DX: accept and ignore. | **Accept and ignore** known-safe params in Claude Code. Reject correctness-breaking ones (tools, etc.). |
| Auth requirement | Security: mandatory. DX: optional. | **Optional** — if `API_KEY` env var is set, enforce it. Otherwise no auth. |
| Default port | DevOps: 3000. Others: 3456. | **3456** — avoids conflict with common dev servers. |
| Default host | Engineer: 0.0.0.0. Security: 127.0.0.1. | **127.0.0.1** — security default. Explicit opt-in to expose. |
| Child env | Engineer: inherit. Security: allowlist. | **Minimal allowlist** (PATH, HOME, ANTHROPIC_API_KEY). Never leak server secrets. |
| Session persistence | Engineer: off by default. User: required. | **Enable persistence** — sessions must persist for resume. |

---

## Appendix A: Getting Started

```bash
# Prerequisites
# 1. Node.js >= 22
# 2. claude CLI installed and authenticated (for Claude Code mode)
# 3. OpenAI API key (for passthrough mode)

# Clone and setup
git clone <repo>
cd claude-cli-api
pnpm install

# Configure
export OPENAI_API_KEY=sk-your-openai-key   # For passthrough mode

# Development
pnpm dev                    # Start dev server on localhost:3456

# Test passthrough mode (default)
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'

# Test Claude Code mode (opt-in)
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Claude-Code: true" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello!"}]}'

# Or use any OpenAI SDK — passthrough by default
export OPENAI_BASE_URL=http://localhost:3456/v1
# Your existing code now routes through the server
```

## Appendix B: Related Documents

- `docs/SECURITY_MODEL.md` — Full security threat model and mitigations
- `.claude/tdd-guard/data/instructions.md` — TDD discipline rules
