// What the scheduler's pass holds, as it publishes them (agent-board#307),
// each with whether only the operator releases it: the inbox renders these
// rather than deriving its own from labels. They are the bot's comment on
// the usage issue (or, past one comment's size, its comments, compressed:
// agent-board#774), read like the usage with the viewer's token, and parsed
// strictly: anything amiss in it, or a token that can't read it, is no holds.
// The pass's WIP limit and what it did come with them, and are shown from
// here rather than worked out again. So does its ranked needs-you list
// (agent-board's docs/pass.md, `holds.needsYou`): the inbox's holds,
// review waits, proposals and digest asks, which the inbox shows in the
// pass's order and with its count instead of assembling its own.

import type { GitHub } from "./api.ts";
import { isBot } from "./authors.ts";
import { fencedJson, isObject, type RawComment, str, time } from "./heartbeat.ts";
import { ITEM_RE, usagePath } from "./usage.ts";
import { parsePassView, type PassView } from "./passview.ts";
import { findMaintainerReports } from "./repositories.ts";
import { findPasses } from "./passes.ts";
import { parseDispatchableWork, type DispatchableWork } from "./repositoryboard.ts";
import { parseToday, type Today } from "./today.ts";
import { parseFocus, type Focus } from "./focus.ts";

/** The comment's first line. */
export const HOLDS_MARKER = "<!-- agent-board-holds v1 -->";
const SCHEMA = "agent-board/holds/v1";
/**
 * A snapshot longer than one comment is published compressed (agent-board#774):
 * the first comment, with HOLDS_MARKER, has a header of this schema that
 * counts the comments, and each other the part marker, its number and the
 * snapshot's time; the pieces in their `text` blocks, joined, are the plain
 * comment gzipped, in base64.
 */
export const PARTS_SCHEMA = "agent-board/holds-parts/v1";
export const PART_MARKER = "<!-- agent-board-holds part v1 -->";
const PARTS_ENCODING = "gzip+base64";
/** agent-board's MAX_PARTS: a header that counts more is refused. */
const MAX_PARTS = 4;
/** The most a compressed snapshot inflates to, as agent-board bounds it. */
const MAX_SNAPSHOT_BYTES = 8_000_000;
const TEXT_BLOCK_RE = /\n```text\n([A-Za-z0-9+/=]*)\n```/;
/** A hold's kind: needs-human, wip, ..., or a newer one, shown as it is. */
const KIND_RE = /^[a-z][a-z-]{0,31}$/;
const PRIORITY_RE = /^P[0-9]$/;

/** One hold, as published: every key is there, null where there is no value. */
export interface Hold {
  carried?: boolean;
  /** OWNER/REPO#N; null for a hold of every new run (wip, pools). */
  item: string | null;
  url: string | null;
  epic: boolean;
  kind: string;
  /** What the pass's `hold …:` line says. */
  reason: string;
  /** Only the operator releases it: needs-human, needs-design, epic-unplanned, needs-operator. */
  operator: boolean;
  priority: string | null;
  /** What the item's board Why asks, after its `Q:`. */
  question: string | null;
}

/** What an ask names to act on: typed parts the inbox makes its own link from, never an address it follows. */
export interface AskRef {
  /** issue, pull_request, approve_pull_request, review_pull_request, reply_pull_request, close_pull_request or operator_action. */
  type: string;
  /** OWNER/REPO. */
  repository: string;
  number: number;
  /** The proposal's comment, for operator_action. */
  comment?: number;
  /** The full head an approval or review is at. */
  head?: string;
}

/** One thing that waits on the operator, as the pass lists it. */
export interface Ask {
  /** The nearest and the top live epic (agent-board#661), `none` or `unknown`; absent is unknown, not none. */
  epic?: string;
  topEpic?: string;
  /** The same from pass to pass: `owner/repo#n`, with `/comment-ID` or `/digest`. */
  key: string;
  /** OWNER/REPO#N it is on. */
  item: string;
  /** epics, items, pass, reviews, proposals or digest. */
  source: string;
  /** The hold's kind, review-…, operator-action or digest-…. */
  kind: string;
  priority: string | null;
  waitingSince: string;
  /** The one-line question, display text only. */
  ask: string;
  recommendation: string | null;
  action: AskRef;
  /** Kept from an earlier pass, as its source was not read again whole. */
  carried: boolean;
  /** PR membership, not permission to act on its representative. */
  group?: { reason: string; numbers: number[] };
  /** The pass's descriptors of the decisions this card stands for (needs_you.requests): data, never write authority. */
  requests?: Request[];
  /** Descriptors were supplied but could not be read safely; never fall back to legacy writes. */
  requestsUnreadable?: boolean;
  /** An inventory identity whose detailed card the pass did not publish: a read-only placeholder. */
  detailMissing?: boolean;
  /** Informational evidence for exact members, never approval authority. */
  reviewBuckets?: Record<string, ReviewBucket>;
  approvalEvidence?: ApprovalEvidence;
}

