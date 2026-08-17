import { en, type Messages } from "./messages/en";

export const locales = {
  en: { label: "English", messages: en },
} satisfies Record<string, { label: string; messages: Messages }>;

export type Locale = keyof typeof locales;
export const DEFAULT_LOCALE: Locale = "en";
