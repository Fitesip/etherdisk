"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Download, KeyRound, LifeBuoy, Printer, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { renderSVG } from "uqr";

import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { checkRecoveryWords, fromB64, loadCrypto, newRecoveryWords, toB64, WasmVault } from "@/lib/crypto";
import { formatDate } from "@/lib/format";
import { takeOver } from "@/lib/drive-key";
import { openKeyring, rewrapVault } from "@/lib/kdf";
import { passphraseValid } from "@/lib/passphrase";
import { useStored, writeStored } from "@/lib/storage";
import { useUnlocked } from "@/lib/unlocked";

import { PassphraseRules } from "../passphrase-rules";
import { useToast } from "../toast";
import { Button, Dialog, Input, Notice, PasswordInput } from "../ui";
import type { DriveCtx } from "./dialogs";

/** Positions (1-based) asked back to check the words were saved. */
const CHECKS = 3;

function pickPositions(): number[] {
  const all = Array.from({ length: 24 }, (_, i) => i + 1);
  for (let i = all.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, CHECKS).sort((a, b) => a - b);
}

function WordGrid({ words }: { words: string[] }) {
  return (
    <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-bg-subtle p-4 font-mono text-sm sm:grid-cols-3">
      {words.map((w, i) => (
        <li key={i} className="flex gap-2">
          <span className="w-5 text-right text-muted tabular-nums">{i + 1}</span>
          <span>{w}</span>
        </li>
      ))}
    </ol>
  );
}

interface SheetInfo {
  name: string;
  tokenId: string;
  words: string[];
  created: number;
}

/** "Photos (#3)", or just "Drive #3" when the drive has no name of its own. */
const driveLabel = (s: SheetInfo) => (s.name.endsWith(`#${s.tokenId}`) ? s.name : `${s.name} (#${s.tokenId})`);

