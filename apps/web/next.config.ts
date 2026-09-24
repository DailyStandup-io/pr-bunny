import type { NextConfig } from "next";

// Release files live on GitHub Releases (tag v<version>). prbunny.dev/releases/* redirects there, so
// the installer and the app's updater only need to know prbunny.dev, and storage can move later
// (set RELEASES_ORIGIN to a host laid out like dist/: <origin>/latest.json, <origin>/<version>/<file>).
const GITHUB = "https://github.com/DailyStandup-io/pr-bunny/releases";
const origin = process.env.RELEASES_ORIGIN?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/install.sh", destination: "/install" }];
  },
  async redirects() {
    const to = (path: string) => ({ destination: path, permanent: false });
    return origin
      ? [{ source: "/releases/:path*", ...to(`${origin}/:path*`) }]
      : [
          // "latest" follows GitHub's newest (non-draft, non-prerelease) release.
          { source: "/releases/latest.json", ...to(`${GITHUB}/latest/download/latest.json`) },
          { source: "/releases/latest", ...to(`${GITHUB}/latest/download/latest`) },
          { source: "/releases/:version/:file", ...to(`${GITHUB}/download/v:version/:file`) },
        ];
  },
};

export default nextConfig;
