import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AnimatePresence, animate, motion } from "framer-motion";

/* ──────────────────────────────────────────────────────────────────────────
 * Types & constants
 * ────────────────────────────────────────────────────────────────────────── */

type GameId = "sound" | "color" | "time";
type Mode = "practice" | "daily";

interface RoundResult {
  score: number;
  guess: number;
  target: number;
}

type Difficulty = "gentle" | "balanced" | "strict";

interface Session {
  targets: number[];
  results: (RoundResult | null)[];
  cursor: number;
  dateStr: string;
  difficulty: Difficulty;
}

interface RoundProps {
  target: number;
  roundIndex: number;
  locked: RoundResult | null;
  isLast: boolean;
  difficulty: Difficulty;
  onLock: (result: RoundResult) => void;
  onNext: () => void;
}

// widen: multiplies the base tolerance. tail: share of the score from a long,
// slow-decaying tail so rough guesses still earn partial credit. Strict is the
// original brief's pure Gaussian.
const DIFFICULTIES: { id: Difficulty; label: string; widen: number; tail: number }[] = [
  { id: "gentle", label: "Gentle", widen: 2.2, tail: 0.35 },
  { id: "balanced", label: "Balanced", widen: 1.5, tail: 0.2 },
  { id: "strict", label: "Strict", widen: 1, tail: 0 },
];

const ROUNDS = 5;
const MAX_TOTAL = ROUNDS * 10;
const SPRING = { type: "spring", stiffness: 400, damping: 30 } as const;

const MIN_HZ = 220;
const SPAN_CENTS = 2400; // two octaves, A3 → A5
const MEMORIZE_SECONDS = 2.5;
const BLANK_MS = 400;
const TONE_SECONDS = 2.0;

const GLASS =
  "bg-white/[0.03] backdrop-blur-2xl border border-white/[0.08] shadow-[inset_0_1px_1px_rgba(255,255,255,0.08),0_20px_50px_rgba(0,0,0,0.6)]";

const GAMES: { id: GameId; label: string; sub: string; title: string; blurb: string }[] = [
  {
    id: "sound",
    label: "Sound",
    sub: "Pitch Memory",
    title: "Pitch Recall",
    blurb: "Hold a pure tone in memory, then reproduce it.",
  },
  {
    id: "color",
    label: "Color",
    sub: "Visual Recall",
    title: "Color Recall",
    blurb: "Memorize a hue, then find it again after a blank.",
  },
  {
    id: "time",
    label: "Time",
    sub: "Internal Clock",
    title: "Time Recall",
    blurb: "Hold for an exact duration using only your internal clock.",
  },
];

const GAME_INDEX: Record<GameId, number> = { sound: 0, color: 1, time: 2 };

/* ──────────────────────────────────────────────────────────────────────────
 * Pure helpers: PRNG, targets, scoring, formatting
 * ────────────────────────────────────────────────────────────────────────── */

function utcDateStr(): string {
  return new Date().toISOString().split("T")[0];
}

// Mulberry32 seeded by the UTC date. `warmup` decorrelates the three games
// while staying fully deterministic for a given date.
function getDailyPRNG(todayStr: string = utcDateStr(), warmup = 0) {
  let seed = todayStr.split("-").reduce((acc, part) => acc * 31 + parseInt(part, 10), 0);
  const next = function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < warmup; i++) next();
  return next;
}

const centsToHz = (cents: number) => MIN_HZ * Math.pow(2, cents / 1200);
const hzToCents = (hz: number) => 1200 * Math.log2(hz / MIN_HZ);

// A color (hue 0–360, saturation 0–100, brightness 0–100) is packed into a
// single number so every game can share the same number-only session shape.
const packHSB = (h: number, s: number, b: number) => h * 1000000 + s * 1000 + b;
const unpackHSB = (n: number) => ({
  h: Math.floor(n / 1000000),
  s: Math.floor((n % 1000000) / 1000),
  b: n % 1000,
});

function hsbToRgb(h: number, s: number, b: number): [number, number, number] {
  const S = s / 100;
  const V = b / 100;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return V - V * S * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}

function hsbCss(h: number, s: number, b: number): string {
  const [r, g, bl] = hsbToRgb(h, s, b);
  return `rgb(${r} ${g} ${bl})`;
}

function inkFor(h: number, s: number, b: number) {
  const [r, g, bl] = hsbToRgb(h, s, b);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
  return luma > 0.62
    ? { main: "rgba(0,0,0,0.78)", dim: "rgba(0,0,0,0.42)" }
    : { main: "#ffffff", dim: "rgba(255,255,255,0.5)" };
}

function generateTargets(game: GameId, rand: () => number): number[] {
  return Array.from({ length: ROUNDS }, () => {
    switch (game) {
      case "sound":
        return Math.round(centsToHz(rand() * SPAN_CENTS) * 10) / 10;
      case "color": {
        const h = Math.floor(rand() * 360);
        const s = 50 + Math.floor(rand() * 51);
        const b = 45 + Math.floor(rand() * 56);
        return packHSB(h, s, b);
      }
      case "time":
        return Math.round((1.5 + rand() * 2.5) * 100) / 100;
    }
  });
}

function createSession(game: GameId, mode: Mode, difficulty: Difficulty): Session {
  const dateStr = utcDateStr();
  const rand = mode === "daily" ? getDailyPRNG(dateStr, 16 * (GAME_INDEX[game] + 1)) : Math.random;
  return {
    targets: generateTargets(game, rand),
    results: Array.from({ length: ROUNDS }, () => null),
    cursor: 0,
    dateStr,
    difficulty,
  };
}

// distance is the error already divided by the game's base tolerance.
function shapeScore(distance: number, difficulty: Difficulty): number {
  const { widen, tail } = DIFFICULTIES.find((d) => d.id === difficulty)!;
  const x = distance / widen;
  return Math.max(0, 10 * ((1 - tail) * Math.exp(-x * x) + tail * Math.exp(-x / 1.5)));
}

