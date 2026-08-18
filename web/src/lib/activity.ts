"use client";

// Last user activity in this tab, for auto-lock. Survives reloads via sessionStorage,
// so reloading does not reset the idle timer.

const KEY = "nftvault.activity";
const PERSIST_EVERY_MS = 5_000;

let last = 0;
let persisted = 0;
let started = false;

function persist(now: number) {
  if (now - persisted < PERSIST_EVERY_MS) return;
  persisted = now;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {}
}

/** Marks the tab as active (user input, or work such as an upload in progress). */
export function touchActivity() {
  last = Date.now();
  persist(last);
}

/** Milliseconds since the last activity. */
export function idleFor(): number {
  return Date.now() - lastActivity();
}

export function lastActivity(): number {
  if (!last) {
    const stored = Number(typeof sessionStorage === "undefined" ? 0 : sessionStorage.getItem(KEY));
    last = Number.isFinite(stored) && stored > 0 ? stored : Date.now();
  }
  return last;
}

/** Starts listening for user input once per tab. */
export function startActivityTracking() {
  if (started || typeof window === "undefined") return;
  started = true;
  lastActivity();
  const onInput = () => touchActivity();
  for (const e of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(e, onInput, { passive: true, capture: true });
  // Flush the exact time before a reload.
  window.addEventListener("pagehide", () => {
    persisted = 0;
    persist(last);
  });
}
