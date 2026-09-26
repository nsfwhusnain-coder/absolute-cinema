/**
 * AllDebrid client for the PREMIUM debrid tier — sibling to realdebrid.ts and
 * torbox.ts, used chiefly to cover Real-Debrid takedowns: RD refuses new adds
 * of DMCA'd hashes with 451, while AllDebrid enforces takedowns separately
 * (verified 2026-09-26: an Andor S02 2160p pack RD rejects was `ready` here).
 *
 * VERIFIED live against api.alldebrid.com on 2026-09-26 with a premium key:
 *
 *   Base:     https://api.alldebrid.com/v4   (every call needs `agent=`)
 *   Auth:     `Authorization: Bearer <ALLDEBRID_API_KEY>`
 *   upload:   POST /magnet/upload   form magnets[]=<hash> (repeatable)
 *             -> { status, data: { magnets: [{ hash, id, ready, name, size }] } }
 *             `ready: true` means cached. The old /magnet/instant endpoint is
 *             gone, so uploading IS the cache check; uncached uploads start a
 *             real download and are deleted straight away.
 *   files:    POST /magnet/files    form id[]=<id>
 *             -> { data: { magnets: [{ id, files: [{ n, s, l } | { n, e: [...] }] }] } }
 *             A tree: folders carry `e` (entries), files carry size `s` and
 *             hoster link `l`.
 *   unlock:   POST /link/unlock     form link=<l>
 *             -> { data: { link, filename, filesize } } — a token-free CDN URL
 *             that honours Range requests.
 *   delete:   POST /magnet/delete   form id=<id>
 *
 * The key is read ONLY from `process.env.ALLDEBRID_API_KEY`, never logged,
 * never placed in a Torrentio request. Every function no-ops (null / empty)
 * when the key is unset or a call fails, and is bounded by one absolute
 * `deadline` shared across the whole resolve.
 */

import { parseReleaseTitle, type ReleaseCodec, type ReleaseCompat } from "./torrentio";
import { pickDebridVideoFile, type DebridTorrentFile } from "./realdebrid";

const ALLDEBRID_BASE = "https://api.alldebrid.com/v4";
const ALLDEBRID_AGENT = "absolutecinema";
const ALLDEBRID_TIMEOUT_MS = 12_000;
export const ALLDEBRID_TOTAL_BUDGET_MS = 20_000;
/** Candidates uploaded per quality in one batch call — the batch is the cache check. */
export const ALLDEBRID_BATCH_SIZE = 8;

const PLAYABLE_EXT_PATTERN = /\.(mp4|mkv|webm|m4v)$/i;
const EPISODE_TAG_PATTERN = /s(\d{1,2})[ ._-]?e(\d{1,3})/i;

interface AllDebridEnvelope<T> {
  status?: string;
  data?: T | null;
}

interface AllDebridUploaded {
  hash?: string;
  id?: number;
  ready?: boolean;
  error?: unknown;
}

interface AllDebridFileNode {
  n?: string;
  s?: number;
  l?: string;
  e?: AllDebridFileNode[];
}

interface AllDebridLinkFile {
  name: string;
  bytes: number;
  link: string;
}

export interface AllDebridResolvedFile {
  url: string;
  fileBytes: number;
  codec: ReleaseCodec;
  compat: ReleaseCompat;
}

export interface AllDebridTarget {
  infoHash: string;
  releaseTitle: string;
  fileIdx?: number;
}

export function isAllDebridConfigured(): boolean {
  return Boolean(getKey());
}

export function allDebridDeadlineFromNow(): number {
  return Date.now() + ALLDEBRID_TOTAL_BUDGET_MS;
}

function getKey(): string | null {
  return process.env.ALLDEBRID_API_KEY?.trim() || null;
}

