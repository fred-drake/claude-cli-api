# TASKS.md — Epics & Task Breakdown

> Last Updated: 2026-02-25 | Source: `docs/PRODUCT_SPEC.md` v0.2.1
>
> Each epic has a **demo-able deliverable** that can be explained and
> shown end-to-end. Tasks follow strict TDD (Red-Green-Refactor).
>
> **Review status**: Revised after full team review (Architect,
> Engineer, QA Lead, Security Lead, DevOps, DX Advocate).

---

## Team Roster

| Role | Shorthand | Responsibility |
|------|-----------|----------------|
| **Architect** | `ARCH` | Interfaces, backend abstraction, module boundaries |
| **Software Engineer** | `ENG` | Core implementation, all services and backends |
| **QA Lead** | `QA` | Test infrastructure, TDD enforcement, fixtures |
| **Security Lead** | `SEC` | Auth, validation, injection prevention, env sanitization |
| **DevOps Engineer** | `OPS` | Build config, Nix flake, scripts, CI pipeline |
| **DX Advocate** | `DX` | Error messages, SDK examples, developer docs |

---

## Epic 1: Project Scaffold

**Deliverable**: `pnpm dev` starts a Fastify server on `:3456`,
`pnpm test` runs Vitest with zero tests, `GET /health` returns
`{"status":"ready"}`. The Nix flake provides a reproducible dev shell.
CI pipeline runs `pnpm preflight` on every push.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 1.1 | Create `package.json` with `"type": "module"`, engines `>=22.0.0`, pnpm, all npm scripts from §13.4. Include `preflight` script: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` | `OPS` | §13.4 |
| 1.2 | Create `tsconfig.json` — target ES2022, module NodeNext, strict mode, ESM | `OPS` | §13.5 |
| 1.3 | Create `vitest.config.ts` — V8 coverage provider, 90% lines / 85% branches / 90% functions thresholds | `QA` | §14.2 |
| 1.4 | Update `flake.nix` — Node.js 22, pnpm, typescript, oxlint, prettier in dev shell; add `shellHook` for claude CLI presence check per §13.3 | `OPS` | §13.3 |
| 1.5 | Create `src/types/openai.ts` — all OpenAI request/response interfaces from §12.2. Include optional `usage?: ChatCompletionUsage` on `ChatCompletionChunk` and `stream_options?: { include_usage?: boolean }` on `ChatCompletionRequest` for streaming usage support | `ARCH` | §12.2, §5.8 |
| 1.6 | Create `src/types/claude-cli.ts` — all Claude CLI output types from §12.3 | `ARCH` | §12.3 |
| 1.7 | Create `src/config.ts` — load all env vars from §10.1–10.3, typed `ServerConfig` from §12.4. Validate constraints: `PORT` 1-65535, `LOG_LEVEL` valid Pino level, `MAX_CONCURRENT_PROCESSES` > 0 | `ENG` | §10, §12.4 |
| 1.8 | Tests: config loads defaults, merges `API_KEY`+`API_KEYS`, validates types, rejects invalid PORT/LOG_LEVEL | `QA` | §10, §14.4 #1-2 |
| 1.9 | Create `tests/helpers/` — mock utilities for `child_process.spawn` (mock ChildProcess with readable stdout/stderr) and OpenAI SDK async iterable stream mock | `QA` | §14.3 |
| 1.10 | Create `tests/helpers/fixtures.ts` and `tests/fixtures/` — sample CLI JSON output, NDJSON stream data, OpenAI API responses, error scenarios per §14.3 | `QA` | §14.3 |
| 1.11 | Create `tests/helpers/fastify.ts` — shared Fastify `inject()` helper for integration tests, `expectOpenAIError()` assertion helper for §9.6 error schema validation | `QA` | §14.3 |
| 1.12 | Create `tests/helpers/timers.ts` — `vi.useFakeTimers()` patterns for TTL cleanup and request timeout tests | `QA` | §14.3 |
| 1.13 | Create minimal `src/server.ts` — Fastify instance with Pino logger, no routes yet | `ENG` | §2.2 |
| 1.14 | Create `src/index.ts` — bootstrap, startup validation, listen on `HOST:PORT` | `ENG` | §2.2 |
| 1.15 | Create stub `src/routes/health.ts` — `GET /health` returns `{"status":"ready"}` | `ENG` | §4.4 |
| 1.16 | Create CI pipeline config (GitHub Actions) — run `pnpm preflight`, enforce coverage thresholds, run banned-pattern checks, Node.js 22 | `OPS` | §13.4, §14.2, §8.1 |
| 1.17 | Add `pnpm audit` to CI pipeline — fail on high/critical vulnerabilities | `OPS` | SECURITY §14.3 |

**Exit criteria**: Server starts, health endpoint responds, test suite
runs (green with initial config tests), `pnpm lint` and
`pnpm format:check` pass. CI pipeline runs on push.

---

## Epic 2: Mode Router & Backend Abstraction

**Deliverable**: Given any combination of `X-Claude-Code` and
`X-Claude-Session-ID` headers, the mode router correctly resolves to
`CLAUDE_CODE` or `OPENAI_PASSTHROUGH`. Demo by showing unit tests for
all 8 header combinations from §3.2.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 2.0 | Establish config injection pattern — `app.decorate("config", config)` with `FastifyInstance` declaration merging for type-safe config access in all routes and services. Deferred from Epic 1 per architect review (P1-4): premature when only the health stub existed, needed now that services consume config | `ARCH` | §2.2 |
| 2.1 | Create `src/backends/types.ts` — `CompletionBackend` (with `healthCheck(): Promise<HealthStatus>` method), `BackendResult`, `BackendStreamCallbacks` (with `onDone: (metadata: { headers: Record<string, string>; usage?: ChatCompletionUsage }) => void`), `RequestContext` (with `apiKey?: string` for rate limiting) | `ARCH` | §3.3, §12.1 |
| 2.2 | Create `src/services/mode-router.ts` — header inspection, priority logic from §3.2 | `ENG` | §3.2 |
| 2.3 | Test: no headers → `OPENAI_PASSTHROUGH` | `QA` | §14.4 #3 |
| 2.4 | Test: `X-Claude-Code: true` → `CLAUDE_CODE` | `QA` | §14.4 #4 |
| 2.5 | Test: `X-Claude-Code: 1` → `CLAUDE_CODE` (all truthy variants) | `QA` | §14.4 #5 |
| 2.6 | Test: `X-Claude-Session-ID` present → `CLAUDE_CODE` | `QA` | §14.4 #6 |
| 2.7 | Test: `X-Claude-Code: false` + session ID → `OPENAI_PASSTHROUGH` | `QA` | §14.4 #7 |
| 2.8 | Test: invalid `X-Claude-Code` value (e.g., `"maybe"`) → 400 error | `QA` | §14.4 #8 |
| 2.9 | Test: no Claude headers + `OPENAI_PASSTHROUGH_ENABLED=false` → router still resolves to `OPENAI_PASSTHROUGH` (backend returns 503, not router) | `QA` | §3.2 |

**Exit criteria**: `mode-router.ts` has 100% branch coverage. All
routing scenarios pass. Interface types compile with no errors.

---

## Epic 3: OpenAI Passthrough Backend

**Deliverable**: Send a chat completion request to the server with no
Claude headers — it proxies to OpenAI and returns the response.
Streaming works via SSE. Client can override OpenAI key via header.
Demo with `curl` hitting the server and getting a real OpenAI response.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 3.1 | Create `src/backends/openai-passthrough.ts` — implements `CompletionBackend`, wraps `openai` npm SDK | `ENG` | §6.2 |
| 3.2 | Implement `complete()` — forward request to OpenAI, return response as-is | `ENG` | §6.2, §6.4 |
| 3.3 | Implement `completeStream()` — iterate async stream, pipe chunks via `onChunk()`, call `onDone()` (never emit `[DONE]`) | `ENG` | §6.2, §5.8 |
| 3.4 | Implement OpenAI key resolution — server default vs client `X-OpenAI-API-Key` override. Create per-request `OpenAI` client when client provides key (SDK sets key at construction) | `ENG` | §6.5 |
| 3.5 | Implement `healthCheck()` — verify OpenAI key availability and passthrough enabled status | `ENG` | §4.4 |
| 3.6 | Test: non-streaming forwards request and returns OpenAI response | `QA` | §14.4 #9-10 |
| 3.7 | Test: streaming pipes chunks directly, `[DONE]` not emitted by backend | `QA` | §14.4 #11 |
| 3.8 | Test: streaming error from OpenAI propagates | `QA` | §14.4 #12 |
| 3.9 | Test: OpenAI SDK error passes through as-is (preserving status + body) | `QA` | §14.4 #13 |
| 3.10 | Test: uses server `OPENAI_API_KEY` by default | `QA` | §14.4 #14 |
| 3.11 | Test: client `X-OpenAI-API-Key` overrides server key (per-request client created) | `QA` | §14.4 #15 |
| 3.12 | Test: `ALLOW_CLIENT_OPENAI_KEY=false` + client `X-OpenAI-API-Key` header → key ignored, server key used | `QA` | §6.5 |
| 3.13 | Test: no key available → 503 `passthrough_not_configured` | `QA` | §14.4 #16 |
| 3.14 | Test: `OPENAI_PASSTHROUGH_ENABLED=false` → 503 `passthrough_disabled` | `QA` | §14.4 #17 |
| 3.15 | Test: passthrough with `tools` param → forwarded to OpenAI (NOT rejected, unlike Claude Code mode) | `QA` | §14.5 |
| 3.16 | Test: OpenAI SDK connection/timeout error → error passed through with original status | `QA` | §14.5 |
| 3.17 | Integration test: passthrough non-streaming happy path via Fastify `inject()` | `QA` | §14.5 |
| 3.18 | Integration test: passthrough streaming happy path via Fastify `inject()` | `QA` | §14.5 |
| 3.19 | Verify `X-OpenAI-API-Key` values are never logged | `SEC` | §8.5 |
| 3.20 | Verify no client header can override `OPENAI_BASE_URL` (SSRF prevention) | `SEC` | §6.5 |

**Exit criteria**: All passthrough tests green. Non-streaming and
streaming both work against the mocked OpenAI SDK. Error passthrough
verified. Client key override and disable both tested. No API keys
appear in logs.

---

## Epic 4: Claude Code Backend — Non-Streaming

**Deliverable**: Send `POST /v1/chat/completions` with
`X-Claude-Code: true` and `model: "gpt-4o"` — the server maps the
model to `sonnet`, spawns `claude` CLI, and returns an
OpenAI-compatible JSON response. Demo with a curl request showing the
full round-trip.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 4.1 | Create `src/services/model-mapper.ts` — full mapping table from §5.2, prefix matching, default model | `ENG` | §5.2 |
| 4.2 | Test: `gpt-4` → `opus`, `gpt-4o` → `sonnet`, `gpt-3.5-turbo` → `haiku` | `QA` | §14.4 #25 |
| 4.3 | Test: `gpt-4o-2024-11-20` prefix match → `sonnet` | `QA` | §5.2 |
| 4.4 | Test: unknown model (`o1`) → 400 with valid options list | `QA` | §14.4 #26 |
| 4.5 | Create `src/transformers/request.ts` — OpenAI request → CLI args (§5.5, §5.6) | `ENG` | §5.5, §5.6 |
| 4.6 | Test: single system message extraction → `--system-prompt` arg | `QA` | §14.4 #22 |
| 4.7 | Test: multiple system messages → concatenated with `\n\n` separator in `--system-prompt` | `QA` | §14.5 |
| 4.8 | Test: single user message → prompt text in CLI args | `QA` | §14.4 #23 |
| 4.9 | Test: multi-turn first request → formatted with `User:`/`Assistant:` labels | `QA` | §14.4 #24 |
| 4.10 | Implement parameter validation — Tier 1 (supported), Tier 2 (accepted/ignored), Tier 3 (rejected) | `ENG` | §5.3 |
| 4.11 | Test: Tier 3 param `tools` present → 400 `unsupported_parameter` | `QA` | §14.4 #20 |
| 4.12 | Test: `n > 1` → 400 rejected | `QA` | §14.4 #21 |
| 4.13 | Test: `n=1` → accepted (Tier 2), appears in `X-Claude-Ignored-Params` | `QA` | §5.3 |
| 4.14 | Test: missing `model` → 400 | `QA` | §14.4 #18 |
| 4.15 | Test: missing `messages` → 400 | `QA` | §14.4 #19 |
| 4.16 | Test: empty `messages: []` → 400 | `QA` | §14.5 |
| 4.17 | Test: empty user message content `""` → 400 | `QA` | §14.5 |
| 4.18 | Implement CLI argument array construction from `ClaudeCliOptions` (pure function) | `ENG` | §5.6 |
| 4.19 | Implement `buildSanitizedEnv()` — minimal env allowlist (pure function) | `ENG` | §7.2 |
| 4.20 | Implement `src/services/claude-cli.ts` — process spawning with `child_process.spawn()`, stdout/stderr collection, exit code handling | `ENG` | §7.1 |
| 4.21 | Implement long prompt stdin delivery — prompts >128KB piped via stdin instead of argv | `ENG` | §14.5 |
| 4.22 | Test: spawn uses correct args for new session (§5.6) | `QA` | §14.4 #27 |
| 4.23 | Test: spawn uses `--resume` for existing session | `QA` | §5.6 |
| 4.24 | Test: env sanitization — allowlisted vars present (`PATH`, `HOME`, `LANG`, `TERM=dumb`, `ANTHROPIC_API_KEY`), `OPENAI_API_KEY` absent, `CLAUDECODE` excluded | `QA` | §14.4 #57 |
| 4.25 | Test: env sanitization negative — arbitrary env var (e.g., `SECRET_TOKEN`) does NOT leak to child | `QA` | SECURITY §7.2 |
| 4.26 | Test: `HOME` fallback to `/tmp` → warning logged | `QA` | §7.2 |
| 4.27 | Test: long prompt >128KB → piped via stdin, not argv | `QA` | §14.5 |
| 4.28 | Create `src/transformers/response.ts` — CLI JSON result → OpenAI `ChatCompletionResponse` (§5.7) | `ENG` | §5.7 |
| 4.29 | Test: successful result → 200 with correct field mapping (`id`, `usage`, `model` echo) | `QA` | §14.4 #28 |
| 4.30 | Test: `is_error: true` → 500 `internal_error` (not 200) | `QA` | §14.4 #29, §9.6 |
| 4.31 | Test: Claude CLI auth failure (Anthropic key invalid) → 401 `backend_auth_failed` | `QA` | §9.6 |
| 4.32 | Create `src/backends/claude-code.ts` — non-streaming `complete()` orchestration: model-mapper → request-transformer → session-manager → claude-cli → response-transformer | `ENG` | §2.2 |
| 4.33 | Implement `healthCheck()` on Claude Code backend — check CLI binary and Anthropic key | `ENG` | §4.4 |
| 4.34 | Test: `X-Claude-Ignored-Params` header set for Tier 2 params | `QA` | §14.4 #37 |
| 4.35 | Integration test: non-streaming happy path end-to-end (mocked CLI) | `QA` | §14.4 #30 |

**Exit criteria**: Full non-streaming pipeline works with mocked
`claude` CLI. Model mapping, request transform, process spawn, response
transform all individually tested. Long prompt stdin works. Integration
test passes.

---

## Epic 5: Claude Code Streaming

**Deliverable**: Send a streaming request with `"stream": true` and
`X-Claude-Code: true` — the server returns SSE chunks in OpenAI format,
token by token. Demo by showing real-time SSE output with `curl`.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 5.1 | Create `src/transformers/stream.ts` — line-buffered NDJSON parser for stdout (handle split lines across chunk boundaries) + SSE adapter per §5.8 event mapping table | `ENG` | §5.8 |
| 5.2 | Test: `content_block_start` → emit chunk with `delta: { role: "assistant" }` | `QA` | §14.4 #31 |
| 5.3 | Test: `content_block_delta` (text_delta) → SSE chunk with `delta: { content: text }` | `QA` | §14.4 #32 |
| 5.4 | Test: `message_delta` → chunk with `finish_reason` (stop reason mapping: `end_turn` → `"stop"`, `max_tokens` → `"length"`) | `QA` | §14.4 #33, §5.8 |
| 5.5 | Test: `result` event → record usage/session, call `onDone()` | `QA` | §5.8 |
| 5.6 | Test: `content_block_stop` and `message_stop` events → silently skipped (no output) | `QA` | §5.8 |
| 5.7 | Test: `system` and `tool_use` events → skip silently | `QA` | §5.8 |
| 5.8 | Test: second `content_block_start` (multiple content blocks) → do NOT re-emit role chunk | `QA` | §5.8 |
| 5.9 | Test: partial NDJSON lines split across stdout chunks → buffered and parsed correctly | `QA` | §5.8 |
| 5.10 | Test: empty/whitespace-only lines in NDJSON stream → skipped silently | `QA` | §5.8 |
| 5.11 | Implement mid-stream error handling — SSE error event before closing stream (§5.8) | `ENG` | §5.8 |
| 5.12 | Test: CLI crash mid-stream → SSE error event + `[DONE]` | `QA` | §14.4 #34 |
| 5.13 | Implement client disconnect → `SIGTERM` child process | `ENG` | §7.4 |
| 5.14 | Test: client disconnect → child receives SIGTERM | `QA` | §14.4 #35 |
| 5.15 | Wire streaming into `claude-code.ts` backend `completeStream()` | `ENG` | §5.8 |
| 5.16 | Integration test: streaming happy path end-to-end (mocked CLI NDJSON output) | `QA` | §14.4 #36 |

**Exit criteria**: All streaming event types mapped correctly. NDJSON
line buffering handles split chunks. Mid-stream errors produce valid
SSE error events. Client disconnect kills child. Integration test
passes with realistic NDJSON fixture.

---

## Epic 6: Session Management

**Deliverable**: First request creates a session and returns
`X-Claude-Session-ID`. Follow-up requests with that session ID resume
the conversation. Concurrent requests on the same session return 429.
Sessions are scoped to the authenticated client. Demo a multi-turn
conversation via `curl`.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 6.1 | Create `src/services/session-manager.ts` — in-memory `Map<string, SessionMetadata>`, create/get/update/lock/cleanup. Sessions scoped to client identity (API key) | `ENG` | §5.4, §12.4, SECURITY §4.2 |
| 6.2 | Implement session creation — generate UUID via `crypto.randomUUID()`, store metadata with client identity binding | `ENG` | §5.4 |
| 6.3 | Implement session resume — validate UUID format, verify client owns session, look up metadata, set `--resume` flag | `ENG` | §5.4, SECURITY §4.2 |
| 6.4 | Implement per-session mutex — reject concurrent requests with 429 `session_busy` | `ENG` | §5.4 |
| 6.5 | Implement TTL cleanup — expire entries after `SESSION_TTL_MS` of inactivity | `ENG` | §5.4 |
| 6.6 | Implement max session age — 24-hour hard cap regardless of activity | `ENG` | SECURITY §4.3 |
| 6.7 | Test: no session ID → new session created, `X-Claude-Session-ID` returned | `QA` | §14.4 #38 |
| 6.8 | Test: existing session → `--resume` used in CLI args | `QA` | §14.4 #39 |
| 6.9 | Test: session not found on disk (resume fails) → 404 `session_not_found` | `QA` | §14.4 #40 |
| 6.10 | Test: session busy (concurrent request) → 429 `session_busy` | `QA` | §14.4 #41 |
| 6.11 | Test: invalid session ID format (not UUID v4) → 400 `invalid_session_id` | `QA` | §14.4 #42 |
| 6.12 | Test: `X-Claude-Session-Created: true` header only on first request | `QA` | §4.2 |
| 6.13 | Test: client A cannot access client B's session → 404 (session isolation) | `QA` | SECURITY §4.2 |
| 6.14 | Test: expired sessions cleaned up after `SESSION_TTL_MS` | `QA` | §5.4 |
| 6.15 | Test: session exceeding 24-hour max age → rejected even if recently active | `QA` | SECURITY §4.3 |

**Exit criteria**: Sessions create, resume, and lock correctly.
Client-scoped isolation enforced. TTL and max-age cleanup verified.
All error paths tested.

---

## Epic 7: HTTP Server & Route Integration

**Deliverable**: All three endpoints work (`/v1/chat/completions`,
`/v1/models`, `/health`). The chat completions route is fully
backend-agnostic — it delegates to whichever backend the mode router
selects. Demo by sending requests to all endpoints and showing both
passthrough and Claude Code responses with correct headers.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 7.1 | Finalize `src/server.ts` — Fastify instance + Pino logger + body limit (1 MB) | `ENG` | §2.2, §8.4 |
| 7.2 | Configure CORS + register all routes on Fastify instance | `ENG` | §2.2 |
| 7.3 | Add security headers: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: no-referrer` | `SEC` | SECURITY §9.2 |
| 7.4 | Create `src/routes/chat-completions.ts` — backend-agnostic handler per §3.3 pseudocode | `ENG` | §4.2, §3.3 |
| 7.5 | Non-streaming path: call `backend.complete()`, set headers, send response | `ENG` | §3.3 |
| 7.6 | Streaming path: write SSE headers, call `backend.completeStream()`, emit `data: [DONE]` after `onDone()` | `ENG` | §5.8, §11.4 |
| 7.7 | Set `X-Backend-Mode` and `X-Request-ID` on every response | `ENG` | §4.2 |
| 7.8 | Create `src/errors/handler.ts` — backend-aware error mapping to OpenAI error schema (§9.6 table) | `ENG` | §9.6 |
| 7.9 | Finalize `src/routes/health.ts` — use `backend.healthCheck()` for claude CLI, Anthropic key, OpenAI passthrough status, capacity | `ENG` | §4.4 |
| 7.10 | Test: health endpoint — both backends ok → 200 | `QA` | §14.4 #47 |
| 7.11 | Test: health endpoint — one backend down → still 200 (at least one functional) | `QA` | §14.4 #48 |
| 7.12 | Test: health endpoint — no backends → 503 | `QA` | §4.4 |
| 7.13 | Create `src/routes/models.ts` — return Claude model list from §4.3 | `ENG` | §4.3 |
| 7.14 | Test: models endpoint returns correct Claude model list | `QA` | §14.4 #49 |
| 7.15 | Test: `X-Backend-Mode` header present on all responses | `QA` | §4.2 |
| 7.16 | Test: `X-Request-ID` header present on all responses | `QA` | §4.2 |
| 7.17 | Test: streaming response emits `data: [DONE]` exactly once, from route handler only | `QA` | §5.8 |
| 7.18 | Test: security headers present on all responses | `QA` | SECURITY §9.2 |
| 7.19 | Tests: error handler maps each §9.6 error code correctly (missing field → 400, unsupported param → 400, model not found → 400, auth missing → 401, backend auth → 401, session busy → 429, rate limit → 429, capacity → 429, passthrough not configured → 503, CLI not found → 503, CLI crash → 500, timeout → 504, invalid header → 400, invalid session → 400, session not found → 404, payload too large → 413, wrong content-type → 415, passthrough disabled → 503, shutting down → 503) | `QA` | §9.6 |

