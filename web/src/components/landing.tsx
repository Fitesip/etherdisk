"use client";

import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  Cpu,
  FileText,
  Film,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Lock,
  Palette,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { formatEther } from "viem";

import { useT, type MessageKey } from "@/i18n";
import { useTiers } from "@/lib/tiers";

import { Logo } from "./header";
import { cn, Spinner } from "./ui";

// ------------------------------------------------------------------ motion helpers

const prefersReducedMotion = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fades its content in the first time it scrolls into view. */
function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.setAttribute("data-shown", "");
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn("reveal", className)} style={{ "--delay": `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

const HEX = "0123456789abcdef";
const randomHex = (n: number) => Array.from({ length: n }, () => HEX[Math.floor(Math.random() * 16)]).join("");

/** Ciphertext-looking hex that keeps changing (static when motion is reduced). */
function Ciphertext({ length, seed, className }: { length: number; seed: string; className?: string }) {
  // Deterministic first render (no hydration mismatch), random after.
  const [text, setText] = useState(() => seed.padEnd(length, "0").slice(0, length));
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const tick = () => setText(randomHex(length));
    const id = setInterval(tick, 90 + Math.random() * 60);
    return () => clearInterval(id);
  }, [length]);
  return <span className={cn("font-mono tabular-nums", className)}>{text}</span>;
}

// ------------------------------------------------------------------ hero

/** Deterministic pseudo-random hex (same on server and client, no hydration mismatch). */
function seededHex(seed: number, n: number): string {
  let s = seed * 2654435761;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (s ^ (s >>> 15)) * 2246822507;
    s = (s ^ (s >>> 13)) * 3266489909;
    s ^= s >>> 16;
    out += HEX[(s >>> 0) % 16];
  }
  return out;
}

const COLS = 4;
const ROWS = 2;
const CHUNKS = COLS * ROWS;

/** How the plaintext of each demo file looks, sliced into chunk tiles. */
const DEMO_FILES = [
  {
    name: "beach-sunset.jpg",
    size: "6.8 MB",
    icon: ImageIcon,
    // One picture across all tiles: each tile shows its own slice.
    tile: (i: number): CSSProperties => ({
      backgroundImage:
        "radial-gradient(circle at 70% 38%, #fde68a 0 7%, transparent 8%), linear-gradient(180deg, #f97316 0%, #fb7185 30%, #a855f7 52%, #1e3a8a 53%, #0ea5e9 72%, #fcd34d 73%, #f59e0b 100%)",
      backgroundSize: `${COLS * 100}% ${ROWS * 100}%`,
      backgroundPosition: `${((i % COLS) * 100) / (COLS - 1)}% ${(Math.floor(i / COLS) * 100) / (ROWS - 1)}%`,
    }),
  },
  {
    name: "taxes-2026.pdf",
    size: "812 KB",
    icon: FileText,
    tile: (): CSSProperties => ({
      backgroundColor: "#f8fafc",
      backgroundImage: "repeating-linear-gradient(180deg, transparent 0 7px, #cbd5e1 7px 9px)",
      backgroundSize: "70% 100%",
      backgroundPosition: "center 6px",
      backgroundRepeat: "no-repeat",
    }),
  },
  {
    name: "wedding-film.mp4",
    size: "1.3 GB",
    icon: Film,
    // Film frames: dark strip with sprocket holes and a colored frame.
    tile: (i: number): CSSProperties => ({
      backgroundColor: "#111827",
      backgroundImage: `repeating-linear-gradient(90deg, #f8fafc 0 4px, transparent 4px 9px), repeating-linear-gradient(90deg, #f8fafc 0 4px, transparent 4px 9px), linear-gradient(135deg, hsl(${(i * 37) % 360} 70% 55%), hsl(${(i * 37 + 60) % 360} 70% 40%))`,
      backgroundSize: "100% 4px, 100% 4px, 76% 56%",
      backgroundPosition: "0 3px, 0 calc(100% - 3px), center",
      backgroundRepeat: "repeat-x, repeat-x, no-repeat",
    }),
  },
] as const;

