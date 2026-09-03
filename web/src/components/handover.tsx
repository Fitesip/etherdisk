"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, KeyRound, Send, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Address } from "viem";
import { useSignMessage } from "wagmi";

import { useT } from "@/i18n";
import { api, type OutgoingHandover } from "@/lib/api";
import { fromB64, toB64, type WasmVault } from "@/lib/crypto";
import { shortAddress } from "@/lib/format";
import { enableInbox, openDriveKey, sealDriveKey, verifiedInbox, type Sign } from "@/lib/inbox";
import { rewrapKey, unlockVault } from "@/lib/kdf";
import { passphraseValid } from "@/lib/passphrase";
import { useSession } from "@/lib/session";
import { useStored, writeStored } from "@/lib/storage";
import { useUnlocked } from "@/lib/unlocked";

import { PassphraseRules } from "./passphrase-rules";
import { useToast } from "./toast";
import { Button, Card, Notice, PasswordInput } from "./ui";

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message.split("\n")[0] : fallback);

function useSign(): Sign {
  const sign = useSignMessage();
  return (message) => sign.mutateAsync({ message });
}

/** Whether this wallet has published an inbox key. */
export function useInboxStatus(token: string | null) {
  const { address } = useSession();
  return useQuery({
    queryKey: ["inbox", address],
    queryFn: async () => !!(await api.getInbox(address!)),
    enabled: !!address && !!token,
  });
}

