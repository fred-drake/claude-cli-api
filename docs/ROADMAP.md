# Roadmap

Last Updated: 2026-02-26 | Version: 0.2.0

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

## In Progress

### Epic 4: Claude Code Non-Streaming
Model mapper, request transformer, CLI spawning, response
transformer for non-streaming `complete()`.

## Planned

### Epic 6: Session Management
Session persistence, `X-Claude-Session-ID` header handling.

### Epic 7: Route Handler
Fastify route for `POST /v1/chat/completions` with SSE
formatting, error responses, and backend dispatch.

## Architecture

```
Client → Fastify Route → Mode Router → Backend
                                         ├── OpenAI Passthrough
                                         └── Claude Code
                                              ├── Model Mapper
                                              ├── Request Transformer
                                              ├── CLI Spawner
                                              └── Stream Transformer
                                                   ├── NdjsonLineBuffer
                                                   └── StreamAdapter
```
