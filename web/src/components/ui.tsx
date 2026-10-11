"use client";

import { Eye, EyeOff, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";

import { useT } from "@/i18n";

/** Joins classes; of two conflicting Tailwind classes the later one wins (`cn("border-border", "border-accent")`). */
export const cn = (...c: (string | false | null | undefined)[]) => twMerge(c.filter(Boolean).join(" "));

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-border bg-card hover:bg-bg-subtle",
  ghost: "hover:bg-bg-subtle",
  danger: "bg-danger text-white hover:opacity-90",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "icon"; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
        size === "md" && "h-9 px-4",
        size === "sm" && "h-8 px-3",
        size === "icon" && "h-8 w-8",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition placeholder:text-muted focus:border-accent",
        className,
      )}
      {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-5 w-5 animate-spin text-muted", className)} />;
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle", className)}>
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-card", className)}>{children}</div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "danger"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        tone === "info" ? "border-border bg-bg-subtle text-muted" : "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      {children}
    </div>
  );
}

/** Password field with its own show/hide toggle (the browser's built-in one is unreliable). */
export function PasswordInput({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const Icon = shown ? EyeOff : Eye;
  return (
    <div className="relative">
      <Input type={shown ? "text" : "password"} spellCheck={false} className={cn("pr-10", className)} {...rest} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? t("common.hidePassword") : t("common.showPassword")}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-muted transition hover:text-fg"
      >
        <Icon className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Longest close animation (globals.css); after it the content unmounts. */
const CLOSE_MS = 220;

/**
 * Native modal <dialog>: focus trap, Esc and backdrop handled by the browser.
 * Opening and closing are animated in CSS; while closing, the last content stays
 * rendered so it fades out instead of disappearing (and media stops after).
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  tone?: "danger";
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  // Snapshot of the content while open, shown during the close animation.
  const [snapshot, setSnapshot] = useState<{ title: ReactNode; children: ReactNode } | null>(null);
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setClosing(true);
  }
  if (open && (snapshot?.title !== title || snapshot?.children !== children)) setSnapshot({ title, children });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);

  const content = open ? { title, children } : closing ? snapshot : null;
  return (
    <dialog
      ref={ref}
      // Escape asks the parent instead of closing natively, so it can keep the dialog open
      // (e.g. to warn about unsaved work). Browsers may still force-close after repeated
      // presses: reopen then if the parent still wants it open.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        onClose();
        requestAnimationFrame(() => {
          const d = ref.current;
          if (openRef.current && d && !d.open) d.showModal();
        });
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-2xl border bg-card p-0 text-fg shadow-2xl",
        tone === "danger" ? "border-danger/50" : "border-border",
        wide ? "max-w-4xl" : "max-w-md",
      )}
    >
      {content && (
        <div className="flex max-h-[85vh] flex-col">
          <div className={cn("flex items-center justify-between gap-4 border-b px-5 py-3", tone === "danger" ? "border-danger/30" : "border-border")}>
            <h2 className={cn("truncate font-semibold", tone === "danger" && "text-danger")}>{content.title}</h2>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("common.close")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="overflow-auto p-5">{content.children}</div>
        </div>
      )}
    </dialog>
  );
}
