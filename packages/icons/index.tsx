// The icons PR Bunny draws with (see scripts/generate.ts for free vs Pro).
import { HugeiconsIcon } from "@hugeicons/react";
import { ICON_SET, icons } from "./generated/icons";

export { ICON_SET, icons };
export type IconName = keyof typeof icons;

/** An icon in currentColor, `size` px square. */
export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return <HugeiconsIcon icon={icons[name]} size={size} strokeWidth={1.5} color="currentColor" className={className} aria-hidden />;
}
