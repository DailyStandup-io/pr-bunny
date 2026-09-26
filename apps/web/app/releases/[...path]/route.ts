// prbunny.dev/releases/*: counts the request, then redirects to the release file. The installer and
// the app's updater only need to know prbunny.dev, and storage can move later: release files live on
// GitHub Releases (tag v<version>), or RELEASES_ORIGIN, a host laid out like dist/
// (<origin>/latest, <origin>/latest.json, <origin>/<version>/<file>).
//
// What's counted (lib/counts.ts), after the response is sent so it never delays or breaks a download:
//   /releases/<version>/bunny-<os-arch>?arch=<os-arch>   install.sh's download: one install
//   /releases/latest.json?v=<version>                    the updater's check, by the running version
//   /releases/<version>/bunny-<os-arch>?from=<v>         the updater's download: one update
// Only the binaries count (not their .sha256 or anything else under a version).
import { after, type NextRequest } from "next/server";
import { ARCHES, arch, record, version, type Count } from "@/lib/counts";

export const dynamic = "force-dynamic";

const GITHUB = "https://github.com/DailyStandup-io/pr-bunny/releases";
const BINARIES = ARCHES.map((a) => `bunny-${a}`);

/** Where a release path redirects to (the same URLs next.config.ts used to redirect to). */
function destination(path: string[]): string | null {
  const origin = process.env.RELEASES_ORIGIN?.replace(/\/+$/, "");
  if (origin) return `${origin}/${path.map(encodeURIComponent).join("/")}`;
  const [a, b] = path.map(encodeURIComponent);
  if (path.length === 1 && a === "latest.json") return `${GITHUB}/latest/download/latest.json`;
  if (path.length === 1 && a === "latest") return `${GITHUB}/latest/download/latest`;
  if (path.length === 2) return `${GITHUB}/download/v${a}/${b}`;
  return null;
}

function redirect(to: string | null) {
  // 307, like the config redirects this replaces; no-store so every request reaches the counter.
  if (!to) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 307, headers: { location: to, "cache-control": "no-store" } });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { path } = await params;
  const to = destination(path);
  const q = req.nextUrl.searchParams;
  if (to) {
    try {
      const count = classify(path, q);
      if (count) after(() => record(count).catch(() => {}));
    } catch {}
  }
  return redirect(to);
}

// `curl -I` and link checkers: same redirect, not counted.
export async function HEAD(_req: NextRequest, { params }: Ctx) {
  return redirect(destination((await params).path));
}

function classify(path: string[], q: URLSearchParams): Count | null {
  if (path.length === 1 && path[0] === "latest.json") return { kind: "check", version: version(q.get("v")) };
  if (path.length !== 2 || !BINARIES.includes(path[1]!)) return null;
  if (q.has("from")) return { kind: "update", from: version(q.get("from")), to: version(path[0]) };
  if (q.has("arch")) return { kind: "install", arch: arch(q.get("arch")), version: version(path[0]) };
  return null;
}
