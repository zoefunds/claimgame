import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { getEnv } from "./env.js";
import { prismaPlugin } from "./plugins/prisma.js";
import { authGuardPlugin } from "./plugins/auth-guard.js";
import { authRoutes } from "./routes/auth.js";
import { claimsRoutes } from "./routes/claims.js";
import { profileRoutes } from "./routes/profile.js";

async function main(): Promise<void> {
  const env = getEnv();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      // Structured logging per docs/architecture.md §observability — never
      // log secrets, private keys, or session tokens.
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
    trustProxy: true,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  await app.register(prismaPlugin);
  await app.register(authGuardPlugin);

  app.get("/healthz", async () => ({
    status: "ok",
    contractAddress: env.CLAIMGAME_CONTRACT_ADDRESS,
    timestamp: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(claimsRoutes);
  await app.register(profileRoutes);

  app.setErrorHandler((error: import("fastify").FastifyError, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, "unhandled request error");
    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: {
        message: statusCode >= 500 ? "Internal server error" : error.message,
        requestId: request.id,
      },
    });
  });

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`CLAIMGAME API listening on :${env.PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal boot error:", err);
  process.exit(1);
});
