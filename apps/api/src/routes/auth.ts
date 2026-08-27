import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { verifyMessage } from "viem";
import { getEnv } from "../env.js";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ACCESS_TOKEN_TTL = "24h";
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const NonceRequestSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
});

const VerifyRequestSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid wallet address"),
  nonce: z.string().min(16),
  signature: z.string().min(1),
  issuedAt: z.string(),
});

function buildSiweMessage(params: {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: string;
  chainId: number;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum-compatible account:`,
    params.address,
    "",
    "Sign in to CLAIMGAME. This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `URI: https://${params.domain}`,
    "Version: 1",
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

/** Wallet-based auth: connect + sign-a-nonce, never a custodial key.
 * See docs/architecture.md §13 for the full flow rationale. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  app.post("/api/v1/auth/nonce", async (request, reply) => {
    const body = NonceRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { message: "Invalid request", details: body.error.flatten() } });
    }

    const walletAddress = body.data.walletAddress.toLowerCase();
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

    await app.prisma.authNonce.create({
      data: { nonce, walletAddress, expiresAt },
    });

    const issuedAt = new Date().toISOString();
    const message = buildSiweMessage({
      domain: request.hostname,
      address: walletAddress,
      nonce,
      issuedAt,
      chainId: env.NEXT_PUBLIC_CHAIN_ID,
    });

    return reply.send({ data: { nonce, issuedAt, message } });
  });

  app.post("/api/v1/auth/verify", async (request, reply) => {
    const body = VerifyRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: { message: "Invalid request", details: body.error.flatten() } });
    }

    const walletAddress = body.data.walletAddress.toLowerCase();
    const record = await app.prisma.authNonce.findUnique({ where: { nonce: body.data.nonce } });

    if (!record || record.walletAddress !== walletAddress) {
      return reply.code(401).send({ error: { message: "Unknown or mismatched nonce" } });
    }
    if (record.usedAt) {
      return reply.code(401).send({ error: { message: "Nonce already used" } });
    }
    if (record.expiresAt < new Date()) {
      return reply.code(401).send({ error: { message: "Nonce expired" } });
    }

    const message = buildSiweMessage({
      domain: request.hostname,
      address: walletAddress,
      nonce: body.data.nonce,
      issuedAt: body.data.issuedAt,
      chainId: env.NEXT_PUBLIC_CHAIN_ID,
    });

    const isValid = await verifyMessage({
      address: walletAddress as `0x${string}`,
      message,
      signature: body.data.signature as `0x${string}`,
    });

    if (!isValid) {
      return reply.code(401).send({ error: { message: "Signature verification failed" } });
    }

    await app.prisma.authNonce.update({
      where: { nonce: body.data.nonce },
      data: { usedAt: new Date() },
    });

    await app.prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress },
      update: {},
    });

    const accessToken = jwt.sign({ sub: walletAddress }, env.JWT_SIGNING_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    });
    const refreshToken = crypto.randomBytes(32).toString("hex");

    await app.prisma.session.create({
      data: {
        walletAddress,
        refreshToken,
        userAgent: request.headers["user-agent"] ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    // Frontend (claim-game.vercel.app) and backend (claimgame-api.fly.dev)
    // are different sites, so a cross-site fetch with credentials:"include"
    // only carries the cookie back if it's SameSite=None; Secure — SameSite
    // "lax" would silently never be sent here, which is why this cookie
    // never actually authenticated anything cross-origin before.
    reply.setCookie("claimgame_session", accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    reply.setCookie("claimgame_refresh", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/api/v1/auth/refresh",
      maxAge: REFRESH_TOKEN_TTL_MS / 1000,
    });

    return reply.send({ data: { walletAddress } });
  });

  /**
   * Audit finding #7: this route was promised (the refresh cookie was
   * already being issued, scoped to this exact path) but never
   * implemented — a session's access token silently expired after 24h
   * with no way to renew it short of a full re-sign-in. Implements
   * rotation: every use consumes the current refresh token and issues a
   * new one, so a leaked/replayed old refresh token stops working the
   * moment the legitimate client rotates past it.
   */
  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const refreshToken = request.cookies["claimgame_refresh"];
    if (!refreshToken) {
      return reply.code(401).send({ error: { message: "No refresh token" } });
    }

    const session = await app.prisma.session.findUnique({ where: { refreshToken } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      reply.clearCookie("claimgame_session", { path: "/" });
      reply.clearCookie("claimgame_refresh", { path: "/api/v1/auth/refresh" });
      return reply.code(401).send({ error: { message: "Refresh token invalid or expired" } });
    }

    // Rotate: revoke the used token, issue a fresh one. Never reuse a
    // refresh token across renewals — that's what makes replay of a
    // stolen-but-already-used token detectable/ineffective.
    const newRefreshToken = crypto.randomBytes(32).toString("hex");
    await app.prisma.$transaction([
      app.prisma.session.update({ where: { refreshToken }, data: { revokedAt: new Date() } }),
      app.prisma.session.create({
        data: {
          walletAddress: session.walletAddress,
          refreshToken: newRefreshToken,
          userAgent: request.headers["user-agent"] ?? null,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      }),
    ]);

    const accessToken = jwt.sign({ sub: session.walletAddress }, env.JWT_SIGNING_SECRET, {
      expiresIn: ACCESS_TOKEN_TTL,
    });

    reply.setCookie("claimgame_session", accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
    reply.setCookie("claimgame_refresh", newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/api/v1/auth/refresh",
      maxAge: REFRESH_TOKEN_TTL_MS / 1000,
    });

    return reply.send({ data: { walletAddress: session.walletAddress } });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies["claimgame_refresh"];
    if (refreshToken) {
      await app.prisma.session.updateMany({
        where: { refreshToken, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie("claimgame_session", { path: "/" });
    reply.clearCookie("claimgame_refresh", { path: "/api/v1/auth/refresh" });
    return reply.send({ data: { ok: true } });
  });
}
