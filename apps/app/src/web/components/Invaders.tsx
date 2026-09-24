// An easter egg: ↑↑↓↓←→←→BA opens a small Invaders game, drawn in the theme's colours.
import { useEffect, useRef } from "react";

const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];

/**
 * Watches for the Konami code (in the capture phase, so the final "a" doesn't also accept a finding)
 * and calls `onCode`. While `blocking`, every key goes to the game instead of the page.
 */
export function useKonami(onCode: () => void, blocking: boolean) {
  const idx = useRef(0);
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (blocking) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = (e.key || "").toLowerCase();
      idx.current = k === KONAMI[idx.current] ? idx.current + 1 : k === KONAMI[0] ? 1 : 0;
      if (idx.current === KONAMI.length) {
        idx.current = 0;
        e.preventDefault();
        e.stopImmediatePropagation();
        cb.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [blocking]);
}

interface Alien {
  x: number;
  y: number;
  row: number;
}
interface Game {
  W: number;
  H: number;
  px: number;
  score: number;
  lives: number;
  wave: number;
  state: "play" | "over" | "won";
  t: number;
  aliens: Alien[];
  dir: number;
  shots: Array<{ x: number; y: number }>;
  bullet: { x: number; y: number } | null;
  fireT: number;
  hitT: number;
}

function newWave(g: Game) {
  g.aliens = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) g.aliens.push({ x: 60 + c * 40, y: 44 + r * 28, row: r });
  g.dir = 1;
  g.shots = [];
  g.bullet = null;
  g.fireT = 1.2;
}