**Exit criteria**: All endpoints respond correctly. Route handler is
fully backend-agnostic. Error handler covers all §9.6 codes. Response
headers and security headers present. `data: [DONE]` emitted exactly
once.

---

## Epic 8: Security & Authentication

**Deliverable**: Server rejects unauthenticated requests when `API_KEY`
is configured. Rate limiting enforces per-IP, per-key, and per-session
limits with standard rate-limit headers. All inputs are validated within
documented bounds. No command injection is possible. Demo by showing
auth enforcement, rate limit 429s, and input validation 400s.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 8.1 | Create `src/middleware/auth.ts` — `Bearer` token extraction, `sk-cca-` prefix validation, multi-key support | `SEC` | §8.2 |
| 8.2 | Implement timing-safe comparison via `crypto.timingSafeEqual()` | `SEC` | §8.2 |
| 8.3 | Test: missing auth header (when required) → 401 `missing_api_key` | `QA` | §14.4 #51 |
| 8.4 | Test: wrong key → 401 `invalid_api_key` | `QA` | §14.4 #52 |
| 8.5 | Test: valid key → request proceeds | `QA` | §14.4 #53 |
| 8.6 | Test: no `API_KEY` configured → auth disabled, all requests pass | `QA` | §8.2 |
| 8.7 | Test: timing-safe comparison (verify `timingSafeEqual` is called) | `QA` | §14.4 #54 |
| 8.8 | Test: `API_KEYS=key1,key2` → request with key2 succeeds (multi-key acceptance) | `QA` | §8.2 |
| 8.9 | Test: `API_KEY` + `API_KEYS` both set → merged set, deduped, both keys work | `QA` | §8.2 |
| 8.10 | Test: `Basic` auth scheme or raw key without `Bearer` prefix → 401 with guidance | `QA` | §8.2 |
| 8.11 | Implement per-IP rate limiter — sliding window, 60 requests/min | `SEC` | §8.3 |
| 8.12 | Implement per-key concurrency limiter — max 5 simultaneous requests per API key | `SEC` | §8.3 |
| 8.13 | Implement per-session rate limiter — 10 requests/min per session | `SEC` | §8.3 |
| 8.14 | Implement rate limit response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every response, `Retry-After` on 429s | `SEC` | SECURITY §6.3 |
| 8.15 | Test: per-IP rate limit exceeded → 429 `rate_limit_exceeded` with `Retry-After` header | `QA` | §8.3 |
| 8.16 | Test: per-key concurrency — 5 concurrent requests succeed, 6th → 429 | `QA` | §8.3 |
| 8.17 | Test: per-session rate limit exceeded → 429 | `QA` | §8.3 |
| 8.18 | Test: rate limit headers present on normal responses | `QA` | SECURITY §6.3 |
| 8.19 | Implement input validation — body size (1 MB), messages (max 100), content (max 500K chars), model (max 256 chars) | `SEC` | §8.4 |
| 8.20 | Test: body too large → 413 `payload_too_large` | `QA` | §8.4 |
| 8.21 | Test: wrong Content-Type → 415 `unsupported_media_type` | `QA` | §9.6 |
| 8.22 | Test: session ID validated as UUID v4 before reaching CLI | `QA` | §14.4 #56 |
| 8.23 | Verify `spawn()` uses argument arrays with explicit `shell: false`, never `exec()` or `shell: true` | `SEC` | §8.1 |
| 8.24 | Test: command injection prevention — malicious model/prompt cannot escape args | `QA` | §14.4 #55 |
| 8.25 | Configure oxlint to ban unsafe `child_process` imports (`exec`, `execSync`, `execFile`, `execFileSync`) | `SEC` | §8.1, SECURITY §3.5 |
| 8.26 | Add CI grep check banning `exec`, `execSync`, `execFile`, `execFileSync`, `shell: true` in source | `SEC` | §8.1 |
| 8.27 | Implement logging security — test: exercise request lifecycle, capture log output, assert no prompt content, API keys, response bodies, or `X-OpenAI-API-Key` values. Assert presence of request ID, session ID, status code, duration | `SEC` | §8.6 |
| 8.28 | Implement key prefix masking in logs — log only `sk-cca-****7f3a` format, never full key | `SEC` | §8.6 |
| 8.29 | Test: key prefix masking produces correct masked format | `QA` | §8.6 |

