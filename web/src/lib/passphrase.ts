import type { MessageKey } from "@/i18n";

import { MIN_PASSPHRASE_LENGTH } from "./config";

export interface Rule {
  key: MessageKey;
  ok: (p: string) => boolean;
}

/** Required for new passphrases. Existing ones still unlock whatever they are. */
export const PASSPHRASE_RULES: Rule[] = [
  { key: "vault.ruleLength", ok: (p) => [...p].length >= MIN_PASSPHRASE_LENGTH },
  { key: "vault.ruleLower", ok: (p) => /\p{Ll}/u.test(p) },
  { key: "vault.ruleUpper", ok: (p) => /\p{Lu}/u.test(p) },
  { key: "vault.ruleDigit", ok: (p) => /\p{Nd}/u.test(p) },
  // Anything that is not a letter, digit or whitespace.
  { key: "vault.ruleSpecial", ok: (p) => /[^\p{L}\p{Nd}\s]/u.test(p) },
];

export const passphraseValid = (p: string) => PASSPHRASE_RULES.every((r) => r.ok(p));