function EnableInboxButton({ token, size }: { token: string; size?: "sm" }) {
  const t = useT();
  const qc = useQueryClient();
  const { address } = useSession();
  const sign = useSign();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="primary"
        size={size}
        loading={busy}
        onClick={async () => {
          if (!address) return;
          setBusy(true);
          setError(null);
          try {
            await enableInbox(token, address, sign);
            await qc.invalidateQueries({ queryKey: ["inbox", address] });
          } catch (e) {
            setError(errorText(e, t("common.error")));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Inbox className="h-4 w-4" />
        {busy ? t("handover.inboxEnabling") : t("handover.inboxEnable")}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Settings page section. */
export function InboxSettings({ token }: { token: string }) {
  const t = useT();
  const status = useInboxStatus(token);
  return (
    <div>
      <h2 className="font-medium">{t("handover.inboxTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("handover.inboxText")}</p>
      <div className="mt-3">
        {status.data ? <p className="text-sm text-success">{t("handover.inboxOn")}</p> : status.isSuccess && <EnableInboxButton token={token} />}
      </div>
    </div>
  );
}

/** One-time suggestion on the drives page. */
export function InboxHint({ token }: { token: string }) {
  const t = useT();
  const status = useInboxStatus(token);
  const dismissed = useStored("etherdisk.inboxHint") === "dismissed";
  if (dismissed || !status.isSuccess || status.data) return null;
  return (
    <Card className="flex animate-fade-up flex-wrap items-center gap-4 p-4">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
        <Inbox className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t("handover.inboxHintTitle")}</p>
        <p className="text-sm text-muted">{t("handover.inboxHint")}</p>
      </div>
      <EnableInboxButton token={token} size="sm" />
      <Button size="icon" variant="ghost" aria-label={t("handover.notNow")} onClick={() => writeStored("etherdisk.inboxHint", "dismissed")}>
        <X className="h-4 w-4" />
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ sender side

function OutgoingRow({ token, h }: { token: string; h: OutgoingHandover }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = h.name || t("drives.drive", { id: h.token_id });
  const refresh = () => qc.invalidateQueries({ queryKey: ["handovers", token] });

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!h.key_blob || !h.recipient || !pass) return;
    setBusy(true);
    setError(null);
    let vault: WasmVault | null = null;
    try {
      try {
        vault = await unlockVault(fromB64(h.key_blob), pass);
      } catch {
        throw new Error(t("vault.wrongPassphrase"));
      }
      // Re-check the recipient's signature here: the server must not be able to swap keys.
      const recipient = await verifiedInbox(h.to as Address, h.recipient);
      if (!recipient) throw new Error(t("common.error"));
      await api.sealHandover(token, h.token_id, h.to, sealDriveKey(vault, h.token_id, recipient));
      toast({ text: t("handover.sent", { to: shortAddress(h.to) }) });
      await refresh();
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      vault?.free();
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="font-mono text-xs text-muted">{t("handover.to", { to: shortAddress(h.to) })}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await api.declineHandover(token, h.token_id);
            await refresh();
          }}
        >
          {t("handover.decline")}
        </Button>
      </div>
      {!h.recipient ? (
        <p className="text-sm text-muted">{t("handover.waitingRecipient")}</p>
      ) : !h.key_blob ? (
        <p className="text-sm text-muted">{t("handover.blobChanged")}</p>
      ) : (
        <form onSubmit={send} className="flex flex-wrap items-start gap-2">
          <div className="min-w-48 flex-1">
            <PasswordInput autoComplete="current-password" placeholder={t("vault.passphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" loading={busy} disabled={!pass}>
            <Send className="h-4 w-4" />
            {t("handover.send")}
          </Button>
          {error && <p className="basis-full text-xs text-danger">{error}</p>}
        </form>
      )}
    </li>
  );
}

/** Drives the user gave away that still wait for their key (drives page). */
export function OutgoingHandovers({ token }: { token: string }) {
  const t = useT();
  const list = useQuery({ queryKey: ["handovers", token], queryFn: () => api.outgoingHandovers(token) });
  if (!list.data?.length) return null;
  return (
    <section className="animate-fade-up">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Send className="h-4 w-4 text-accent" />
        {t("handover.outgoingTitle")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("handover.outgoingText")}</p>
      <Card className="mt-4">
        <ul className="divide-y divide-border">
          {list.data.map((h) => (
            <OutgoingRow key={h.token_id} token={token} h={h} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

// ------------------------------------------------------------------ recipient side

/**
 * On a locked drive: the key the previous owner sent (open it with the wallet, then set
 * a new passphrase), or a note that it hasn't arrived yet.
 */
export function IncomingHandover({ token, tokenId, keyBlob, etag }: { token: string; tokenId: string; keyBlob: string; etag: string }) {
  const t = useT();
  const qc = useQueryClient();
  const store = useUnlocked();
  const sign = useSign();
  const inbox = useInboxStatus(token);
  const incoming = useQuery({ queryKey: ["handover", token, tokenId], queryFn: () => api.incomingHandover(token, tokenId) });
  const [dek, setDek] = useState<Uint8Array | null>(null);
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const h = incoming.data;
  if (!h) return null;

  if (!h.sealed) {
    return (
      <Notice>
        <span className="font-medium text-fg">{t("handover.waitingTitle")}. </span>
        {t("handover.waitingText", { from: shortAddress(h.from) })}
        {inbox.isSuccess && !inbox.data && (
          <span className="mt-3 flex flex-wrap items-center gap-3">
            {t("handover.waitingNoInbox")}
            <EnableInboxButton token={token} size="sm" />
          </span>
        )}
      </Notice>
    );
  }

  async function receive() {
    setBusy(true);
    setError(null);
    try {
      setDek(await openDriveKey(h!.sealed!, tokenId, sign));
    } catch {
      setError(t("handover.openFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dek || !passphraseValid(pass) || pass !== repeat) return;
    setBusy(true);
    setError(null);
    let vault: WasmVault | null = null;
    try {
      vault = await rewrapKey(dek, fromB64(keyBlob), pass);
      const saved = await api.putKey(token, tokenId, toB64(vault.keyBlob), etag);
      dek.fill(0);
      await api.dismissHandover(token, tokenId).catch(() => {});
      store.set(tokenId, { vault, etag: saved.etag });
      vault = null;
      await qc.invalidateQueries({ queryKey: ["handover", token, tokenId] });
    } catch (err) {
      setError(errorText(err, t("common.error")));
    } finally {
      vault?.free();
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto mt-10 max-w-md animate-fade-up border-accent/50 p-8">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
        <KeyRound className="h-6 w-6" />
      </div>
      <h2 className="text-lg font-semibold">{t("handover.incomingTitle")}</h2>
      <p className="mt-1 text-sm text-muted">
        {t("handover.incomingText")} <span className="font-mono">({shortAddress(h.from)})</span>
      </p>
      {!dek ? (
        <Button variant="primary" className="mt-6 w-full" loading={busy} onClick={receive}>
          {busy ? t("handover.receiving") : t("handover.receive")}
        </Button>
      ) : (
        <form onSubmit={save} className="mt-6 flex flex-col gap-3">
          <p className="text-sm font-medium">{t("handover.choosePassphrase")}</p>
          <PasswordInput autoComplete="new-password" placeholder={t("vault.newPassphrase")} value={pass} onChange={(e) => setPass(e.target.value)} />
          <PassphraseRules value={pass} />
          <PasswordInput autoComplete="new-password" placeholder={t("vault.passphraseRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          {repeat && pass !== repeat && <p className="text-xs text-danger">{t("vault.passphraseMismatch")}</p>}
          <Button type="submit" variant="primary" loading={busy} disabled={!passphraseValid(pass) || pass !== repeat}>
            {t("handover.saveAndOpen")}
          </Button>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
    </Card>
  );
}
