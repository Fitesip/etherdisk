"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { useStored, writeStored } from "@/lib/storage";

import { DEFAULT_LOCALE, locales, type Locale } from "./locales";
import type { Messages } from "./messages/en";

const STORAGE_KEY = "locale";

/** Dot paths to every string, e.g. "files.upload". */
type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Paths<Messages>;
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18n | null>(null);

function lookup(messages: Messages, key: string): string {
  const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages);
  return typeof v === "string" ? v : key;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const stored = useStored(STORAGE_KEY);
  const locale: Locale = stored && stored in locales ? (stored as Locale) : DEFAULT_LOCALE;

  const setLocale = useCallback((l: Locale) => {
    writeStored(STORAGE_KEY, l);
    document.documentElement.lang = l;
  }, []);

  const t = useCallback<Translate>(
    (key, vars) => {
      let s = lookup(locales[locale].messages, key);
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

export function useT(): Translate {
  return useI18n().t;
}
