// Forge PRs: the bot's draft PRs in jmarrero-forge that wait for
// jmarrero's review. Pure functions over REST JSON (search results,
// reviews, patches, checks) and the review the app submits, so tests
// feed them synthetic payloads.
//
// The review is what `bot-pr promote` keys on: the latest APPROVED,
// CHANGES_REQUESTED or DISMISSED review by jmarrero, or conversation
// comment of his with a `/promote` line, decides, and an approval counts
// only for the commit it names (commit_id), which must be the PR's
// current head. So the app always submits with commit_id set to the head
// it showed, after checking the head didn't move. A `/promote` comment
// names no commit; bot-pr dates it against the push log, which the app
// can't read, so it shows such a PR as promoted but leaves the decision
// (and the PR, in the queue) to bot-pr.

import { AnswerError, isCommandLine } from "../answer.ts";
import { type IssueRef, parseIssueUrl } from "./board.ts";
import { BOT_LOGIN, FORGE_ORG } from "./config.ts";

/** A line in an approving review asking promote for a draft upstream PR. */
export const DRAFT_LINE = "/draft";
/** Lines in his conversation comments that approve, as bot-pr reads them. */
export const PROMOTE_LINES: readonly string[] = ["/promote", "/promote --human-text"];

/** `owner/repo#number`, the key the app uses for a PR everywhere. */
export function refKey(r: IssueRef): string {
  return `${r.owner}/${r.repo}#${r.number}`;
}

