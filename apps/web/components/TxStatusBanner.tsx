import type { TxStatus } from "@/lib/types";

const LABELS: Record<TxStatus, string> = {
  idle: "",
  preparing: "Preparing transaction…",
  wallet_prompt: "Confirm in your wallet…",
  submitted: "Submitted — waiting for network…",
  pending: "Pending consensus (Proposing → Committing → Revealing)…",
  confirmed: "Accepted — waiting for finalization…",
  success: "Finalized.",
  rejected: "Rejected in wallet.",
  failed: "Transaction failed.",
  timed_out: "Timed out waiting for finalization — check the transaction manually.",
  unknown: "Unknown result — this needs manual verification, it was not marked successful.",
};

const ERROR_STATES: TxStatus[] = ["rejected", "failed", "timed_out", "unknown"];

export function TxStatusBanner({ status }: { status: TxStatus }) {
  if (status === "idle") return null;
  const isError = ERROR_STATES.includes(status);
  const isSuccess = status === "success";
  return (
    <div
      className={
        "font-code-sm text-code-sm px-3 py-2 rounded border " +
        (isError
          ? "border-error/30 bg-error/10 text-error"
          : isSuccess
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-outline-variant bg-surface-container text-on-surface-variant")
      }
    >
      {LABELS[status]}
    </div>
  );
}
