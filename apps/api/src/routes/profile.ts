import type { FastifyInstance } from "fastify";
import { z } from "zod";

const UpdateProfileSchema = z.object({
  displayName: z.string().min(1).max(40).optional(),
  avatarUrl: z.string().url().optional(),
});

/** Writes here only ever touch NATIVE tables (display name, avatar) — never
 * anything that mirrors contract state. Requires an authenticated session. */
export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/me",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({ where: { walletAddress: request.walletAddress! } });
      return reply.send({ data: user });
    },
  );

  app.patch(
    "/api/v1/me",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const body = UpdateProfileSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: { message: "Invalid request", details: body.error.flatten() } });
      }
      const user = await app.prisma.user.update({
        where: { walletAddress: request.walletAddress! },
        data: body.data,
      });
      return reply.send({ data: user });
    },
  );

  app.get(
    "/api/v1/notifications",
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const notifications = await app.prisma.notification.findMany({
        where: { walletAddress: request.walletAddress! },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return reply.send({ data: notifications });
    },
  );
}