export interface ForgePr {
  ref: IssueRef;
  url: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

/** The subset of a search/issues result the app uses. */
export interface RawSearchIssue {
  html_url?: string;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  draft?: boolean;
  pull_request?: unknown;
}

/** A PR from a search result, or undefined if it isn't one. */
export function parseSearchPr(raw: RawSearchIssue): ForgePr | undefined {
  if (!raw.pull_request || !raw.html_url || !/\/pull\/\d+$/.test(raw.html_url)) return undefined;
  const ref = parseIssueUrl(raw.html_url);
  if (!ref) return undefined;
  return {
    ref,
    url: raw.html_url,
    title: raw.title?.trim() || "(no title)",
    body: raw.body ?? "",
    author: raw.user?.login ?? "ghost",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    draft: raw.draft === true,
  };
}

export const META_START = "<!-- bot-meta -->";
export const META_END = "<!-- /bot-meta -->";

/** What bot-pr records in a fork PR's bot-meta section. */
export interface BotMeta {
  /** The upstream repository, `owner/repo`. */
  upstream?: string;
  /** The upstream base branch. */
  base?: string;
  /** The Workstream board item, `PVTI_...`. */
  item?: string;
  policy?: string;
}

function metaSection(body: string): string | undefined {
  const start = body.indexOf(META_START);
  if (start < 0) return undefined;
  const end = body.indexOf(META_END, start);
  return body.slice(start + META_START.length, end < 0 ? undefined : end);
}

/** Parse the bot-meta section of a fork PR body; empty if there is none. */
export function parseBotMeta(body: string): BotMeta {
  const meta: BotMeta = {};
  const section = metaSection(body.replace(/\r\n?/g, "\n"));
  if (section === undefined) return meta;
  const up = /^- Upstream: `([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`(?:, base `([^`\s]+)`)?/m.exec(section);
  if (up?.[1]) meta.upstream = up[1];
  if (up?.[2]) meta.base = up[2];
  const item = /^- Board item: `(PVTI_[A-Za-z0-9_-]+)`/m.exec(section);
  if (item?.[1]) meta.item = item[1];
  const policy = /^- Contribution policy: `([^`]+)`/m.exec(section);
  if (policy?.[1]) meta.policy = policy[1];
  return meta;
}

/** Whether a PR is a draft in the forge. */
export function isForgeDraft(pr: ForgePr): boolean {
  return pr.draft && pr.ref.owner.toLowerCase() === FORGE_ORG.toLowerCase();
}

/** The next operator action for an approved fork, until /promote is sent. */
export function promotionAction(pr: ForgePr, verdict: Verdict | undefined): "promote" | "write" | undefined {
  if (verdict?.state !== "approved" || pr.author !== BOT_LOGIN || pr.ref.owner.toLowerCase() !== FORGE_ORG.toLowerCase()) return undefined;
  const meta = parseBotMeta(pr.body);
  if (!meta.upstream) return undefined;
  return meta.policy === "human-text" ? "write" : "promote";
}

/** The body as it will read upstream: without the bot-meta section. */
export function withoutBotMeta(body: string): string {
  const start = body.indexOf(META_START);
  if (start < 0) return body;
  const end = body.indexOf(META_END, start);
  return (body.slice(0, start) + (end < 0 ? "" : body.slice(end + META_END.length))).trimEnd();
}

export interface RawReview {
  id?: number;
  user?: { login?: string } | null;
  state?: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  html_url?: string;
  body?: string | null;
}

export interface RawIssueComment {
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string;
  html_url?: string;
}

/** Whether a comment has a line bot-pr reads as `/promote` (trimming spaces and tabs, as it does). */
export function hasPromoteLine(body: string): boolean {
  return body
    .replace(/\r/g, "")
    .split("\n")
    .some((l) => PROMOTE_LINES.includes(l.replace(/^[ \t]+|[ \t]+$/g, "")));
}

export type VerdictState =
  /** No approval or change request by him (or the last was dismissed). */
  | "none"
  /** He approved the current head: promote can go ahead. */
  | "approved"
  /** He approved an older head; the commits since are unreviewed. */
  | "approved-older"
  /** He asked for changes on the current head: the bot owes a push. */
  | "changes-requested"
  /** He asked for changes, and the bot pushed since. */
  | "changes-requested-older"
  /** His latest word is a `/promote` comment; bot-pr decides which head it approves. */
  | "promoted";

export interface Verdict {
  state: VerdictState;
  at?: string;
  url?: string;
}

const DECIDING = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

interface Decision {
  kind: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PROMOTE";
  at: string;
  commit?: string | null | undefined;
  url?: string | undefined;
}

/**
 * His latest deciding review or `/promote` comment, read against the
 * current head, as bot-pr does. Ties keep the later entry in API order,
 * and entries without a date are ignored.
 */
export function reviewVerdict(
  reviews: readonly RawReview[],
  head: string,
  reviewer: string,
  comments: readonly RawIssueComment[] = [],
): Verdict {
  const decisions: Decision[] = [
    ...reviews
      .filter((r) => r.user?.login === reviewer && DECIDING.includes(r.state ?? "") && r.submitted_at)
      .map((r): Decision => ({ kind: r.state as Decision["kind"], at: r.submitted_at ?? "", commit: r.commit_id, url: r.html_url })),
    ...comments
      .filter((c) => c.user?.login === reviewer && c.created_at && hasPromoteLine(c.body ?? ""))
      .map((c): Decision => ({ kind: "PROMOTE", at: c.created_at ?? "", url: c.html_url })),
  ];
  // A stable sort, so equal times keep reviews' and then comments' order.
  // ISO 8601 times compare as strings, as bot-pr's sort_by does.
  const last = decisions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
  if (!last || last.kind === "DISMISSED") return { state: "none" };
  const current = last.commit === head;
  const state: VerdictState =
    last.kind === "PROMOTE"
      ? "promoted"
      : last.kind === "APPROVED"
        ? current
          ? "approved"
          : "approved-older"
        : current
          ? "changes-requested"
          : "changes-requested-older";
  const v: Verdict = { state, at: last.at };
  if (last.url) v.url = last.url;
  return v;
}

/** Whether the PR is still in his queue: not approved (nor sent back) at its head. */
export function waitsOnReviewer(v: Verdict): boolean {
  return v.state !== "approved" && v.state !== "changes-requested";
}

export const VERDICT_LABEL: Record<VerdictState, string> = {
  none: "not reviewed",
  approved: "approved",
  "approved-older": "approved an older head",
  "changes-requested": "changes requested",
  "changes-requested-older": "updated since your change request",
  promoted: "/promote sent; bot-pr decides",
};

export type CiState = "success" | "failure" | "pending" | "none";

export interface CiCheck {
  name: string;
  state: CiState;
  url?: string;
  /** The raw conclusion or state, e.g. "timed_out". */
  detail: string;
}

export interface RawCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

export interface RawStatus {
  context?: string;
  state?: string;
  target_url?: string | null;
}

const PASSING = ["success", "neutral", "skipped"];

function withUrl(check: CiCheck, url: string | null | undefined): CiCheck {
  if (url) check.url = url;
  return check;
}

/** Check runs and commit statuses as one list, failures first. */
export function ciChecks(runs: readonly RawCheckRun[], statuses: readonly RawStatus[]): CiCheck[] {
  const out: CiCheck[] = [];
  for (const r of runs) {
    const done = r.status === "completed";
    const detail = done ? (r.conclusion ?? "unknown") : (r.status ?? "queued");
    const state: CiState = !done ? "pending" : PASSING.includes(detail) ? "success" : "failure";
    out.push(withUrl({ name: r.name ?? "(unnamed)", state, detail }, r.html_url ?? r.details_url));
  }
  for (const s of statuses) {
    const detail = s.state ?? "unknown";
    const state: CiState = detail === "success" ? "success" : detail === "pending" ? "pending" : "failure";
    out.push(withUrl({ name: s.context ?? "(unnamed)", state, detail }, s.target_url));
  }
  const order: CiState[] = ["failure", "pending", "success", "none"];
  return out.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name));
}

