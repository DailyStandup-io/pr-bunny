// Generated avatars for demo mode: the demo's people are fictional, and github.com/<login>.png would
// show whoever really owns that login. A deterministic SVG per login: initials on a soft colour,
// with a geometric accent. Nothing here is derived from the bunny art.

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "amara-fenwick" → "AF", "quokka-deps[bot]" → "QD", "robin" → "RO". */
export function initials(login: string): string {
  const words = login
    .replace(/\[bot\]$/i, "")
    .split(/[-_.\s]+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function avatarSvg(login: string): string {
  const h = hash(login.toLowerCase());
  const hue = h % 360;
  const bg = `hsl(${hue} 55% 88%)`;
  const shape = `hsl(${(hue + 40) % 360} 60% 76%)`;
  const ink = `hsl(${hue} 45% 28%)`;
  const r = 18 + (h >>> 9) % 14;
  const cx = (h >>> 13) % 2 ? 64 - r / 2 : r / 2;
  const cy = (h >>> 15) % 2 ? 64 - r / 3 : r / 3;
  const bot = /\[bot\]$/i.test(login);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${escape(login)}">
<rect width="64" height="64" fill="${bg}"/>
${bot ? `<rect x="${cx - r / 2}" y="${cy - r / 2}" width="${r}" height="${r}" rx="4" fill="${shape}"/>` : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${shape}"/>`}
<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" fill="${ink}">${escape(initials(login))}</text>
</svg>`;
}
