// The coordinator's heartbeat: its loop state and the workers it runs
// on its own machine, which the browser can't otherwise see.
// bin/bot-heartbeat in homegit keeps it in one comment by the bot on
// TRACKER_REPO#HEARTBEAT_ISSUE, edited in place: a marker line, then
// the JSON in a ```json fence. The comment is untrusted input like any
// other: it is parsed strictly, and links only to github.com issues and
// pull requests.

import type { GitHub } from "./api.ts";
import { isBot } from "./authors.ts";
import { HEARTBEAT_ISSUE, HEARTBEAT_STALE_MS, HEARTBEAT_WAKE_GRACE_MS, TRACKER_REPO } from "./config.ts";

/** The comment's first line. */
export const HEARTBEAT_MARKER = "<!-- bot-heartbeat v1 -->";
const SCHEMA = "bot-heartbeat/v1";
const JSON_FENCE_RE = /^```json\n([\s\S]*?)\n```$/m;
/** bot-heartbeat allows no more. */
const MAX_WORKERS = 32;
const ITEM_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/([1-9][0-9]{0,9})$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEVSPACE_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** A loop state or worker status: bot-heartbeat's words, or newer ones shown as they are. */
const WORD_RE = /^[a-z][a-z-]{0,23}$/;

export interface LocalWorker {
  engine?: string;
  name: string;
  itemUrl: string;
  /** OWNER/REPO#N */
  itemRef: string;
  startedAt: string;
  /** starting, working, testing, reviewing, landing or waiting. */
  status: string;
  devspace?: string;
}

export interface Heartbeat {
  updatedAt: string;
  session: string;
  /** polling, working, sleeping or stopped. */
  loopState: string;
  nextWakeAt?: string;
  workers: LocalWorker[];
  /** Workers left out as malformed. */
  skipped: number;
  commentUrl?: string;
}

export interface RawComment {
  id?: number;
  html_url?: string;
  user?: { login?: string } | null;
  body?: string | null;
  /** GitHub's: when the comment was last edited (its creation, if never). */
  updated_at?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, re: RegExp): string | undefined => (typeof v === "string" && re.test(v) ? v : undefined);
const time = (v: unknown): string | undefined => {
  const s = str(v, TIME_RE);
  return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
};

function parseWorker(raw: unknown): LocalWorker | undefined {
  if (!isObject(raw)) return undefined;
  const name = str(raw.name, NAME_RE);
  const itemUrl = str(raw.item_url, ITEM_URL_RE);
  const startedAt = time(raw.started_at);
  const status = str(raw.status, WORD_RE);
  if (!name || !itemUrl || !startedAt || !status) return undefined;
  const m = ITEM_URL_RE.exec(itemUrl);
  const w: LocalWorker = { name, itemUrl, itemRef: `${m?.[1]}/${m?.[2]}#${m?.[4]}`, startedAt, status };
  const devspace = str(raw.devspace, DEVSPACE_RE);
  if (devspace) w.devspace = devspace;
  const engine = str(raw.engine, WORD_RE);
  if (engine) w.engine = engine;
  return w;
}

/** The heartbeat in a comment's body, or undefined if it isn't one. Malformed workers are left out and counted. */
export function parseHeartbeat(body: string | null | undefined): Heartbeat | undefined {
  if (!body?.startsWith(HEARTBEAT_MARKER)) return undefined;
  const m = JSON_FENCE_RE.exec(body);
  if (!m?.[1]) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw.schema !== SCHEMA || !isObject(raw.coordinator) || !Array.isArray(raw.workers)) return undefined;
  const updatedAt = time(raw.updated_at);
  const session = str(raw.coordinator.session, NAME_RE);
  const loopState = str(raw.coordinator.loop_state, WORD_RE);
  if (!updatedAt || !session || !loopState) return undefined;
  const workers = raw.workers.slice(0, MAX_WORKERS).flatMap((w) => parseWorker(w) ?? []);
  const hb: Heartbeat = { updatedAt, session, loopState, workers, skipped: raw.workers.length - workers.length };
  const wake = time(raw.coordinator.next_wake_at);
  if (wake) hb.nextWakeAt = wake;
  return hb;
}

/** The bot's heartbeat among an issue's comments: the first of its comments that is one. */
export function findHeartbeat(comments: readonly RawComment[]): Heartbeat | undefined {
  for (const c of comments) {
    if (!isBot(c.user?.login)) continue;
    const hb = parseHeartbeat(c.body);
    if (!hb) continue;
    if (c.html_url) hb.commentUrl = c.html_url;
    return hb;
  }
  return undefined;
}

/**
 * Whether the heartbeat is too old to trust: older than
 * HEARTBEAT_STALE_MS, and past the wake time it gave (plus a grace), if
 * any. A coordinator that said it stopped isn't stale, just stopped.
 */
export function isStale(hb: Heartbeat, now: number): boolean {
  if (hb.loopState === "stopped") return false;
  if (now - Date.parse(hb.updatedAt) <= HEARTBEAT_STALE_MS) return false;
  return !hb.nextWakeAt || now > Date.parse(hb.nextWakeAt) + HEARTBEAT_WAKE_GRACE_MS;
}

export const heartbeatPath = `/repos/${TRACKER_REPO}/issues/${HEARTBEAT_ISSUE}/comments?per_page=100`;

/** The published heartbeat (read conditionally, so an unchanged one costs no budget), or null if there is none yet. */
export async function loadHeartbeat(gh: GitHub): Promise<Heartbeat | null> {
  const res = await gh.get<RawComment[]>(heartbeatPath);
  return findHeartbeat(Array.isArray(res.data) ? res.data : []) ?? null;
}
