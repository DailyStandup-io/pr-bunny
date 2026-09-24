import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { existsSync } from "node:fs";
import { join } from "node:path";
import "./globals.css";

const sans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

const TITLE = "PR Bunny — free AI code review from your terminal";
const SHORT = "A second pair of ears on every pull request.";
const DESCRIPTION =
  "PR Bunny reviews code with the Claude Code or Codex you're already signed in to. It runs on your Mac, and nothing reaches GitHub until you press Post.";

// The social preview image (app/opengraph-image.png, twitter-image.png) comes from the licensed art
// and only exists in builds that have it; Next adds its og:image / twitter:image tags itself. Without
// it, the tags below still give a proper text card.
const hasSocialImage = existsSync(join(process.cwd(), "app", "opengraph-image.png"));

export const metadata: Metadata = {
  metadataBase: new URL("https://prbunny.dev"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "PR Bunny",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "https://prbunny.dev",
    siteName: "PR Bunny",
    title: `PR Bunny — ${SHORT}`,
    description: "Free AI code review with the Claude Code or Codex you already use. No API keys, macOS.",
    locale: "en_GB",
  },
  twitter: {
    card: hasSocialImage ? "summary_large_image" : "summary",
    title: `PR Bunny — ${SHORT}`,
    description: "Free AI code review with the Claude Code or Codex you already use. No API keys, macOS.",
  },
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