**Exit criteria**: Auth middleware enforces key validation when
configured (single, multi-key, merged). Rate limits return 429 at
thresholds with correct headers. All input bounds enforced. No command
injection vectors. No secrets in logs. CI check and lint rule in place.

---

## Epic 9: Process Management & Operational Readiness

**Deliverable**: Server manages a pool of concurrent `claude` CLI
processes with hard timeouts. Output buffering prevents memory
exhaustion. Graceful shutdown drains in-flight requests before exiting.
Demo by showing process pool at capacity returning 429, and `SIGTERM`
triggering clean shutdown with active requests.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 9.1 | Implement process pool concurrency limiter — acquire/release slots, reject when `MAX_CONCURRENT_PROCESSES` exceeded | `ENG` | §7.3 |
| 9.2 | Implement process pool queue — brief wait with `POOL_QUEUE_TIMEOUT_MS` timeout before rejecting | `ENG` | §7.3 |
| 9.3 | Implement per-request timeout — `REQUEST_TIMEOUT_MS`, SIGTERM then SIGKILL after 5s. Cancel SIGKILL timer if process exits after SIGTERM; `unref()` after SIGKILL | `ENG` | §7.4 |
| 9.4 | Track active processes in `Set<ChildProcess>`, clean up on exit/abort | `ENG` | §7.4 |
| 9.5 | Implement stdout/stderr output buffering limits — 10 MB stdout, 1 MB stderr. Kill child if exceeded, return 502 | `ENG` | SECURITY §7.1, §7.3 |
| 9.6 | Implement graceful shutdown — SIGTERM/SIGINT signal handlers + shutdown flag (refuse new requests with 503). Note: `index.ts` intentionally has no signal handlers until this task; adding a skeleton earlier would create false confidence without process pool drain logic (architect review P1-5) | `ENG` | §7.5 |
| 9.7 | Implement shutdown drain — send SIGTERM to all children, wait `SHUTDOWN_TIMEOUT_MS`, then SIGKILL survivors | `ENG` | §7.5 |
| 9.8 | Implement connection timeout configuration — `server.headersTimeout`, `server.requestTimeout`, `server.keepAliveTimeout` | `ENG` | SECURITY §12 |
| 9.9 | Test: process pool exhaustion → 429 `capacity_exceeded` | `QA` | §14.4 #46 |
| 9.10 | Test: pool queue timeout → 429 after `POOL_QUEUE_TIMEOUT_MS` | `QA` | §7.3 |
| 9.11 | Test: request timeout → 504 `timeout` | `QA` | §14.4 #45 |
| 9.12 | Test: CLI not found on PATH → 503 `backend_unavailable` | `QA` | §14.4 #43 |
| 9.13 | Test: CLI exit non-zero → 500 `internal_error`, stderr sanitized (strip paths, env, stack traces) | `QA` | §14.4 #44, §9.6 |
| 9.14 | Test: CLI exit 0 with stderr output → success response, stderr logged as warning | `QA` | §14.5 |
| 9.15 | Test: server shutdown flag → new spawn requests return 503 `server_shutting_down` | `QA` | §14.4 #50 |
| 9.16 | Test: shutdown SIGKILL escalation — child that ignores SIGTERM gets SIGKILL after `SHUTDOWN_TIMEOUT_MS` | `QA` | §7.5 |
| 9.17 | Test: malformed JSON from Claude CLI → 500 `internal_error` with generic error message | `QA` | §14.4 #58 |
| 9.18 | Test: stdout exceeds 10 MB → child killed, 502 returned | `QA` | SECURITY §7.1 |
| 9.19 | Test: after shutdown completes, `Set<ChildProcess>` is empty and no child PIDs remain | `QA` | §7.5 |
| 9.20 | Implement response secret scanning — scan CLI output for credential patterns (API keys, Bearer tokens, AWS keys, PEM keys) and redact before returning to client | `SEC` | SECURITY §8.4 |
| 9.21 | Test: response containing `sk-ant-...` or `Bearer ...` → redacted in output | `QA` | SECURITY §8.4 |

