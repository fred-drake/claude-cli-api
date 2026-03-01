# claude-cli-api

An OpenAI-compatible API server that routes requests to either OpenAI (or DeepSeek, or anything else that speaks the same protocol) or the Claude Code CLI. Your existing tools keep working unchanged. When you want Claude Code instead, add a header. That's the whole idea.

## Quick start

You'll need Node.js 22+, pnpm, and optionally the `claude` CLI if you want Claude Code mode.

```bash
# Clone and install
git clone https://github.com/fred-drake/claude-cli-api.git
cd claude-cli-api
pnpm install

# Start the server
OPENAI_API_KEY="sk-..." API_KEY="my-secret" pnpm dev
```

That's it. The server is now running on `http://localhost:3456`.

Try it out:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

This request goes straight through to OpenAI. To route it to Claude Code instead, add the `X-Claude-Code: true` header:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -H "X-Claude-Code: true" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

Same endpoint, same request format, different backend. The response comes back in OpenAI's format either way.

## How routing works

Every request to `/v1/chat/completions` gets inspected for two headers:

| Header | Effect |
|--------|--------|
| `X-Claude-Code: true` | Routes to the Claude Code CLI backend |
| `X-Claude-Session-ID: <uuid>` | Routes to Claude Code and resumes that session |

If neither header is present, the request passes through to OpenAI (or whatever compatible API you've configured).

## Sessions

Claude Code supports persistent sessions. When you send a request with `X-Claude-Code: true`, the response includes an `X-Claude-Session-ID` header. Pass that ID back in subsequent requests to continue the conversation:

```bash
# First request - starts a new session
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -H "X-Claude-Code: true" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Remember: my name is Alice"}]}'
# Response header: X-Claude-Session-ID: 550e8400-e29b-41d4-a716-446655440000

# Second request - resumes the session
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -H "X-Claude-Session-ID: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "What is my name?"}]}'
```

Sessions expire after 1 hour of inactivity (configurable) and have a maximum lifetime of 24 hours.

## Streaming

Pass `"stream": true` in the request body and you'll get Server-Sent Events back, matching OpenAI's streaming format:

```bash
curl -N http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Tell me a joke"}],
    "stream": true
  }'
```

This works with both backends.

## Client-provided OpenAI keys

If you want clients to bring their own OpenAI API keys rather than using the server's key, they can pass the `X-OpenAI-API-Key` header:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret" \
  -H "X-OpenAI-API-Key: sk-their-own-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

This can be disabled with `ALLOW_CLIENT_OPENAI_KEY=false`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check with backend status |

The health endpoint returns the status of both backends, the CLI availability, and current capacity:

```json
{
  "status": "ready",
  "checks": {
    "claude_cli": "ok",
    "anthropic_key": "ok",
    "openai_passthrough": "ok",
    "capacity": { "active": 2, "max": 10, "queued": 0 }
  }
}
```

## Configuration

All configuration is through environment variables. Nothing is required. The server starts up with defaults and disables whichever backends don't have keys set.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `LOG_LEVEL` | `info` | One of: fatal, error, warn, info, debug, trace, silent |
| `LOG_FORMAT` | `json` | `json` or `pretty` |
| `API_KEY` | — | API key for authenticating requests |
| `API_KEYS` | — | Comma-separated list of valid API keys (merged with `API_KEY`) |

### Claude Code backend

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required for Claude Code mode |
| `CLAUDE_PATH` | `claude` | Path to the `claude` CLI binary |
| `DEFAULT_MODEL` | `sonnet` | Default Claude model |
| `REQUEST_TIMEOUT_MS` | `300000` | Per-request timeout (5 minutes) |
| `SESSION_TTL_MS` | `3600000` | Session inactivity timeout (1 hour) |
| `MAX_SESSION_AGE_MS` | `86400000` | Maximum session lifetime (24 hours) |

### OpenAI passthrough

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Required for passthrough mode |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL (change for DeepSeek, etc.) |
| `OPENAI_PASSTHROUGH_ENABLED` | `true` | Enable/disable passthrough |
| `ALLOW_CLIENT_OPENAI_KEY` | `true` | Allow `X-OpenAI-API-Key` header |

### Rate limiting and concurrency

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_PER_IP` | `60` | Max requests per IP per window |
| `RATE_LIMIT_PER_SESSION` | `10` | Max requests per session per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |
| `MAX_CONCURRENT_PER_KEY` | `5` | Concurrent requests per API key |
| `MAX_CONCURRENT_PROCESSES` | `10` | Max parallel CLI processes |
| `POOL_QUEUE_TIMEOUT_MS` | `5000` | Queue wait timeout for CLI slot |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful shutdown wait |

### CORS

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated allowed origins |

## Using with DeepSeek (or other compatible APIs)

Point the OpenAI base URL at any OpenAI-compatible API:

```bash
OPENAI_API_KEY="sk-deepseek-..." \
OPENAI_BASE_URL="https://api.deepseek.com/v1" \
API_KEY="my-secret" \
pnpm dev
```

Requests without the Claude Code headers will now go to DeepSeek instead of OpenAI.

## Model mapping

When using Claude Code mode, OpenAI model names get mapped to Claude model names automatically. The response still echoes back the model name you requested, so your client code doesn't need to change.

| Requested Model | Claude Model |
|-----------------|-------------|
| `gpt-4o` | `sonnet` |
| `gpt-4o-mini` | `haiku` |
| `gpt-4` | `sonnet` |
| `gpt-3.5-turbo` | `haiku` |

You can also pass Claude model names directly (e.g., `sonnet`, `opus`, `haiku`).

## Response headers

The server adds a few useful headers to every response:

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Request tracking UUID (echoes your `X-Request-ID` or generates one) |
| `X-Backend-Mode` | Which backend handled the request (`openai-passthrough` or `claude-code`) |
| `X-Claude-Session-ID` | Session UUID (Claude Code mode) |
| `X-Claude-Session-Created` | `true` if a new session was created |
| `X-Claude-Ignored-Params` | Parameters that were accepted but not used by Claude Code |
| `X-RateLimit-*` | Rate limit status headers |

## Development

```bash
pnpm dev            # Watch mode server
pnpm preflight      # Full QA: lint + format check + typecheck + tests
pnpm test           # All tests
pnpm test:unit      # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:coverage  # Tests with coverage report
pnpm lint           # Lint with oxlint
pnpm typecheck      # TypeScript type checking
pnpm format:check   # Check formatting
```

### Building for production

```bash
pnpm build    # Compile TypeScript to dist/
pnpm start    # Run the compiled server
```

### E2E tests

The E2E test suite hits real API endpoints and costs real money. It needs three separate environment variable names (intentionally different from the server-facing ones to avoid conflicts):

```bash
OPENAI_KEY="sk-..." ANTHROPIC_KEY="sk-ant-..." DEEPSEEK_KEY="sk-..." pnpm test:e2e
```

The script spins up its own server instance on a random port and tears it down when done.

## Security

The server never calls `exec()` or uses `shell: true`. All CLI processes go through `spawn()` with argument arrays, and CI rejects any code that tries to sneak in shell execution.

The Claude CLI runs in a stripped-down environment. It only sees PATH, HOME, LANG, ANTHROPIC_API_KEY, and TERM=dumb. Nothing else from your shell leaks through.

Error output gets scrubbed before it leaves the server. Anthropic keys, OpenAI keys, AWS credentials, Bearer tokens, and PEM blocks are all redacted. File paths, environment variable references, and stack traces are stripped from stderr. Both stdout and stderr are capped at 1 MB per request.

Rate limiting runs on three levels: per-IP, per-session, and per-key concurrency, all using sliding window counters. Standard security headers (X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy, Cache-Control) are set on every response.

## License

MIT