function sheetText(s: SheetInfo, t: ReturnType<typeof useT>): string {
  const lines = s.words.map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`);
  return [
    t("recovery.sheetTitle"),
    "",
    `${t("recovery.sheetDrive")}: ${driveLabel(s)}`,
    `${t("recovery.sheetContract")}: ${CONTRACT_ADDRESS}`,
    `${t("recovery.sheetCreated")}: ${formatDate(s.created)}`,
    "",
    ...lines,
    "",
    t("recovery.sheetKeep"),
    t("recovery.sheetUse"),
    t("recovery.sheetCancel"),
    "",
  ].join("\n");
}

/** The printable sheet: only visible while printing (see `.print-only` in globals.css). */
function PrintSheet({ sheet }: { sheet: SheetInfo }) {
  const t = useT();
  const qr = useMemo(() => renderSVG(sheet.words.join(" "), { border: 1 }), [sheet.words]);
  return createPortal(
    <div className="print-only p-10 text-black">
      <h1 className="text-2xl font-semibold">{t("recovery.sheetTitle")}</h1>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>{t("recovery.sheetDrive")}</dt>
        <dd>{driveLabel(sheet)}</dd>
        <dt>{t("recovery.sheetContract")}</dt>
        <dd className="font-mono">{CONTRACT_ADDRESS}</dd>
        <dt>{t("recovery.sheetCreated")}</dt>
        <dd>{formatDate(sheet.created)}</dd>
      </dl>
      <div className="mt-6 flex items-start gap-8">
        <ol className="grid flex-1 grid-cols-3 gap-x-6 gap-y-2 font-mono text-base">
          {sheet.words.map((w, i) => (
            <li key={i}>
              {i + 1}. {w}
            </li>
          ))}
        </ol>
        {/* Generated locally from the words; contains no markup from elsewhere. */}
        <div className="h-36 w-36 shrink-0" dangerouslySetInnerHTML={{ __html: qr }} />
      </div>
      <p className="mt-6 text-sm">{t("recovery.sheetKeep")}</p>
      <p className="mt-1 text-sm">{t("recovery.sheetUse")}</p>
      <p className="mt-1 text-sm">{t("recovery.sheetCancel")}</p>
    </div>,
    document.body,
  );
}

/**
 * Words shown but not saved yet, per signed-in wallet and drive. Kept in page memory only
 * (never stored), so reopening the dialog shows the same words and a sheet already
 * downloaded or printed stays valid. A reload starts over.
 */
interface Draft {
  words: string[];
  created: number;
  /** Downloaded or sent to the printer: closing now would leave a sheet that opens nothing. */
  exported: boolean;
}
const drafts = new Map<string, Draft>();

/** Creates (or replaces) the drive's recovery key: show the words, check them, save. */
export function RecoveryDialog({ open, onClose, ctx, replacing }: { open: boolean; onClose: () => void; ctx: DriveCtx; replacing?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const draftKey = `${ctx.token}:${ctx.tokenId}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const words = draft?.words ?? null;
  const [step, setStep] = useState<"show" | "check" | "leave">("show");
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    loadCrypto().then(() => {
      if (!live) return;
      let d = drafts.get(draftKey);
      if (!d) {
        d = { words: newRecoveryWords().split(" "), created: Date.now(), exported: false };
        drafts.set(draftKey, d);
      }
      setDraft(d);
    });
    return () => {
      live = false;
      setDraft(null);
      setStep("show");
      setAnswers({});
      setWrong(false);
      setError(null);
    };
  }, [open, draftKey]);

  const sheet: SheetInfo | null = draft && { name: ctx.name, tokenId: ctx.tokenId, words: draft.words, created: draft.created };

  function markExported() {
    if (!draft) return;
    const next = { ...draft, exported: true };
    drafts.set(draftKey, next);
    setDraft(next);
  }

  /** Closing with a sheet out but nothing saved: warn first. */
  function requestClose() {
    if (busy) return;
    if (draft?.exported && step !== "leave") setStep("leave");
    else onClose();
  }

  function startCheck() {
    setPositions(pickPositions());
    setAnswers({});
    setWrong(false);
    setStep("check");
  }

  function download() {
    if (!sheet) return;
    markExported();
    const url = URL.createObjectURL(new Blob([sheetText(sheet, t)], { type: "text/plain;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `etherdisk-recovery-drive-${ctx.tokenId}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!words) return;
    const ok = positions.every((p) => (answers[p] ?? "").trim().toLowerCase() === words[p - 1]);
    if (!ok) {
      setWrong(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const blob = ctx.vault.wrapForRecovery(words.join(" "));
      await api.putRecovery(ctx.token, ctx.tokenId, toB64(blob));
      await qc.invalidateQueries({ queryKey: ["vault", ctx.token, ctx.tokenId] });
      await qc.invalidateQueries({ queryKey: ["vaults", ctx.token] });
      drafts.delete(draftKey);
      toast({ text: t("recovery.saved") });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={requestClose} title={t("recovery.dialogTitle", { name: ctx.name })}>
      {!words ? null : step === "leave" ? (
        <div className="flex flex-col gap-4">
          <Notice tone="danger">{t("recovery.notSavedYet")}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={startCheck}>
              {t("recovery.finishCheck")}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t("recovery.closeAnyway")}
            </Button>
          </div>
        </div>
      ) : step === "show" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t("recovery.intro")}</p>
          {replacing && <Notice tone="danger">{t("recovery.replaceWarning")}</Notice>}
          <WordGrid words={words} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={download}>
              <Download className="h-4 w-4" />
              {t("recovery.download")}
            </Button>
            <Button
              onClick={() => {
                markExported();
                window.print();
              }}
            >
              <Printer className="h-4 w-4" />
              {t("recovery.print")}
            </Button>
          </div>
          <Button variant="primary" onClick={startCheck}>
            {t("recovery.next")}
          </Button>
          {sheet && <PrintSheet sheet={sheet} />}
        </div>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-medium">{t("recovery.checkTitle")}</p>
            <p className="text-sm text-muted">{t("recovery.checkText")}</p>
          </div>
          {positions.map((p, i) => (
            <label key={p} className="text-sm">
              {t("recovery.wordN", { n: p })}
              <Input
                className="mt-1 font-mono"
                autoFocus={i === 0}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={answers[p] ?? ""}
                onChange={(e) => {
                  setWrong(false);
                  setAnswers((a) => ({ ...a, [p]: e.target.value }));
                }}
              />
            </label>
          ))}
          {wrong && <p className="text-xs text-danger">{t("recovery.checkWrong")}</p>}
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep("show")} disabled={busy}>
              {t("recovery.back")}
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={positions.some((p) => !answers[p]?.trim())}>
              {t("recovery.save")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Live hint while typing the words. */
function useWordsProblem(words: string): { ok: boolean; hint: string | null } {
  const t = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadCrypto().then(() => setReady(true));
  }, []);
  if (!ready || !words.trim()) return { ok: false, hint: null };
  const problem = checkRecoveryWords(words);
  if (!problem) return { ok: true, hint: t("recovery.looksRight") };
  if (problem.startsWith("word:")) return { ok: false, hint: t("recovery.problemWord", { n: problem.slice(5) }) };
  if (problem === "checksum") return { ok: false, hint: t("recovery.problemChecksum") };
  const n = words.split(/[^A-Za-z]+/).filter(Boolean).length;
  return { ok: false, hint: n < 24 ? null : t("recovery.problemCount", { n }) };
}

/** Lost passphrase: open the drive with the recovery words and choose a new passphrase. */
export function RecoverForm({
  token,
  tokenId,
  name,
  keyBlob,
  etag,
  keyring,
  needsNewKey,
  onCancel,
}: {
  token: string;
  tokenId: string;
  name: string;
  keyBlob: string;
  etag: string;
  keyring: string | null;
  needsNewKey: boolean;
  onCancel: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const unlocked = useUnlocked();
  const [words, setWords] = useState("");
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = useWordsProblem(words);
  const valid = problem.ok && passphraseValid(pass) && pass === repeat;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    let recovered: WasmVault | undefined;
    try {
      const saved = await api.getRecovery(token, tokenId);
      if (!saved) throw new Error(t("recovery.noKey"));
      await loadCrypto();
      let opened: WasmVault;
      try {
        opened = WasmVault.recover(fromB64(saved.blob), words, fromB64(keyBlob));
      } catch {
        throw new Error(t("recovery.wrongKey"));
      }
      recovered = opened;
      openKeyring(opened, keyring);
      if (needsNewKey) {
        unlocked.set(tokenId, await takeOver(token, tokenId, opened, pass, etag));
      } else {
        const vault = await rewrapVault(opened, pass);
        try {
          const put = await api.putKey(token, tokenId, toB64(vault.keyBlob), etag);
          unlocked.set(tokenId, { vault, etag: put.etag });
        } catch (err) {
          vault.free();
          throw err;
        }
      }
      await qc.invalidateQueries({ queryKey: ["key", token, tokenId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
      setBusy(false);
    } finally {
      recovered?.free();
    }
  }

  return (
    <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-8">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
        <LifeBuoy className="h-6 w-6" />
      </div>
      <h1 className="text-lg font-semibold">{t("recovery.useTitle", { name })}</h1>
      <p className="mt-1 text-sm text-muted">{t("recovery.useText")}</p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label className="text-sm font-medium">
          {t("recovery.words")}
          <textarea
            value={words}
            onChange={(e) => setWords(e.target.value)}
            rows={4}
            autoFocus
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("recovery.wordsPlaceholder")}
            className="mt-2 w-full resize-y rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm font-normal outline-none transition focus:border-accent"
          />
        </label>
        {problem.hint && <p className={problem.ok ? "-mt-1 text-xs text-success" : "-mt-1 text-xs text-danger"}>{problem.hint}</p>}
        <PasswordInput autoComplete="new-password" placeholder={t("vault.newPassphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
        <PassphraseRules value={pass} />
        <PasswordInput autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        {repeat && pass !== repeat && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          <KeyRound className="h-4 w-4" />
          {t("recovery.open")}
        </Button>
        <button type="button" className="self-start text-xs text-muted underline" onClick={onCancel} disabled={busy}>
          {t("recovery.usePassphrase")}
        </button>
      </form>
    </div>
  );
}

const hintKey = (tokenId: string) => `etherdisk.recoveryHint.${tokenId}`;

/** Inside an unlocked drive without a recovery key: suggests creating one. */
export function RecoveryBanner({ ctx, recoveryAt }: { ctx: DriveCtx; recoveryAt: number | null }) {
  const t = useT();
  const dismissed = useStored(hintKey(ctx.tokenId)) === "dismissed";
  const [open, setOpen] = useState(false);
  if (recoveryAt || dismissed) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm">
      <LifeBuoy className="h-4 w-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1">{t("recovery.bannerText")}</p>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        {t("recovery.create")}
      </Button>
      <Button size="icon" variant="ghost" aria-label={t("recovery.notNow")} title={t("recovery.notNow")} onClick={() => writeStored(hintKey(ctx.tokenId), "dismissed")}>
        <X className="h-4 w-4" />
      </Button>
      <RecoveryDialog open={open} onClose={() => setOpen(false)} ctx={ctx} />
    </div>
  );
}

/** Settings row: status, create / replace / remove. */
export function RecoverySettings({ ctx, recoveryAt }: { ctx: DriveCtx | null; recoveryAt: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (!ctx) return;
    setBusy(true);
    try {
      await api.deleteRecovery(ctx.token, ctx.tokenId);
      await qc.invalidateQueries({ queryKey: ["vault", ctx.token, ctx.tokenId] });
      toast({ text: t("recovery.removed") });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-md">
        <p className="text-sm font-medium">{t("recovery.title")}</p>
        <p className="text-sm text-muted">{t("recovery.text")}</p>
        <p className={recoveryAt ? "mt-1 text-sm text-success" : "mt-1 text-sm text-danger"}>
          {recoveryAt ? t("recovery.savedOn", { date: formatDate(recoveryAt) }) : t("recovery.none")}
        </p>
      </div>
      {ctx && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant={recoveryAt ? "secondary" : "primary"} onClick={() => setOpen(true)}>
            {recoveryAt ? t("recovery.replace") : t("recovery.create")}
          </Button>
          {recoveryAt &&
            (confirming ? (
              <Button variant="danger" loading={busy} onClick={remove}>
                {t("recovery.removeConfirm")}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                {t("recovery.remove")}
              </Button>
            ))}
          <RecoveryDialog open={open} onClose={() => setOpen(false)} ctx={ctx} replacing={!!recoveryAt} />
        </div>
      )}
    </div>
  );
}