**Exit criteria**: Pool limits enforced with queue timeout. Per-request
timeouts trigger SIGTERM→SIGKILL. Output buffering prevents memory
exhaustion. Graceful shutdown drains with SIGKILL escalation. All error
scenarios return correct HTTP codes. Response secrets redacted. No
orphaned processes.

---

## Epic 10: Developer Experience & Polish

**Deliverable**: A developer can use any OpenAI SDK (Python, Node.js,
curl) against the server with zero code changes for passthrough, and
one extra header for Claude Code mode. All error messages are
actionable and match OpenAI's schema. Comprehensive documentation
covers quickstart, API reference, session workflows, SDK compatibility,
and known limitations. Demo with Python SDK showing passthrough,
Claude Code, and multi-turn session usage.

| # | Task | Owner | Spec Ref |
|---|------|-------|----------|
| 10.1 | Audit all error messages against §9.6 table (20 rows) — each must be human-readable with actionable guidance. Use §9.6 as the checklist | `DX` | §9.6 |
| 10.2 | Verify Tier 3 rejection errors suggest passthrough mode or direct Claude API | `DX` | §5.3 |
| 10.3 | Verify unknown model error lists all valid model names | `DX` | §5.2 |
| 10.4 | Verify `X-Claude-Ignored-Params` lists all Tier 2 params that were present | `DX` | §5.3 |
| 10.5 | Create `docs/API_REFERENCE.md` — all endpoints, all request/response headers (explicitly document all 5 response headers: `X-Backend-Mode`, `X-Request-ID`, `X-Claude-Session-ID`, `X-Claude-Session-Created`, `X-Claude-Ignored-Params`), request/response examples, error code reference | `DX` | §4 |
| 10.6 | Add session workflow guide to API_REFERENCE.md — explain `with_raw_response` (Python) and `withResponse()` (Node.js) patterns for extracting session IDs from response headers | `DX` | §9.3 |
| 10.7 | Add SDK compatibility matrix to API_REFERENCE.md — 7-row table from §9.4 with passthrough vs Claude Code support per SDK, note about tools/functions/images breaking Claude Code mode | `DX` | §9.4 |
| 10.8 | Add "What Works / What Doesn't / Behavioral Differences" section to API_REFERENCE.md per §9.7 | `DX` | §9.7 |
| 10.9 | Add quickstart section to API_REFERENCE.md — 2-line env var setup (§9.1), first request in under 1 minute | `DX` | §9.1 |
| 10.10 | Document `X-Claude-Ignored-Params` header semantics for clients: "Your request succeeded, but these parameters were not honored" | `DX` | §5.3 |
| 10.11 | Create SDK usage examples: Python, Node.js, curl (passthrough + Claude Code + sessions) | `DX` | §9.2–9.3 |
| 10.12 | Create `docs/ROADMAP.md` — current features, known limitations, future plans | `DX` | Global |
| 10.13 | Run `pnpm preflight` — lint + format:check + typecheck + test must all pass | `QA` | §13.4 |
| 10.14 | Verify test coverage meets thresholds: 90% lines, 85% branches, 90% functions | `QA` | §14.2 |
| 10.15 | End-to-end smoke test: passthrough non-streaming | `QA` | §14.5 |
| 10.16 | End-to-end smoke test: passthrough streaming | `QA` | §14.5 |
| 10.17 | End-to-end smoke test: Claude Code non-streaming with session | `QA` | §14.5 |
| 10.18 | End-to-end smoke test: Claude Code streaming | `QA` | §14.5 |