export interface ApprovalEvidence {
  assessed_head: string;
  observed_at: string;
  diff: "unavailable" | { additions: number; deletions: number };
  ci: { state: "unknown" | "failing" | "pending" | "green"; complete: boolean };
  review: { verdict: "approved" | "changes_requested" | "withheld"; at: string } | null;
}

export interface ReviewBucket {
  bucket: "quick" | "deep";
  assessed_head: string;
  reason: string;
  summary: string;
  ci: "green" | "unknown";
}

/** One next step a request names, and whether the pass says it can be taken from here. */
export interface RequestAction {
  /** promote, merge-or-enqueue, reply, close, review-at-head, check-proposal or a newer one. */
  kind: string;
  supported: boolean;
  reason: string;
}

export interface Request {
  /** Optional published explanation; text only, never a write precondition. */
  detail?: Record<string, string>;
  /** The forge host the target is on, a Forgejo instance's with its scheme, port and path. */
  forge: string;
  /** decision, missing-concrete-decision, unknown-request or unverified-carried. */
  quality: string;
  actions: RequestAction[];
}

/** The pass's ranked list of what waits on the operator. */
export interface NeedsYou {
  /** Service passes own ordering; local filters must not rank their decisions. */
  producerOrder?: boolean;
  /** Hold decisions superseded by this snapshot's operator-hold inventory. */
  excludedHolds?: number;
  /** Optional producer-certified actionable rows, grouped by detailed ask key. Absent means off. */
  actNow?: { key: string; unblocks: number }[];
  count?: number;
  counts?: { decisions: number; groups: number; members: number };
  identities?: InboxIdentity[];
  detailsOmitted?: number;
  omittedSources?: Record<string, number>;
  context?: InboxContext;
  /** Absent on older publishers or malformed metadata: do not default-filter. */
  epics?: InboxEpic[];
  /** Every source read whole (or off), nothing omitted, and every item read here: only then is an empty list "nothing waits". */
  complete: boolean;
  /** When the pass last wrote the list, if only to confirm it: its age, whatever a 304 says of the comment. */
  validatedAt: string;
  /** When a pass last changed it. */
  changedAt: string;
  /** How much of each source the pass read: complete, partial, unread or off. */
  sources: Record<string, string>;
  /** Whether the bot's summaries of the held issues were all read; an ask falls back to the board's question or the hold's reason. */
  summaries: string;
  /** Asks past the pass's cap, left out. */
  omitted: number;
  items: Ask[];
  /** Items left out here as malformed. */
  refused: number;
}

export interface InboxIdentity extends Pick<Ask, "item" | "source" | "kind" | "priority" | "waitingSince" | "carried" | "epic" | "topEpic" | "requests" | "requestsUnreadable"> {
  key: string;
  detailKey: string;
}

export interface InboxContext {
  wip?: Wip;
  observedAt?: string;
  sources: Record<string, string>;
  omitted: number;
  items: { source: string; item?: string; itemUnreadable?: boolean; kind: string; reason: string; since?: string; observedAt?: string }[];
  limits: Record<string, Record<string, string | number>>;
}

export interface InboxEpic {
  /** OWNER/REPO#N, lower case; the pass publishes no title. */
  item: string;
  active: boolean;
  activeWhy: string[];
  /** Whether its activity was read whole: an inactive epic read in part may be active. */
  complete: boolean;
  focus: boolean;
}

/** The WIP limit, and the runs holding a slot (null where the pass did not count them). */
export interface Wip {
  limit: number;
  inFlight: number | null;
}

/** What the pass did: its mode, stage 4's candidates, the runs it started (or would) and the live epics; null where a stage did not get that far. */
export interface PassSummary {
  /** preview, actions or local. */
  mode: string;
  candidates: number | null;
  started: number;
  liveEpics: number | null;
}

export interface Holds {
  /** When the pass that last changed them ran. */
  at: string;
  /** Absent from a comment older than agent-board#373, or one that doesn't parse; shown as not published. */
  wip?: Wip;
  pass?: PassSummary;
  holds: Hold[];
  /** The ranked list, or why the snapshot's can't be used; absent where the snapshot has none (holds.needsYou off, an older pass, or past the comment's cap). */
  needsYou?: NeedsYou | string;
  passView?: PassView | string;
  dispatchableWork?: DispatchableWork | string;
  today?: Today | string;
  epicFocus?: Focus | string;
}

