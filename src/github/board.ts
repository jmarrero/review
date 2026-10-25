// Parse the Projects v2 REST API (`/orgs/{o}/projectsV2/{n}/...`) into
// the app's item model. Pure functions over JSON, so tests feed them
// synthetic payloads.

import { parseBlocks, parseQuestion, type Question, unfencedLines } from "../answer.ts";
import { isBot } from "./authors.ts";
import { BOT_LOGIN, CHORE_LABEL, DONE, FEED_FIELD, FIELD, OPERATOR, QUESTION_LABEL, QUEUE_STATUSES, REVIEW_LABEL, TRACKER_REPO, TRIAGE_FIELD } from "./config.ts";

/** The subset of a project field the app uses. */
export interface RawField {
  id: number;
  name: string;
}

interface RawFieldValue {
  id?: number;
  name: string;
  data_type?: string;
  value: null | { raw?: string; name?: { raw?: string } } | string | number;
}

interface RawUser {
  login?: string;
}

/** GitHub's sub-issue progress on an issue. */
export interface SubIssueSummary {
  total: number;
  completed: number;
  percent_completed: number;
}

/** An issue's labels: objects from the API, strings in some payloads. */
export type RawLabel = { name?: string } | string;

/** The subset of an issue or PR (as a board item's content, or from the issues API) the app uses. */
export interface RawContent {
  node_id?: string;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  created_at?: string;
  user?: RawUser | null;
  labels?: RawLabel[];
  assignees?: (RawUser | null)[] | null;
  /** Number of comments, on issues. */
  comments?: number;
  sub_issues_summary?: SubIssueSummary | null;
  /** The API URL of the parent issue, when this is a sub-issue. */
  parent_issue_url?: string | null;
  /** Present on an issue that is a PR, from the issues API. */
  pull_request?: unknown;
}

/** The subset of a project item the app uses. */
export interface RawItem {
  id: number;
  node_id: string;
  content_type: string;
  content?: RawContent | null;
  fields?: RawFieldValue[];
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

export type ItemKind = "issue" | "pr" | "draft" | "unknown";

/** An issue or PR, as `owner/repo#number`. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface Item {
  engine?: string;
  /** Numeric project item id, for REST. */
  id: number;
  /** PVTI_... node id, as the bot and bot-board name items. */
  nodeId: string;
  kind: ItemKind;
  title: string;
  /** The issue or PR page; absent for drafts. */
  url?: string;
  ref?: IssueRef;
  /** Issue/PR state, e.g. "open", "closed", "merged". */
  state?: string;
  /** Label names, on issues and PRs. */
  labels: string[];
  /** Assignee logins, on issues and PRs. */
  assignees: string[];
  /** Who opened the issue or PR, when the payload says. */
  author?: string;
  /** Number of comments, when the payload says. */
  comments?: number;
  /** Sub-issue progress, on issues that have sub-issues. */
  subIssues?: SubIssueSummary;
  /** The parent issue, on a sub-issue. */
  parent?: IssueRef;
  body: string;
  status?: string;
  priority?: string;
  why: string;
  org?: string;
  branch: string[];
  gist: string[];
  /** The Theme field: the triage group the item belongs to. */
  theme?: string;
  /** The Verdict field, as the board names it (see triage.ts). */
  verdict?: string;
  /** The Verdict target field: what a merge or close verdict points at. */
  verdictTarget?: string;
  /** The Lead field: the topic session that owns the item. */
  lead?: string;
  /** The News field: the latest notable event, one dated line. */
  news?: string;
  /** The Run field: the devspace agent run working on it, a URL. */
  run?: string;
  /** When its issue or PR was created, else when the item was added to the board. */
  createdAt?: string;
  /** When the board item itself (a field) last changed. */
  movedAt?: string;
  updatedAt?: string;
}

