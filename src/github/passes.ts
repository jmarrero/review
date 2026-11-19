// Independent pass history proposed in #248. Display data only: no write authority.
import { isBot } from "./authors.ts";
import { fencedJson, isObject, type RawComment, str, time } from "./heartbeat.ts";
import { ITEM_RE } from "./usage.ts";

export const PASSES_MARKER = "<!-- agent-board-passes v1 -->";
const SCHEMA = "agent-board/passes/v1";
export const MAX_PASSES = 10;
export const MAX_BODY = 60_000;
const MAX_COUNT = 1_000_000;
/** Fixed display threshold, not scheduling policy. */
export const UNDER_PACE_POINTS = 20;
export const STALE_MS = 3600_000;
const SKEW_MS = 5 * 60_000;
const TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type Mode = "actions" | "preview" | "local";
export type Result = "success" | "partial" | "failure";
export type Outcome = "ok" | "failed" | "skipped" | "cut-short";
export type StartState = "confirmed" | "preview" | "uncertain";

export interface RunRef { repository: string; id: number; attempt?: number }

export interface Section { name: string; outcome: Outcome; error: string | null }

export interface Start { state: StartState; item: string; kind: string; pool: string | null; run: RunRef | null }

export interface NoStart { reason: string; item: string | null; until: string | null; cap: string | null; hold: string | null }

export interface Candidates { read: number; unread: number; ready: number }

export interface Pass {
  run: RunRef | null;
  startedAt: string;
  finishedAt: string;
  mode: Mode;
  result: Result;
  sections: Section[];
  starts: Start[];
  noStart: NoStart[];
  candidates: Candidates | null;
  omitted: { sections: number; starts: number; noStart: number };
}

export interface Pool {
  pool: string;
  observedAt: string;
  usedPercent: number | null;
  allowedPercent: number | null;
  resetsAt: string | null;
  held: boolean | null;
  ready: number | null;
}

export interface Pools { observedAt: string; complete: boolean; omitted: number; items: Pool[] }

export interface FlightRun { item: string; kind: string; pool: string | null; run: RunRef; since: string | null }

export interface FlightPr { repository: string; number: number; state: "merge-queue" | "review-wait"; since: string | null }

export interface InFlight { observedAt: string; complete: boolean; omitted: number; runs: FlightRun[]; prs: FlightPr[] }

export interface Passes {
  publishedAt: string;
  retention: number;
  omitted: number;
  passes: Pass[];
  unreadable: number;
  pools: Pools | string | null;
  inFlight: InFlight | string | null;
}

// Publisher prose must not expose inference, broker or tailnet addresses.
const ADDRESS_RES: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b(?::\d+)?/gi,
  // Include ordinary two-label DNS names, not only public three-label names.
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b(?::\d+)?/gi,
  /\b[a-z0-9-]+\.(?:internal|local|lan|home\.arpa|localdomain)\b(?::\d+)?/gi,
  /\[(?=[0-9a-f:.%\w-]*:)[0-9a-f:]+(?:%[a-z0-9_.-]+)?\](?::\d+)?/gi,
  /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?![\w:])/gi,
  /\[?\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\b\]?(?::\d+)?/gi,
  /\[?(?:\b[0-9a-f]{1,4})?::[0-9a-f]{1,4}\b(?::[0-9a-f]{1,4})*\]?(?::\d+)?/gi,
  // Include single-digit ports without matching the numeric hour in a timestamp.
  /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{1,5}\b/gi,
];

// MagicDNS can be a bare word. In network errors, redact the named target
// even when it has neither a suffix nor a port, and whether or not it is
// quoted. The target ends where hostname characters end; connecting words
// such as "to" or "host" are never taken for it. Keep the operation and any
// quotes as context.
const TARGET = String.raw`(["'\`\u201c\u2018]?)(?!(?:to|host|at|on|tcp|udp)(?![a-z0-9_.-]))(?:\[address\]|[a-z0-9][a-z0-9_.-]*)(?![a-z0-9_.-])`;
const NETWORK_TARGET_RE = new RegExp(String.raw`\b((?:lookup|resolv(?:e|ing)(?: host)?|dial(?: tcp| udp)?|connect(?:ing)?(?: to)?|connection to|request to|reach(?:ing)?|(?:unknown|to) host|(?:broker|inference|tailnet|proxy) at)\s+)` + TARGET, "gi");
const HOST_FIELD_RE = new RegExp(String.raw`\b((?:host|hostname|server|endpoint|to)(?:\s*[:=]\s*|\s+(?=["'\`\u201c\u2018])))` + TARGET, "gi");

export function redactAddresses(text: string): string {
  const redacted = ADDRESS_RES.reduce((t, re) => t.replace(re, "[address]"), text);
  return redacted.replace(NETWORK_TARGET_RE, "$1$2[address]").replace(HOST_FIELD_RE, "$1$2[address]");
}

const isToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_COUNT;
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isPercent = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000;
const isItem = (v: unknown): v is string => typeof v === "string" && v.length <= 212 && ITEM_RE.test(v) && isRepo(v.split("#")[0]);
const isRepo = (v: unknown): v is string => typeof v === "string" && REPO_RE.test(v) && !v.split("/").some((p) => p === "." || p === "..");
const nullable = <T>(v: unknown, read: (v: unknown) => T | undefined): T | null | undefined => (v === null ? null : read(v));
const pick = <T extends string>(v: unknown, values: readonly T[]): T | undefined => (values as readonly unknown[]).includes(v) ? (v as T) : undefined;

function line(v: unknown): string | undefined {
  if (typeof v !== "string" || !v || v.length > 200 || /[\x00-\x1f\x7f\u2028\u2029]/.test(v)) return undefined;
  return redactAddresses(v);
}

function runRef(v: unknown): RunRef | undefined {
  if (!isObject(v) || !isRepo(v.repository) || !isId(v.id)) return undefined;
  if (v.attempt !== undefined && !isId(v.attempt)) return undefined;
  return { repository: v.repository, id: v.id, ...(v.attempt === undefined ? {} : { attempt: v.attempt as number }) };
}

function list<T>(v: unknown, max: number, read: (v: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out = v.map(read);
  return out.every((x) => x !== undefined) ? (out as T[]) : undefined;
}

function section(v: unknown): Section | undefined {
  if (!isObject(v) || !isToken(v.name)) return undefined;
  const outcome = pick(v.outcome, ["ok", "failed", "skipped", "cut-short"] as const);
  const error = nullable(v.error, line);
  if (!outcome || error === undefined || (outcome === "failed") !== (error !== null)) return undefined;
  return { name: v.name, outcome, error };
}

function start(v: unknown): Start | undefined {
  if (!isObject(v) || !isItem(v.item) || !isToken(v.kind)) return undefined;
  const pool = nullable(v.pool, (p) => (isToken(p) ? p : undefined));
  const run = nullable(v.run, runRef);
  if (pool === undefined || run === undefined || !isToken(v.state)) return undefined;
  const state = pick(v.state, ["confirmed", "preview"] as const) ?? "uncertain";
  if (state === "preview" && run) return undefined;
  return { state, item: v.item, kind: v.kind, pool, run };
}

function noStart(v: unknown): NoStart | undefined {
  if (!isObject(v) || !isToken(v.reason)) return undefined;
  const item = nullable(v.item, (i) => (isItem(i) ? i : undefined));
  const until = nullable(v.until, time);
  const cap = nullable(v.cap, (c) => (isToken(c) ? c : undefined));
  const hold = nullable(v.hold, (c) => (isToken(c) ? c : undefined));
  if (item === undefined || until === undefined || cap === undefined || hold === undefined) return undefined;
  if (v.reason === "replan-wait" && !until) return undefined;
  return { reason: v.reason, item, until, cap, hold };
}

function pass(v: unknown): Pass | undefined {
  if (!isObject(v) || !isObject(v.omitted)) return undefined;
  const run = nullable(v.run, runRef);
  const startedAt = time(v.started_at);
  const finishedAt = time(v.finished_at);
  const mode = pick(v.mode, ["actions", "preview", "local"] as const);
  const result = pick(v.result, ["success", "partial", "failure"] as const);
  const sections = list(v.sections, 16, section);
  const starts = list(v.starts, 20, start);
  const noStarts = list(v.no_start, 20, noStart);
  const c = v.candidates;
  const candidates = c === null ? null : isObject(c) && isCount(c.read) && isCount(c.unread) && isCount(c.ready) ? { read: c.read, unread: c.unread, ready: c.ready } : undefined;
  const o = v.omitted;
  if (run === undefined || !startedAt || !finishedAt || Date.parse(finishedAt) < Date.parse(startedAt) || !mode || !result
    || !sections || !starts || !noStarts || candidates === undefined || !isCount(o.sections) || !isCount(o.starts) || !isCount(o.no_start)) return undefined;
  if (starts.some((s) => (s.state === "preview") !== (mode === "preview"))) return undefined;
  return { run, startedAt, finishedAt, mode, result, sections, starts, noStart: noStarts, candidates, omitted: { sections: o.sections, starts: o.starts, noStart: o.no_start } };
}

function pool(v: unknown): Pool | undefined {
  if (!isObject(v) || !isToken(v.pool)) return undefined;
  const observedAt = time(v.observed_at);
  const usedPercent = nullable(v.used_percent, (p) => (isPercent(p) ? p : undefined));
  const allowedPercent = nullable(v.allowed_percent, (p) => (isPercent(p) ? p : undefined));
  const resetsAt = nullable(v.resets_at, time);
  const held = nullable(v.held, (b) => (typeof b === "boolean" ? b : undefined));
  const ready = nullable(v.ready, (n) => (isCount(n) ? n : undefined));
  if (!observedAt || usedPercent === undefined || allowedPercent === undefined || resetsAt === undefined || held === undefined || ready === undefined) return undefined;
  return { pool: v.pool, observedAt, usedPercent, allowedPercent, resetsAt, held, ready };
}

function flightRun(v: unknown): FlightRun | undefined {
  if (!isObject(v) || !isItem(v.item) || !isToken(v.kind)) return undefined;
  const pool = nullable(v.pool, (p) => (isToken(p) ? p : undefined));
  const run = runRef(v.run);
  const since = nullable(v.since, time);
  if (pool === undefined || !run || since === undefined) return undefined;
  return { item: v.item, kind: v.kind, pool, run, since };
}

function flightPr(v: unknown): FlightPr | undefined {
  if (!isObject(v) || !isRepo(v.repository) || !isId(v.number)) return undefined;
  const state = pick(v.state, ["merge-queue", "review-wait"] as const);
  const since = nullable(v.since, time);
  if (!state || since === undefined) return undefined;
  return { repository: v.repository, number: v.number, state, since };
}

function observed(v: unknown): { observedAt: string; complete: boolean; omitted: number } | undefined {
  if (!isObject(v)) return undefined;
  const observedAt = time(v.observed_at);
  return observedAt && typeof v.complete === "boolean" && isCount(v.omitted) ? { observedAt, complete: v.complete, omitted: v.omitted } : undefined;
}

function pools(v: unknown): Pools | string | null {
  if (v === null || v === undefined) return null;
  const head = observed(v);
  const items = isObject(v) ? list(v.items, 16, pool) : undefined;
  return head && items ? { ...head, items } : "malformed or past its bounds";
}

function inFlight(v: unknown): InFlight | string | null {
  if (v === null || v === undefined) return null;
  const head = observed(v);
  const runs = isObject(v) ? list(v.runs, 50, flightRun) : undefined;
  const prs = isObject(v) ? list(v.prs, 50, flightPr) : undefined;
  return head && runs && prs ? { ...head, runs, prs } : "malformed or past its bounds";
}

/** A malformed record is counted, not mistaken for evidence of an idle pass. */
export function parsePasses(body: string | null | undefined): Passes | string | undefined {
  if (!body?.startsWith(PASSES_MARKER)) return undefined;
  if (body.length > MAX_BODY) return `over ${MAX_BODY} characters`;
  const raw = fencedJson(body, PASSES_MARKER);
  if (!raw) return "no JSON object";
  if (raw.schema !== SCHEMA) return `unknown schema ${redactAddresses(str(raw.schema, /^[\x20-\x7e]{1,64}$/) ?? "(none)")}`;
  const publishedAt = time(raw.published_at);
  if (!publishedAt || !isCount(raw.retention) || !isCount(raw.omitted) || !Array.isArray(raw.passes)) return "malformed header";
  if (raw.passes.length > MAX_PASSES) return `more than ${MAX_PASSES} passes`;
  const read = raw.passes.map(pass);
  const passes = read.filter((p) => p !== undefined).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return { publishedAt, retention: raw.retention, omitted: raw.omitted, passes, unreadable: read.length - passes.length, pools: pools(raw.pools), inFlight: inFlight(raw.in_flight) };
}

export function findPasses(comments: readonly RawComment[]): Passes | string | undefined {
  const c = comments.findLast((c) => isBot(c.user?.login) && c.body?.startsWith(PASSES_MARKER));
  return parsePasses(c?.body);
}

export function underPace(p: Pool): boolean | undefined {
  return p.usedPercent === null || p.allowedPercent === null ? undefined : p.allowedPercent - p.usedPercent >= UNDER_PACE_POINTS;
}

function readinessComplete(p: Pass): boolean {
  return p.result === "success" && p.sections.length > 0 && p.omitted.sections === 0
    && p.sections.every((s) => s.outcome === "ok" || s.outcome === "skipped")
    && p.candidates !== null && p.candidates.unread === 0;
}

export function readyEvidence(p: Pass): boolean {
  return readinessComplete(p) && p.candidates!.ready === 0;
}

export function stale(iso: string, now: number): boolean {
  const t = Date.parse(iso);
  return now - t > STALE_MS || t - now > SKEW_MS;
}

export function nothingReady(p: Passes, now: number): boolean {
  const newest = p.passes[0];
  // Complete global coverage is required, but the zero-ready count is per
  // pool: another pool's ready candidates must not hide this pool's imbalance.
  if (!newest || newest.mode === "preview" || p.unreadable || p.omitted || stale(newest.finishedAt, now) || stale(p.publishedAt, now) || !readinessComplete(newest)) return false;
  return typeof p.pools === "object" && p.pools !== null && p.pools.complete && !p.pools.omitted && !stale(p.pools.observedAt, now);
}
