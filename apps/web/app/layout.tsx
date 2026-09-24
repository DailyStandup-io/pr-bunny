import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const sans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://prbunny.dev"),
  title: "PR Bunny — free AI code review from your terminal",
  description:
    "PR Bunny reviews code with the Claude Code or Codex you're already signed in to. It runs on your Mac, and nothing reaches GitHub until you press Post.",
  openGraph: { title: "PR Bunny", description: "A second pair of ears on every pull request. Free, no account, no API keys.", url: "https://prbunny.dev" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f3" },
    { media: "(prefers-color-scheme: dark)", color: "#1c1b19" },
  ],
};

// Set the theme before first paint: the saved choice, else the OS setting.
const themeScript = `try{var t=localStorage.getItem("pb:theme");document.documentElement.dataset.theme=t==="light"||t==="dark"?t:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Only the icons the page uses. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..24,400,0..1,0&icon_names=check,check_circle,content_copy&display=block"
        />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