**Exit criteria**: All error messages reviewed and actionable. Docs
complete with quickstart, API reference, session guide, SDK matrix,
and limitations. SDK examples work. Preflight passes. Coverage
thresholds met. Smoke tests green.

---

## Dependency Graph

```
Epic 1: Project Scaffold
  │
  ├──► Epic 2: Mode Router & Backend Abstraction
  │      │
  │      ├──► Epic 3: OpenAI Passthrough Backend ──────────┐
  │      │                                                  │
  │      └──► Epic 4: Claude Code Non-Streaming             │
  │             │                │                          │
  │             │                ├──► Epic 5: Streaming      │
  │             │                │                          │
  │             │                └──► Epic 6: Sessions       │
  │             │                       │                   │
  │             │                       │                   │
  │    ┌────────┴───────────────────────┴───────────────────┘
  │    │
  │    └──► Epic 7: HTTP Server & Route Integration
  │           │
  │           ├──► Epic 8: Security & Authentication
  │           │      (8.1–8.10 auth + 8.19–8.22 validation
  │           │       can start after Epic 1)
  │           │
  │           └──► Epic 9: Process Management
  │                  │
  │                  └──► Epic 10: Developer Experience & Polish
```

**Parallel tracks**:
- Epics 3 and 4 can be developed concurrently after Epic 2 (they share
  only the `CompletionBackend` interface). This is by design per §15.
