import type { FastifyInstance } from "fastify";

const CLAUDE_MODELS = {
  object: "list" as const,
  data: [
    {
      id: "claude-opus-4-6",
      object: "model" as const,
      created: 1700000000,
      owned_by: "anthropic",
      permission: [],
    },
    {
      id: "claude-sonnet-4-6",
      object: "model" as const,
      created: 1700000000,
      owned_by: "anthropic",
      permission: [],
    },
    {
      id: "claude-haiku-4-5",
      object: "model" as const,
      created: 1700000000,
      owned_by: "anthropic",
      permission: [],
    },
  ],
};

export async function modelsRoute(app: FastifyInstance) {
  app.get("/v1/models", async (_request, reply) => {
    return reply.send(CLAUDE_MODELS);
  });
}
