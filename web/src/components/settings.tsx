"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useI18n } from "@/i18n";
import { locales, type Locale } from "@/i18n/locales";
import { useThemePref, type ThemePref } from "@/lib/theme";

import { Card, cn } from "./ui";

export function SettingsView() {
  const { t, locale, setLocale } = useI18n();
  const [theme, setTheme] = useThemePref();
  const themes: { value: ThemePref; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("settings.themeLight"), icon: Sun },
    { value: "dark", label: t("settings.themeDark"), icon: Moon },
    { value: "system", label: t("settings.themeSystem"), icon: Monitor },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
      <Card className="mt-6 divide-y divide-border">
        <div className="p-5">
          <h2 className="font-medium">{t("settings.theme")}</h2>
          <div role="radiogroup" className="mt-3 grid grid-cols-3 gap-2">
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition",
                  theme === value ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:bg-bg-subtle",
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="p-5">
          <label htmlFor="locale" className="font-medium">
            {t("settings.language")}
          </label>
          <select
            id="locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="mt-3 block h-10 w-full rounded-lg border border-border bg-card px-3 text-sm"
          >
            {Object.entries(locales).map(([code, l]) => (
              <option key={code} value={code}>
                {l.label}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">{t("settings.languageHint")}</p>
        </div>
      </Card>
    </div>
  );
}
