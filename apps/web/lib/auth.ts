import { apiPost } from "./api";

type NonceResponse = { nonce: string; issuedAt: string; message: string };

/**
 * Completes the backend's sign-in-with-wallet flow (apps/api/src/routes/
 * auth.ts): fetch a nonce, sign the returned message with the connected
 * wallet, then verify — on success the backend sets an httpOnly session
 * cookie. This is what makes "connected" also mean "authenticated" for
 * NATIVE-data features (profile display name, notifications); on-chain
 * reads/writes never needed this and keep working regardless.
 */
export async function signInWithWallet(
  address: `0x${string}`,
  signMessageAsync: (args: { message: string }) => Promise<string>,
): Promise<void> {
  const { nonce, issuedAt, message } = await apiPost<NonceResponse>("/api/v1/auth/nonce", {
    walletAddress: address,
  });
  const signature = await signMessageAsync({ message });
  await apiPost("/api/v1/auth/verify", { walletAddress: address, nonce, signature, issuedAt });
}

export async function signOut(): Promise<void> {
  await apiPost("/api/v1/auth/logout").catch(() => {
    /* session may already be gone server-side */
  });
}