function scorePitch(guessFreq: number, targetFreq: number, difficulty: Difficulty = "strict") {
  const centsError = Math.abs(1200 * Math.log2(guessFreq / targetFreq));
  return { centsError, score: shapeScore(centsError / 55, difficulty) };
}

// Hue term is the original spec formula (shortest angular distance, 25° falloff);
// saturation and brightness extend it as extra terms of the same distance.
function scoreColor(guessPacked: number, targetPacked: number, difficulty: Difficulty = "strict") {
  const g = unpackHSB(guessPacked);
  const t = unpackHSB(targetPacked);
  const hueDiff = Math.min(Math.abs(g.h - t.h), 360 - Math.abs(g.h - t.h));
  const satDiff = Math.abs(g.s - t.s);
  const briDiff = Math.abs(g.b - t.b);
  const distance = Math.sqrt(
    Math.pow(hueDiff / 25, 2) + Math.pow(satDiff / 20, 2) + Math.pow(briDiff / 20, 2),
  );
  return { hueDiff, satDiff, briDiff, score: shapeScore(distance, difficulty) };
}

function scoreTime(elapsedSeconds: number, targetSeconds: number, difficulty: Difficulty = "strict") {
  const diff = Math.abs(elapsedSeconds - targetSeconds);
  return { diff, score: shapeScore(diff / 0.45, difficulty) };
}

