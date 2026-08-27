// Public config only — every value here is safe to ship to the browser.
// Server-only secrets never live in this file or in any NEXT_PUBLIC_* var.
export const env = {
  contractAddress: process.env.NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS ?? "",
  genlayerRpcUrl: process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "",
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080",
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 0),
};

if (!env.contractAddress) {
  // eslint-disable-next-line no-console
  console.warn(
    "NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS is not set — contract reads/writes will fail. " +
      "Copy .env.example to apps/web/.env.local.",
  );
}

/** The `studionet` chain constant from genlayer-js already carries the
 * correct StudioNet RPC URL (https://studio.genlayer.com/api) and chain id
 * (61999) — confirmed by inspecting the installed genlayer-js@1.1.8
 * package directly. `NEXT_PUBLIC_GENLAYER_RPC_URL` is only needed if you
 * want to override that default (e.g. a private StudioNet gateway), so it
 * is not required here — only the contract address is. */
export function getContractConfig(): { address: `0x${string}` } {
  if (!env.contractAddress) {
    throw new Error(
      "GenLayer contract is not configured — check NEXT_PUBLIC_CLAIMGAME_CONTRACT_ADDRESS",
    );
  }
  return { address: env.contractAddress as `0x${string}` };
}