/** The priorities in queue order; anything else sorts after them. */
export const PRIORITY_ORDER: readonly string[] = ["P0", "P1", "P2", "P3"];
/** Group heading for items with no priority. */
export const NO_PRIORITY = "No priority";

const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)$/;
const API_ISSUE_URL_RE = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)$/;

function refFrom(m: RegExpExecArray | null): IssueRef | undefined {
  return m ? { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) } : undefined;
}

/** Parse a github.com issue or PR URL. */
export function parseIssueUrl(url: string): IssueRef | undefined {
  return refFrom(ISSUE_URL_RE.exec(url));
}

/** Parse an api.github.com issue URL, e.g. `parent_issue_url`. */
export function parseApiIssueUrl(url: string): IssueRef | undefined {
  return refFrom(API_ISSUE_URL_RE.exec(url));
}

/** `owner/repo`, lowercased: GitHub names are case-insensitive. */
export function repoOf(ref: IssueRef): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

/** Assignee logins. */
export function assigneeLogins(assignees: RawContent["assignees"]): string[] {
  return (assignees ?? []).flatMap((a) => (a?.login ? [a.login] : []));
}

/** Label names, whichever shape the payload uses. */
export function labelNames(labels: readonly RawLabel[] | undefined): string[] {
  return (labels ?? []).flatMap((l) => {
    const name = typeof l === "string" ? l : l.name;
    return name ? [name] : [];
  });
}

/**
 * Field ids for the fields the app reads, failing clearly if a required
 * one is gone; the triage fields are added when the board has them.
 */
export function fieldIds(fields: readonly RawField[]): number[] {
  const byName = new Map(fields.map((f) => [f.name, f.id]));
  const required = Object.values(FIELD).map((name) => {
    const id = byName.get(name);
    if (id === undefined) {
      throw new Error(`the board has no field named "${name}"; was it renamed?`);
    }
    return id;
  });
  const optional = [...Object.values(TRIAGE_FIELD), ...Object.values(FEED_FIELD), "Engine"].flatMap((name) => byName.get(name) ?? []);
  return [...required, ...optional];
}

/** The triage fields the board lacks, by name. */
export function missingTriageFields(fields: readonly RawField[]): string[] {
  const names = new Set(fields.map((f) => f.name));
  return Object.values(TRIAGE_FIELD).filter((name) => !names.has(name));
}

function fieldText(v: RawFieldValue["value"]): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v.raw === "string") return v.raw;
  if (typeof v.name?.raw === "string") return v.name.raw;
  return undefined;
}

/** Split a Branch or Gist field, which holds space-separated URLs. */
function urls(text: string | undefined): string[] {
  return (text ?? "").split(/\s+/).filter((u) => /^https:\/\/\S+$/.test(u));
}

function kindOf(contentType: string): ItemKind {
  switch (contentType) {
    case "Issue":
      return "issue";
    case "PullRequest":
      return "pr";
    case "DraftIssue":
      return "draft";
    default:
      return "unknown";
  }
}

