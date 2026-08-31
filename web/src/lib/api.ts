// Typed client for the Rust backend (crates/vault-server). Binary fields are base64 in JSON.

import { API_URL } from "./config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the backend rejects the session token, so the session can be dropped. */
export const UNAUTHORIZED_EVENT = "nftvault:unauthorized";

interface RequestOpts {
  method?: string;
  token?: string | null;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

async function request(path: string, opts: RequestOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api${path}`, { method: opts.method ?? "GET", headers, body });
  } catch {
    throw new ApiError(0, "network", "network");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 && opts.token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, err.error ?? "error", err.message ?? res.statusText);
  }
  return res;
}

const json = async <T>(p: Promise<Response>): Promise<T> => (await p).json() as Promise<T>;
const empty = async (p: Promise<Response>): Promise<void> => {
  await p;
};

// ------------------------------------------------------------------ types

export interface VaultInfo {
  token_id: string;
  capacity_bytes: number;
  used_bytes: number;
  initialized: boolean;
  /** Owner-chosen look; null = defaults. Plaintext on the server. */
  name: string | null;
  stroke: string | null;
  fill: string | null;
}

export type VaultProfile = Pick<VaultInfo, "name" | "stroke" | "fill">;

export interface ObjectRow {
  id: string;
  parent_id: string | null;
  kind: "file" | "folder";
  /** base64, sealed with the vault metadata key */
  metadata: string;
  /** encrypted size */
  size: number;
  thumb_size: number | null;
  created_at: number;
  updated_at: number;
  /** Set while in the trash (unix seconds). */
  trashed_at: number | null;
}

export interface PendingUpload extends ObjectRow {
  /** Encrypted bytes the server already has. */
  received: number;
}

export interface InboxKey {
  /** base64 X25519 public key */
  pubkey: string;
  /** 0x-hex wallet signature over the inbox message */
  signature: string;
}

export interface IncomingHandover {
  from: string;
  /** base64 drive key sealed to the caller's inbox; null while the previous owner hasn't sent it */
  sealed: string | null;
  created_at: number;
}

export interface OutgoingHandover {
  token_id: string;
  to: string;
  /** base64 wrapped key, while unchanged since the transfer */
  key_blob: string | null;
  recipient: InboxKey | null;
  name: string | null;
  created_at: number;
}

/** null for 404, the value otherwise. */
const orNull = <T>(p: Promise<T>): Promise<T | null> =>
  p.catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });

export type IdeaStatus = "open" | "planned" | "in_progress" | "done" | "declined";

export interface Idea {
  id: number;
  title: string;
  body: string;
  author: string;
  status: IdeaStatus;
  hidden: boolean;
  votes: number;
  created_at: number;
}

export interface IdeasMe {
  /** Votes this wallet casts (one per drive). */
  tokens: number;
  admin: boolean;
  voted: number[];
}

export interface ShareRow {
  id: string;
  owner_metadata: string;
  file_count: number;
  created_at: number;
  expires_at: number | null;
}

// ------------------------------------------------------------------ endpoints

export const api = {
  nonce: () => json<{ nonce: string }>(request("/auth/nonce")),
  verify: (message: string, signature: string) =>
    json<{ token: string; address: string; expires_at: number }>(
      request("/auth/verify", { method: "POST", json: { message, signature } }),
    ),
  logout: (token: string) => empty(request("/auth/logout", { method: "POST", token })),

  vaults: (token: string) => json<VaultInfo[]>(request("/vaults", { token })),
  vault: (token: string, id: string) => json<VaultInfo>(request(`/vaults/${id}`, { token })),
  getKey: (token: string, id: string) =>
    json<{ key_blob: string; etag: string }>(request(`/vaults/${id}/key`, { token })),
  putKey: (token: string, id: string, keyBlob: string, previousEtag: string | null) =>
    json<{ key_blob: string; etag: string }>(
      request(`/vaults/${id}/key`, { method: "PUT", token, json: { key_blob: keyBlob, previous_etag: previousEtag } }),
    ),
  setProfile: (token: string, id: string, profile: VaultProfile) =>
    json<VaultInfo>(request(`/vaults/${id}/profile`, { method: "PUT", token, json: profile })),
  reset: (token: string, id: string) =>
    empty(request(`/vaults/${id}/reset`, { method: "POST", token, json: { confirm: "DELETE" } })),

  list: (token: string, vault: string, parent: string | null) =>
    json<ObjectRow[]>(request(`/vaults/${vault}/objects${parent ? `?parent=${parent}` : ""}`, { token })),
  /** Every live object of the drive (for search). */
  all: (token: string, vault: string) => json<ObjectRow[]>(request(`/vaults/${vault}/objects/all`, { token })),
  trash: (token: string, vault: string) => json<ObjectRow[]>(request(`/vaults/${vault}/trash`, { token })),
  emptyTrash: (token: string, vault: string) => empty(request(`/vaults/${vault}/trash/empty`, { method: "POST", token })),
  restore: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/objects/${id}/restore`, { method: "POST", token })),
  removePermanent: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/objects/${id}/permanent`, { method: "DELETE", token })),
  uploads: (token: string, vault: string) => json<PendingUpload[]>(request(`/vaults/${vault}/uploads`, { token })),
  /** Encrypted bytes `from..=to` of a file (also of a pending upload, for resuming). */
  contentRange: async (token: string, vault: string, id: string, from: number, to: number) =>
    new Uint8Array(
      await (await request(`/vaults/${vault}/files/${id}/content`, { token, headers: { Range: `bytes=${from}-${to}` } })).arrayBuffer(),
    ),
  /** The folder and its ancestors, root first. */
  path: (token: string, vault: string, id: string) => json<ObjectRow[]>(request(`/vaults/${vault}/objects/${id}/path`, { token })),
  createFolder: (token: string, vault: string, body: { id: string; parent_id: string | null; metadata: string }) =>
    empty(request(`/vaults/${vault}/folders`, { method: "POST", token, json: body })),
  createFile: (
    token: string,
    vault: string,
    body: { id: string; parent_id: string | null; metadata: string; size: number; thumb_size: number | null },
  ) => empty(request(`/vaults/${vault}/files`, { method: "POST", token, json: body })),
  putContent: (token: string, vault: string, id: string, offset: number, data: Uint8Array<ArrayBuffer>) =>
    json<{ received: number }>(
      request(`/vaults/${vault}/files/${id}/content?offset=${offset}`, {
        method: "PUT",
        token,
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    ),
  putThumbnail: (token: string, vault: string, id: string, data: Uint8Array<ArrayBuffer>) =>
    empty(
      request(`/vaults/${vault}/files/${id}/thumbnail`, {
        method: "PUT",
        token,
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    ),
  dropThumbnail: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/files/${id}/thumbnail`, { method: "DELETE", token })),
  complete: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/files/${id}/complete`, { method: "POST", token, json: {} })),
  thumbnail: async (token: string, vault: string, id: string) =>
    new Uint8Array(await (await request(`/vaults/${vault}/files/${id}/thumbnail`, { token })).arrayBuffer()),
  setMetadata: (token: string, vault: string, id: string, metadata: string) =>
    empty(request(`/vaults/${vault}/objects/${id}/metadata`, { method: "PUT", token, json: { metadata } })),
  move: (token: string, vault: string, id: string, parentId: string | null) =>
    empty(request(`/vaults/${vault}/objects/${id}/move`, { method: "POST", token, json: { parent_id: parentId } })),
  remove: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/objects/${id}`, { method: "DELETE", token })),

  createShare: (
    token: string,
    vault: string,
    body: { object_ids: string[]; manifest: string; owner_metadata: string; expires_at: number | null },
  ) => json<{ id: string }>(request(`/vaults/${vault}/shares`, { method: "POST", token, json: body })),
  shares: (token: string, vault: string) => json<ShareRow[]>(request(`/vaults/${vault}/shares`, { token })),
  revokeShare: (token: string, vault: string, id: string) =>
    empty(request(`/vaults/${vault}/shares/${id}`, { method: "DELETE", token })),

  putInbox: (token: string, key: InboxKey) => empty(request("/inbox", { method: "PUT", token, json: key })),
  getInbox: (address: string) => orNull(json<InboxKey>(request(`/inbox/${address}`))),
  incomingHandover: (token: string, vault: string) => orNull(json<IncomingHandover>(request(`/vaults/${vault}/handover`, { token }))),
  sealHandover: (token: string, vault: string, to: string, sealed: string) =>
    empty(request(`/vaults/${vault}/handover`, { method: "POST", token, json: { to, sealed } })),
  skipHandover: (token: string, vault: string, to: string) => empty(request(`/vaults/${vault}/handover/skip`, { method: "POST", token, json: { to } })),
  dismissHandover: (token: string, vault: string) => empty(request(`/vaults/${vault}/handover`, { method: "DELETE", token })),
  outgoingHandovers: (token: string) => json<OutgoingHandover[]>(request("/handovers/outgoing", { token })),
  declineHandover: (token: string, vault: string) => empty(request(`/handovers/outgoing/${vault}`, { method: "DELETE", token })),

  ideas: (token: string | null) => json<Idea[]>(request("/ideas", { token })),
  ideasMe: (token: string) => json<IdeasMe>(request("/ideas/me", { token })),
  proposeIdea: (token: string, title: string, body: string) =>
    json<{ id: number }>(request("/ideas", { method: "POST", token, json: { title, body } })),
  voteIdea: (token: string, id: number, vote: { choice: "for" | "withdraw"; issued_at: number; signature: string }) =>
    json<{ votes: number }>(request(`/ideas/${id}/vote`, { method: "POST", token, json: vote })),
  moderateIdea: (token: string, id: number, patch: { status?: IdeaStatus; hidden?: boolean }) =>
    empty(request(`/ideas/${id}`, { method: "PATCH", token, json: patch })),

  openShare: (id: string) => json<{ manifest: string }>(request(`/shares/${id}`)),
  shareThumbnail: async (share: string, id: string) =>
    new Uint8Array(await (await request(`/shares/${share}/files/${id}/thumbnail`)).arrayBuffer()),
};

/** Absolute URLs of encrypted content, fetched with Range by the streaming service worker. */
export const contentUrl = (vault: string, id: string) => `${API_URL}/api/vaults/${vault}/files/${id}/content`;
export const shareContentUrl = (share: string, id: string) => `${API_URL}/api/shares/${share}/files/${id}/content`;