type Phase = "ready" | "encrypting" | "uploading" | "stored";
const STEP_MS = 280;

/**
 * The real upload pipeline, animated: the file is cut into chunks, each chunk is
 * encrypted in turn (tile flips to ciphertext, the name follows), then the ciphertext
 * drops into the drive. Cycles through a photo, a PDF and a video.
 */
function EncryptionDemo() {
  const t = useT();
  const [state, setState] = useState<{ file: number; phase: Phase; step: number }>({ file: 0, phase: "ready", step: 0 });
  const [stored, setStored] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const { phase, step } = state;
    const next = (ms: number, s: Partial<typeof state>) => setTimeout(() => setState((p) => ({ ...p, ...s })), ms);
    let timer: ReturnType<typeof setTimeout>;
    if (phase === "ready") timer = next(900, { phase: "encrypting", step: 0 });
    else if (phase === "encrypting") timer = step < CHUNKS ? next(STEP_MS, { step: step + 1 }) : next(350, { phase: "uploading" });
    else if (phase === "uploading")
      timer = setTimeout(() => {
        setStored((n) => n + 1);
        setState((p) => ({ ...p, phase: "stored" }));
      }, 750);
    else timer = setTimeout(() => setState((p) => ({ file: (p.file + 1) % DEMO_FILES.length, phase: "ready", step: 0 })), 1600);
    return () => clearTimeout(timer);
  }, [state]);

  const file = DEMO_FILES[state.file];
  const Icon = file.icon;
  const encrypted = (i: number) => state.phase !== "ready" && (state.phase !== "encrypting" || i < state.step);
  const shown = state.phase === "encrypting" ? Math.round((file.name.length * state.step) / CHUNKS) : state.phase === "ready" ? 0 : file.name.length;
  const name = seededHex(state.file + 7, shown) + file.name.slice(shown);
  const usage = 0.22 + ((stored % 6) * 0.11);

  let status: string;
  if (state.phase === "ready") status = t("landing.demo.ready");
  else if (state.phase === "encrypting") status = t("landing.demo.encrypting", { n: Math.min(state.step + 1, CHUNKS), total: CHUNKS });
  else if (state.phase === "uploading") status = t("landing.demo.uploading");
  else status = t("landing.demo.stored");

  return (
    <div className="relative mx-auto flex w-full max-w-sm flex-col gap-4">
      {/* The file being uploaded */}
      <div className="float rounded-2xl border border-border bg-card/90 p-4 shadow-2xl shadow-accent/10 backdrop-blur" style={{ "--tilt": "-1.5deg" } as CSSProperties}>
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm">
              <span className="text-accent">{name.slice(0, shown)}</span>
              {name.slice(shown)}
            </p>
            <p className="text-xs text-muted">{file.size}</p>
          </div>
          <Lock className={cn("h-4 w-4 shrink-0 transition-colors duration-500", state.phase === "ready" ? "text-muted" : "text-accent")} />
        </div>

        <div className="mt-4 grid grid-cols-4 gap-1.5 [perspective:600px]">
          {Array.from({ length: CHUNKS }, (_, i) => (
            <div
              key={i}
              className={cn(
                "aspect-square transition-all duration-500 ease-out",
                state.phase === "uploading" && "translate-y-24 opacity-0",
                state.phase === "stored" && "opacity-0",
              )}
              style={{ transitionDelay: state.phase === "uploading" ? `${i * 45}ms` : "0ms" }}
            >
              <div
                className="relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d]"
                style={{ transform: encrypted(i) ? "rotateY(180deg)" : "none" }}
              >
                <div className="absolute inset-0 rounded-md [backface-visibility:hidden]" style={file.tile(i)} />
                <div className="absolute inset-0 flex flex-col items-center justify-center rounded-md bg-[#11111a] font-mono text-[9px] leading-tight text-[#a5b4fc] [backface-visibility:hidden] [transform:rotateY(180deg)]">
                  <span>{seededHex(state.file * 31 + i, 4)}</span>
                  <span className="opacity-60">{seededHex(state.file * 31 + i + 99, 4)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          <span className={cn("flex items-center gap-1.5 truncate", state.phase === "stored" ? "text-success" : "text-muted")}>
            {state.phase === "stored" && <Check className="h-3.5 w-3.5 shrink-0" />}
            {status}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted">{t("landing.demo.cipher")}</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${state.phase === "ready" ? 0 : state.phase === "encrypting" ? (state.step / CHUNKS) * 100 : 100}%` }}
          />
        </div>
      </div>

      {/* Where the ciphertext lands */}
      <div className="float rounded-2xl border border-border bg-card/90 p-4 shadow-xl backdrop-blur [animation-delay:-3s]" style={{ "--tilt": "1deg" } as CSSProperties}>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg shadow-md transition-transform duration-300",
              state.phase === "stored" && "scale-110",
            )}
          >
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">{t("landing.demoDrive", { id: 7 })}</span>
              <span className="font-mono text-xs text-muted">4 GB</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-subtle">
              <div className="h-full rounded-full bg-accent transition-[width] duration-700 ease-out" style={{ width: `${usage * 100}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  const t = useT();
  return (
    <section className="relative overflow-hidden">
      {/* Background: slow aurora + dot grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="aurora absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-accent/25 blur-3xl" />
        <div className="aurora absolute top-20 -right-24 h-[24rem] w-[24rem] rounded-full bg-pink-500/15 blur-3xl [animation-delay:-6s]" />
        <div className="aurora absolute -bottom-24 -left-24 h-[22rem] w-[22rem] rounded-full bg-amber-400/15 blur-3xl [animation-delay:-12s]" />
        <div className="dot-grid absolute inset-0" />
      </div>

      <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pt-14 pb-20 md:grid-cols-[1.15fr_1fr] md:pt-24 md:pb-28">
        <div>
          <p className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3 py-1 text-xs text-muted backdrop-blur">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" />
            {t("landing.eyebrow")}
          </p>
          <h1 className="animate-fade-up mt-6 text-4xl font-semibold tracking-tight text-balance [animation-delay:80ms] sm:text-6xl">
            {t("landing.titleStart")} <span className="text-shimmer">{t("landing.titleAccent")}</span>
          </h1>
          <p className="animate-fade-up mt-6 max-w-xl text-lg text-pretty text-muted [animation-delay:160ms]">{t("landing.subtitle")}</p>
          <div className="animate-fade-up mt-9 flex flex-wrap gap-3 [animation-delay:240ms]">
            <Link
              href="/drive"
              className="group inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-6 text-sm font-medium text-accent-fg shadow-lg shadow-accent/25 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-accent/30"
            >
              {t("landing.ctaPrimary")}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <a
              href="#how"
              className="inline-flex h-12 items-center rounded-xl border border-border bg-card/70 px-6 text-sm font-medium backdrop-blur transition hover:bg-bg-subtle"
            >
              {t("landing.ctaSecondary")}
            </a>
          </div>
          <p className="animate-fade-up mt-6 text-xs text-muted [animation-delay:320ms]">{t("landing.testnet")}</p>
        </div>

        <div aria-hidden className="animate-fade-up [animation-delay:200ms]">
          <EncryptionDemo />
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ sections

const STACK = ["XChaCha20-Poly1305", "Argon2id", "ERC-721", "Rust", "WebAssembly", "Sepolia"];

function Stack() {
  const t = useT();
  return (
    <div className="border-y border-border bg-bg-subtle/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-3 px-4 py-6 text-sm text-muted">
        <span className="text-xs tracking-widest uppercase">{t("landing.stack")}</span>
        {STACK.map((s) => (
          <span key={s} className="font-mono">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

const FILES = [
  { name: "family-photos/beach.jpg", size: "4.2 MB", icon: ImageIcon },
  { name: "taxes-2026.pdf", size: "812 KB", icon: FileText },
  { name: "wedding.mp4", size: "1.3 GB", icon: Film },
  { name: "passwords-backup.txt", size: "2 KB", icon: FileText },
];

function ServerSees() {
  const t = useT();
  return (
    <section className="mx-auto max-w-6xl px-4 py-24">
      <Reveal className="max-w-2xl">
        <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t("landing.serverTitle")}</h2>
        <p className="mt-4 text-pretty text-muted">{t("landing.serverText")}</p>
      </Reveal>
      <Reveal delay={120} className="mt-12">
        <div className="grid overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:grid-cols-2">
          <div className="p-6">
            <p className="mb-4 flex items-center gap-2 text-xs tracking-widest text-muted uppercase">
              <KeyRound className="h-3.5 w-3.5 text-accent" />
              {t("landing.youSee")}
            </p>
            <ul className="flex flex-col gap-2">
              {FILES.map(({ name, size, icon: Icon }) => (
                <li key={name} className="flex items-center gap-3 rounded-lg bg-bg-subtle px-3 py-2.5 text-sm">
                  <Icon className="h-4 w-4 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <span className="text-xs text-muted tabular-nums">{size}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="relative border-t border-border bg-[#0b0b0f] p-6 text-[#9ca3af] md:border-t-0 md:border-l">
            <p className="mb-4 flex items-center gap-2 text-xs tracking-widest uppercase">
              <Cpu className="h-3.5 w-3.5" />
              {t("landing.serverSees")}
            </p>
            <ul className="flex flex-col gap-2">
              {FILES.map(({ name }, i) => (
                <li key={name} className="flex items-center gap-3 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
                  <Lock className="h-4 w-4 shrink-0 text-[#6b7280]" />
                  <Ciphertext length={28} seed={["a1f9", "77c0", "e3b2", "0d4e"][i]} className="min-w-0 flex-1 truncate text-xs text-[#a5b4fc]" />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

const FEATURES = [
  { key: "encryption", icon: ShieldCheck, wide: true },
  { key: "ownership", icon: HardDrive },
  { key: "transfer", icon: ArrowRightLeft },
  { key: "sharing", icon: Link2 },
  { key: "previews", icon: PlayCircle, wide: true },
  { key: "formats", icon: Palette },
] as const;

function onSpotlight(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
}

function Features() {
  const t = useT();
  return (
    <section className="border-t border-border bg-bg-subtle/50">
      <div className="mx-auto max-w-6xl px-4 py-24">
        <Reveal className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("landing.featuresTitle")}</h2>
          <p className="mt-4 text-muted">{t("landing.featuresText")}</p>
        </Reveal>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon, ...f }, i) => (
            <Reveal key={key} delay={i * 70} className={cn("wide" in f && "lg:col-span-2")}>
              <div
                onPointerMove={onSpotlight}
                className="spotlight h-full rounded-2xl border border-border bg-card p-6 transition-transform duration-300 hover:-translate-y-1"
              >
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 font-medium">{t(`landing.features.${key}.title` as MessageKey)}</h3>
                <p className="mt-2 text-sm text-pretty text-muted">{t(`landing.features.${key}.text` as MessageKey)}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = ["mint", "passphrase", "upload"] as const;

function Steps() {
  const t = useT();
  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-24">
      <Reveal>
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("landing.stepsTitle")}</h2>
      </Reveal>
      <ol className="relative mt-14 grid gap-10 sm:grid-cols-3 sm:gap-6">
        {STEPS.map((key, i) => (
          <li key={key}>
            <Reveal delay={i * 150}>
              <div className="relative flex items-center">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-2 border-accent bg-card font-mono text-sm font-semibold text-accent">
                  {i + 1}
                </span>
                {i < STEPS.length - 1 && <span className="draw-line ml-4 hidden h-0.5 flex-1 rounded-full bg-accent/40 sm:block" />}
              </div>
              <h3 className="mt-5 font-medium">{t(`landing.steps.${key}.title` as MessageKey)}</h3>
              <p className="mt-2 max-w-xs text-sm text-muted">{t(`landing.steps.${key}.text` as MessageKey)}</p>
            </Reveal>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Tiers() {
  const t = useT();
  const { tiers, isLoading } = useTiers();
  const active = tiers.filter((x) => x.active);
  // Highlight the cheapest per GB; a fact from the contract, not a marketing pick.
  const perGb = (x: (typeof active)[number]) => Number(x.price) / x.capacityGb;
  const best = active.length > 1 ? active.reduce((a, b) => (perGb(b) < perGb(a) ? b : a)).id : -1;

  return (
    <section className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-24">
        <Reveal className="text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("landing.tiersTitle")}</h2>
          <p className="mt-4 text-muted">{t("landing.tiersText")}</p>
        </Reveal>
        {isLoading ? (
          <Spinner className="mx-auto mt-12" />
        ) : (
          <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
            {active.map((tier, i) => {
              const hot = tier.id === best;
              return (
                <Reveal key={tier.id} delay={i * 100}>
                  <div
                    className={cn(
                      "relative flex h-full flex-col rounded-2xl border bg-card p-6 transition-transform duration-300 hover:-translate-y-1",
                      hot ? "border-accent shadow-xl shadow-accent/15" : "border-border",
                    )}
                  >
                    {hot && (
                      <span className="absolute -top-3 left-6 rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-fg">
                        {t("landing.bestValue")}
                      </span>
                    )}
                    <div className="text-4xl font-semibold tracking-tight">{t("drives.capacity", { gb: tier.capacityGb })}</div>
                    <div className="mt-2 font-mono text-sm">{formatEther(tier.price)} ETH</div>
                    <div className="mt-1 text-xs text-muted">
                      {t("landing.perGb", { price: formatEther(tier.price / BigInt(tier.capacityGb)) })}
                    </div>
                    <ul className="mt-6 flex flex-col gap-2 text-sm text-muted">
                      {(["encryption", "sharing", "transfer"] as const).map((k) => (
                        <li key={k} className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-accent" />
                          {t(`landing.features.${k}.title`)}
                        </li>
                      ))}
                    </ul>
                    <Link
                      href="/drive"
                      className={cn(
                        "mt-8 inline-flex h-10 items-center justify-center rounded-lg text-sm font-medium transition",
                        hot ? "bg-accent text-accent-fg hover:opacity-90" : "border border-border hover:bg-bg-subtle",
                      )}
                    >
                      {t("landing.mintCta")}
                    </Link>
                  </div>
                </Reveal>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function FinalCta() {
  const t = useT();
  return (
    <section className="mx-auto max-w-6xl px-4 pb-24">
      <Reveal>
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-6 py-16 text-center sm:px-16">
          <div aria-hidden className="aurora pointer-events-none absolute -top-24 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-accent/20 blur-3xl" />
          <h2 className="relative text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{t("landing.finalTitle")}</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-muted">{t("landing.finalText")}</p>
          <Link
            href="/drive"
            className="group relative mt-8 inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-6 text-sm font-medium text-accent-fg shadow-lg shadow-accent/25 transition hover:-translate-y-0.5"
          >
            {t("landing.ctaPrimary")}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

export function Landing() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-transparent bg-bg/70 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
          <Logo />
          <Link
            href="/drive"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card/70 px-4 text-sm font-medium transition hover:bg-bg-subtle"
          >
            {t("nav.openApp")}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <Hero />
        <Stack />
        <ServerSees />
        <Features />
        <Steps />
        <Tiers />
        <FinalCta />
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-muted">{t("landing.footer")}</div>
      </footer>
    </div>
  );
}
