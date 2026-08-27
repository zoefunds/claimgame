import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export const prismaPlugin = fp(async function prismaPluginImpl(app: FastifyInstance) {
  const prisma = new PrismaClient();

  // Fly Postgres can occasionally close an idle pooled connection. Prisma
  // reports that as P1017, even though a fresh connection succeeds moments
  // later. Retry that one safe-to-retry transport failure once so a browser
  // polling request does not surface an avoidable 500 to the user.
  prisma.$use(async (params, next) => {
    try {
      return await next(params);
    } catch (error) {
      if ((error as { code?: string }).code !== "P1017") throw error;
      await prisma.$disconnect();
      await prisma.$connect();
      return next(params);
    }
  });
  await prisma.$connect();

  app.decorate("prisma", prisma);
  app.addHook("onClose", async (instance) => {
    await instance.prisma.$disconnect();
  });
});
