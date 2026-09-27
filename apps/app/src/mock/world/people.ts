// The fictional org and its people. None of these are real accounts; in demo mode every avatar is
// generated locally (src/mock/avatar.ts), so no real GitHub photo is ever loaded for them.
import type { Person } from "../types";

export const ORG = "quokka-labs";

/** The signed-in user in the demo (the "you" of the video). */
export const VIEWER: Person & { email: string } = { login: "robin-vale", name: "Robin Vale", email: "robin.vale@quokka-labs.example" };

export const PEOPLE: Person[] = [
  VIEWER,
  { login: "amara-fenwick", name: "Amara Fenwick" },
  { login: "jonah-pike", name: "Jonah Pike" },
  { login: "lena-okoro", name: "Lena Okoro" },
  { login: "yuki-brenner", name: "Yuki Brenner" },
  { login: "dmitri-ashgrove", name: "Dmitri Ashgrove" },
  { login: "hana-lindqvist", name: "Hana Lindqvist" },
  { login: "felix-oduya", name: "Felix Oduya" },
  { login: "sol-hartley", name: "Sol Hartley" },
  { login: "marco-tilde", name: "Marco Tilde" },
  { login: "priya-castell", name: "Priya Castell" },
  { login: "quokka-deps[bot]", name: "quokka-deps" },
];

export const person = (login: string): Person => PEOPLE.find((p) => p.login === login) ?? { login, name: login };
export const emailOf = (login: string) => (login === VIEWER.login ? VIEWER.email : `${login.replace(/\[bot\]$/, "")}@quokka-labs.example`);

/**
 * Dedents a template literal so fixture files can be indented with the code around them. Strips the
 * first newline and the common leading indentation, and ends the text with exactly one newline.
 */
export function code(strings: TemplateStringsArray, ...values: unknown[]): string {
  // Cooked strings: \` and \${ come out as ` and ${. (Fixture code avoids other backslashes.)
  const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""), "");
  const text = raw.replace(/^\n/, "").replace(/\s+$/, "");
  const indents = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.match(/^ */)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return `${text
    .split("\n")
    .map((l) => l.slice(cut))
    .join("\n")}\n`;
}
