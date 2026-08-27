import type { FastifyInstance } from "fastify";
import { z } from "zod";

const ListQuerySchema = z.object({
  status: z.string().optional(),
  protocol: z.string().optional(),
  difficulty: z.string().optional(),
  creator: z.string().optional(),
  challenger: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
});

/** Read-only. All of this data is a CACHE mirror of the deployed contract —
 * see docs/architecture.md §2 and §15. Nothing here is authoritative; the
 * frontend still confirms writes against the contract itself. */
export async function claimsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/claims", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: { message: "Invalid query", details: query.error.flatten() } });
    }
    const { status, protocol, difficulty, creator, challenger, cursor, limit } = query.data;

    const claims = await app.prisma.claim.findMany({
      where: {
        status: status ?? undefined,
        protocol: protocol ?? undefined,
        difficulty: difficulty ?? undefined,
        creator: creator ? creator.toLowerCase() : undefined,
        ...(challenger
          ? { challenge: { challenger: challenger.toLowerCase() } }
          : {}),
      },
      include: { challenge: true },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = claims.length > limit;
    const page = hasMore ? claims.slice(0, limit) : claims;

    return reply.send({
      data: page,
      meta: { nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null },
    });
  });

  app.get("/api/v1/claims/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const claim = await app.prisma.claim.findUnique({
      where: { id },
      include: { versions: true, evidence: true, challenge: true, objections: true, resolution: true, appeal: true },
    });
    if (!claim) {
      return reply.code(404).send({ error: { message: "Claim not found" } });
    }
    return reply.send({ data: claim });
  });

  app.get("/api/v1/leaderboard", async (request, reply) => {
    const { seasonId, category } = request.query as { seasonId?: string; category?: string };
    if (!seasonId || !category) {
      return reply.code(400).send({ error: { message: "seasonId and category are required" } });
    }
    const entries = await app.prisma.leaderboardEntry.findMany({
      where: { seasonId, category },
      orderBy: { rank: "asc" },
      take: 50,
    });
    return reply.send({ data: entries });
  });

  app.get("/api/v1/reputation/:walletAddress", async (request, reply) => {
    const { walletAddress } = request.params as { walletAddress: string };
    const score = await app.prisma.reputationScore.findUnique({
      where: { walletAddress: walletAddress.toLowerCase() },
    });
    return reply.send({ data: score ?? null });
  });

  /** Audit finding #6: makes indexer freshness/health checkable instead of
   * only visible in Fly logs. `staleAfterMs` matches the indexer's own
   * poll interval with margin — if `updatedAt` is older than that, either
   * the process is down or every recent tick has been failing (e.g. a
   * rate-limit exhaustion, as previously happened live). */
  app.get("/api/v1/indexer/status", async (request, reply) => {
    const cursor = await app.prisma.indexerCursor.findUnique({ where: { id: 1 } });
    const staleAfterMs = 20 * 60_000; // indexer polls every 15min; 20min margin
    const ageMs = cursor ? Date.now() - cursor.updatedAt.getTime() : null;
    const stale = ageMs === null || ageMs > staleAfterMs;
    return reply.send({
      data: {
        lastSyncedAt: cursor?.updatedAt ?? null,
        lastClaimCount: cursor ? Number(cursor.lastBlock) : null,
        stale,
      },
    });
  });

  app.get("/api/v1/reputation/:walletAddress/events", async (request, reply) => {
    const { walletAddress } = request.params as { walletAddress: string };
    const events = await app.prisma.reputationEvent.findMany({
      where: { user: walletAddress.toLowerCase() },
      orderBy: { occurredAt: "desc" },
      take: 100,
    });
    return reply.send({ data: events });
  });
}
