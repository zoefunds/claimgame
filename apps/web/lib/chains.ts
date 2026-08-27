import { defineChain } from "@reown/appkit/networks";

/**
 * StudioNet as a Reown AppKit / wagmi network — field values copied from
 * genlayer-js's own `studionet` export (`genlayer-js/chains`), confirmed
 * by inspecting the installed package directly: chain id 61999, RPC
 * https://studio.genlayer.com/api, native currency GEN. AppKit needs its
 * own chain definition (it doesn't know about genlayer-js's internal chain
 * object), so this is kept in sync with that source by hand — if GenLayer
 * ever changes StudioNet's id/RPC, update both.
 */
export const studionetChain = defineChain({
  id: 61999,
  caipNetworkId: "eip155:61999",
  chainNamespace: "eip155",
  name: "Genlayer Studio Network",
  nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://studio.genlayer.com/api"] },
  },
  blockExplorers: {
    default: { name: "GenLayer Explorer", url: "https://genlayer-explorer.vercel.app" },
  },
});
