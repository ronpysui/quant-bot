import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quant Scalp Bot",
  description: "Crypto scalping bot with backtesting & Monte Carlo simulation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-white">{children}</body>
    </html>
  );
}
