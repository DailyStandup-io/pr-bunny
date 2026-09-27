import type { NextConfig } from "next";

// /releases/* is app/releases/[...path]/route.ts: it counts installs and update checks, then
// redirects to GitHub Releases (or RELEASES_ORIGIN).
const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/install.sh", destination: "/install" }];
  },
};

export default nextConfig;