- **Epics 5 and 6 can be developed concurrently** after Epic 4 —
  sessions are independent of streaming. Both feed into Epic 7.
- Epic 8 auth middleware (8.1–8.10) and input validation (8.19–8.22)
  depend only on Epic 1 (Fastify setup) and can start early. Rate
  limiting (8.11–8.18) needs route handler context from Epic 7.

---

## Task Count Summary

| Epic | Tasks | Primary Owners |
|------|-------|----------------|
| 1. Project Scaffold | 17 | `OPS`, `QA`, `ENG`, `ARCH` |
| 2. Mode Router | 9 | `ARCH`, `ENG`, `QA` |
| 3. OpenAI Passthrough | 20 | `ENG`, `QA`, `SEC` |
| 4. Claude Code Non-Streaming | 35 | `ENG`, `QA` |
| 5. Claude Code Streaming | 16 | `ENG`, `QA` |
| 6. Session Management | 15 | `ENG`, `QA` |
| 7. HTTP Server & Routes | 19 | `ENG`, `QA`, `SEC`, `DX` |
| 8. Security & Auth | 29 | `SEC`, `QA` |
| 9. Process Management | 21 | `ENG`, `QA`, `SEC` |
| 10. DX & Polish | 18 | `DX`, `QA` |
| **Total** | **199** | |

