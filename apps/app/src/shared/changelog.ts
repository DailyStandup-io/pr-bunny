// Parses CHANGELOG.md into release notes for the update popup and What's new. The changelog's
// shape (see the release skill): `## <version> “<codename>” — <YYYY-MM-DD>`, then `### Added`,
// `### Changed`, `### Fixed` with `- ` bullets, continuation lines indented. An Added bullet that
// starts with `**Title.**` becomes a highlight card; everything else is a line of text.

export interface NoteItem {
  /** The bold lead-in without its markers and trailing full stop, e.g. "Merge from PR Bunny". */
  title: string | null;
  /** The rest of the bullet (or all of it, with no title), with `code` and **bold** kept. */
  text: string;
}

export interface ReleaseNotes {
  version: string;
  name: string;
  /** YYYY-MM-DD */
  date: string | null;
  added: NoteItem[];
  changed: NoteItem[];
  fixed: NoteItem[];
}

const HEAD = /^## (\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s+[“"]([^”"]+)[”"])?(?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(md: string): ReleaseNotes[] {
  const out: ReleaseNotes[] = [];
  let rel: ReleaseNotes | null = null;
  let section: "added" | "changed" | "fixed" | null = null;
  let bullet: string[] | null = null;
  const flush = () => {
    if (rel && section && bullet) rel[section].push(noteItem(bullet.join(" ")));
    bullet = null;
  };
  for (const line of md.split("\n")) {
    const head = line.match(HEAD);
    if (head) {
      flush();
      rel = { version: head[1]!, name: head[2] ?? "", date: head[3] ?? null, added: [], changed: [], fixed: [] };
      out.push(rel);
      section = null;
    } else if (line.startsWith("## ")) {
      flush();
      rel = null;
    } else if (line.startsWith("### ")) {
      flush();
      const h = line.slice(4).trim().toLowerCase();
      section = h.startsWith("add") ? "added" : h.startsWith("fix") ? "fixed" : "changed";
    } else if (/^[-*] /.test(line)) {
      flush();
      bullet = [line.slice(2).trim()];
    } else if (bullet && /^\s+\S/.test(line)) {
      bullet.push(line.trim());
    } else if (!line.trim()) {
      flush();
    }
  }
  flush();
  return out;
}

function noteItem(raw: string): NoteItem {
  const m = raw.match(/^\*\*(.+?)\*\*\s*(.*)$/);
  if (!m) return { title: null, text: raw };
  return { title: m[1]!.replace(/[.:]\s*$/, ""), text: m[2]! };
}

/** A release with only fixes: What's new gives it a small note by the bunny, not a dialog. */
export const fixesOnly = (n: ReleaseNotes) => !n.added.length && !n.changed.length && n.fixed.length > 0;
