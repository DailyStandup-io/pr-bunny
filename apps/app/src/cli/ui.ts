// Terminal output for `bunny setup`: colours, spinners, prompts, and running commands with live
// progress. Plain text when stdout isn't a terminal (CI, logs) or NO_COLOR is set.
import { openSync, closeSync, readSync } from "node:fs";

const tty = Boolean(process.stdout.isTTY);
const colour = tty && !process.env.NO_COLOR;
const esc = (code: string) => (s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: esc("1"),
  dim: esc("2"),
  red: esc("31"),
  green: esc("32"),
  yellow: esc("33"),
  cyan: esc("36"),
  /** PR Bunny's rose accent. */
  rose: esc("38;2;214;96;124"),
};

const clearLine = () => tty && process.stdout.write("\r\x1b[2K");
const cols = () => process.stdout.columns || 80;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const icons = { ok: c.green("✓"), todo: c.yellow("○"), bad: c.red("✗"), note: c.cyan("›"), ask: c.rose("?") };

export function header(title: string, sub: string) {
  console.log(`\n  ${c.rose("●")} ${c.bold(title)} ${c.dim(sub)}\n`);
}

export function section(title: string) {
  console.log(`\n${c.bold(title)}`);
}

export const line = (icon: string, text: string, hint?: string) => console.log(`${icon} ${text}${hint ? `  ${c.dim(`→ ${hint}`)}` : ""}`);
export const note = (text: string) => console.log(`  ${icons.note} ${text}`);
export const detail = (text: string) => console.log(`  ${c.dim(text)}`);

/** A spinner on one line: text, elapsed seconds, and an optional dim status (e.g. a command's latest output). */
export function spinner(text: string) {
  let status = "";
  let i = 0;
  const started = Date.now();
  const draw = () => {
    if (!tty) return;
    const secs = Math.floor((Date.now() - started) / 1000);
    const time = secs >= 2 ? c.dim(` ${secs}s`) : "";
    const head = `${c.rose(FRAMES[i++ % FRAMES.length]!)} ${text}`;
    const room = cols() - text.length - 12;
    const tail = status && room > 10 ? `  ${c.dim(truncate(status, room))}` : "";
    clearLine();
    process.stdout.write(`${head}${time}${tail}`);
  };
  const timer = tty ? setInterval(draw, 80) : null;
  draw();
  const end = (icon: string, msg: string, hint?: string) => {
    if (timer) clearInterval(timer);
    clearLine();
    line(icon, msg, hint);
  };
  return {
    status: (s: string) => (status = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim()),
    text: (t: string) => (text = t),
    ok: (msg = text) => end(icons.ok, msg),
    todo: (msg = text, hint?: string) => end(icons.todo, msg, hint),
    fail: (msg = text, hint?: string) => end(icons.bad, msg, hint),
    /** Stop without printing (e.g. before handing the terminal to a prompt). */
    stop: () => {
      if (timer) clearInterval(timer);
      clearLine();
    },
  };
}

/**
 * Asks a yes/no question. Reads one line straight from /dev/tty and closes it again, so the
 * terminal is free for whatever runs next (brew, sudo's password prompt). Without a terminal
 * (CI, piped input) it takes the default.
 */
export function ask(question: string, yes = true): boolean {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r");
  } catch {
    return yes;
  }
  process.stdout.write(`${icons.ask} ${question} ${c.dim(yes ? "(Y/n)" : "(y/N)")} `);
  const buf = Buffer.alloc(1);
  let answer = "";
  try {
    while (readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) answer += String.fromCharCode(buf[0]!);
  } finally {
    closeSync(fd);
  }
  answer = answer.trim();
  return answer ? /^y/i.test(answer) : yes;
}

/**
 * Runs a command under a spinner, showing its latest output line and the elapsed time. Output is
 * kept, and its last lines are printed if the command fails. Nothing can be typed into it, so use
 * `interactive` for anything that asks questions.
 */
export async function task(label: string, cmd: string[], env: Record<string, string> = {}): Promise<boolean> {
  const spin = spinner(label);
  const started = Date.now();
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const lines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const parts = rest.split(/\r?\n|\r/);
      rest = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) {
        lines.push(p);
        spin.status(p);
      }
    }
    if (rest.trim()) lines.push(rest);
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const ok = (await proc.exited) === 0;
  if (ok) spin.ok(`${label} ${c.dim(`· ${Math.max(1, Math.round((Date.now() - started) / 1000))}s`)}`);
  else {
    spin.fail(label, `\`${cmd.join(" ")}\` exited with code ${proc.exitCode}`);
    for (const l of lines.slice(-15)) console.log(`    ${c.dim(l)}`);
  }
  return ok;
}

/** Runs a command attached to the terminal, for things that ask questions (gh auth login, sudo). */
export async function interactive(cmd: string[], env: Record<string, string> = {}): Promise<boolean> {
  console.log(`  ${c.dim(`$ ${cmd.join(" ")}`)}`);
  const p = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, ...env } });
  return (await p.exited) === 0;
}

/** Ask for the sudo password up front (on its own line, no spinner), so the next sudo command can run under one. */
export async function sudoUpfront(why: string): Promise<boolean> {
  const cached = Bun.spawnSync(["sudo", "-n", "true"], { stdio: ["ignore", "ignore", "ignore"] });
  if (cached.exitCode === 0) return true;
  note(`${why} needs your password (sudo).`);
  const p = Bun.spawn(["sudo", "-v"], { stdio: ["inherit", "inherit", "inherit"] });
  return (await p.exited) === 0;
}