---

## Review Changes Applied

The following revisions were incorporated from the full team review:

**Architect** (12 findings):
- Fixed dependency graph: Epic 6 no longer depends on Epic 5
- Added `healthCheck()` to `CompletionBackend` interface (2.1)
- Added `apiKey` to `RequestContext` for rate limiting (2.1)
- Extended `onDone` callback with optional usage metadata (2.1)
- Added `usage` field to `ChatCompletionChunk` type (1.5)
- Added test fixtures task (1.10) and passthrough-disabled router test (2.9)
- Added per-request OpenAI client task detail (3.4)
- Config validation constraints added (1.7)

**Software Engineer** (18 findings):
- Split task 4.14 into 4.18/4.19/4.20 (arg construction, env sanitization, spawn)
- Split task 4.21 into 4.32 (non-streaming orchestration only)
- Split task 8.8 into 8.11/8.12/8.13 (per-IP, per-key, per-session)
- Split task 9.1 into 9.1/9.2 (concurrency limiter + queue)
- Split task 7.1 into 7.1/7.2 (server setup + CORS/routes)
- Added NDJSON line buffering to stream adapter (5.1) and tests (5.9, 5.10)
- Added long prompt stdin delivery (4.21) and test (4.27)
- Added multiple content blocks test (5.8)
- Merged stop reason mapping into message_delta test (5.4)

