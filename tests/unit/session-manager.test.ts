import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SessionManager,
  SessionError,
} from "../../src/services/session-manager.js";
import type {
  SessionManagerOptions,
  SessionResult,
} from "../../src/services/session-manager.js";

function defaultOptions(
  overrides: Partial<SessionManagerOptions> = {},
): SessionManagerOptions {
  return {
    sessionTtlMs: 3_600_000,
    maxSessionAgeMs: 86_400_000,
    cleanupIntervalMs: 60_000,
    ...overrides,
  };
}

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.destroy();
    vi.useRealTimers();
  });

  describe("resolveSession — create (no sessionId)", () => {
    it("creates a new session with valid UUID and action=created", () => {
      manager = new SessionManager(defaultOptions());

      const result = manager.resolveSession(undefined, "client-a", "sonnet");

      expect(result.action).toBe("created");
      expect(SessionManager.isValidUUID(result.sessionId)).toBe(true);
      expect(manager.size).toBe(1);
    });

    it("stores session metadata correctly", () => {
      manager = new SessionManager(defaultOptions());

      const result = manager.resolveSession(undefined, "client-a", "sonnet");
      const session = manager.getSession(result.sessionId);

      expect(session).toBeDefined();
      expect(session!.clientId).toBe("client-a");
      expect(session!.model).toBe("sonnet");
      expect(session!.isActive).toBe(false);
      expect(session!.createdAt).toBe(session!.lastUsedAt);
    });

    it("creates multiple sessions for the same client", () => {
      manager = new SessionManager(defaultOptions());

      const r1 = manager.resolveSession(undefined, "client-a", "sonnet");
      const r2 = manager.resolveSession(undefined, "client-a", "sonnet");

      expect(r1.sessionId).not.toBe(r2.sessionId);
      expect(manager.size).toBe(2);
    });
  });

  describe("resolveSession — resume (existing sessionId)", () => {
    it("resumes an existing session with action=resumed", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      const resumed = manager.resolveSession(
        created.sessionId,
        "client-a",
        "sonnet",
      );

      expect(resumed.action).toBe("resumed");
      expect(resumed.sessionId).toBe(created.sessionId);
    });

    it("updates lastUsedAt on resume", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      const beforeResume = manager.getSession(created.sessionId)!.lastUsedAt;

      vi.advanceTimersByTime(5000);

      manager.resolveSession(created.sessionId, "client-a", "sonnet");
      const afterResume = manager.getSession(created.sessionId)!.lastUsedAt;

      expect(afterResume).toBeGreaterThan(beforeResume);
    });
  });

  describe("resolveSession — unknown UUID → 404", () => {
    it("throws 404 session_not_found for unknown UUID", () => {
      manager = new SessionManager(defaultOptions());

      const unknownId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

      expect(() =>
        manager.resolveSession(unknownId, "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession(unknownId, "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(404);
        expect(e.body.error.code).toBe("session_not_found");
      }
    });
  });

  describe("mutex — acquireLock / releaseLock", () => {
    it("throws 429 session_busy when session is active", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      manager.acquireLock(created.sessionId);

      expect(() =>
        manager.resolveSession(created.sessionId, "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession(created.sessionId, "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(429);
        expect(e.body.error.code).toBe("session_busy");
      }
    });

    it("allows resume after releaseLock", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      manager.acquireLock(created.sessionId);
      manager.releaseLock(created.sessionId);

      const resumed = manager.resolveSession(
        created.sessionId,
        "client-a",
        "sonnet",
      );
      expect(resumed.action).toBe("resumed");
    });

    it("acquireLock throws 429 on double lock", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      manager.acquireLock(created.sessionId);

      expect(() => manager.acquireLock(created.sessionId)).toThrow(
        SessionError,
      );

      try {
        manager.acquireLock(created.sessionId);
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(429);
        expect(e.body.error.code).toBe("session_busy");
      }
    });

    it("releaseLock on missing session is a no-op", () => {
      manager = new SessionManager(defaultOptions());

      expect(() => manager.releaseLock("nonexistent-id")).not.toThrow();
    });

    it("acquireLock on missing session is a no-op", () => {
      manager = new SessionManager(defaultOptions());

      expect(() => manager.acquireLock("nonexistent-id")).not.toThrow();
    });
  });

  describe("isValidUUID", () => {
    it("rejects non-UUID string → 400 invalid_session_id", () => {
      manager = new SessionManager(defaultOptions());

      expect(() =>
        manager.resolveSession("not-a-uuid", "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession("not-a-uuid", "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(400);
        expect(e.body.error.code).toBe("invalid_session_id");
      }
    });

    it("rejects empty string → 400", () => {
      manager = new SessionManager(defaultOptions());

      expect(() => manager.resolveSession("", "client-a", "sonnet")).toThrow(
        SessionError,
      );

      try {
        manager.resolveSession("", "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(400);
        expect(e.body.error.code).toBe("invalid_session_id");
      }
    });

    it("rejects UUID v1 format → 400", () => {
      manager = new SessionManager(defaultOptions());

      // UUID v1 has version digit 1 in position 13
      const uuidV1 = "550e8400-e29b-11d4-a716-446655440000";

      expect(() =>
        manager.resolveSession(uuidV1, "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession(uuidV1, "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(400);
        expect(e.body.error.code).toBe("invalid_session_id");
      }
    });

    it("accepts valid UUID v4", () => {
      expect(
        SessionManager.isValidUUID("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
      ).toBe(true);
    });

    it("rejects invalid formats", () => {
      expect(SessionManager.isValidUUID("not-a-uuid")).toBe(false);
      expect(SessionManager.isValidUUID("")).toBe(false);
      // UUID v1
      expect(
        SessionManager.isValidUUID("550e8400-e29b-11d4-a716-446655440000"),
      ).toBe(false);
    });
  });

  describe("X-Claude-Session-Created header via SessionResult", () => {
    it("returns action=created on first resolve, action=resumed on second", () => {
      manager = new SessionManager(defaultOptions());

      const first = manager.resolveSession(undefined, "client-a", "sonnet");
      expect(first.action).toBe("created");

      const second = manager.resolveSession(
        first.sessionId,
        "client-a",
        "sonnet",
      );
      expect(second.action).toBe("resumed");
    });
  });

  describe("client isolation", () => {
    it("client B gets 404 for client A's session — same as nonexistent", () => {
      manager = new SessionManager(defaultOptions());

      const created = manager.resolveSession(undefined, "client-a", "sonnet");

      // Client B trying to access client A's session
      let clientBError: SessionError | undefined;
      try {
        manager.resolveSession(created.sessionId, "client-b", "sonnet");
      } catch (err) {
        clientBError = err as SessionError;
      }

      // Nonexistent session
      let nonexistentError: SessionError | undefined;
      try {
        manager.resolveSession(
          "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
          "client-a",
          "sonnet",
        );
      } catch (err) {
        nonexistentError = err as SessionError;
      }

      // Both should produce identical errors — no info leak
      expect(clientBError).toBeDefined();
      expect(nonexistentError).toBeDefined();
      expect(clientBError!.status).toBe(nonexistentError!.status);
      expect(clientBError!.body.error.code).toBe(
        nonexistentError!.body.error.code,
      );
      expect(clientBError!.body.error.message).toBe(
        nonexistentError!.body.error.message,
      );
    });
  });

  describe("TTL cleanup", () => {
    it("removes expired sessions on cleanup", () => {
      manager = new SessionManager(defaultOptions({ sessionTtlMs: 10_000 }));

      manager.resolveSession(undefined, "client-a", "sonnet");
      expect(manager.size).toBe(1);

      vi.advanceTimersByTime(15_000);

      const removed = manager.cleanup();
      expect(removed).toBe(1);
      expect(manager.size).toBe(0);
    });

    it("recently-used session survives cleanup", () => {
      manager = new SessionManager(defaultOptions({ sessionTtlMs: 10_000 }));

      const created = manager.resolveSession(undefined, "client-a", "sonnet");

      vi.advanceTimersByTime(8_000);

      // Touch the session
      manager.resolveSession(created.sessionId, "client-a", "sonnet");

      vi.advanceTimersByTime(5_000);

      const removed = manager.cleanup();
      expect(removed).toBe(0);
      expect(manager.size).toBe(1);
    });

    it("skips active sessions during cleanup", () => {
      manager = new SessionManager(defaultOptions({ sessionTtlMs: 10_000 }));

      const created = manager.resolveSession(undefined, "client-a", "sonnet");
      manager.acquireLock(created.sessionId);

      vi.advanceTimersByTime(15_000);

      const removed = manager.cleanup();
      expect(removed).toBe(0);
      expect(manager.size).toBe(1);
    });

    it("resolveSession rejects TTL-expired session with 404", () => {
      manager = new SessionManager(defaultOptions({ sessionTtlMs: 10_000 }));

      const created = manager.resolveSession(undefined, "client-a", "sonnet");

      vi.advanceTimersByTime(15_000);

      expect(() =>
        manager.resolveSession(created.sessionId, "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession(created.sessionId, "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(404);
        expect(e.body.error.code).toBe("session_not_found");
      }
    });
  });

  describe("max age (24h)", () => {
    it("rejects session that exceeds max age even if recently used", () => {
      manager = new SessionManager(
        defaultOptions({ maxSessionAgeMs: 86_400_000 }),
      );

      const created = manager.resolveSession(undefined, "client-a", "sonnet");

      // Keep using it over 24 hours
      for (let i = 0; i < 24; i++) {
        vi.advanceTimersByTime(3_500_000); // ~58 min
        manager.resolveSession(created.sessionId, "client-a", "sonnet");
      }

      // Now advance past 24h total
      vi.advanceTimersByTime(3_600_000);

      expect(() =>
        manager.resolveSession(created.sessionId, "client-a", "sonnet"),
      ).toThrow(SessionError);

      try {
        manager.resolveSession(created.sessionId, "client-a", "sonnet");
      } catch (err) {
        const e = err as SessionError;
        expect(e.status).toBe(404);
        expect(e.body.error.code).toBe("session_not_found");
      }
    });

    it("cleanup removes max-age-exceeded sessions", () => {
      manager = new SessionManager(defaultOptions({ maxSessionAgeMs: 10_000 }));

      manager.resolveSession(undefined, "client-a", "sonnet");

      vi.advanceTimersByTime(15_000);

      const removed = manager.cleanup();
      expect(removed).toBe(1);
      expect(manager.size).toBe(0);
    });
  });

  describe("destroy", () => {
    it("clears sessions and stops timer", () => {
      manager = new SessionManager(defaultOptions());

      manager.resolveSession(undefined, "client-a", "sonnet");
      expect(manager.size).toBe(1);

      manager.destroy();
      expect(manager.size).toBe(0);
    });
  });
});
