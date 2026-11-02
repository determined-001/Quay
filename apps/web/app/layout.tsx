import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

/*
 * Typefaces are local files, not `next/font/google`: the Google loader fetches
 * the font at build time, so an offline or firewalled build (CI, a docker
 * layer) would fail on a cosmetic dependency. Geist is SIL OFL 1.1, so the
 * variable WOFF2 files can live in the repo.
 */
const geist = localFont({
  src: "./fonts/geist-variable.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-variable.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Quay — non-custodial checkout on Stellar", template: "%s · Quay" },
  description:
    "Payment links, a hosted checkout and an embeddable widget for USDC on Stellar. Buyers pay from their own wallet, funds go straight to yours, and you can cash out to local currency through a Stellar anchor.",
  openGraph: {
    title: "Quay — non-custodial checkout on Stellar",
    description: "Get paid in USDC without handing anyone your keys.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#080c0b" },
  ],
  colorScheme: "dark light",
};

/**
 * Applies a saved light/dark choice before first paint, so a returning visitor
 * never sees the other theme flash. "System" stores nothing and needs nothing:
 * the stylesheet follows prefers-color-scheme on its own. Keep the key in step
 * with THEME_KEY in components/ThemeToggle.tsx.
 */
const THEME_BOOT = `try{var t=localStorage.getItem("quay-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script sets data-theme on <html> before
    // React hydrates, which is the one attribute React would otherwise flag.
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
