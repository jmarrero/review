// Review drafts: agent-drafted reviews of others' PRs, each kept as an
// open issue in a tracker repository until the operator approves sending
// it (cgwalters-forge/tracker#848 specifies the format and the rules).
// The tracker's workflow does the sending, as the bot, once the operator
// ticks the issue body's send box; this app only shows the newest draft as
// the review will look, ticks that box as the viewer, and starts new
// drafts. Off unless review-draft-config.json on the default branch names
// a tracker: no repository or login is built in.

import rawConfig from "./review-draft-config.json" with { type: "json" };
import { GitHubError, type GitHub } from "./api.ts";
import { parseHunks, type Row } from "./diff.ts";

export interface ReviewDraftConfig {
  /** OWNER/REPO holding the draft issues, where the drafting workflow runs too. */
  tracker: string;
  label: string;
  /** Logins whose issue bodies and comments may hold a draft: the bot and the operator. */
  authors: string[];
  /** The text of the body's send box, `- [ ] TEXT`, as the tracker's workflow reads it. */
  sendBox: string;
  /** The tracker's dispatch workflow (task, repo, item and kind inputs) and its branch. */
  workflow: string;
  ref: string;
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN = /^[A-Za-z0-9-]+(?:\[bot\])?$/;

export function reviewDraftConfig(value: unknown): ReviewDraftConfig | undefined {
  const c = value as ReviewDraftConfig;
  if (c && c.tracker === "" && c.label === "" && c.sendBox === "" && c.workflow === "" && c.ref === ""
    && Array.isArray(c.authors) && !c.authors.length) return undefined;
  if (!c || typeof c.tracker !== "string" || !REPO.test(c.tracker)
    || typeof c.label !== "string" || !/^[\w .:-]{1,50}$/.test(c.label) || /^\.{1,2}$/.test(c.label)
    || !Array.isArray(c.authors) || !c.authors.length || c.authors.length > 10
    || c.authors.some((a) => typeof a !== "string" || !LOGIN.test(a))
    || typeof c.sendBox !== "string" || !/^[^\r\n\[\]]{1,200}$/.test(c.sendBox) || c.sendBox.trim() !== c.sendBox
    || typeof c.workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(c.workflow)
    || typeof c.ref !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(c.ref)) throw new Error("Invalid review draft configuration");
  return c;
}

export const REVIEW_DRAFT_CONFIG = reviewDraftConfig(rawConfig);

/** Open draft issues read, newest first; each read costs its comments, its PR and the PR's files. */
export const MAX_DRAFT_ISSUES = 20;
/** Comments read per issue: one page. An issue with more is refused, not read in part, so no newer draft goes unseen. */
export const MAX_DRAFT_COMMENTS = 100;
/** Pages of a PR's files read (100 each) to find the commented lines. */
export const MAX_FILE_PAGES = 3;
/** Lines of the hunk shown above a commented line, as GitHub shows them. */
export const EXCERPT_CONTEXT = 3;

export const EVENTS = { COMMENT: "Comment", REQUEST_CHANGES: "Request changes", APPROVE: "Approve" } as const;
export type ReviewEvent = keyof typeof EVENTS;

export interface PrRef { owner: string; repo: string; number: number }
export const refText = (r: PrRef): string => `${r.owner}/${r.repo}#${r.number}`;
const PR_REF = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d{0,9})(?:[/?#].*)?$/;

/** `OWNER/REPO#N` or a github.com PR URL. */
export function parsePrRef(text: string): PrRef | undefined {
  const m = PR_REF.exec(text.trim()) ?? PR_URL.exec(text.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : undefined;
}

export interface DraftComment { path: string; line: number; body: string }

export interface Draft {
  pr: PrRef;
  head: string;
  event: ReviewEvent;
  body: string;
  comments: DraftComment[];
}

/** Where a draft was written, and the draft or why it can't be read. */
export interface Found {
  /** "body", or the comment's id. */
  source: string;
  url: string;
  /** The draft's text, from its fence to the next draft or the send box: what an approval approves. */
  raw: string;
  draft?: Draft;
  error?: string;
}

const FENCE = /^```review-draft[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gm;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boxLine = (sendBox: string, mark: string): RegExp => new RegExp(`^- \\[${mark}\\] ${escape(sendBox)}[ \\t]*\\r?$`, "gm");

function parseDraft(fields: string, rest: string): Draft {
  const kv = new Map<string, string>();
  for (const line of fields.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^\s*(\w+)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line);
    if (!m) throw new Error(`unreadable line in the draft block: ${line.trim()}`);
    kv.set(m[1]!, m[2]!);
  }
  const pr = PR_REF.exec(kv.get("pr") ?? "");
  if (!pr) throw new Error('pr must be "OWNER/REPO#N"');
  const head = kv.get("head") ?? "";
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("head must be a full commit SHA");
  const event = kv.get("event") ?? "";
  if (!Object.hasOwn(EVENTS, event)) throw new Error(`event must be one of ${Object.keys(EVENTS).join(", ")}`);
  // Every line after the block must land in the body or a comment: text the
  // preview would drop, the sender might still post, so it is refused instead.
  const sections = [...rest.matchAll(/^## (Review|Comments)[ \t]*\r?$/gm)];
  const [first, second] = sections;
  if (sections.length > 2 || (second && (first![1] !== "Review" || second[1] !== "Comments"))) {
    throw new Error("expected at most one ## Review, then at most one ## Comments");
  }
  if (rest.slice(0, first?.index ?? rest.length).trim()) throw new Error("text between the draft block and its ## Review or ## Comments heading");
  const review = sections.find((s) => s[1] === "Review");
  const listed = sections.find((s) => s[1] === "Comments");
  const body = review ? rest.slice(review.index + review[0].length, listed?.index ?? rest.length).trim() : "";
  const comments: DraftComment[] = [];
  if (listed) {
    const text = rest.slice(listed.index + listed[0].length);
    const heading = /^### `([^`\r\n]+):([1-9]\d{0,8})`[ \t]*\r?$/;
    const bad = text.split("\n").find((l) => /^###(?:[ \t]|$)/.test(l) && !heading.test(l));
    if (bad) throw new Error(`malformed comment heading: ${bad.trim()}`);
    const parts = text.split(new RegExp(heading.source, "m"));
    // parts: text before the first heading, then path, line, body triples.
    if (parts[0]!.trim()) throw new Error("text under ## Comments before its first ### `path:line` heading");
    for (let i = 1; i + 2 < parts.length; i += 3) comments.push({ path: parts[i]!, line: Number(parts[i + 1]), body: parts[i + 2]!.trim() });
  }
  return { pr: { owner: pr[1]!, repo: pr[2]!, number: Number(pr[3]) }, head, event: event as ReviewEvent, body, comments };
}

/**
 * The drafts in one text, in order, each running to the next draft or, in
 * the issue body (given `sendBox`), to the send box Send ticks: its last.
 */
export function draftsIn(text: string, sendBox?: string): { raw: string; draft?: Draft; error?: string }[] {
  const box = sendBox === undefined ? undefined : [...text.matchAll(boxLine(sendBox, "[ xX]"))].at(-1);
  const end = box ? box.index : text.length;
  const fences = [...text.slice(0, end).matchAll(FENCE)];
  const drafts = fences.map((m, i) => {
    const raw = text.slice(m.index, fences[i + 1]?.index ?? end);
    try { return { raw, draft: parseDraft(m[1]!, raw.slice(m[0].length)) }; }
    catch (e) { return { raw, error: e instanceof Error ? e.message : String(e) }; }
  });
  // A sender reading the body's last block would take one after the box, which the panel can't show as approved.
  if (text.slice(end).match(FENCE)) drafts.push({ raw: text.slice(end), error: "a draft follows the send box" });
  return drafts;
}

export interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  comments: number;
  user: { login: string } | null;
  pull_request?: unknown;
}
export interface RawComment { id: number; html_url: string; body: string | null; user: { login: string } | null }

/**
 * The newest draft: the last block of the last text holding one, of the
 * issue body and its comments in order. Only the configured authors'
 * texts count: the tracker is public, and anyone may comment there.
 */
export function newestDraft(issue: RawIssue, comments: readonly RawComment[], c: ReviewDraftConfig): Found | undefined {
  const trusted = (u: { login: string } | null) => !!u && c.authors.some((a) => a.toLowerCase() === u.login.toLowerCase());
  const texts = [
    ...(trusted(issue.user) ? [{ source: "body", url: issue.html_url, text: issue.body ?? "", sendBox: c.sendBox }] : []),
    ...comments.filter((cm) => trusted(cm.user)).map((cm) => ({ source: String(cm.id), url: cm.html_url, text: cm.body ?? "", sendBox: undefined })),
  ];
  for (const t of texts.reverse()) {
    const last = draftsIn(t.text, t.sendBox).at(-1);
    if (last) return { source: t.source, url: t.url, ...last };
  }
  return undefined;
}

/** The send box's state in the body: the tracker's workflow acts on a tick by the operator. */
export function sendBoxState(body: string, sendBox: string): "unticked" | "ticked" | "missing" {
  const all = [...body.matchAll(boxLine(sendBox, "[ xX]"))];
  const last = all.at(-1);
  return !last ? "missing" : /^- \[ \]/.test(last[0]) ? "unticked" : "ticked";
}

/**
 * What a tick approves, written on the line under the box: the draft's
 * source (`body` or the comment id), the SHA-256 of its `raw` text as
 * UTF-8, its PR and its head. A tick alone approves whatever is newest
 * when the sender runs, and a draft can arrive after Send's last read; so
 * the sender must post only the newest draft whose source and digest match
 * this line, and only while the PR is open at this head, and refuse
 * otherwise (cgwalters-forge/tracker#848).
 */
export const approvalLine = (source: string, digest: string, d: Draft): string =>
  `<!-- review-draft-approved: source=${source} sha256=${digest} pr=${refText(d.pr)} head=${d.head} -->`;
const APPROVAL_LINE = /^<!-- review-draft-approved: [^\r\n]*-->[ \t]*\r?(?:\n|$)/gm;

export async function draftDigest(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tick the body's last send box, refusing a body whose box is not there
 * unticked, and put `approval` on the line under it in place of any older one.
 */
export function tickSendBox(body: string, sendBox: string, approval?: string): string {
  if (approval !== undefined) body = body.replace(APPROVAL_LINE, "");
  const last = [...body.matchAll(boxLine(sendBox, "[ xX]"))].at(-1);
  if (!last || !/^- \[ \]/.test(last[0])) throw new Error("The send box is no longer there unticked; reload");
  const at = last.index + 3;
  const end = last.index + last[0].length;
  const under = approval === undefined ? "" : `\n${approval}${last[0].endsWith("\r") ? "\r" : ""}`;
  return body.slice(0, at) + "x" + body.slice(at + 1, end) + under + body.slice(end);
}

export interface DraftIssue {
  issue: RawIssue;
  /** The newest draft as read: Send refuses unless it is still the newest. */
  found?: Found;
  box: "unticked" | "ticked" | "missing";
  /** Why the issue was not read. */
  refused?: string;
}

const issuesPath = (c: ReviewDraftConfig, perPage: number): string =>
  `/repos/${c.tracker}/issues?state=open&labels=${encodeURIComponent(c.label)}&sort=updated&direction=desc&per_page=${perPage}`;

async function readIssue(gh: GitHub, c: ReviewDraftConfig, issue: RawIssue, fresh: boolean): Promise<DraftIssue> {
  const box = sendBoxState(issue.body ?? "", c.sendBox);
  // A full page may have more behind it, so a full page is refused too.
  const refused = `${MAX_DRAFT_COMMENTS} or more comments; read it on GitHub`;
  if (issue.comments >= MAX_DRAFT_COMMENTS) return { issue, box, refused };
  const path = `/repos/${c.tracker}/issues/${issue.number}/comments?per_page=${MAX_DRAFT_COMMENTS}`;
  const comments = fresh ? await gh.send<RawComment[]>("GET", path) : (await gh.get<RawComment[]>(path)).data;
  if (comments.length >= MAX_DRAFT_COMMENTS) return { issue, box, refused };
  const found = newestDraft(issue, comments, c);
  return { issue, box, ...(found ? { found } : {}) };
}

/** The open draft issues, most recently updated first, each with its newest draft. */
export async function loadDraftIssues(gh: GitHub, c: ReviewDraftConfig): Promise<DraftIssue[]> {
  const issues = (await gh.get<RawIssue[]>(issuesPath(c, MAX_DRAFT_ISSUES))).data.filter((i) => !i.pull_request).slice(0, MAX_DRAFT_ISSUES);
  return Promise.all(issues.map((i) => readIssue(gh, c, i, false)));
}

export interface Excerpt { rows: Row[]; at: number }

/** The commented line and the hunk lines above it, or undefined when the line is not on the diff's new side. */
export function excerpt(patch: string | undefined, line: number): Excerpt | undefined {
  for (const hunk of parseHunks(patch ?? "")) {
    const i = hunk.rows.findIndex((r) => r.kind !== "del" && r.new === line);
    if (i < 0) continue;
    const from = Math.max(0, i - EXCERPT_CONTEXT);
    return { rows: hunk.rows.slice(from, i + 1), at: i - from };
  }
  return undefined;
}

export interface PrState {
  title: string;
  url: string;
  state: string;
  merged: boolean;
  head: string;
  /** Per draft comment, its excerpt at head; empty when the head moved, since the lines then refer to another diff. */
  excerpts: (Excerpt | undefined)[];
}

/** The draft's PR now: whether it is still open at the draft's head, and each comment's place on its diff. */
export async function readPr(gh: GitHub, d: Draft): Promise<PrState> {
  const base = `/repos/${d.pr.owner}/${d.pr.repo}/pulls/${d.pr.number}`;
  const pr = (await gh.get<{ title: string; html_url: string; state: string; merged?: boolean; head: { sha: string } }>(base)).data;
  const out: PrState = { title: pr.title, url: pr.html_url, state: pr.state, merged: !!pr.merged, head: pr.head.sha, excerpts: [] };
  if (pr.head.sha !== d.head || !d.comments.length) return out;
  const files = (await gh.getAll<{ filename: string; patch?: string }>(`${base}/files?per_page=100`, MAX_FILE_PAGES)).data;
  const patches = new Map(files.map((f) => [f.filename, f.patch]));
  out.excerpts = d.comments.map((cm) => excerpt(patches.get(cm.path), cm.line));
  return out;
}

/**
 * Tick the send box as the viewer, approving the draft that was shown by
 * its digest (approvalLine). Refuses when a newer draft arrived since, the
 * body changed, or the PR closed or moved from the draft's head, so the
 * tick names what the operator read; the sender enforces the rest.
 */
export async function sendDraft(gh: GitHub, c: ReviewDraftConfig, shown: DraftIssue): Promise<void> {
  const found = shown.found;
  const draft = found?.draft;
  if (!found || !draft) throw new Error("No readable draft to send");
  const pr = await gh.send<{ state: string; head: { sha: string } }>("GET", `/repos/${draft.pr.owner}/${draft.pr.repo}/pulls/${draft.pr.number}`);
  if (pr.state !== "open") throw new Error(`${refText(draft.pr)} is no longer open; reload`);
  if (pr.head.sha !== draft.head) throw new Error(`${refText(draft.pr)}'s head moved since the draft; it needs a redraft`);
  const path = `/repos/${c.tracker}/issues/${shown.issue.number}`;
  const issue = await gh.send<RawIssue>("GET", path);
  if ((issue.body ?? "") !== (shown.issue.body ?? "")) throw new Error("The issue changed since it was shown; reload");
  const now = await readIssue(gh, c, issue, true);
  if (now.refused) throw new Error(now.refused);
  if (now.found?.source !== found.source || now.found.raw !== found.raw) throw new Error("A newer draft arrived since this one was shown; reload");
  const body = tickSendBox(issue.body ?? "", c.sendBox, approvalLine(found.source, await draftDigest(found.raw), draft));
  // No issue-body CAS on GitHub: re-read just before the write, as the decisions document does.
  const fresh = await gh.send<RawIssue>("GET", path);
  if ((fresh.body ?? "") !== (issue.body ?? "")) throw new Error("The issue changed since it was shown; reload");
  await gh.send("PATCH", path, { body });
}

export const draftTitle = (ref: PrRef, title: string): string => `Review draft: ${refText(ref)}: ${title}`;

/** What the drafting run is told; the dispatch workflow puts its research profile before it. */
export function draftTask(c: ReviewDraftConfig, ref: PrRef, url: string, head: string, issue: number): string {
  return [
    `Draft a review of the pull request ${refText(ref)} (${url}) and post it on ${c.tracker}#${issue}.`,
    `Read the PR, its commits and its discussion at head ${head}; do not repeat what reviewers already said, and post nothing on the PR itself.`,
    "Finish with one comment on the issue holding the draft, in this form:",
    "",
    "```review-draft",
    `pr = "${refText(ref)}"`,
    `head = "${head}"`,
    'event = "COMMENT"   # COMMENT, REQUEST_CHANGES or APPROVE',
    "```",
    "",
    "## Review",
    "",
    "<the review body, Markdown; do not summarize the PR>",
    "",
    "## Comments",
    "",
    "### `path/to/file:LINE`",
    "",
    "<one inline comment per heading, LINE on the new side of the PR's diff at head>",
    "",
    "Mark must-fix comments `*Important*:` and nits `(low)`; no positive-only inline comments.",
  ].join("\n");
}

export interface Started { issue: string; dispatchError?: string; retried?: boolean }

/** Pages of open draft issues (100 each) read to find a PR's existing one; more is refused, not read in part. */
export const MAX_OPEN_PAGES = 10;

/**
 * The marker a draft issue's body gets when its drafting run did not start.
 * Draft review on the same PR then dispatches again on that issue, and
 * only then: without it, an open issue may have a run under way.
 */
export const dispatchFailedMarker = (attempt: string): string => `<!-- review-draft: dispatch failed attempt=${attempt} -->`;
const MARKER = /^<!-- review-draft: dispatch failed attempt=([0-9a-f-]{36}) -->\r?$/;
/** The failed attempt's id, which each retry's claim names (claimRetry). */
const failedAttempt = (body: string | null): string | undefined =>
  (body ?? "").split("\n").map((l) => MARKER.exec(l)?.[1]).filter((a) => a !== undefined).at(-1);
export const dispatchFailed = (body: string | null): boolean => failedAttempt(body) !== undefined;
const withoutMarker = (body: string): string => body.split("\n").filter((l) => !MARKER.test(l)).join("\n");

async function openDraftIssues(gh: GitHub, c: ReviewDraftConfig): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  // Oldest first, so an issue updated mid-read can't move to a page already read.
  const path = `/repos/${c.tracker}/issues?state=open&labels=${encodeURIComponent(c.label)}&sort=created&direction=asc&per_page=100`;
  for (let page = 1; page <= MAX_OPEN_PAGES; page++) {
    const issues = await gh.send<RawIssue[]>("GET", `${path}&page=${page}`);
    out.push(...issues);
    if (issues.length < 100) return out;
  }
  throw new Error(`More than ${MAX_OPEN_PAGES * 100} open ${c.label} issues in ${c.tracker}; close some before drafting more`);
}

async function dispatchDraft(gh: GitHub, c: ReviewDraftConfig, ref: PrRef, url: string, head: string, issue: number): Promise<string | undefined> {
  const inputs = { task: draftTask(c, ref, url, head, issue), repo: c.tracker, item: String(issue), kind: "research" };
  try {
    await gh.send("POST", `/repos/${c.tracker}/actions/workflows/${c.workflow}/dispatches`, { ref: c.ref, inputs });
    return undefined;
  } catch (e) {
    return e instanceof GitHubError && (e.status === 403 || e.status === 404)
      ? `dispatching ${c.workflow} needs Actions write access on ${c.tracker}` : String(e);
  }
}

/**
 * Mark the issue for a retry after a failed dispatch, and say so if even
 * that fails. `body` is the body as this attempt last wrote it: one edited
 * since (by the operator, say, while the dispatch was pending) is left as
 * it is, unmarked, rather than overwritten with the older text.
 */
async function markFailed(gh: GitHub, path: string, body: string, why: string): Promise<string> {
  const unmarked = `${why}; the issue changed meanwhile, so it was not marked for a retry: check it, and close it to start over`;
  try {
    // No issue-body CAS on GitHub: re-read just before the write, as Send does.
    if (((await gh.send<RawIssue>("GET", path)).body ?? "") !== body) return unmarked;
    await gh.send("PATCH", path, { body: `${withoutMarker(body).replace(/\s*$/, "")}\n\n${dispatchFailedMarker(crypto.randomUUID())}\n` });
    return why;
  } catch (e) {
    return `${why}; marking the issue for a retry failed too (${String(e)}), so close it to start over`;
  }
}

/** Comments read (100 a page) to find the earliest claim; more is refused, not read in part. */
export const MAX_CLAIM_PAGES = 10;

/**
 * Whether `mine` is the earliest comment with its exact text on the issue.
 * GitHub has no compare-and-set on an issue body, so a read-then-write of
 * it can't serialize two tabs or viewers; but ids rise in creation order,
 * and a racer's read after its own post sees every earlier post, so of
 * claims posted with the same text exactly one finds itself first. Anyone
 * may comment on the tracker: a stranger's claim can only refuse a retry.
 */
async function firstClaim(gh: GitHub, c: ReviewDraftConfig, issue: number, mine: { id: number; body: string }): Promise<boolean> {
  const path = `/repos/${c.tracker}/issues/${issue}/comments?per_page=100`;
  for (let page = 1; page <= MAX_CLAIM_PAGES; page++) {
    const comments = await gh.send<RawComment[]>("GET", `${path}&page=${page}`);
    // Oldest first, so the first match is the earliest claim.
    const first = comments.find((cm) => (cm.body ?? "").trim() === mine.body);
    if (first) return first.id === mine.id;
    if (comments.length < 100) break;
  }
  throw new Error(`Could not find this retry's claim in the first ${MAX_CLAIM_PAGES * 100} comments of ${c.tracker}#${issue}; reload`);
}

/**
 * Create the draft issue for an open PR, assigned to the viewer, and
 * dispatch the drafting run on it. Refuses a PR that already has an open
 * draft issue, so a repeated click doesn't pay for a second run, unless
 * that issue's dispatch failed: then it dispatches again on it.
 */
export async function startDraft(gh: GitHub, c: ReviewDraftConfig, input: string): Promise<Started> {
  const ref = parsePrRef(input);
  if (!ref) throw new Error("Give a PR as OWNER/REPO#N or its github.com URL");
  const pr = await gh.send<{ title: string; html_url: string; state: string; head: { sha: string } }>(
    "GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
  if (pr.state !== "open") throw new Error(`${refText(ref)} is not open`);
  const prefix = `Review draft: ${refText(ref)}:`.toLowerCase();
  const dup = (await openDraftIssues(gh, c)).find((i) => !i.pull_request && i.title.toLowerCase().startsWith(prefix));
  if (dup && !dispatchFailed(dup.body)) throw new Error(`${refText(ref)} already has an open draft: ${dup.html_url}`);
  if (dup) {
    const path = `/repos/${c.tracker}/issues/${dup.number}`;
    const attempt = failedAttempt((await gh.send<RawIssue>("GET", path)).body);
    if (!attempt) throw new Error(`${refText(ref)} already has an open draft: ${dup.html_url}`);
    // Only the earliest claim on this failed attempt dispatches; a later one, from another tab or viewer, is refused.
    const text = `<!-- review-draft: retry claim attempt=${attempt} -->`;
    const claim = await gh.send<{ id: number }>("POST", `${path}/comments`, { body: text });
    if (!await firstClaim(gh, c, dup.number, { id: claim.id, body: text })) {
      throw new Error(`${refText(ref)}'s draft is already being retried; if no run starts, close it to start over: ${dup.html_url}`);
    }
    // Clear the marker, keeping the rest of the body as it is now, so the panel stops flagging a failed run.
    const now = (await gh.send<RawIssue>("GET", path)).body ?? "";
    const body = withoutMarker(now);
    if (body !== now) await gh.send("PATCH", path, { body });
    const why = await dispatchDraft(gh, c, ref, pr.html_url, pr.head.sha, dup.number);
    return { issue: dup.html_url, retried: true, ...(why ? { dispatchError: await markFailed(gh, path, body, why) } : {}) };
  }
  const viewer = await gh.send<{ login: string }>("GET", "/user");
  const body = [
    `Review draft for ${pr.html_url}, at \`${pr.head.sha}\`. The drafting run adds the draft as a comment; edit it there before sending.`,
    "",
    `- [ ] ${c.sendBox}`,
    "",
  ].join("\n");
  const issue = await gh.send<{ number: number; html_url: string }>("POST", `/repos/${c.tracker}/issues`,
    { title: draftTitle(ref, pr.title), body, labels: [c.label], assignees: [viewer.login] });
  // The check above is no claim: two tabs or viewers may both have passed it. Issue numbers rise in
  // creation order, as comment ids do (firstClaim), so the PR's oldest open draft issue is the one
  // that dispatches; a later one closes itself instead.
  const older = (await openDraftIssues(gh, c)).find((i) => !i.pull_request && i.number < issue.number && i.title.toLowerCase().startsWith(prefix));
  if (older) {
    await gh.send("PATCH", `/repos/${c.tracker}/issues/${issue.number}`, { state: "closed", state_reason: "not_planned" });
    throw new Error(`${refText(ref)} already has an open draft: ${older.html_url}`);
  }
  const why = await dispatchDraft(gh, c, ref, pr.html_url, pr.head.sha, issue.number);
  // The issue exists either way; say so rather than lose it behind the error.
  return { issue: issue.html_url, ...(why ? { dispatchError: await markFailed(gh, `/repos/${c.tracker}/issues/${issue.number}`, body, why) } : {}) };
}
