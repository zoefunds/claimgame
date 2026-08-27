import type { Metadata } from "next";
import { Sidebar } from "@/components/Sidebar";
import { MobileHeader } from "@/components/MobileHeader";
import { AppKitProvider } from "@/components/AppKitProvider";
import { WalletProvider } from "@/lib/wallet-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "CLAIMGAME — Put money behind your interpretation of a protocol.",
  description:
    "A Web3 strategy game: interpret ambiguous protocol statements, stake GEN, defend against adversarial challenges, and let GenLayer judge the evidence.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <AppKitProvider>
          <WalletProvider>
            <MobileHeader />
            <Sidebar />
            <main className="md:ml-64 pt-16 md:pt-0 min-h-screen">{children}</main>
          </WalletProvider>
        </AppKitProvider>
      </body>
    </html>
  );
}
