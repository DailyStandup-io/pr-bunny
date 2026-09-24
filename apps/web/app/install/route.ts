// `curl -fsSL https://prbunny.dev/install | sh`: the installer, straight from the app's source
// (apps/app/scripts/install.sh), baked in at build time.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const dynamic = "force-static";

const script = readFileSync(join(process.cwd(), "..", "app", "scripts", "install.sh"), "utf8");

export function GET() {
  return new Response(script, {
    headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