**QA Lead** (15 findings):
- Added empty messages array test (4.16)
- Added empty user content test (4.17)
- Added multiple system messages test (4.7)
- Added CLI exit-0-with-stderr test (9.14)
- Added `content_block_stop`/`message_stop` skip test (5.6)
- Added passthrough integration tests (3.17, 3.18)
- Added passthrough tools-forwarded test (3.15)
- Added passthrough SDK timeout test (3.16)
- Added `ALLOW_CLIENT_OPENAI_KEY=false` test (3.12)
- Added session TTL cleanup test (6.14)
- Expanded test helpers (1.10, 1.11, 1.12)
- Added error handler unit tests (7.19)

**Security Lead** (14 findings):
- Added session isolation by client identity (6.1, 6.3, 6.13) — P0
- Added output buffering limits (9.5, 9.18)
- Added response secret scanning (9.20, 9.21)
- Added security headers (7.3, 7.18)
- Added connection timeouts (9.8)
- Added per-key concurrency test (8.16)
- Added rate limit headers (8.14, 8.18)
- Added env sanitization negative test (4.25)
- Added HOME fallback warning test (4.26)
- Added multi-key auth tests (8.8, 8.9, 8.10)
- Added max session age (6.6, 6.15)
- Expanded CI grep to include `execFile`/`execFileSync` (8.26)
- Added oxlint rule for unsafe child_process imports (8.25)
- Added concrete logging security tests (8.27, 8.28, 8.29)
- Added `pnpm audit` to CI (1.17)

**DevOps** (7 findings):
- Added shellHook to Nix flake task (1.4)
- Clarified preflight script implementation (1.1)
- Added CI/CD pipeline task (1.16)
- Added `pnpm audit` in CI (1.17)
- Expanded graceful shutdown with SHUTDOWN_TIMEOUT_MS + SIGKILL (9.6, 9.7)
- Added shutdown SIGKILL escalation test (9.16)
- Made process cleanup verification a concrete test (9.19)

**DX Advocate** (12 findings):
- Added `backend_auth_failed` error test (4.31)
- Fixed error code: `backend_error` → `internal_error` (4.30, 9.13, 9.17)
- Added `n=1` Tier 2 acceptance test (4.13)
- Added response header documentation (10.5)
- Added session workflow guide (10.6)
- Added SDK compatibility matrix (10.7)
- Added limitations section (10.8)
- Added quickstart guide (10.9)
- Added `X-Claude-Ignored-Params` client documentation (10.10)
- Made error audit reference §9.6 checklist explicitly (10.1)
- Added wrong auth scheme test (8.10)
