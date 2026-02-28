# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenAI-compatible REST API server that routes requests to either a Claude Code CLI backend or an OpenAI passthrough backend. Requests with `X-Claude-Code: true` or `X-Claude-Session-ID` headers go to Claude Code; all others pass through to OpenAI/compatible APIs.

## Commands

```bash
pnpm dev                    # Watch mode development server
pnpm preflight              # Full QA gate: lint + format + typecheck + test
pnpm test                   # Run all tests (unit + integration)
pnpm test -- tests/unit/config.test.ts          # Run single test file
pnpm test -- -t "loads default values"          # Run tests matching name
pnpm test:unit              # Unit tests only
pnpm test:integration       # Integration tests only (Fastify inject, mocked CLI)
pnpm test:e2e               # E2E tests against live APIs (see below)
pnpm test:coverage          # Tests with v8 coverage report
pnpm lint                   # oxlint
pnpm typecheck              # tsc --noEmit
pnpm format:check           # Prettier check
```

### E2E Integration Tests (`pnpm test:e2e`)

These hit real API endpoints and cost real money. Requirements:
- **Environment variables**: `OPENAI_KEY`, `ANTHROPIC_KEY`, `DEEPSEEK_KEY` (note: intentionally different names from `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` to avoid inheriting dev shell server-facing env vars)
- **Binaries on PATH**: `claude`, `jq`, `curl`
- The script starts/stops its own server instances on a random port
- Covers 6 groups: OpenAI passthrough, DeepSeek passthrough, client-provided key, Claude Code non-streaming, Claude Code streaming, Claude Code sessions

## Architecture

### Request Flow

```
Client → Fastify (hooks: request-id, CORS, security headers)
       → POST /v1/chat/completions
       → Mode Router (header inspection → "claude-code" | "openai-passthrough")
       → Backend.complete() or Backend.completeStream()
       → Response (OpenAI-compatible JSON or SSE)
```

### Two Backends

Both implement `CompletionBackend` (`src/backends/types.ts`): `complete()`, `completeStream()`, `healthCheck()`.

**OpenAI Passthrough** (`src/backends/openai-passthrough.ts`): Proxies to OpenAI SDK. Supports client-provided keys via `X-OpenAI-API-Key` header. Configurable base URL for DeepSeek/other compatible APIs.

**Claude Code** (`src/backends/claude-code.ts`): Spawns `claude` CLI as child process. Two-phase error handling in `complete()`: validation before lock, CLI execution after lock with guaranteed release in `finally`. Streaming path (`doCompleteStream`) spawns CLI directly and pipes NDJSON through `StreamAdapter`.

### Claude Code Pipeline

Request transformation chain (all in `src/transformers/request.ts`):
1. `validateParams()` — Tier 3 params rejected (tools, function_call), Tier 2 collected as ignored (temperature, top_p)
2. `buildPrompt()` — Extracts system prompt, formats multi-turn as `User:`/`Assistant:` labels
3. `buildCliArgs()` — Constructs CLI flags: `--output-format`, `--model`, `--dangerously-skip-permissions`, `--tools ""`, session handling, `-p` prompt
4. `buildSanitizedEnv()` — Allowlist-only env (PATH, HOME, LANG, ANTHROPIC_API_KEY, TERM=dumb)

Model mapping (`src/services/model-mapper.ts`): Maps OpenAI model names to Claude names (e.g., `gpt-4o` → `sonnet`). Response echoes the original requested model name.

Session management (`src/services/session-manager.ts`): UUID-based sessions with TTL eviction, max-age limit, per-session locking. `--session-id` for new, `--resume` for existing.

### Streaming

CLI streams NDJSON with `--output-format stream-json --verbose --include-partial-messages`. The `StreamAdapter` (`src/transformers/stream.ts`) converts `stream_event` types to OpenAI `ChatCompletionChunk` format. Route handler wraps in SSE (`data: ...\n\n`) and terminates with `data: [DONE]`.

### Error Handling

All errors map to OpenAI error schema (`{ error: { message, type, param, code } }`). Custom classes: `ApiError` (status + body), `ModeRouterError`, `PassthroughError`, `SessionError`. Centralized handler in `src/errors/handler.ts`.

## Testing Patterns

- **Unit tests** mock dependencies (CLI via `vi.mock`, child_process via helpers in `tests/helpers/spawn.ts`)
- **Integration tests** use Fastify's `inject()` with mocked backends — no network
- **Test helpers** barrel-exported from `tests/helpers/index.ts`: fixtures (`sampleCliResult`, `sampleChatRequest`), mock spawners, Fastify injection helpers (`injectRequest`, `expectOpenAIError`), callback collectors
- Coverage thresholds: 90% lines, 85% branches, 90% functions

## CI

GitHub Actions runs `preflight` (lint, format, typecheck, test:coverage, audit) and `banned-patterns` (rejects `exec`/`execSync`/`shell: true` in src/).

## Key Constraints

- **No `exec`/`execSync`/`execFile`** — only `spawn()` for child processes (CI enforces this)
- **No `shell: true`** in spawn options
- CLI environment is sanitized to an allowlist — never pass full `process.env`
- TypeScript strict mode with `noUncheckedIndexedAccess`
- ESM throughout (`"type": "module"`, NodeNext module resolution)