export function Invaders({ onClose }: { onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const keys: Record<string, boolean> = {};
    let fire = false;
    const W = 480;
    const H = 360;
    const g: Game = { W, H, px: W / 2, score: 0, lives: 3, wave: 1, state: "play", t: 0, aliens: [], dir: 1, shots: [], bullet: null, fireT: 1.2, hitT: 0 };
    newWave(g);

    // Keys go to the game only; the page underneath doesn't see them.
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      const k = e.key;
      if (down && k === "Escape") return onClose();
      if (k === "ArrowLeft" || k === "ArrowRight" || k === " " || k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        if (down && k === " " && !keys[" "]) fire = true;
        keys[k] = down;
      }
    };
    const kd = onKey(true);
    const ku = onKey(false);
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);

    const step = (dt: number) => {
      const shoot = fire;
      fire = false;
      g.t += dt;
      if (g.state !== "play") {
        if (shoot) {
          if (g.state === "won") g.wave++;
          else Object.assign(g, { score: 0, lives: 3, wave: 1 });
          g.state = "play";
          newWave(g);
        }
        return;
      }
      const py = H - 30;
      if (keys.ArrowLeft) g.px -= 240 * dt;
      if (keys.ArrowRight) g.px += 240 * dt;
      g.px = Math.max(18, Math.min(W - 18, g.px));
      if (shoot && !g.bullet) g.bullet = { x: g.px, y: py - 10 };
      if (g.bullet) {
        g.bullet.y -= 460 * dt;
        if (g.bullet.y < 0) g.bullet = null;
      }
      const speed = (18 + (32 - g.aliens.length) * 3.2) * (1 + (g.wave - 1) * 0.25);
      let edge = false;
      for (const a of g.aliens) {
        a.x += g.dir * speed * dt;
        if (a.x < 14 || a.x > W - 36) edge = true;
      }
      if (edge) {
        g.dir *= -1;
        for (const a of g.aliens) {
          a.x += g.dir * speed * dt;
          a.y += 14;
        }
      }
      if (g.bullet) {
        const b = g.bullet;
        const i = g.aliens.findIndex((a) => b.x > a.x && b.x < a.x + 22 && b.y > a.y && b.y < a.y + 16);
        if (i >= 0) {
          g.score += (4 - g.aliens[i]!.row) * 10;
          g.aliens.splice(i, 1);
          g.bullet = null;
        }
      }
      g.fireT -= dt;
      if (g.fireT <= 0 && g.aliens.length) {
        const cols: Record<number, Alien> = {};
        for (const a of g.aliens) if (!cols[a.x] || cols[a.x]!.y < a.y) cols[a.x] = a;
        const bottoms = Object.values(cols);
        const s = bottoms[Math.floor(Math.random() * bottoms.length)]!;
        g.shots.push({ x: s.x + 11, y: s.y + 16 });
        g.fireT = Math.max(0.35, 1.1 - g.wave * 0.1) + Math.random() * 0.5;
      }
      for (const s of g.shots) s.y += 190 * dt;
      g.shots = g.shots.filter((s) => {
        if (s.y > py - 6 && s.y < py + 10 && Math.abs(s.x - g.px) < 16) {
          g.lives--;
          g.hitT = 0.4;
          return false;
        }
        return s.y < H;
      });
      if (g.hitT) g.hitT = Math.max(0, g.hitT - dt);
      if (g.lives <= 0 || g.aliens.some((a) => a.y + 16 > py - 6)) g.state = "over";
      else if (!g.aliens.length) g.state = "won";
    };

    const draw = () => {
      const cv = canvas.current;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== W * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(document.documentElement);
      const v = (n: string) => css.getPropertyValue(n).trim();
      const text = v("--text");
      const text3 = v("--text-3");
      const accent = v("--accent");
      const del = v("--del");
      const code = v("--code");
      ctx.fillStyle = code;
      ctx.fillRect(0, 0, W, H);
      ctx.font = "500 12px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "top";
      ctx.fillStyle = text3;
      ctx.textAlign = "left";
      ctx.fillText("SCORE " + String(g.score).padStart(4, "0"), 14, 12);
      ctx.textAlign = "right";
      ctx.fillText("LIVES " + "▲".repeat(Math.max(0, g.lives)), W - 14, 12);
      const frame = Math.floor(g.t * 2) % 2;
      for (const a of g.aliens) {
        const c = a.row === 0 ? del : text;
        ctx.fillStyle = c;
        ctx.fillRect(a.x + 4, a.y, 14, 10);
        ctx.fillRect(a.x, a.y + 4, 22, 5);
        ctx.fillStyle = code;
        ctx.fillRect(a.x + 7, a.y + 3, 2, 2);
        ctx.fillRect(a.x + 13, a.y + 3, 2, 2);
        ctx.fillStyle = c;
        if (frame) {
          ctx.fillRect(a.x + 2, a.y + 10, 3, 5);
          ctx.fillRect(a.x + 17, a.y + 10, 3, 5);
        } else {
          ctx.fillRect(a.x + 6, a.y + 10, 3, 5);
          ctx.fillRect(a.x + 13, a.y + 10, 3, 5);
        }
      }
      const py = H - 30;
      if (!(g.hitT && Math.floor(g.hitT * 20) % 2)) {
        ctx.fillStyle = accent;
        ctx.fillRect(g.px - 14, py + 4, 28, 8);
        ctx.fillRect(g.px - 3, py - 2, 6, 6);
      }
      if (g.bullet) {
        ctx.fillStyle = accent;
        ctx.fillRect(g.bullet.x - 1, g.bullet.y, 2, 10);
      }
      ctx.fillStyle = del;
      for (const s of g.shots) ctx.fillRect(s.x - 1.5, s.y, 3, 8);
      ctx.fillStyle = v("--line-strong");
      ctx.fillRect(0, H - 12, W, 1);
      if (g.state !== "play") {
        ctx.fillStyle = v("--surface");
        ctx.globalAlpha = 0.85;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = text;
        ctx.font = "600 22px 'IBM Plex Sans', sans-serif";
        ctx.fillText(g.state === "won" ? "Wave cleared" : "Game over", W / 2, H / 2 - 14);
        ctx.fillStyle = text3;
        ctx.font = "400 13px 'IBM Plex Mono', monospace";
        ctx.fillText(`Score ${g.score} · Space ${g.state === "won" ? "for next wave" : "to restart"}`, W / 2, H / 2 + 16);
      }
    };

    let last = performance.now();
    let raf = requestAnimationFrame(function loop(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
      draw();
      raf = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
    };
  }, [onClose]);

  return (
    <div onClick={onClose} className="fixed inset-0 z-[100] grid place-items-center bg-[oklch(0.2_0.01_80/0.45)] p-4">
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invaders" className="w-[min(100%,528px)] overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop-lg">
        <header className="flex items-center gap-2.5 border-b border-line py-3 pr-3 pl-[18px]">
          <span className="flex-1 text-[14px] font-semibold">Invaders</span>
          <button onClick={onClose} aria-label="Close" className="grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-fg-3 hover:bg-hover">
            <span className="sym" style={{ fontSize: 20 }}>
              close
            </span>
          </button>
        </header>
        <div className="p-4">
          <canvas ref={canvas} className="block aspect-[4/3] w-full rounded-lg bg-code" />
        </div>
        <div className="flex flex-wrap gap-4 border-t border-line bg-sunken px-[18px] py-2 text-[12px] text-fg-3">
          <span>
            <span className="font-mono">← →</span> move
          </span>
          <span>
            <span className="font-mono">Space</span> fire
          </span>
          <span>
            <span className="font-mono">Esc</span> close
          </span>
        </div>
      </div>
    </div>
  );
}
