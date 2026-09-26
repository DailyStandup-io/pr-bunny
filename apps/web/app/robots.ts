import type { MetadataRoute } from "next";

// /stats is private (and noindex); /releases/* are redirects to release files.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/stats", "/releases/"] } };
}