const isText = (v: unknown): v is string => typeof v === "string";
/** A count of runs or items: well under this. */
const MAX_COUNT = 10_000;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_COUNT;
const countOrNull = (v: unknown): number | null | undefined => (v === null ? null : isCount(v) ? v : undefined);
const MODE_RE = /^[a-z]{1,16}$/;

function parseWip(raw: unknown): Wip | undefined {
  if (!isObject(raw)) return undefined;
  const inFlight = countOrNull(raw.in_flight);
  return isCount(raw.limit) && inFlight !== undefined ? { limit: raw.limit, inFlight } : undefined;
}

function parsePass(raw: unknown): PassSummary | undefined {
  if (!isObject(raw)) return undefined;
  const candidates = countOrNull(raw.candidates);
  const liveEpics = countOrNull(raw.live_epics);
  const mode = str(raw.mode, MODE_RE);
  return mode && isCount(raw.started) && candidates !== undefined && liveEpics !== undefined ? { mode, candidates, started: raw.started, liveEpics } : undefined;
}

function parseHold(raw: unknown): Hold | undefined {
  if (!isObject(raw)) return undefined;
  const { item, url, epic, kind, reason, operator, priority, question } = raw;
  if ((item !== null && !str(item, ITEM_RE)) || (priority !== null && !str(priority, PRIORITY_RE)) || (question !== null && !isText(question))) return undefined;
  if (typeof epic !== "boolean" || typeof operator !== "boolean" || !str(kind, KIND_RE) || !isText(reason)) return undefined;
  // The link is the item's issue on github.com, or there is none: nothing else goes in an href.
  if (url !== (isText(item) ? `https://github.com/${item.replace("#", "/issues/")}` : null)) return undefined;
  return { item, url, epic, kind, reason, operator, priority, question, ...(raw.carried === true ? { carried: true } : {}) } as Hold;
}

const NEEDS_YOU_SCHEMA = "agent-board/needs-you/v2";
const READS = ["complete", "partial", "unread", "off"];
const KEY_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d{0,9}(?:\/comment-[1-9]\d{0,19}|\/digest|\/decision-[1-9]\d{0,9}|\/draft)?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_RE = /^[0-9a-f]{40}$/;
/** The pass cuts every text to its first line and this many characters. */
const TEXT_MAX = 500;
/** The action types a published ask may have; any other is not read. */
export const ASK_ACTIONS = ["issue", "pull_request", "approve_pull_request", "review_pull_request", "reply_pull_request", "close_pull_request", "operator_action"];
const isPositive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const text = (v: unknown): string | undefined => (isText(v) && v.trim() ? v.split("\n")[0]!.slice(0, TEXT_MAX) : undefined);
/** Bound member rendering; refuse rather than silently truncate membership. */
const MAX_GROUP_MEMBERS = 100;

/** Fail closed without changing legacy asks or canonical counts. */
function reviewBuckets(raw: unknown): Record<string, ReviewBucket> {
  if (!isObject(raw) || Object.keys(raw).length > MAX_COUNT) return {};
  if (Object.keys(raw).some((key) => !/^[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d*$/.test(key))) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, v]) => {
    const match = /^([a-z0-9_.-]+\/[a-z0-9_.-]+)#([1-9]\d*)$/.exec(key);
    return match && !/\/\.+$/.test(match[1]!) && isPositive(Number(match[2])) && isObject(v) &&
      Object.keys(v).every((k) => ["bucket", "assessed_head", "reason", "summary", "ci"].includes(k)) && (v.bucket === "quick" || v.bucket === "deep") && str(v.assessed_head, HEAD_RE) &&
      (v.ci === "green" || v.ci === "unknown") && [v.reason, v.summary].every((s) => typeof s === "string" && s.trim() && s.length <= TEXT_MAX);
  })) as Record<string, ReviewBucket>;
}

/** Stops another head's or a partial read's success looking like evidence for this approval.
 * Optional/off on older publishers; the producer caps this extension at 50 rows. */