/** Parse one project item. */
export function parseItem(raw: RawItem): Item {
  const fields = new Map<string, string>();
  for (const f of raw.fields ?? []) {
    const text = fieldText(f.value);
    if (text !== undefined) fields.set(f.name, text);
  }
  const c = raw.content ?? {};
  const kind = kindOf(raw.content_type);
  const item: Item = {
    id: raw.id,
    nodeId: raw.node_id,
    kind,
    title: c.title?.trim() || "(no title or no access)",
    body: c.body ?? "",
    why: fields.get(FIELD.why) ?? "",
    branch: urls(fields.get(FIELD.branch)),
    gist: urls(fields.get(FIELD.gist)),
    labels: labelNames(c.labels),
    assignees: assigneeLogins(c.assignees),
  };
  const opt = <K extends keyof Item>(key: K, value: Item[K] | undefined) => {
    if (value !== undefined) item[key] = value;
  };
  opt("status", fields.get(FIELD.status));
  opt("priority", fields.get(FIELD.priority));
  opt("org", fields.get(FIELD.org));
  opt("theme", fields.get(TRIAGE_FIELD.theme)?.trim() || undefined);
  opt("verdict", fields.get(TRIAGE_FIELD.verdict)?.trim() || undefined);
  opt("verdictTarget", fields.get(TRIAGE_FIELD.verdictTarget)?.trim() || undefined);
  opt("lead", fields.get(FEED_FIELD.lead)?.trim() || undefined);
  opt("news", fields.get(FEED_FIELD.news)?.trim() || undefined);
  opt("run", urls(fields.get(FEED_FIELD.run))[0]);
  opt("engine", fields.get("Engine")?.trim().toLowerCase() || undefined);
  opt("createdAt", c.created_at ?? raw.created_at);
  opt("movedAt", raw.updated_at);
  opt("updatedAt", c.updated_at ?? raw.updated_at);
  if (kind !== "draft" && c.html_url) {
    item.url = c.html_url;
    opt("ref", parseIssueUrl(c.html_url));
    opt("state", c.merged_at ? "merged" : c.state);
  }
  if (c.user?.login) item.author = c.user.login;
  if (typeof c.comments === "number") item.comments = c.comments;
  if (c.sub_issues_summary && c.sub_issues_summary.total > 0) item.subIssues = c.sub_issues_summary;
  if (c.parent_issue_url) opt("parent", parseApiIssueUrl(c.parent_issue_url));
  return item;
}

/** Unarchived items whose Status is one of `statuses`. */
export function boardItems(raw: readonly RawItem[], statuses: readonly string[]): Item[] {
  return raw
    .filter((r) => !r.archived_at)
    .map(parseItem)
    .filter((i) => i.status !== undefined && statuses.includes(i.status));
}

/** Unarchived items that aren't Done, those without a Status included. */
export function openItems(raw: readonly RawItem[]): Item[] {
  return raw
    .filter((r) => !r.archived_at)
    .map(parseItem)
    .filter((i) => i.status !== DONE);
}

/** The board's part of the queue: unarchived items needing a human, or Draft (ready for review). */
export function queueItems(raw: readonly RawItem[]): Item[] {
  return boardItems(raw, QUEUE_STATUSES);
}

/** The kinds of ask: a tracker issue asking him to answer, review or act. */
export type AskKind = "question" | "review" | "chore";

/** Each kind's label; an ask carries exactly one. */
export const ASK_LABELS: Readonly<Record<AskKind, string>> = { question: QUESTION_LABEL, review: REVIEW_LABEL, chore: CHORE_LABEL };

const ASK_KINDS = Object.keys(ASK_LABELS) as AskKind[];

/** The ask kinds its labels name. */
function askLabels(labels: readonly string[]): AskKind[] {
  return ASK_KINDS.filter((k) => labels.includes(ASK_LABELS[k]));
}

/** What postAnswer, postAskComment and askTarget check an issue against. */
export interface AskFacts {
  kind: ItemKind;
  ref?: IssueRef;
  state?: string;
  labels: readonly string[];
  assignees: readonly string[];
  author?: string;
}

/** Where asks live, whom they ask and who writes them. */
export interface AskScope {
  repo: string;
  assignee: string;
  author: string;
}

/**
 * The real scope: the tracker, the bot asking him. Tests against a
 * sandbox repository override the assignee, since he can't be assigned
 * there.
 */
export const TRACKER_SCOPE: AskScope = { repo: TRACKER_REPO, assignee: OPERATOR, author: BOT_LOGIN };

/** The kind of ask an issue is, if it is one: an issue in the tracker with exactly one ask label. */
export function askKind(q: Pick<AskFacts, "kind" | "ref" | "labels">, repo: string = TRACKER_REPO): AskKind | undefined {
  if (q.kind !== "issue" || !q.ref || repoOf(q.ref) !== repo.toLowerCase()) return undefined;
  const kinds = askLabels(q.labels);
  return kinds.length === 1 ? kinds[0] : undefined;
}

