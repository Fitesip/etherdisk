"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ExternalLink, EyeOff, Lightbulb, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Address } from "viem";
import { useSignMessage } from "wagmi";

import { useT, type MessageKey } from "@/i18n";
import { api, ApiError, type Idea, type IdeaStatus, type VoteChoice } from "@/lib/api";
import { API_URL } from "@/lib/config";
import { formatDate, shortAddress } from "@/lib/format";
import { useHydrated } from "@/lib/hydrated";
import { useSession } from "@/lib/session";

import { useToast } from "./toast";
import { Button, Card, cn, Dialog, Input, Notice, Spinner } from "./ui";
import { ConnectButton } from "./wallet";

const STATUSES: IdeaStatus[] = ["open", "planned", "in_progress", "done", "declined"];
const MAX_TITLE = 120;
const MAX_BODY = 2000;

/** Must match the server's `vote_message`. */
const voteMessage = (idea: number, choice: string, address: Address, issuedAt: number) =>
  `Etherdisk vote\n\nIdea: #${idea}\nChoice: ${choice}\nAddress: ${address.toLowerCase()}\nIssued at: ${issuedAt}`;

const STATUS_STYLE: Record<IdeaStatus, string> = {
  open: "border-border text-muted",
  planned: "border-accent/50 text-accent",
  in_progress: "border-amber-500/50 text-amber-600 dark:text-amber-400",
  done: "border-success/50 text-success",
  declined: "border-danger/40 text-danger",
};

function StatusBadge({ status }: { status: IdeaStatus }) {
  const t = useT();
  return <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", STATUS_STYLE[status])}>{t(`ideas.status.${status}` as MessageKey)}</span>;
}

function ProposeDialog({ open, onClose, token }: { open: boolean; onClose: () => void; token: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.proposeIdea(token, title.trim(), body.trim());
      await qc.invalidateQueries({ queryKey: ["ideas"] });
      setTitle("");
      setBody("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? err.message : err instanceof Error ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("ideas.proposeTitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="text-sm font-medium">
          {t("ideas.titleLabel")}
          <Input className="mt-2 font-normal" value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        <label className="text-sm font-medium">
          {t("ideas.bodyLabel")}
          <textarea
            value={body}
            maxLength={MAX_BODY}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            className="mt-2 w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal outline-none transition focus:border-accent"
          />
          <span className="mt-1 block text-right text-xs font-normal text-muted tabular-nums">
            {body.length}/{MAX_BODY}
          </span>
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>
          {t("ideas.submit")}
        </Button>
      </form>
    </Dialog>
  );
}

function VoteButton({ dir, active, disabled, busy, label, onClick }: { dir: VoteChoice; active: boolean; disabled: boolean; busy: boolean; label: string; onClick: () => void }) {
  const Icon = dir === "for" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "grid h-7 w-10 place-items-center rounded-lg border transition",
        active
          ? dir === "for"
            ? "border-accent bg-accent text-accent-fg"
            : "border-danger bg-danger text-white"
          : cn("border-transparent", dir === "for" ? "hover:border-accent hover:text-accent" : "hover:border-danger hover:text-danger"),
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-inherit",
      )}
    >
      {busy ? <Spinner className="h-4 w-4" /> : <Icon className="h-5 w-5" />}
    </button>
  );
}

