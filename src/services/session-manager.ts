import { randomUUID } from "node:crypto";
import type { OpenAIError } from "../types/openai.js";

export interface SessionMetadata {
  id: string;
  clientId: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
  isActive: boolean;
}

export interface SessionManagerOptions {
  sessionTtlMs: number;
  maxSessionAgeMs: number;
  cleanupIntervalMs: number;
}

export type SessionResult =
  | { action: "created"; sessionId: string }
  | { action: "resumed"; sessionId: string };

export class SessionError extends Error {
  readonly status: number;
  readonly body: OpenAIError;

  constructor(status: number, body: OpenAIError) {
    super(body.error.message);
    this.name = "SessionError";
    this.status = status;
    this.body = body;
  }
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SessionManager {
  private readonly sessions = new Map<string, SessionMetadata>();
  private readonly options: SessionManagerOptions;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.cleanupTimer = setInterval(
      () => this.cleanup(),
      options.cleanupIntervalMs,
    );
    this.cleanupTimer.unref();
  }

  static isValidUUID(id: string): boolean {
    return UUID_V4_RE.test(id);
  }

  resolveSession(
    sessionId: string | undefined,
    clientId: string,
    model: string,
  ): SessionResult {
    if (sessionId === undefined) {
      return this.createSession(clientId, model);
    }
    return this.resumeSession(sessionId, clientId);
  }

  // Mutex relies on Node.js single-threaded event loop — no locking primitives needed.
  acquireLock(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.isActive) {
      throw new SessionError(429, {
        error: {
          message: "Session is currently processing another request",
          type: "rate_limit_error",
          param: null,
          code: "session_busy",
        },
      });
    }

    session.isActive = true;
    session.lastUsedAt = Date.now();
  }

  releaseLock(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.isActive = false;
    session.lastUsedAt = Date.now();
  }

  getSession(sessionId: string): SessionMetadata | undefined {
    return this.sessions.get(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (session.isActive) continue;

      const exceededMaxAge =
        now - session.createdAt > this.options.maxSessionAgeMs;
      const exceededTtl = now - session.lastUsedAt > this.options.sessionTtlMs;

      if (exceededMaxAge || exceededTtl) {
        this.sessions.delete(id);
        removed++;
      }
    }

    return removed;
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }

  private createSession(clientId: string, model: string): SessionResult {
    const id = randomUUID();
    const now = Date.now();

    this.sessions.set(id, {
      id,
      clientId,
      createdAt: now,
      lastUsedAt: now,
      model,
      isActive: false,
    });

    return { action: "created", sessionId: id };
  }

  private resumeSession(sessionId: string, clientId: string): SessionResult {
    if (!SessionManager.isValidUUID(sessionId)) {
      throw new SessionError(400, {
        error: {
          message: `Invalid session ID format: ${sessionId}`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_session_id",
        },
      });
    }

    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionError(404, {
        error: {
          message: "Session not found",
          type: "invalid_request_error",
          param: null,
          code: "session_not_found",
        },
      });
    }

    // Client isolation — same error as not found to avoid info leak
    if (session.clientId !== clientId) {
      throw new SessionError(404, {
        error: {
          message: "Session not found",
          type: "invalid_request_error",
          param: null,
          code: "session_not_found",
        },
      });
    }

    const now = Date.now();

    // Max age check
    if (now - session.createdAt > this.options.maxSessionAgeMs) {
      this.sessions.delete(sessionId);
      throw new SessionError(404, {
        error: {
          message: "Session not found",
          type: "invalid_request_error",
          param: null,
          code: "session_not_found",
        },
      });
    }

    // TTL check
    if (now - session.lastUsedAt > this.options.sessionTtlMs) {
      this.sessions.delete(sessionId);
      throw new SessionError(404, {
        error: {
          message: "Session not found",
          type: "invalid_request_error",
          param: null,
          code: "session_not_found",
        },
      });
    }

    // Mutex check
    if (session.isActive) {
      throw new SessionError(429, {
        error: {
          message: "Session is currently processing another request",
          type: "rate_limit_error",
          param: null,
          code: "session_busy",
        },
      });
    }

    session.lastUsedAt = now;

    return { action: "resumed", sessionId };
  }
}