/**
 * Why this can't take his action, or undefined if it can: only an open
 * issue in the tracker, opened by the bot, assigned to him, with exactly
 * one ask label (`want`'s, when given) does. Anything else, above all an
 * upstream issue or PR, is acted on in GitHub: a bare "B" there is noise
 * to its maintainers.
 */
export function askProblem(q: AskFacts, want?: AskKind, scope: AskScope = TRACKER_SCOPE): string | undefined {
  if (!q.ref) return "this item has no issue to comment on";
  const where = `${q.ref.owner}/${q.ref.repo}#${q.ref.number}`;
  if (q.kind !== "issue") return `${where} is not an issue`;
  if (repoOf(q.ref) !== scope.repo.toLowerCase()) return `${where} is not in ${scope.repo}, where the bot's asks are`;
  const kinds = askLabels(q.labels);
  if (want !== undefined && !kinds.includes(want)) return `${where} is not labelled "${ASK_LABELS[want]}"`;
  if (kinds.length === 0) return `${where} has none of the labels ${ASK_KINDS.map((k) => `"${ASK_LABELS[k]}"`).join(", ")}`;
  if (kinds.length > 1) return `${where} has several of the labels ${kinds.map((k) => `"${ASK_LABELS[k]}"`).join(", ")}`;
  if (q.author?.toLowerCase() !== scope.author.toLowerCase()) return `${where} was not opened by ${scope.author}`;
  if (!q.assignees.some((a) => a.toLowerCase() === scope.assignee.toLowerCase())) return `${where} is not assigned to ${scope.assignee}`;
  if (q.state !== "open") return `${where} is closed`;
  return undefined;
}

/** Why a question can't take an answer; see askProblem. */
export function questionProblem(q: AskFacts, scope: AskScope = TRACKER_SCOPE): string | undefined {
  return askProblem(q, "question", scope);
}

/** An ask issue in the tracker, open or closed, of any kind. */
export function isAsk(item: Item): boolean {
  return askKind(item) !== undefined;
}

/**
 * Since when an item has waited on him, as far as the API says. An ask
 * waits from its issue's creation: the bot opens it when it asks. Any
 * other item may be months older than its move to Needs human or Draft,
 * and GitHub keeps no field history, so it waits from the board item's
 * own last change, an upper bound on that move; undefined (age unknown)
 * without one, never the issue's age.
 */
export function waitingSince(item: Item): string | undefined {
  return isAsk(item) ? item.createdAt ?? item.updatedAt : item.movedAt;
}

/** A question issue in the tracker, open or closed. */
export function isQuestion(item: Item): boolean {
  return askKind(item) === "question";
}

/** The question an item asks: parsed from a question issue's body, else none. */
export function questionOf(item: Item): Question {
  return isQuestion(item) ? parseQuestion(item.body) : { options: [] };
}

/** The item an ask blocks: its parent issue, else its `Blocks:` line. */
export function blockedBy(item: Item): IssueRef | undefined {
  if (!isAsk(item)) return undefined;
  if (item.parent) return item.parent;
  const url = parseBlocks(unfencedLines(item.body));
  return url ? parseIssueUrl(url) : undefined;
}

/** The subset of a comment that decides whether he has answered. */
export interface CommentFacts {
  author: string;
  createdAt: string;
}

/**
 * Has he answered this question and the bot not yet acted? True if he
 * commented after the bot's last comment (the bot's reply to an earlier
 * answer, or a follow-up question), comments in the API's oldest-first
 * order.
 */
export function answeredPending(comments: readonly CommentFacts[]): boolean {
  const mine = comments.findLastIndex((c) => c.author === OPERATOR);
  return mine >= 0 && mine > comments.findLastIndex((c) => isBot(c.author));
}