function IdeaCard({ idea, token, mine, canVote, admin }: { idea: Idea; token: string | null; mine?: VoteChoice; canVote: boolean; admin: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { address } = useSession();
  const sign = useSignMessage();
  const [busy, setBusy] = useState<VoteChoice | null>(null);
  const own = !!address && idea.author.toLowerCase() === address.toLowerCase();
  const score = idea.votes_for - idea.votes_against;

  /** Clicking your current side withdraws the vote; the other side switches to it. */
  async function vote(side: VoteChoice) {
    if (!token || !address) return;
    setBusy(side);
    try {
      const choice = mine === side ? "withdraw" : side;
      const issued_at = Math.floor(Date.now() / 1000);
      const signature = await sign.mutateAsync({ message: voteMessage(idea.id, choice, address, issued_at) });
      await api.voteIdea(token, idea.id, { choice, issued_at, signature });
      await qc.invalidateQueries({ queryKey: ["ideas"] });
    } catch (err) {
      toast({ text: err instanceof Error ? err.message.split("\n")[0] : t("common.error") });
    } finally {
      setBusy(null);
    }
  }

  async function moderate(patch: { status?: IdeaStatus; hidden?: boolean }) {
    if (!token) return;
    await api.moderateIdea(token, idea.id, patch);
    await qc.invalidateQueries({ queryKey: ["ideas"] });
  }

  return (
    <li className={cn("animate-fade-up", idea.hidden && "opacity-60")}>
      <Card className="flex gap-4 p-4 sm:p-5">
        <div className="flex shrink-0 flex-col items-center gap-0.5" title={own ? t("ideas.ownIdea") : undefined}>
          <VoteButton
            dir="for"
            active={mine === "for"}
            disabled={!canVote || own || !!busy}
            busy={busy === "for"}
            label={mine === "for" ? t("ideas.votedFor") : t("ideas.voteFor")}
            onClick={() => vote("for")}
          />
          <span
            className={cn("text-sm font-semibold tabular-nums", score > 0 && "text-accent", score < 0 && "text-danger")}
            aria-label={t("ideas.score", { n: score, for: idea.votes_for, against: idea.votes_against })}
          >
            {score}
          </span>
          <VoteButton
            dir="against"
            active={mine === "against"}
            disabled={!canVote || own || !!busy}
            busy={busy === "against"}
            label={mine === "against" ? t("ideas.votedAgainst") : t("ideas.voteAgainst")}
            onClick={() => vote("against")}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-pretty">{idea.title}</h3>
            <StatusBadge status={idea.status} />
            {idea.hidden && (
              <span className="flex items-center gap-1 text-xs text-muted">
                <EyeOff className="h-3 w-3" />
                {t("ideas.hidden")}
              </span>
            )}
          </div>
          {idea.body && <p className="mt-1 line-clamp-4 text-sm whitespace-pre-line text-muted">{idea.body}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="font-mono">{t("ideas.by", { author: shortAddress(idea.author) })}</span>
            <span>{formatDate(idea.created_at)}</span>
            <span className="tabular-nums">{t("ideas.tally", { for: idea.votes_for, against: idea.votes_against })}</span>
            {own && <span>{t("ideas.ownIdea")}</span>}
            {idea.votes_for + idea.votes_against > 0 && (
              <a href={`${API_URL}/api/ideas/${idea.id}/votes`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-accent">
                {t("ideas.audit")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {admin && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={idea.status}
                onChange={(e) => moderate({ status: e.target.value as IdeaStatus })}
                className="h-8 rounded-md border border-border bg-card px-2 text-xs"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`ideas.status.${s}` as MessageKey)}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" onClick={() => moderate({ hidden: !idea.hidden })}>
                {idea.hidden ? t("ideas.unhide") : t("ideas.hide")}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </li>
  );
}

/** The ideas board: public to read; drive holders propose and vote. */
export function IdeasView() {
  const t = useT();
  const hydrated = useHydrated();
  const { token, address } = useSession();
  const [filter, setFilter] = useState<IdeaStatus | "all">("all");
  const [proposing, setProposing] = useState(false);
  const ideas = useQuery({ queryKey: ["ideas", "list", token], queryFn: () => api.ideas(token) });
  const me = useQuery({ queryKey: ["ideas", "me", token], queryFn: () => api.ideasMe(token!), enabled: !!token });

  const holder = (me.data?.tokens ?? 0) > 0;
  const myVotes = me.data?.votes ?? {};
  const list = (ideas.data ?? []).filter((i) => filter === "all" || i.status === filter);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-xl">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Lightbulb className="h-6 w-6 text-accent" />
            {t("ideas.title")}
          </h1>
          <p className="mt-1 text-sm text-pretty text-muted">{t("ideas.text")}</p>
        </div>
        {hydrated && token && holder && (
          <Button variant="primary" onClick={() => setProposing(true)}>
            <Plus className="h-4 w-4" />
            {t("ideas.propose")}
          </Button>
        )}
      </div>

      {hydrated && !address && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted">{t("ideas.needDrive")}</p>
          <ConnectButton />
        </Card>
      )}
      {hydrated && token && me.isSuccess && !holder && <Notice>{t("ideas.needDrive")}</Notice>}
      {holder && me.data && me.data.tokens > 1 && <p className="text-xs text-muted">{t("ideas.yourVotes", { n: me.data.tokens })}</p>}

      <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-bg-subtle p-1">
        {(["all", ...STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
            className={cn("h-8 rounded-lg px-3 text-sm transition-all", filter === s ? "bg-card font-medium shadow-sm" : "text-muted hover:text-fg")}
          >
            {s === "all" ? t("ideas.filterAll") : t(`ideas.status.${s}` as MessageKey)}
          </button>
        ))}
      </div>

      {ideas.isLoading ? (
        <Spinner className="mx-auto mt-10" />
      ) : ideas.error ? (
        <Notice tone="danger">{t("errors.network")}</Notice>
      ) : !list.length ? (
        <p className="py-12 text-center text-sm text-muted">{t("ideas.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} token={token} mine={myVotes[idea.id]} canVote={!!token && holder && !idea.hidden} admin={!!me.data?.admin} />
          ))}
        </ul>
      )}

      {token && <ProposeDialog open={proposing} onClose={() => setProposing(false)} token={token} />}
    </div>
  );
}
