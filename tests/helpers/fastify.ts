import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import type { OpenAIError } from "../../src/types/openai.js";

export async function injectRequest(
  app: FastifyInstance,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  },
) {
  return app.inject({
    method: options.method ?? "POST",
    url: options.url,
    payload: options.payload,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
}

export function expectOpenAIError(
  body: unknown,
  expected: {
    message?: string | RegExp;
    type?: string;
    code?: string;
    param?: string | null;
  },
) {
  const parsed = typeof body === "string" ? JSON.parse(body) : body;
  const error = (parsed as OpenAIError).error;

  expect(error).toBeDefined();
  expect(error).toHaveProperty("message");
  expect(error).toHaveProperty("type");
  expect(error).toHaveProperty("code");
  expect(error).toHaveProperty("param");

  if (expected.message instanceof RegExp) {
    expect(error.message).toMatch(expected.message);
  } else if (expected.message) {
    expect(error.message).toContain(expected.message);
  }

  if (expected.type) {
    expect(error.type).toBe(expected.type);
  }

  if (expected.code) {
    expect(error.code).toBe(expected.code);
  }

  if (expected.param !== undefined) {
    expect(error.param).toBe(expected.param);
  }
}