function approvalEvidence(raw: unknown): Record<string, ApprovalEvidence> {
  if (!isObject(raw) || raw.schema !== "agent-board/approval-evidence/v1" || !time(raw.observed_at) || !isCount(raw.omitted) || !isObject(raw.items) || Object.keys(raw.items).length > 50) return {};
  const result: Record<string, ApprovalEvidence> = {};
  for (const [key, v] of Object.entries(raw.items)) {
    if (!str(key, KEY_RE) || !isObject(v) || !str(v.assessed_head, HEAD_RE) || !isObject(v.ci) || !["unknown", "failing", "pending", "green"].includes(v.ci.state as string) || typeof v.ci.complete !== "boolean") continue;
    if (v.diff !== "unavailable" && (!isObject(v.diff) || ![v.diff.additions, v.diff.deletions].every((n) => Number.isSafeInteger(n) && (n as number) >= 0))) continue;
    if (v.review !== null && (!isObject(v.review) || !["approved", "changes_requested", "withheld"].includes(v.review.verdict as string) || !time(v.review.at))) continue;
    result[key] = {
      assessed_head: v.assessed_head as string, observed_at: raw.observed_at as string,
      diff: v.diff === "unavailable" ? "unavailable" : { additions: (v.diff as Record<string, number>).additions!, deletions: (v.diff as Record<string, number>).deletions! },
      ci: { state: v.ci.state as ApprovalEvidence["ci"]["state"], complete: v.ci.complete },
      review: v.review === null ? null : { verdict: (v.review as Record<string, unknown>).verdict as NonNullable<ApprovalEvidence["review"]>["verdict"], at: (v.review as Record<string, string>).at! },
    };
  }
  return result;
}

function parseRef(raw: unknown): AskRef | undefined {
  if (!isObject(raw) || !ASK_ACTIONS.includes(raw.type as string) || !str(raw.repository, REPO_RE) || /\/\.+$/.test(raw.repository as string) || !isPositive(raw.number)) return undefined;
  if ((raw.comment !== undefined && !isPositive(raw.comment)) || (raw.head !== undefined && raw.head !== null && !str(raw.head, HEAD_RE))) return undefined;
  // Approving and running a proposal each need their part.
  if ((raw.type === "approve_pull_request" && !raw.head) || (raw.type === "operator_action" && raw.comment === undefined)) return undefined;
  return { type: raw.type as string, repository: raw.repository as string, number: raw.number, ...(raw.comment ? { comment: raw.comment as number } : {}), ...(raw.head ? { head: raw.head as string } : {}) };
}

function parseAsk(raw: unknown): Ask | undefined {
  if (!isObject(raw)) return undefined;
  const action = parseRef(raw.action);
  const key = str(raw.key, KEY_RE);
  const item = str(raw.item, ITEM_RE);
  const waitingSince = time(raw.waiting_since);
  const ask = text(raw.ask);
  const recommendation = raw.recommendation === null ? null : text(raw.recommendation);
  if (!action || !key || !item || !waitingSince || !ask || recommendation === undefined || !str(raw.source, MODE_RE) || !str(raw.kind, KIND_RE)) return undefined;
  if ((raw.priority !== null && !str(raw.priority, PRIORITY_RE)) || (raw.carried !== undefined && typeof raw.carried !== "boolean")) return undefined;
  // A group read as its representative alone would answer for the others: a malformed one is no ask.
  const group = raw.group === undefined ? undefined : parseGroup(raw.group, action);
  if (group === null) return undefined;
  const epic = epicRef(raw.epic);
  const topEpic = epicRef(raw.topEpic);
  return { key, item, source: raw.source as string, kind: raw.kind as string, priority: raw.priority as string | null, waitingSince, ask, recommendation, action, carried: raw.carried === true, ...(group ? { group } : {}), ...(epic ? { epic } : {}), ...(topEpic ? { topEpic } : {}) };
}

const epicRef = (v: unknown): string | undefined => v === "none" || v === "unknown" ? v : str(v, ITEM_RE)?.toLowerCase();

/** The pass's activity reasons: focus, recent-run, open-pr, operator-comment, or a newer one. */
const WHY_RE = /^[a-z][a-z-]{0,31}$/;

