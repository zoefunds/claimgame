import { cookieStorage, createStorage } from "@wagmi/core";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { studionetChain } from "./chains";

/**
 * Reown project id — public by design (it identifies the app to WalletConnect's
 * relay, it is not a secret). Set NEXT_PUBLIC_REOWN_PROJECT_ID in env; falls
 * back to the id provided for this project so local/dev checkouts still work
 * without extra setup.
 */
export const REOWN_PROJECT_ID =
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "138176b654e2fdc1b7f6f263b8731372";

export const networks = [studionetChain] as const;

export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId: REOWN_PROJECT_ID,
  networks: [...networks],
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
