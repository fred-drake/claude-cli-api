# Integration Test Guide

Manual end-to-end testing guide for claude-cli-api. Use this to verify
the server works against real HTTP requests.

## Prerequisites

Start the dev server in a separate terminal:

```bash
pnpm dev
```

Server listens on `http://localhost:3456` by default. Override with `PORT`
and `HOST` env vars.

## Available Endpoints

### GET /health

Liveness/readiness check. Always available.

```bash
curl -s http://localhost:3456/health | jq
```

Expected response:

```json
{
  "status": "ready",
  "backends": {}
}
```

The `backends` object will be populated once backend implementations are
wired in (Epics 3, 4, 7).

## What's Not Yet Available

The following endpoints exist in the spec but are not yet routed:

- `POST /v1/chat/completions` — Needs Epics 3/4/7 (backend implementations
  and route handler)
- `GET /v1/models` — Needs Epic 7 (route integration)

## Adding New Tests to This Guide

When adding a new feature with a testable HTTP endpoint, append a new
section under "Available Endpoints" with:

1. The endpoint method and path
2. Required headers (if any)
3. A curl command that can be copy-pasted
4. The expected response body
5. Any relevant env vars needed to configure it