const signed = (n: number, digits: number) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(digits)}`;

function roundTier(score: number): string {
  if (score >= 9.5) return "Dead on";
  if (score >= 8) return "Excellent";
  if (score >= 6) return "Sharp";
  if (score >= 3.5) return "Close";
  if (score >= 1) return "Drifting";
  return "Off target";
}

function totalTier(total: number): string {
  if (total >= 45) return "Zeroed";
  if (total >= 38) return "Dialed In";
  if (total >= 28) return "Calibrated";
  if (total >= 18) return "Drifting";
  return "Uncalibrated";
}

function scoreText(score: number): string {
  if (score >= 8) return "text-emerald-300";
  if (score >= 5) return "text-cyan-300";
  if (score >= 2.5) return "text-amber-300";
  return "text-rose-300";
}

function scoreBar(score: number): string {
  if (score >= 8) return "bg-emerald-400";
  if (score >= 5) return "bg-cyan-400";
  if (score >= 2.5) return "bg-amber-400";
  return "bg-rose-400";
}

function scoreEmoji(score: number): string {
  if (score >= 8) return "🟩";
  if (score >= 5) return "🟦";
  if (score >= 2.5) return "🟨";
  return "🟥";
}

/* ──────────────────────────────────────────────────────────────────────────
 * Clipboard with execCommand fallback
 * ────────────────────────────────────────────────────────────────────────── */

function legacyCopy(text: string): boolean {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  // 16px prevents iOS zoom-on-focus
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  previouslyFocused?.focus?.();
  return ok;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / insecure context / blocked by iframe policy: use fallback
  }
  return legacyCopy(text);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Hooks: mounted flag, managed timeouts, Web Audio tone player
 * ────────────────────────────────────────────────────────────────────────── */

function useMounted() {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

function useTimeouts() {
  const ids = useRef<Set<number>>(new Set());
  useEffect(() => {
    const set = ids.current;
    return () => {
      set.forEach((id) => window.clearTimeout(id));
      set.clear();
    };
  }, []);
  return useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      ids.current.delete(id);
      fn();
    }, ms);
    ids.current.add(id);
    return id;
  }, []);
}

type PlayStatus = "ok" | "unavailable" | "cancelled";

function useTonePlayer() {
  const ctxRef = useRef<AudioContext | null>(null);
  const activeRef = useRef<{ osc: OscillatorNode; gain: GainNode } | null>(null);
  const genRef = useRef(0);

  // Created lazily and resumed only from a user-initiated call path.
  const ensureContext = useCallback(async (): Promise<AudioContext | null> => {
    try {
      if (!ctxRef.current || ctxRef.current.state === "closed") {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        ctxRef.current = new Ctor();
      }
      if (ctxRef.current.state === "suspended") await ctxRef.current.resume();
      return ctxRef.current;
    } catch {
      return null;
    }
  }, []);

  const silence = useCallback(() => {
    const active = activeRef.current;
    const ctx = ctxRef.current;
    activeRef.current = null;
    if (!active || !ctx) return;
    try {
      const t = ctx.currentTime;
      active.gain.gain.cancelScheduledValues(t);
      active.gain.gain.setValueAtTime(Math.max(active.gain.gain.value, 0.0001), t);
      active.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      active.osc.stop(t + 0.04);
    } catch {
      // node already ended
    }
  }, []);

  const stop = useCallback(() => {
    genRef.current += 1; // invalidates any play() still awaiting the context
    silence();
  }, [silence]);

  const play = useCallback(
    async (freq: number, duration = TONE_SECONDS): Promise<PlayStatus> => {
      const myGen = ++genRef.current;
      const ctx = await ensureContext();
      if (genRef.current !== myGen) return "cancelled";
      if (!ctx) return "unavailable";
      silence();
      try {
        const peak = 0.25;
        const t0 = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.05);
        gain.gain.setValueAtTime(peak, t0 + Math.max(0.06, duration - 0.35));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
          if (activeRef.current?.osc === osc) activeRef.current = null;
        };
        activeRef.current = { osc, gain };
        osc.start(t0);
        osc.stop(t0 + duration + 0.05);
        return "ok";
      } catch {
        return "unavailable";
      }
    },
    [ensureContext, silence],
  );

  // Strict-mode safe teardown: no ghost audio, no leaked contexts.
  useEffect(() => {
    return () => {
      genRef.current += 1;
      silence();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx && ctx.state !== "closed") ctx.close().catch(() => undefined);
    };
  }, [silence]);

  return useMemo(() => ({ play, stop }), [play, stop]);
}

type TonePlayer = ReturnType<typeof useTonePlayer>;

/* ──────────────────────────────────────────────────────────────────────────
 * Presentational primitives
 * ────────────────────────────────────────────────────────────────────────── */

function Reticle({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" />
      <path
        d="M16 1.5v6M16 24.5v6M1.5 16h6M24.5 16h6"
        stroke="currentColor"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
    </svg>
  );
}

function Btn({
  variant = "ghost",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium select-none touch-manipulation transition duration-150 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";
  const look =
    variant === "primary"
      ? "bg-white text-[#090A0F] hover:bg-white/90 shadow-[0_0_30px_rgba(255,255,255,0.12)]"
      : "bg-white/[0.05] border border-white/[0.08] text-white/90 hover:bg-white/[0.09]";
  return <button type="button" className={`${base} ${look} ${className}`} {...props} />;
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M11 5 6 9H3v6h3l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/40">{children}</span>
  );
}

function AnimatedNumber({
  value,
  decimals = 1,
  className = "",
}: {
  value: number;
  decimals?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const controls = animate(0, value, {
      duration: 0.9,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value]);
  return <span className={`font-mono tabular-nums ${className}`}>{display.toFixed(decimals)}</span>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Game 1: Pitch Recall
 * ────────────────────────────────────────────────────────────────────────── */

// Layered sine ribbons running down the card; frequency sets the number of
// oscillations, energy sets the width. Fully canvas-driven, cleaned up on unmount.
function Waveform({ cents, energy }: { cents: number; energy: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetRef = useRef({ cents, energy });

  useEffect(() => {
    targetRef.current = { cents, energy };
  }, [cents, energy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cur = { cents: targetRef.current.cents, energy: 0 };
    let w = 0;
    let h = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const LINES = 22;
    const draw = (t: number) => {
      const goal = targetRef.current;
      cur.cents += (goal.cents - cur.cents) * 0.15;
      cur.energy += (goal.energy - cur.energy) * 0.08;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 1;
      const cycles = 1.5 + (cur.cents / SPAN_CENTS) * 6.5;
      const amp = w * (0.04 + 0.2 * cur.energy);
      const time = reduced ? 0 : t / 1000;
      for (let i = 0; i < LINES; i++) {
        const k = i / (LINES - 1);
        const r = Math.round(45 + (139 - 45) * k);
        const g = Math.round(212 + (92 - 212) * k);
        const b = Math.round(191 + (246 - 191) * k);
        ctx.strokeStyle = `rgba(${r},${g},${b},0.4)`;
        ctx.beginPath();
        for (let y = 0; y <= h; y += 4) {
          const env = Math.pow(Math.sin((Math.PI * y) / h), 0.7);
          const phase = (y / h) * cycles * Math.PI * 2 + time * (1.2 + cur.energy * 2) + k * 1.1;
          const x = w / 2 + Math.sin(phase) * amp * env * (0.45 + 0.55 * Math.sin(Math.PI * k));
          if (y === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <>
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-3/5 -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.22),transparent_65%)]" />
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
    </>
  );
}

const CENTS_PER_PX = 2;

function SoundRound({
  target,
  roundIndex,
  locked,
  isLast,
  difficulty,
  onLock,
  onNext,
  tone,
}: RoundProps & { tone: TonePlayer }) {
  const [phase, setPhase] = useState<"ready" | "listening" | "recall">("ready");
  const [cents, setCents] = useState(SPAN_CENTS / 2);
  const [audioOk, setAudioOk] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const drag = useRef<{ y: number; cents: number } | null>(null);
  const after = useTimeouts();
  const mounted = useMounted();

  useEffect(() => () => tone.stop(), [tone]);

  const guessFreq = centsToHz(cents);
  const view = locked ? "result" : phase;
  const clampCents = (c: number) => Math.min(SPAN_CENTS, Math.max(0, Math.round(c)));

  const begin = async () => {
    setPhase("listening");
    const status = await tone.play(target, TONE_SECONDS);
    if (!mounted.current || status === "cancelled") return;
    setAudioOk(status === "ok");
    after(() => setPhase("recall"), TONE_SECONDS * 1000);
  };

  const preview = async (freq: number) => {
    setPreviewing(true);
    const status = await tone.play(freq, 1.5);
    if (!mounted.current || status === "cancelled") return;
    setAudioOk(status === "ok");
    after(() => setPreviewing(false), 1500);
  };

  const lockIn = () => {
    tone.stop();
    setPreviewing(false);
    onLock({ score: scorePitch(guessFreq, target, difficulty).score, guess: guessFreq, target });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? 25 : 5;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = cents + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = cents - step;
    else if (e.key === "PageUp") next = cents + 100;
    else if (e.key === "PageDown") next = cents - 100;
    if (next === null) return;
    e.preventDefault();
    setCents(clampCents(next));
  };

  const base = { background: "#000" };

  if (view === "ready") {
    return (
      <div className={CARD} style={base}>
        <Waveform cents={SPAN_CENTS / 2} energy={0.12} />
        <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
        <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
        <div className="absolute inset-x-5 top-14 space-y-3">
          <h2 className="text-[min(72px,20cqw)] font-bold leading-none tracking-tighter text-white">sound</h2>
          <p className="max-w-[16rem] text-sm leading-relaxed text-white/60">
            A pure tone plays for 2 seconds. Memorize its pitch, then recreate it. Headphones help.
          </p>
        </div>
        <div className="absolute bottom-5 left-5">
          <Btn variant="primary" onClick={begin}>
            Play reference tone
          </Btn>
        </div>
      </div>
    );
  }

  if (view === "listening") {
    return (
      <div className={CARD} style={base}>
        <Waveform cents={SPAN_CENTS / 2} energy={1} />
        <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
        <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
        <div className="absolute bottom-8 left-5 text-[min(40px,11cqw)] font-bold leading-none tracking-tighter text-white">
          Listening…
        </div>
        <div className="absolute inset-x-5 bottom-5 h-0.5 overflow-hidden rounded-full bg-white/15">
          <motion.div
            className="h-full rounded-full bg-white"
            initial={{ width: "0%" }}
            animate={{ width: "100%" }}
            transition={{ duration: TONE_SECONDS, ease: "linear" }}
          />
        </div>
      </div>
    );
  }

  if (view === "recall") {
    return (
      <div
        className={`${CARD} cursor-ns-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60`}
        style={base}
        role="slider"
        tabIndex={0}
        aria-label="Frequency, drag up for higher and down for lower"
        aria-orientation="vertical"
        aria-valuemin={MIN_HZ}
        aria-valuemax={MIN_HZ * 4}
        aria-valuenow={Math.round(guessFreq)}
        aria-valuetext={`${guessFreq.toFixed(2)} Hz`}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // capture unsupported; dragging inside the card still works
          }
          drag.current = { y: e.clientY, cents };
        }}
        onPointerMove={(e) => {
          if (drag.current) setCents(clampCents(drag.current.cents - (e.clientY - drag.current.y) * CENTS_PER_PX));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <Waveform cents={cents} energy={0.7} />
        <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
        <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
        <div className="pointer-events-none absolute inset-x-5 top-14 text-xs text-white/45">
          Drag up or down to tune
          {!audioOk && <span className="mt-1 block text-amber-300/80">Audio unavailable in this browser.</span>}
        </div>
        <div className="pointer-events-none absolute bottom-5 left-5 font-mono text-[min(52px,10.5cqw)] font-bold leading-none tabular-nums tracking-tighter text-white">
          {guessFreq.toFixed(2)}
          <span className="ml-1 text-base font-semibold text-white/60">Hz</span>
        </div>
        <RoundButton label="Test frequency" glass className="right-[76px]" disabled={previewing} onClick={() => preview(guessFreq)}>
          <SpeakerIcon />
        </RoundButton>
        <RoundButton label="Lock in frequency" onClick={lockIn}>
          <CheckIcon />
        </RoundButton>
      </div>
    );
  }

  if (!locked) return null;
  const errHz = locked.guess - locked.target;
  const errCents = 1200 * Math.log2(locked.guess / locked.target);
  const pill =
    "min-h-11 rounded-full border border-white/15 bg-white/10 px-4 text-xs font-medium text-white backdrop-blur-md outline-none transition duration-150 touch-manipulation active:scale-[0.97] disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-300/60";
  return (
    <div className={CARD} style={base}>
      <Waveform cents={hzToCents(locked.guess)} energy={0.45} />
      <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
      <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
      <div className="absolute left-5 top-14 space-y-1">
        <Label>{roundTier(locked.score)}</Label>
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <AnimatedNumber
            value={locked.score}
            className={`text-[min(88px,24cqw)] font-bold leading-none tracking-tighter ${scoreText(locked.score)}`}
          />
          <span className="font-mono text-xs tabular-nums text-white/40">/ 10.0</span>
        </div>
      </div>
      <div className="absolute bottom-[118px] left-5 flex gap-2">
        <button type="button" className={pill} disabled={previewing} onClick={() => preview(locked.target)}>
          Hear target
        </button>
        <button type="button" className={pill} disabled={previewing} onClick={() => preview(locked.guess)}>
          Hear yours
        </button>
      </div>
      <div className="absolute bottom-5 left-5 right-[76px] space-y-2">
        <div>
          <Label>Target</Label>
          <div className="font-mono text-[min(40px,10.5cqw)] font-bold leading-none tabular-nums tracking-tighter text-white">
            {locked.target.toFixed(2)}
            <span className="ml-1 text-sm font-semibold text-white/60">Hz</span>
          </div>
        </div>
        <div className="font-mono text-[11px] tabular-nums text-white/55">
          Yours {locked.guess.toFixed(2)} · {signed(errHz, 2)} Hz · {signed(errCents, 1)}¢
        </div>
      </div>
      <RoundButton label={isLast ? "View final score" : "Next round"} onClick={onNext}>
        <ArrowIcon />
      </RoundButton>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Game 2: Color Recall
 * ────────────────────────────────────────────────────────────────────────── */

const CARD =
  "relative mx-auto h-[max(28rem,calc(100dvh-26rem))] w-full max-w-[29.75rem] select-none overflow-hidden rounded-[22px] shadow-[0_24px_60px_rgba(0,0,0,0.55)] [container-type:inline-size] sm:h-[clamp(28rem,72dvh,38.75rem)]";
const STRIP_W = 30;
const THUMB = 26;
const THUMB_PAD = THUMB / 2 + 2;
const NEUTRAL_CARD = "#1a1b20";

function RoundBadge({ index, color, className = "" }: { index: number; color: string; className?: string }) {
  return (
    <span
      className={`absolute top-5 font-mono text-xs font-semibold tabular-nums tracking-wide ${className}`}
      style={{ color }}
    >
      {index + 1} / {ROUNDS}
    </span>
  );
}

function CardBrand({ color, className = "" }: { color: string; className?: string }) {
  return (
    <span className={`absolute text-sm font-bold tracking-tight ${className}`} style={{ color }}>
      Zeroed.gg
    </span>
  );
}

function RoundButton({
  label,
  onClick,
  children,
  className = "right-5",
  glass = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  glass?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      className={`absolute bottom-5 z-10 flex h-12 w-12 select-none items-center justify-center rounded-full outline-none transition duration-150 touch-manipulation active:scale-[0.96] disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${
        glass
          ? "border border-white/15 bg-white/10 text-white backdrop-blur-md"
          : "bg-white text-[#090A0F] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Vertical drag strip; pos is 0 at the top and 1 at the bottom.
function VStrip({
  pos,
  onPos,
  gradient,
  label,
  valueNow,
  valueMax,
  valueText,
}: {
  pos: number;
  onPos: (pos: number) => void;
  gradient: string;
  label: string;
  valueNow: number;
  valueMax: number;
  valueText: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fromY = (clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const span = rect.height - THUMB_PAD * 2;
    if (span <= 0) return;
    onPos(Math.min(1, Math.max(0, (clientY - rect.top - THUMB_PAD) / span)));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = pos - step;
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") next = pos + step;
    else if (e.key === "PageUp") next = pos - 0.1;
    else if (e.key === "PageDown") next = pos + 0.1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next === null) return;
    e.preventDefault();
    onPos(Math.min(1, Math.max(0, next)));
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      aria-valuetext={valueText}
      onPointerDown={(e) => {
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture unsupported; dragging inside the strip still works
        }
        fromY(e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) fromY(e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={onKeyDown}
      className="relative h-full cursor-ns-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80"
      style={{ width: STRIP_W, background: gradient }}
    >
      <span
        className="pointer-events-none absolute left-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.45)]"
        style={{
          width: THUMB,
          height: THUMB,
          top: `calc(${THUMB_PAD}px + (100% - ${THUMB_PAD * 2}px) * ${pos})`,
          transform: "translate(-50%, -50%)",
        }}
      />
    </div>
  );
}

const HUE_GRADIENT = `linear-gradient(to bottom, ${[0, 60, 120, 180, 240, 300, 360]
  .map((h) => hsbCss(h, 100, 100))
  .join(", ")})`;

const fmtHSB = (c: { h: number; s: number; b: number }) => `H${c.h} S${c.s} B${c.b}`;

function colorQuip(score: number): string {
  if (score >= 9.5) return "Basically a human spectrophotometer.";
  if (score >= 8) return "Your eyes are suspiciously good.";
  if (score >= 6) return "Solid. Your retina approves.";
  if (score >= 3.5) return "Right neighborhood, wrong house.";
  if (score >= 1) return "Color memory: a work in progress.";
  return "Did you even see it?";
}

function ColorRound({ target, roundIndex, locked, isLast, difficulty, onLock, onNext }: RoundProps) {
  const [phase, setPhase] = useState<"ready" | "memorize" | "blank" | "recall">("ready");
  const [guess, setGuess] = useState(() => ({
    h: Math.floor(Math.random() * 361),
    s: 40 + Math.floor(Math.random() * 31),
    b: 40 + Math.floor(Math.random() * 31),
  }));
  const [remaining, setRemaining] = useState(MEMORIZE_SECONDS);
  const startRef = useRef(0);
  const view = locked ? "result" : phase;

  // Phase timers live in effects keyed on the phase so a re-run re-arms them.
  useEffect(() => {
    if (phase === "memorize") {
      const left = Math.max(0, MEMORIZE_SECONDS * 1000 - (performance.now() - startRef.current));
      const id = window.setTimeout(() => setPhase("blank"), left);
      return () => window.clearTimeout(id);
    }
    if (phase === "blank") {
      const id = window.setTimeout(() => setPhase("recall"), BLANK_MS);
      return () => window.clearTimeout(id);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "memorize") return;
    let raf = 0;
    const tick = () => {
      const left = Math.max(0, MEMORIZE_SECONDS - (performance.now() - startRef.current) / 1000);
      setRemaining(left);
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const begin = () => {
    startRef.current = performance.now();
    setRemaining(MEMORIZE_SECONDS);
    setPhase("memorize");
  };

  const lockIn = () => {
    const packed = packHSB(guess.h, guess.s, guess.b);
    onLock({ score: scoreColor(packed, target, difficulty).score, guess: packed, target });
  };

  const t = unpackHSB(target);

  if (view === "ready") {
    return (
      <div className={CARD} style={{ background: "#000" }}>
        <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
        <div className="absolute inset-x-5 top-5 space-y-4">
          <h2 className="w-fit text-[min(84px,22cqw)] font-bold leading-none tracking-tighter text-white">color</h2>
          <div className="max-w-[19rem] space-y-3 text-base font-medium leading-snug text-white/55">
            <p>Humans can&apos;t reliably recall colors. See how good (or bad) you are at it.</p>
            <p>We&apos;ll show you five colors, one at a time. Rebuild each from memory.</p>
          </div>
        </div>
        <p className="absolute bottom-[76px] left-5 text-lg font-bold tracking-tight text-white">Ready?</p>
        <RoundButton label="Show color" className="left-5" onClick={begin}>
          <PlayIcon />
        </RoundButton>
        <span className="absolute bottom-7 right-5 font-mono text-[11px] tabular-nums text-white/40">
          {ROUNDS} rounds · {MEMORIZE_SECONDS.toFixed(1)}s each
        </span>
      </div>
    );
  }

  if (view === "memorize") {
    const ink = inkFor(t.h, t.s, t.b);
    const [whole, frac] = remaining.toFixed(2).split(".");
    return (
      <div className={CARD} style={{ background: hsbCss(t.h, t.s, t.b) }}>
        <RoundBadge index={roundIndex} color={ink.dim} className="left-5" />
        <div className="absolute right-5 top-4 text-right">
          <div
            className="font-mono text-[min(84px,24cqw)] font-bold leading-none tabular-nums tracking-tighter"
            style={{ color: ink.main }}
            aria-label={`${remaining.toFixed(1)} seconds to remember`}
          >
            {whole}
            <span style={{ color: ink.dim }}>
              .{frac}
            </span>
          </div>
          <div className="mt-2 text-xs font-semibold" style={{ color: ink.main }}>
            Seconds to remember
          </div>
        </div>
        <CardBrand color={ink.dim} className="bottom-5 left-5" />
      </div>
    );
  }

  if (view === "blank") {
    return <div className={CARD} style={{ background: NEUTRAL_CARD }} aria-label="Clearing afterimage" />;
  }

  if (view === "recall") {
    const ink = inkFor(guess.h, guess.s, guess.b);
    const { h, s, b } = guess;
    return (
      <div className={CARD} style={{ background: hsbCss(h, s, b) }}>
        <div className="absolute inset-y-0 left-0 z-10 flex">
          <VStrip
            label="Hue"
            pos={h / 360}
            onPos={(p) => setGuess((g) => ({ ...g, h: Math.round(p * 360) }))}
            gradient={HUE_GRADIENT}
            valueNow={h}
            valueMax={360}
            valueText={`${h} degrees`}
          />
          <VStrip
            label="Saturation"
            pos={1 - s / 100}
            onPos={(p) => setGuess((g) => ({ ...g, s: Math.round((1 - p) * 100) }))}
            gradient={`linear-gradient(to bottom, ${hsbCss(h, 100, b)}, ${hsbCss(h, 0, b)})`}
            valueNow={s}
            valueMax={100}
            valueText={`${s} percent`}
          />
          <VStrip
            label="Brightness"
            pos={1 - b / 100}
            onPos={(p) => setGuess((g) => ({ ...g, b: Math.round((1 - p) * 100) }))}
            gradient={`linear-gradient(to bottom, ${hsbCss(h, s, 100)}, ${hsbCss(h, s, 0)})`}
            valueNow={b}
            valueMax={100}
            valueText={`${b} percent`}
          />
        </div>
        <RoundBadge index={roundIndex} color={ink.dim} className="left-[106px]" />
        <CardBrand color={ink.dim} className="right-5 top-5" />
        <RoundButton label="Lock in color" onClick={lockIn}>
          <CheckIcon />
        </RoundButton>
      </div>
    );
  }

  if (!locked) return null;
  const tg = unpackHSB(locked.target);
  const gs = unpackHSB(locked.guess);
  const inkG = inkFor(gs.h, gs.s, gs.b);
  const inkT = inkFor(tg.h, tg.s, tg.b);
  const diffs = scoreColor(locked.guess, locked.target);
  return (
    <div className={CARD}>
      <div className="absolute inset-x-0 top-0 h-1/2" style={{ background: hsbCss(gs.h, gs.s, gs.b) }}>
        <RoundBadge index={roundIndex} color={inkG.dim} className="left-5" />
        <div className="absolute right-5 top-4 max-w-[75%] text-right" style={{ color: inkG.main }}>
          <AnimatedNumber
            value={locked.score}
            className="text-[min(96px,26cqw)] font-bold leading-none tracking-tighter"
          />
          <p className="mt-2 ml-auto max-w-[16rem] text-sm font-semibold leading-snug opacity-80">
            {colorQuip(locked.score)}
          </p>
          <p className="mt-1 font-mono text-[10px] tabular-nums" style={{ color: inkG.dim }}>
            Δ {diffs.hueDiff.toFixed(0)}° H · {diffs.satDiff} S · {diffs.briDiff} B
          </p>
        </div>
        <div className="absolute bottom-5 left-5 space-y-0.5">
          <div className="text-sm font-semibold" style={{ color: inkG.dim }}>
            Your selection
          </div>
          <div className="font-mono text-sm font-bold tabular-nums" style={{ color: inkG.main }}>
            {fmtHSB(gs)}
          </div>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1/2" style={{ background: hsbCss(tg.h, tg.s, tg.b) }}>
        <div className="absolute bottom-5 left-5 space-y-0.5">
          <div className="text-sm font-semibold" style={{ color: inkT.dim }}>
            Original
          </div>
          <div className="font-mono text-sm font-bold tabular-nums" style={{ color: inkT.main }}>
            {fmtHSB(tg)}
          </div>
        </div>
      </div>
      <RoundButton label={isLast ? "View final score" : "Next round"} onClick={onNext}>
        <ArrowIcon />
      </RoundButton>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Game 3: Time Recall
 * ────────────────────────────────────────────────────────────────────────── */

// Overlapping, drifting circles that bloom while the card is held.
function Rings({ energy }: { energy: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef(energy);

  useEffect(() => {
    energyRef.current = energy;
  }, [energy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cur = { energy: energyRef.current };
    let w = 0;
    let h = 0;
    let raf = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const RINGS = 16;
    const draw = (t: number) => {
      cur.energy += (energyRef.current - cur.energy) * 0.06;
      const e = cur.energy;
      const time = reduced ? 0 : (t / 1000) * (0.5 + e);
      const pulse = reduced ? 0 : Math.sin(((t / 1000) * Math.PI * 2) / 0.9) * e;
      const size = Math.min(w, h);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 2.2;
      for (let i = 0; i < RINGS; i++) {
        const k = i / (RINGS - 1);
        const radius = size * (0.04 + 0.52 * Math.pow(k, 1.1)) * (0.4 + 0.6 * e) * (1 + 0.03 * pulse);
        const cx = w / 2 + Math.sin(time * 0.6 + k * 3) * radius * 0.5;
        const cy = h / 2 + Math.cos(time * 0.5 + k * 2.3) * radius * 0.5;
        const r = Math.round(96 + (192 - 96) * k);
        const g = Math.round(165 + (132 - 165) * k);
        const b = Math.round(250 + (252 - 250) * k);
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.18 + 0.32 * e})`;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}

function TimeRound({ target, roundIndex, locked, isLast, difficulty, onLock, onNext }: RoundProps) {
  const [holding, setHolding] = useState(false);
  const startRef = useRef<number | null>(null);

  const startHold = () => {
    if (startRef.current !== null || locked) return;
    startRef.current = performance.now();
    setHolding(true);
  };

  const endHold = () => {
    if (startRef.current === null) return;
    const elapsed = (performance.now() - startRef.current) / 1000;
    startRef.current = null;
    setHolding(false);
    onLock({ score: scoreTime(elapsed, target, difficulty).score, guess: elapsed, target });
  };

  const abortHold = () => {
    startRef.current = null;
    setHolding(false);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported; window-level release still works for most cases
    }
    startHold();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  };

  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      endHold();
    }
  };

  if (locked) {
    const diff = locked.guess - locked.target;
    return (
      <div className={CARD} style={{ background: "#000" }}>
        <Rings energy={0.6} />
        <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
        <div className="absolute right-5 top-4 text-right">
          <AnimatedNumber
            value={locked.score}
            className={`text-[min(96px,26cqw)] font-bold leading-none tracking-tighter ${scoreText(locked.score)}`}
          />
          <div className="mt-2 text-lg font-bold text-white/60">{roundTier(locked.score)}</div>
          <div className="mt-1 font-mono text-sm tabular-nums text-white/50">{signed(diff, 2)}s off</div>
        </div>
        <div className="absolute bottom-5 left-5 right-[76px] space-y-1">
          <Label>Target</Label>
          <div className="font-mono text-[min(56px,15cqw)] font-bold leading-none tabular-nums tracking-tighter text-white/40">
            {locked.target.toFixed(2)}
            <span className="ml-1 text-base font-semibold">sec</span>
          </div>
          <div className="font-mono text-[min(56px,15cqw)] font-bold leading-none tabular-nums tracking-tighter text-white">
            {locked.guess.toFixed(2)}
            <span className="ml-1 text-base font-semibold">sec</span>
          </div>
        </div>
        <RoundButton label={isLast ? "View final score" : "Next round"} onClick={onNext}>
          <ArrowIcon />
        </RoundButton>
      </div>
    );
  }

  return (
    <div
      className={`${CARD} cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60`}
      style={{ background: "#000" }}
      role="button"
      tabIndex={0}
      aria-pressed={holding}
      aria-label={`Press and hold for ${target.toFixed(2)} seconds, then release`}
      onPointerDown={onPointerDown}
      onPointerUp={endHold}
      onPointerCancel={abortHold}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={abortHold}
    >
      <Rings energy={holding ? 1 : 0.15} />
      <RoundBadge index={roundIndex} color="rgba(255,255,255,0.6)" className="left-5" />
      <CardBrand color="rgba(255,255,255,0.35)" className="right-5 top-5" />
      <div
        className="pointer-events-none absolute left-5 top-14 space-y-1 transition-opacity duration-300"
        style={{ opacity: holding ? 0.3 : 1 }}
      >
        <Label>Target</Label>
        <div className="font-mono text-[min(96px,26cqw)] font-bold leading-none tabular-nums tracking-tighter text-white">
          {target.toFixed(2)}
          <span className="ml-1 text-xl font-semibold text-white/60">sec</span>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-6 text-center text-base font-bold text-white/60">
        {holding ? "release when it feels right" : "your turn — hold to match"}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Summary
 * ────────────────────────────────────────────────────────────────────────── */

function Summary({
  game,
  mode,
  session,
  onRestart,
}: {
  game: GameId;
  mode: Mode;
  session: Session;
  onRestart: () => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const after = useTimeouts();
  const scores = session.results.map((r) => r?.score ?? 0);
  const total = scores.reduce((a, b) => a + b, 0);
  const meta = GAMES.find((g) => g.id === game)!;
  const difficultyLabel = DIFFICULTIES.find((d) => d.id === session.difficulty)!.label;

  const share = async () => {
    const text = [
      `ZEROED // ${meta.label} · ${mode === "daily" ? `Daily ${session.dateStr}` : "Practice"} · ${difficultyLabel}`,
      `${total.toFixed(1)} / ${MAX_TOTAL.toFixed(1)} — ${totalTier(total)}`,
      scores.map(scoreEmoji).join(""),
      "zeroed.gg",
    ].join("\n");
    const ok = await copyText(text);
    setToast(ok ? "Result copied to clipboard" : "Copy blocked — select and copy manually");
    after(() => setToast(null), 2200);
  };

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <Label>
          {meta.title} · {mode === "daily" ? `Daily ${session.dateStr}` : "Practice"} · {difficultyLabel}
        </Label>
        <div className="flex items-baseline gap-2">
          <AnimatedNumber value={total} className="text-7xl font-semibold text-white" />
          <span className="font-mono text-sm tabular-nums text-white/35">/ {MAX_TOTAL.toFixed(1)}</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-white/80">
          {totalTier(total)}
        </span>
      </div>

      <ul className="w-full space-y-2">
        {scores.map((s, i) => (
          <li key={i} className="flex items-center gap-3">
            <span className="w-6 font-mono text-[11px] tabular-nums text-white/40">R{i + 1}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
              <motion.div
                className={`h-full rounded-full ${scoreBar(s)}`}
                initial={{ width: 0 }}
                animate={{ width: `${(s / 10) * 100}%` }}
                transition={{ ...SPRING, delay: i * 0.05 }}
              />
            </div>
            <span className={`w-10 text-right font-mono text-sm tabular-nums ${scoreText(s)}`}>
              {s.toFixed(1)}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex w-full flex-col gap-3 sm:flex-row">
        <Btn className="flex-1" onClick={share}>
          Copy result
        </Btn>
        <Btn variant="primary" className="flex-1" onClick={onRestart}>
          {mode === "daily" ? "Replay benchmark" : "New run"}
        </Btn>
      </div>
      <div aria-live="polite" className="h-4 font-mono text-[11px] text-cyan-200/80">
        {toast}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Header controls
 * ────────────────────────────────────────────────────────────────────────── */

function TextTabs<T extends string>({
  options,
  value,
  onChange,
  layoutId,
  label,
  className = "",
  textClass = "text-base",
  disabled = false,
}: {
  options: { id: T; label: ReactNode; aria: string }[];
  value: T;
  onChange: (id: T) => void;
  layoutId: string;
  label: string;
  className?: string;
  textClass?: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={`flex items-center gap-5 ${className}`}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            aria-label={o.aria}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={`relative select-none rounded py-1 font-medium whitespace-nowrap touch-manipulation outline-none transition duration-150 after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-cyan-300/60 disabled:cursor-not-allowed ${textClass} ${
              active ? "text-white" : disabled ? "text-white/20" : "text-white/40 hover:text-white/70"
            }`}
          >
            {o.label}
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={SPRING}
                className="absolute inset-x-0 -bottom-0.5 h-px bg-white"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function RoundIndicator({ session }: { session: Session }) {
  const label =
    session.cursor >= ROUNDS ? "All rounds complete" : `Round ${session.cursor + 1} of ${ROUNDS}`;
  return (
    <div className="flex gap-1.5" role="group" aria-label={label}>
      {session.results.map((r, i) => {
        const current = i === session.cursor && !r;
        const tone = r ? scoreBar(r.score) : current ? "bg-white/70" : "bg-white/10";
        return (
          <div
            key={i}
            aria-current={current ? "step" : undefined}
            className={`h-[3px] flex-1 rounded-full transition-colors duration-300 ${tone}`}
          />
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * App
 * ────────────────────────────────────────────────────────────────────────── */

export default function App() {
  const [game, setGame] = useState<GameId>("sound");
  const [mode, setMode] = useState<Mode>("practice");
  const [sessions, setSessions] = useState<Record<string, Session>>(() => ({
    "practice:sound": createSession("sound", "practice", "balanced"),
  }));
  const [preferred, setPreferred] = useState<Difficulty>("balanced");
  const tone = useTonePlayer();

  const key = `${mode}:${game}`;
  const session = sessions[key];
  const meta = GAMES.find((g) => g.id === game)!;

  const navigate = useCallback(
    (g: GameId, m: Mode) => {
      setSessions((prev) => {
        const k = `${m}:${g}`;
        const existing = prev[k];
        const stale = m === "daily" && existing && existing.dateStr !== utcDateStr();
        return existing && !stale ? prev : { ...prev, [k]: createSession(g, m, preferred) };
      });
      setGame(g);
      setMode(m);
    },
    [preferred],
  );

  const update = (fn: (s: Session) => Session) =>
    setSessions((prev) => ({ ...prev, [key]: fn(prev[key]) }));

  const lock = (result: RoundResult) =>
    update((s) => {
      const results = [...s.results];
      results[s.cursor] = { ...result, score: Math.round(result.score * 10) / 10 };
      return { ...s, results };
    });

  const next = () => update((s) => ({ ...s, cursor: s.cursor + 1 }));

  const restart = () =>
    update((s) =>
      mode === "daily"
        ? { ...s, results: Array.from({ length: ROUNDS }, () => null), cursor: 0 }
        : createSession(game, mode, s.difficulty),
    );

  const runStarted = session.results.some((r) => r !== null);
  const chooseDifficulty = (d: Difficulty) => {
    if (runStarted) return;
    setPreferred(d);
    update((s) => ({ ...s, difficulty: d }));
  };

  const runningTotal = session.results.reduce((a, r) => a + (r?.score ?? 0), 0);
  const complete = session.cursor >= ROUNDS;
  const bareCard = !complete;
  const roundProps: RoundProps | null = complete
    ? null
    : {
        target: session.targets[session.cursor],
        roundIndex: session.cursor,
        locked: session.results[session.cursor],
        isLast: session.cursor === ROUNDS - 1,
        difficulty: session.difficulty,
        onLock: lock,
        onNext: next,
      };

  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-[#090A0F] font-sans text-slate-200 antialiased">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-40 h-[28rem] w-[28rem] rounded-full bg-indigo-500/10 blur-[140px]" />
        <div className="absolute -bottom-40 -right-32 h-[32rem] w-[32rem] rounded-full bg-emerald-500/5 blur-[140px]" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[31.75rem] flex-col px-4 pb-8 pt-4 sm:pt-6">
        <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <div className="flex items-center gap-2.5">
            <Reticle size={20} className="text-white" />
            <span className="text-sm font-semibold tracking-[0.3em] text-white">ZEROED</span>
            <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(103,232,249,0.9)]" />
            </span>
          </div>

          <TextTabs<Mode>
            label="Mode"
            layoutId="mode-underline"
            textClass="text-xs"
            className="gap-4 sm:order-3"
            value={mode}
            onChange={(m) => navigate(game, m)}
            options={[
              { id: "practice", label: "Practice", aria: "Practice mode" },
              {
                id: "daily",
                label: (
                  <>
                    <span className="sm:hidden">Daily</span>
                    <span className="hidden sm:inline">Daily Benchmark</span>
                  </>
                ),
                aria: "Daily Benchmark mode",
              },
            ]}
          />

          <TextTabs<GameId>
            label="Game"
            layoutId="game-underline"
            className="w-full gap-6 sm:order-2 sm:w-auto"
            textClass="text-base"
            value={game}
            onChange={(g) => navigate(g, mode)}
            options={GAMES.map((g) => ({ id: g.id, label: g.label, aria: `${g.label}: ${g.sub}` }))}
          />
        </header>

        <main className="flex flex-1 flex-col justify-center py-5 sm:py-8">
          <h1 className="sr-only">{meta.title}</h1>
          <div className="mx-auto mb-3 w-full max-w-[29.75rem]">
            <RoundIndicator session={session} />
          </div>

          <section className={bareCard ? "" : `${GLASS} min-h-[26rem] rounded-3xl p-5 sm:p-8`}>
            <div className={bareCard ? "flex flex-col justify-center" : "flex min-h-[22rem] flex-col justify-center"}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={`${key}:${session.cursor}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8, pointerEvents: "none" }}
                  transition={SPRING}
                >
                  {roundProps === null ? (
                    <Summary game={game} mode={mode} session={session} onRestart={restart} />
                  ) : game === "sound" ? (
                    <SoundRound {...roundProps} tone={tone} />
                  ) : game === "color" ? (
                    <ColorRound {...roundProps} />
                  ) : (
                    <TimeRound {...roundProps} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </section>

          <div className="mx-auto mt-5 flex w-full max-w-[29.75rem] items-center justify-between">
            <TextTabs<Difficulty>
              label="Scoring difficulty"
              layoutId="difficulty-underline"
              textClass="text-xs"
              className="gap-4"
              value={session.difficulty}
              onChange={chooseDifficulty}
              disabled={runStarted}
              options={DIFFICULTIES.map((d) => ({
                id: d.id,
                label: d.label,
                aria: runStarted
                  ? `${d.label} scoring (locked until this run ends)`
                  : `${d.label} scoring`,
              }))}
            />
            <span className="font-mono text-[11px] tabular-nums text-white/40">
              <span className="text-white/80">{runningTotal.toFixed(1)}</span> / {MAX_TOTAL.toFixed(1)}
            </span>
          </div>
        </main>

        <footer className="space-y-1 text-center">
          {mode === "daily" && (
            <div className="font-mono text-[10px] tabular-nums text-white/35">
              Daily Benchmark · {session.dateStr} UTC
            </div>
          )}
          <div className="text-[10px] uppercase tracking-[0.28em] text-white/25">
            Human Sensory Calibration Benchmark
          </div>
        </footer>
      </div>
    </div>
  );
}
