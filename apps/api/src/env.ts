import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SIGNING_SECRET: z.string().min(32, "JWT_SIGNING_SECRET must be at least 32 chars"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  CLAIMGAME_CONTRACT_ADDRESS: z.string().min(1, "CLAIMGAME_CONTRACT_ADDRESS is required"),
  // studionet's baked-in RPC (https://studio.genlayer.com/api) is used by
  // default — this only overrides it. See apps/web/lib/env.ts for the
  // confirmation of that default, pulled directly from genlayer-js@1.1.8.
  GENLAYER_RPC_URL: z.string().optional(),
  NEXT_PUBLIC_CHAIN_ID: z.coerce.number().default(61999),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validates process.env once and caches the result. Never read
 * process.env directly outside this module — this is the single point
 * where a missing/malformed secret fails loudly at boot instead of
 * silently at first use. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