/** One state for all checks: any failure, else any pending, else success. */
export function ciSummary(checks: readonly CiCheck[]): CiState {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "success";
}

export type ReviewAction = "approve" | "request-changes" | "comment";

/** A comment on a line (or lines) of the diff at a commit, as the reviews API takes it. */
export interface LineComment {
  path: string;
  /** The last line commented on, in the side's file. */
  line: number;
  side: "LEFT" | "RIGHT";
  /** For a range: its first line and side. */
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

/** A line comment he wrote, anchored to the commit whose diff showed it. */
export interface DraftComment extends LineComment {
  /** The commit the comment's diff ends at: the head, or a commit of the PR viewed alone. */
  commit: string;
  /** Where that diff starts: a commit, or PR_BASE for the PR's own base. Only for showing it. */
  base?: string;
}

/** A draft's base when written on the PR's whole diff. */
export const PR_BASE = "pr";

/** The body of POST /repos/{o}/{r}/pulls/{n}/reviews. */
export interface ReviewRequest {
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments?: LineComment[];
}

const EVENT: Record<ReviewAction, ReviewRequest["event"]> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

const SHA_RE = /^[0-9a-f]{40}$/;

/** His text, trimmed, refusing lines bot-pr would read as commands. */
function cleanText(text: string, what: string): string {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  const bad = clean.split("\n").find(isCommandLine);
  if (bad !== undefined) {
    throw new AnswerError(`the line ${JSON.stringify(bad.trim())} in ${what} would be read as a bot command; reword it (e.g. put it in backticks)`);
  }
  return clean;
}

/**
 * Compose the reviews to submit. His text may not contain a line that
 * bot-pr would read as a command (a `/draft` in a change request would
 * still count), so the only command the app writes is the `/draft` line
 * of an approval he asked for with the checkbox.
 *
 * Line comments go in the review of the commit whose diff he wrote them
 * on. Those on the head's diff ride along with his review; those written
 * on an earlier commit viewed alone go first, in a comment-only review
 * of that commit each. The last request is always the head's review.
 */
export function composeReviews(
  action: ReviewAction,
  text: string,
  head: string,
  opts: { draft?: boolean; comments?: readonly DraftComment[] } = {},
): ReviewRequest[] {
  if (!SHA_RE.test(head)) throw new AnswerError(`not a commit id: ${JSON.stringify(head)}`);
  const clean = cleanText(text, "the review");
  const comments = opts.comments ?? [];
  const byCommit = new Map<string, LineComment[]>();
  for (const c of comments) {
    if (!SHA_RE.test(c.commit)) throw new AnswerError(`not a commit id: ${JSON.stringify(c.commit)}`);
    const body = cleanText(c.body, `the comment on ${c.path}:${c.line}`);
    if (!body) throw new AnswerError(`the comment on ${c.path}:${c.line} is empty`);
    // Only what the API takes: drafts come back from storage, which may hold anything.
    const out: LineComment = { path: c.path, line: c.line, side: c.side, body };
    if (c.start_line !== undefined) {
      out.start_line = c.start_line;
      out.start_side = c.start_side ?? c.side;
    }
    const list = byCommit.get(c.commit) ?? [];
    list.push(out);
    byCommit.set(c.commit, list);
  }
  const atHead = byCommit.get(head) ?? [];
  if (action !== "approve" && !clean && atHead.length === 0) {
    throw new AnswerError(action === "comment" ? "write a comment first" : "say what to change");
  }
  if (opts.draft && action !== "approve") throw new AnswerError(`${DRAFT_LINE} goes only with an approval`);
  const out: ReviewRequest[] = [];
  for (const [commit, list] of byCommit) {
    if (commit !== head) out.push({ commit_id: commit, event: "COMMENT", body: "", comments: list });
  }
  const main: ReviewRequest = { commit_id: head, event: EVENT[action], body: [clean, opts.draft ? DRAFT_LINE : ""].filter(Boolean).join("\n\n") };
  if (atHead.length) main.comments = atHead;
  out.push(main);
  return out;
}

/** Compose his review of the head, without line comments. */
export function composeReview(action: ReviewAction, text: string, head: string, opts: { draft?: boolean } = {}): ReviewRequest {
  return composeReviews(action, text, head, opts).at(-1) as ReviewRequest;
}