/** `epics`, a map of live epic to its activity; a broken or oversized one must not silently hide decisions. */
function parseEpics(raw: unknown): InboxEpic[] | undefined {
  if (!isObject(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > MAX_COUNT) return undefined;
  const epics: InboxEpic[] = [];
  for (const [item, e] of entries) {
    if (!str(item, ITEM_RE) || !isObject(e) || typeof e.active !== "boolean" || typeof e.complete !== "boolean" || !Array.isArray(e.activeWhy) || e.activeWhy.length > 8 || !e.activeWhy.every((why) => str(why, WHY_RE))) return undefined;
    const activeWhy = e.activeWhy as string[];
    epics.push({ item: item.toLowerCase(), active: e.active, complete: e.complete, focus: activeWhy.includes("focus"), activeWhy });
  }
  return new Set(epics.map((e) => e.item)).size === epics.length ? epics : undefined;
}

function parseIdentity(raw: unknown): InboxIdentity | undefined {
  if (!isObject(raw)) return undefined;
  const item = str(raw.item, ITEM_RE);
  const key = str(raw.key ?? item?.toLowerCase(), KEY_RE);
  const detailKey = str(raw.detail_key ?? key, KEY_RE);
  const waitingSince = time(raw.waiting_since);
  const epic = epicRef(raw.epic);
  const topEpic = epicRef(raw.topEpic ?? raw.epic);
  if (!item || !key || !detailKey || !waitingSince || !str(raw.source, MODE_RE) || !str(raw.kind, KIND_RE) || (raw.priority != null && !str(raw.priority, PRIORITY_RE)) || (raw.carried !== undefined && typeof raw.carried !== "boolean")) return undefined;
  return { item, key, detailKey, waitingSince, source: raw.source as string, kind: raw.kind as string, priority: raw.priority as string | null ?? null, carried: raw.carried === true, ...(epic ? { epic } : {}), ...(topEpic ? { topEpic } : {}) };
}

function parseContext(raw: unknown): InboxContext | undefined {
  if (!isObject(raw) || !Array.isArray(raw.items) || raw.items.length > 40 || !isCount(raw.omitted) || !isObject(raw.sources)) return undefined;
  const sources = Object.entries(raw.sources).filter(([k, v]) => str(k, MODE_RE) && READS.includes(v as string)) as [string, string][];
  const items: InboxContext["items"] = raw.items.flatMap((f) => {
    if (!isObject(f) || !["hold", "step", "run"].includes(f.source as string) || !text(f.kind) || !text(f.reason)) return [];
    const item = str(f.item, ITEM_RE);
    const since = time(f.since);
    const observedAt = time(f.observed_at);
    return [{ source: f.source as string, kind: text(f.kind)!, reason: text(f.reason)!, ...(item ? { item } : f.item != null ? { itemUnreadable: true } : {}), ...(since ? { since } : {}), ...(observedAt ? { observedAt } : {}) }];
  });
  // Display values only: never retain a publisher URL or turn context into controls.
  const limits = Object.fromEntries((isObject(raw.limits) ? Object.entries(raw.limits).slice(0, 100) : []).flatMap(([name, value]) => {
    if (!str(name, /^[a-zA-Z0-9_.-]{1,100}$/) || !isObject(value)) return [];
    const fields = Object.entries(value).filter(([k, v]) => ["reason", "used_percent", "limit_percent", "resets_at", "next_dispatch_at", "observed_at", "weekly_usd", "spent_usd", "since"].includes(k) && ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string"));
    return [[name, Object.fromEntries(fields.map(([k, v]) => [k, typeof v === "string" ? v.slice(0, TEXT_MAX) : v])) as Record<string, string | number>]];
  }));
  const wip = parseWip(raw.wip);
  const observedAt = time(raw.observed_at);
  return { sources: Object.fromEntries(sources), items, omitted: raw.omitted + raw.items.length - items.length, limits, ...(wip ? { wip } : {}), ...(observedAt ? { observedAt } : {}) };
}

function parseGroup(raw: unknown, action: AskRef): Ask["group"] | null {
  const reason = isObject(raw) ? text(raw.reason) : undefined;
  const numbers = isObject(raw) ? raw.numbers : undefined;
  if (!reason || !Array.isArray(numbers) || !numbers.length || numbers.length > MAX_GROUP_MEMBERS || !numbers.every(isPositive) || new Set(numbers).size !== numbers.length || numbers[0] !== action.number || !action.type.endsWith("pull_request")) return null;
  return { reason, numbers };
}

const QUALITIES = ["decision", "missing-concrete-decision", "unknown-request", "unverified-carried"];
const FORGE_RE = /^[A-Za-z0-9.:/_-]{1,200}$/;
/** Bounds on what a reader keeps of the optional descriptors. */
const REQUESTS_MAX = 500;
const ACTIONS_MAX = 8;

/** Bound optional ranking evidence; never mine hold prose for dependencies or readiness. */
const ACT_NOW_CANDIDATES = 10;

function parseActNow(raw: unknown, items: readonly Ask[], identities: readonly InboxIdentity[] | undefined): NeedsYou["actNow"] {
  if (!Array.isArray(raw) || raw.length > ACT_NOW_CANDIDATES) return undefined;
  const seen = new Set<string>();
  const result: NonNullable<NeedsYou["actNow"]> = [];
  for (const entry of raw) {
    if (!isObject(entry) || !str(entry.key, KEY_RE) || !isCount(entry.unblocks) || entry.unblocks === 0 || seen.has(entry.key as string)) return undefined;
    const key = entry.key as string;
    const matches = items.filter((a) => a.key === key);
    if (matches.length !== 1 || (identities && !identities.some((i) => i.detailKey === key))) return undefined;
    const ask = matches[0]!;
    const action = parseRef(entry.action);
    // Certification is for this exact action, not another head at the same key.
    if (!action || Object.keys(entry).some((k) => !["key", "unblocks", "priority", "waiting_since", "action"].includes(k)) ||
        !isObject(entry.action) || Object.keys(entry.action).some((k) => !["type", "repository", "number", "comment", "head"].includes(k)) ||
        JSON.stringify(action) !== JSON.stringify(ask.action) || entry.priority !== ask.priority || time(entry.waiting_since) !== ask.waitingSince) return undefined;
    seen.add(key);
    result.push({ key, unblocks: entry.unblocks });
  }
  return result;
}

/** A descriptor and the card key it joins, or undefined where it is malformed. */
function parseRequest(raw: unknown): [string, Request] | undefined {
  if (!isObject(raw) || !Array.isArray(raw.actions) || raw.actions.length > ACTIONS_MAX) return undefined;
  const key = str(raw.key, KEY_RE);
  const forge = str(raw.forge, FORGE_RE);
  const actions = raw.actions.map((a) => (isObject(a) && str(a.kind, KIND_RE) && typeof a.supported === "boolean" && text(a.reason) ? { kind: a.kind as string, supported: a.supported, reason: text(a.reason)! } : undefined));
  if (!key || !forge || !QUALITIES.includes(raw.quality as string) || !actions.every((a) => a !== undefined)) return undefined;
  const detail = Object.fromEntries(["identity", "revision", "question", "recommendation", "requested_operator", "requester", "ownership_evidence", "facts", "resolution", "observed_at", "source_time"].flatMap((field) => typeof raw[field] === "string" ? [[field, (raw[field] as string).slice(0, TEXT_MAX)]] : []));
  return [key, { forge, quality: raw.quality as string, actions: actions as RequestAction[], ...(Object.keys(detail).length ? { detail } : {}) }];
}

/** The snapshot's needs-you list; a string says why it can't be used. A malformed item is left out and makes the list incomplete, not the others unread. */
export function parseNeedsYou(raw: unknown): NeedsYou | string {
  if (!isObject(raw)) return "the needs-you list is not an object";
  if (raw.schema !== NEEDS_YOU_SCHEMA) return `the needs-you list's schema ${JSON.stringify(raw.schema).slice(0, 60)} is not ${NEEDS_YOU_SCHEMA}`;
  const validatedAt = time(raw.validated_at);
  const changedAt = time(raw.changed_at);
  const sources = isObject(raw.sources) ? Object.entries(raw.sources).filter(([k, v]) => str(k, MODE_RE) && READS.includes(v as string)) as [string, string][] : [];
  if (!validatedAt || !changedAt || !Array.isArray(raw.items) || !isCount(raw.omitted) || !READS.includes(raw.summaries as string) || !sources.length) return "the needs-you list is malformed";
  if (raw.items.length > MAX_COUNT || (raw.identities !== undefined && (!Array.isArray(raw.identities) || raw.identities.length > MAX_COUNT))) return "the needs-you inventory exceeds the reader's bound";
  const items = raw.items.map(parseAsk).filter((a) => a !== undefined);
  const identities = Array.isArray(raw.identities) ? raw.identities.map(parseIdentity).filter((i) => i !== undefined) : undefined;
  // Only an absent descriptor field gets legacy behavior. A bound we cannot
  // read, or a malformed descriptor with no usable key, may affect any ask.
  const requests = Array.isArray(raw.requests) ? raw.requests.slice(0, REQUESTS_MAX).map(parseRequest).filter((r) => r !== undefined) : [];
  const unreadable = new Set<string>();
  let allUnreadable = raw.requests !== undefined && (!Array.isArray(raw.requests) || raw.requests.length > REQUESTS_MAX);
  if (Array.isArray(raw.requests)) for (const r of raw.requests.slice(0, REQUESTS_MAX)) {
    if (parseRequest(r)) continue;
    const key = isObject(r) ? str(r.key, KEY_RE) : undefined;
    if (key) unreadable.add(key);
    else allUnreadable = true;
  }
  const buckets = reviewBuckets(raw.review_buckets);
  const evidence = approvalEvidence(raw.approval_evidence);
  for (const a of items) {
    const e = evidence[a.key];
    if (e && a.source === "reviews" && a.key === `${a.action.repository}#${a.action.number}`.toLowerCase() && !a.carried && !a.group && a.action.type === "approve_pull_request" && a.action.head === e.assessed_head && sources.some(([k, v]) => k === a.source && v === "complete")) a.approvalEvidence = e;
    if (raw.review_buckets !== undefined && !a.carried && raw.sources && (raw.sources as Record<string, unknown>)[a.source] === "complete") a.reviewBuckets = Object.fromEntries(
      (a.group?.numbers ?? [a.action.number]).flatMap((n) => {
        const key = `${a.action.repository}#${n}`.toLowerCase();
        return buckets[key] ? [[key, buckets[key]]] : [];
      }));
  }
  // An evicted detail must not restore GitHub navigation or chat authority.
  for (const a of [...items, ...(identities ?? [])]) {
    const key = "detailKey" in a ? a.detailKey : a.key;
    const mine = requests.filter(([k]) => k === key).map(([, r]) => r);
    if (mine.length) a.requests = mine;
    if (allUnreadable || unreadable.has(key) || (raw.requests !== undefined && !mine.length)) a.requestsUnreadable = true;
  }
  const refused = raw.items.length - items.length + (Array.isArray(raw.identities) ? raw.identities.length - identities!.length : 0);
  if (identities && new Set(identities.map((i) => i.key)).size !== identities.length) return "the needs-you inventory has duplicate identities";
  const counts = isObject(raw.counts) && isCount(raw.counts.decisions) && isCount(raw.counts.groups) && isCount(raw.counts.members) ? { decisions: raw.counts.decisions, groups: raw.counts.groups, members: raw.counts.members } : undefined;
  const complete = raw.complete === true && (raw.counts === undefined || counts !== undefined) && refused === 0 && ![...items, ...(identities ?? [])].some((a) => a.requestsUnreadable) && raw.count === (identities?.length ?? raw.items.length) && raw.omitted === 0 && sources.length === Object.keys(raw.sources as object).length && sources.every(([, v]) => v === "complete" || v === "off");
  const epics = parseEpics(raw.epics);
  const context = parseContext(raw.context);
  // Malformed optional evidence disables only the shortlist, not the inbox.
  const actNow = parseActNow(raw.act_now, items, identities);
  const omittedSources = isObject(raw.omitted_sources) ? Object.fromEntries(Object.entries(raw.omitted_sources).filter(([k, v]) => str(k, MODE_RE) && isCount(v))) as Record<string, number> : undefined;
  return { complete, validatedAt, changedAt, sources: Object.fromEntries(sources), summaries: raw.summaries as string, omitted: raw.omitted, items, refused, ...(actNow ? { actNow } : {}), ...(isCount(raw.count) ? { count: raw.count } : {}), ...(counts ? { counts } : {}), ...(identities ? { identities } : {}), ...(isCount(raw.details_omitted) ? { detailsOmitted: raw.details_omitted } : {}), ...(omittedSources ? { omittedSources } : {}), ...(context ? { context } : {}), ...(epics ? { epics } : {}) };
}

/** The holds in a comment's body, or undefined if it isn't a well-formed snapshot. */
export function parseHolds(body: string | null | undefined): Holds | undefined {
  const raw = fencedJson(body, HOLDS_MARKER);
  const at = time(raw?.at);
  if (raw?.schema !== SCHEMA || !at || !Array.isArray(raw.holds)) return undefined;
  const holds = raw.holds.map(parseHold);
  if (!holds.every((h) => h !== undefined)) return undefined;
  const out: Holds = { at, holds: holds as Hold[] };
  // Added to v1 later: a malformed one is left out, not the holds with it.
  const wip = parseWip(raw.wip);
  if (wip) out.wip = wip;
  const pass = parsePass(raw.pass);
  if (pass) out.pass = pass;
  if (raw.needs_you !== undefined) {
    out.needsYou = parseNeedsYou(raw.needs_you);
    if (typeof out.needsYou === "object") reconcileOperatorHolds(out.needsYou, out.holds, raw.truncated === undefined || raw.truncated === 0);
  }
  if (raw.pass_view !== undefined) out.passView = parsePassView(raw.pass_view);
  if (raw.dispatchable_work !== undefined) out.dispatchableWork = parseDispatchableWork(raw.dispatchable_work);
  if (raw.today !== undefined) out.today = parseToday(raw.today);
  if (raw.epic_focus !== undefined) out.epicFocus = parseFocus(raw.epic_focus);
  return out;
}

/** A stale hold detail/identity must not resurrect work no longer waiting on
 * the operator. Use the same snapshot, never labels, prose or target discovery.
 * A truncated hold inventory cannot establish absence; explicit non-operator
 * holds still supersede it. Reviews/proposals have their own published waits. */
function reconcileOperatorHolds(list: NeedsYou, holds: readonly Hold[], whole: boolean): void {
  const operator = new Set(holds.filter((h) => h.operator && h.item).map((h) => h.item!.toLowerCase()));
  const listed = new Set(holds.flatMap((h) => h.item ? [h.item.toLowerCase()] : []));
  const keep = (a: Pick<Ask, "item" | "source">) => !["epics", "items", "pass", "holds"].includes(a.source) || operator.has(a.item.toLowerCase()) || (!whole && !listed.has(a.item.toLowerCase()));
  const before = list.identities?.length ?? list.items.length;
  list.items = list.items.filter(keep);
  if (list.identities) list.identities = list.identities.filter(keep);
  list.excludedHolds = before - (list.identities?.length ?? list.items.length);
}

/** The bot's newest hold comment among an issue's comments, oldest first as GitHub lists them, put back together where it is compressed; nothing if it doesn't parse. */
export async function findHolds(comments: readonly RawComment[]): Promise<Holds | undefined> {
  return parseHolds(await assembleHolds(comments));
}

/**
 * The plain hold comment the bot's comments publish: its newest with
 * HOLDS_MARKER where that is plain, else the snapshot its parts encode
 * (PARTS_SCHEMA). Nothing where a part is missing or of another snapshot,
 * as while a pass writes them, or anything else is amiss: never a mix of two.
 */
export async function assembleHolds(comments: readonly RawComment[]): Promise<string | undefined> {
  const mine = comments.filter((c) => isBot(c.user?.login));
  const first = mine.findLast((c) => c.body?.startsWith(HOLDS_MARKER))?.body;
  const header = fencedJson(first, HOLDS_MARKER);
  if (!first || header?.schema !== PARTS_SCHEMA) return first ?? undefined;
  const count = header.parts;
  if (typeof header.at !== "string" || header.encoding !== PARTS_ENCODING || !Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_PARTS) return undefined;
  const pieces = [TEXT_BLOCK_RE.exec(first)?.[1]];
  for (let part = 2; part <= (count as number); part++) {
    const body = mine.findLast((c) => {
      const h = fencedJson(c.body, PART_MARKER);
      return h?.schema === PARTS_SCHEMA && h.at === header.at && h.part === part;
    })?.body;
    pieces.push(body ? TEXT_BLOCK_RE.exec(body)?.[1] : undefined);
  }
  if (pieces.some((p) => !p)) return undefined;
  const body = await gunzip(pieces.join(""), MAX_SNAPSHOT_BYTES);
  return body !== undefined && fencedJson(body, HOLDS_MARKER)?.at === header.at ? body : undefined;
}

/** `base64`, gzipped UTF-8, as text: nothing if it isn't, or inflates past `limit` bytes. */
async function gunzip(base64: string, limit: number): Promise<string | undefined> {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const whole = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      whole.set(chunk, at);
      at += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(whole);
  } catch {
    return undefined;
  }
}

const DECISION_COMMENTS = `query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) { issueOrPullRequest(number:$number) {
    ... on Issue { comments(last:100) { nodes { body author { login } } } }
    ... on PullRequest { comments(last:100) { nodes { body author { login } } } }
  } }
}`;

/** Fresh bounded read: a newer bot comment may replace the ask without editing the issue. */
export async function readHoldAsk(gh: GitHub, owner: string, repo: string, number: number): Promise<string | undefined> {
  const result = await gh.send<{ data?: { repository?: { issueOrPullRequest?: { comments: { nodes: { body: string; author: { login: string } | null }[] } } } } }>("POST", "/graphql", { query: DECISION_COMMENTS, variables: { owner, repo, number } });
  const nodes = result.data?.repository?.issueOrPullRequest?.comments.nodes;
  if (!nodes) throw new Error("The hold's current question could not be read");
  return nodes.findLast((c) => isBot(c.author?.login))?.body;
}

/** The published holds, read with the viewer's token; undefined when none is published. A failed read throws, for readSource to say. */
export async function loadHolds(gh: GitHub): Promise<Holds | undefined> {
  return (await loadPassPublications(gh)).holds;
}

/** One existing comment read serves both Status panels and the inbox. */
export async function loadPassPublications(gh: GitHub) {
  const { data } = await gh.get<RawComment[]>(usagePath);
  const comments = Array.isArray(data) ? data : [];
  // A replacement publication may be on page two; never accept an older match.
  const uncertain = comments.length >= 100 ? "only the first 100 comments were read; a newer publication may be unread" : undefined;
  return { holds: await findHolds(comments), repositories: findMaintainerReports(comments), passes: uncertain ?? findPasses(comments), uncertain };
}

/**
 * Without a usable needs-you list, the snapshot's own operator holds on
 * items as asks, in its order, so an older pass's holds are not dropped
 * with the list; they ask the board's question or say the hold's reason.
 */
export function holdAsks(h: Holds): Ask[] {
  return h.holds.flatMap((x) => {
    const [, repository = "", number] = (x.operator && x.item && ITEM_RE.exec(x.item)) || [];
    return repository ? [{ key: x.item!.toLowerCase(), item: x.item!, source: "holds", kind: x.kind, priority: x.priority, waitingSince: h.at, ask: x.question ?? x.reason, recommendation: null, action: { type: "issue", repository, number: Number(number) }, carried: x.carried === true }] : [];
  });
}