async function adPost<T>(
  path: string,
  key: string,
  deadline: number,
  fields: [string, string][]
): Promise<T | null> {
  const timeout = Math.min(ALLDEBRID_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return null;
  try {
    const res = await fetch(`${ALLDEBRID_BASE}${path}?agent=${ALLDEBRID_AGENT}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as AllDebridEnvelope<T>;
    return body.status === "success" && body.data ? body.data : null;
  } catch {
    return null;
  }
}

/** Upload a batch of hashes; returns hash -> magnet id for every upload, and the set that is cached. */
async function uploadBatch(
  hashes: string[],
  key: string,
  deadline: number
): Promise<{ ids: Map<string, number>; ready: Set<string> }> {
  const ids = new Map<string, number>();
  const ready = new Set<string>();
  if (!hashes.length) return { ids, ready };
  const data = await adPost<{ magnets?: AllDebridUploaded[] }>(
    "/magnet/upload",
    key,
    deadline,
    hashes.map((h) => ["magnets[]", h])
  );
  for (const magnet of data?.magnets ?? []) {
    const hash = magnet.hash?.toLowerCase();
    if (!hash || typeof magnet.id !== "number") continue;
    ids.set(hash, magnet.id);
    if (magnet.ready) ready.add(hash);
  }
  return { ids, ready };
}

async function deleteMagnets(ids: number[], key: string, deadline: number): Promise<void> {
  await Promise.all(ids.map((id) => adPost("/magnet/delete", key, deadline, [["id", String(id)]])));
}

function flattenFiles(nodes: AllDebridFileNode[] | undefined, prefix = ""): AllDebridLinkFile[] {
  const out: AllDebridLinkFile[] = [];
  for (const node of nodes ?? []) {
    const name = node.n ?? "";
    const path = prefix ? `${prefix}/${name}` : name;
    if (node.e?.length) out.push(...flattenFiles(node.e, path));
    else if (node.l) out.push({ name: path, bytes: node.s ?? 0, link: node.l });
  }
  return out;
}

async function listFiles(id: number, key: string, deadline: number): Promise<AllDebridLinkFile[]> {
  const data = await adPost<{ magnets?: { files?: AllDebridFileNode[] }[] }>(
    "/magnet/files",
    key,
    deadline,
    [["id[]", String(id)]]
  );
  return flattenFiles(data?.magnets?.[0]?.files);
}

/**
 * The file Torrentio meant, via the same pack-safe picker RD uses (fileIdx,
 * then release-title tokens; never "largest in a pack"). A season pack's
 * title names no episode, so for episodes fall back to the file whose own
 * SxxEyy matches the request.
 */
export function pickAllDebridFile(
  files: AllDebridLinkFile[],
  target: AllDebridTarget,
  episode?: { season: number; episode: number }
): AllDebridLinkFile | null {
  const playable = files.filter((f) => PLAYABLE_EXT_PATTERN.test(f.name));
  if (!playable.length) return null;
  const asTorrentFiles: DebridTorrentFile[] = playable.map((f, i) => ({
    id: i + 1,
    path: f.name,
    bytes: f.bytes,
  }));
  const picked = pickDebridVideoFile(asTorrentFiles, { releaseTitle: target.releaseTitle });
  if (picked) return playable[picked.id - 1] ?? null;
  if (!episode) return null;
  const matches = playable.filter((f) => {
    const tag = f.name.match(EPISODE_TAG_PATTERN);
    return tag !== null && Number(tag[1]) === episode.season && Number(tag[2]) === episode.episode;
  });
  if (!matches.length) return null;
  return matches.reduce((best, f) => (f.bytes > best.bytes ? f : best));
}

async function unlock(link: string, key: string, deadline: number): Promise<string | null> {
  const data = await adPost<{ link?: string }>("/link/unlock", key, deadline, [["link", link]]);
  return data?.link || null;
}

/**
 * Resolve the first cached target (in the caller's rank order) to a direct
 * link. One batch upload doubles as the cache check; every uploaded magnet
 * except the winner is deleted so uncached ones never keep downloading and
 * the account does not accumulate. Never throws.
 */
export async function resolveAllDebridFirstCached(
  targets: AllDebridTarget[],
  deadline: number,
  episode?: { season: number; episode: number }
): Promise<{ target: AllDebridTarget; file: AllDebridResolvedFile } | null> {
  const key = getKey();
  if (!key || !targets.length || Date.now() >= deadline) return null;

  const batch = targets.slice(0, ALLDEBRID_BATCH_SIZE);
  const hashes = Array.from(new Set(batch.map((t) => t.infoHash.toLowerCase())));
  const { ids, ready } = await uploadBatch(hashes, key, deadline);
  let keep: number | null = null;

  try {
    for (const target of batch) {
      const hash = target.infoHash.toLowerCase();
      const id = ids.get(hash);
      if (!ready.has(hash) || id === undefined) continue;
      const chosen = pickAllDebridFile(await listFiles(id, key, deadline), target, episode);
      if (!chosen) continue;
      const url = await unlock(chosen.link, key, deadline);
      if (!url) continue;
      keep = id;
      const parsed = parseReleaseTitle(chosen.name);
      return {
        target,
        file: { url, fileBytes: chosen.bytes, codec: parsed.codec, compat: parsed.compat },
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    const stale = Array.from(ids.values()).filter((id) => id !== keep);
    await deleteMagnets(stale, key, Date.now() + ALLDEBRID_TIMEOUT_MS);
  }
}
