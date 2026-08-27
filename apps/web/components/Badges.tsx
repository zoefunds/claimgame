import clsx from "clsx";
import type { ClaimStatus, Difficulty } from "@/lib/types";

const DIFFICULTY_STYLES: Record<Difficulty, string> = {
  EASY: "text-outline bg-outline/10 border-outline/30",
  AMBIGUOUS: "text-secondary bg-secondary/10 border-secondary/30",
  HARD: "text-tertiary-container bg-tertiary-container/10 border-tertiary-container/30",
  EXTREME: "text-error bg-error/10 border-error/30",
};

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span
      className={clsx(
        "font-data-label text-data-label px-2 py-0.5 rounded uppercase border",
        DIFFICULTY_STYLES[difficulty],
      )}
    >
      {difficulty}
    </span>
  );
}

const STATUS_LABELS: Record<ClaimStatus, string> = {
  OPEN: "Open for Challenge",
  CHALLENGED: "Under Challenge",
  UNDER_REVIEW: "GenLayer Reviewing",
  PENDING_APPEAL: "Verdict Reached — Appeal Window Open",
  RESOLVED_MERGE: "Resolved — Interpretation Upheld",
  RESOLVED_REJECT: "Resolved — Challenge Won",
  RESOLVED_PARTIAL: "Resolved — Partial",
  NEEDS_HUMAN_REVIEW: "Needs Human Review",
  RESOLVED_DISPUTE_TIMEOUT: "Resolved — Timeout",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
};

export function StatusBadge({ status }: { status: ClaimStatus }) {
  const active = status === "OPEN" || status === "CHALLENGED";
  return (
    <span
      className={clsx(
        "font-data-label text-data-label px-2 py-1 rounded uppercase tracking-widest border flex items-center gap-2 w-fit",
        active ? "text-error border-error/30 bg-error/10" : "text-on-surface-variant border-outline-variant bg-surface-container-high",
      )}
    >
      {active && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-error opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-error" />
        </span>
      )}
      {STATUS_LABELS[status]}
    </span>
  );
}

export function GenAmount({ baseUnits }: { baseUnits: string }) {
  const gen = Number(BigInt(baseUnits || "0")) / 1e18;
  return <span className="font-code-sm text-code-sm text-primary">{gen.toLocaleString(undefined, { maximumFractionDigits: 2 })} GEN</span>;
}
