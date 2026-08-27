import Link from "next/link";
import { WalletButton } from "./WalletButton";

const NAV_ITEMS = [
  { href: "/claims", label: "Hunt Board" },
  { href: "/my-cases", label: "My Cases" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/profile", label: "Profile" },
] as const;

const FOOTER_ITEMS = [
  { href: "/how-it-works", label: "Support" },
  { href: "/settings", label: "Settings" },
] as const;

export function Sidebar() {
  return (
    <nav className="hidden md:flex flex-col fixed left-0 top-0 h-screen z-40 py-stack-md w-64 bg-surface-container border-r border-outline-variant">
      <div className="px-container-padding mb-8">
        <Link href="/" className="block font-headline-md text-headline-md text-primary mb-6 text-center">
          CLAIMGAME
        </Link>
        <WalletButton />
        <Link
          href="/claims/new"
          className="mt-4 w-full block text-center bg-primary text-on-primary py-2 px-4 rounded font-data-label text-data-label hover:bg-primary-fixed-dim transition-colors"
        >
          NEW CLAIM
        </Link>
      </div>
      <div className="flex-1 px-3 space-y-1">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 px-3 py-2 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-all"
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="px-3 mt-auto space-y-1">
        {FOOTER_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 px-3 py-2 rounded text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-all"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
