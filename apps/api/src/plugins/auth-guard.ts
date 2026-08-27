import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { getEnv } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    walletAddress?: string;
  }
}

/** Decorates `app.requireAuth` — attach as a `preHandler` on any route that
 * writes to NATIVE tables (profile, notifications, settings). Contract
 * writes never go through this: they're signed client-side by the user's
 * own wallet, the backend never signs on their behalf. */
export const authGuardPlugin = fp(async function authGuardImpl(app: FastifyInstance) {
  const env = getEnv();

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies["claimgame_session"];
    if (!token) {
      return reply.code(401).send({ error: { message: "Not authenticated" } });
    }
    try {
      const payload = jwt.verify(token, env.JWT_SIGNING_SECRET) as { sub: string };
      request.walletAddress = payload.sub;
    } catch {
      return reply.code(401).send({ error: { message: "Invalid or expired session" } });
    }
  });
});
