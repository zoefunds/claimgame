import { env } from "./env";

export type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> };

/** Serializes concurrent refresh attempts into one in-flight request — if
 * three authenticated calls all 401 at once, they should trigger exactly
 * one /auth/refresh, not three races against the same rotating token. */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${env.apiBaseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function doFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${env.apiBaseUrl}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/**
 * On a 401 from an authenticated endpoint, tries the refresh-token
 * rotation route (`apps/api/src/routes/auth.ts`'s `/api/v1/auth/refresh`,
 * added to close a real gap: the refresh cookie was already being issued
 * but nothing ever consumed it, so a session silently died after 24h with
 * no way to renew short of reconnecting the wallet) and retries the
 * original request ONCE. A second 401 after a successful refresh attempt
 * is treated as genuinely unauthenticated, not retried again.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await doFetch(method, path, body);

  if (res.status === 401 && path !== "/api/v1/auth/refresh") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(method, path, body);
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message ?? `Request failed: ${res.status}`);
  }
  const json = (await res.json()) as ApiEnvelope<T>;
  return json.data;
}

/** Thin fetch wrapper for the CACHE-layer read API (docs/architecture.md
 * §16). Never used for anything authoritative about funds/verdicts — those
 * reads go straight to the contract via lib/contract.ts. */
export async function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

/** Session-establishing / NATIVE-data writes (auth, profile). Always sent
 * with credentials so the httpOnly session cookie round-trips. */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PATCH", path, body);
}
