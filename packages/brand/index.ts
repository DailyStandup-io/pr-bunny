// PR Bunny's art. The faces and favicons are licensed and only present when packages/brand/private/
// has them (see scripts/generate.ts); otherwise they're null and callers leave the images out.
export { HAS_ART, faces, icon32, appleTouchIcon } from "./generated/art";
import { faces } from "./generated/art";

/** Face 1–10 (bunny-1 … bunny-10), or null in builds without the art. */
export const face = (n: number): string | null => faces?.[n - 1] ?? null;
