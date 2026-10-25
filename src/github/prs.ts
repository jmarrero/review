// What the app reads and writes for forge PRs: the list waiting on him,
// their verdicts, one PR's details for the review pane, and the review
// itself. Views call these; tests drive them with a scripted fetch.

import { type GitHub, GitHubError, RateLimited } from "./api.ts";
import type { RunRef } from "./asks.ts";
import type { IssueRef } from "./board.ts";
import { findGuide, type GuideState } from "./guide.ts";
import { BOT_LOGIN, FETCH_CONCURRENCY, OPERATOR, PAGE_SIZE } from "./config.ts";
import {
  botRepliedSince,
  classifyPr,
  dcoFailing,
  failedRequired,
  isOwnOwner,
  type PrFacts,
  type PrWait,
  type RawAppCheckRun,
  type RawPrCommit,
  type RawTimed,
  unsignedCommits,
} from "./waiting.ts";
import {
  type CiCheck,
  ciChecks,
  type ForgePr,
  isForgeDraft,
  parseSearchPr,
  promotionAction,
  type RawIssueComment,
  type RawReview,
  type RawSearchIssue,
  type RawStatus,
  refKey,
  type ReviewRequest,
  reviewVerdict,
  type Verdict,
} from "./forge.ts";

/**
 * The bot's open PRs anywhere that request his review, from him
 * directly (review-requested: would also match teams he is on, such as
 * CODEOWNERS' automatic requests). GitHub drops the request once he
 * reviews. Drafts too: the bot asks for reviews on forge drafts (see
 * loadOtherPrs); a request on a draft elsewhere is read but not an ask
 * (needs' actionOf).
 */
export const REQUESTED_QUERY = `is:pr is:open author:${BOT_LOGIN} user-review-requested:${OPERATOR}`;
/**
 * All the bot's open PRs: upstream, in its own repositories, and the
 * forge's, drafts in its forks and ready ones in its own (non-fork)
 * repositories. One search serves both lists, the forge's drafts and the
 * others: search has a budget of its own, 30 requests a minute.
 */
export const OTHER_QUERY = `is:pr is:open author:${BOT_LOGIN}`;
/** Search pages to read at most (100 each). */
const MAX_SEARCH_PAGES = 5;

/** The bot's open PRs, oldest first (OTHER_QUERY). Search has no ETags, so poll it sparingly. */
export function searchBotPrs(gh: GitHub): Promise<ForgePr[]> {
  return searchPrs(gh, OTHER_QUERY);
}

/** The bot's open draft PRs on the forge, oldest first: from `all`, searchBotPrs' answer, else searched. */
export async function loadForgePrs(gh: GitHub, all?: readonly ForgePr[]): Promise<ForgePr[]> {
  return (all ?? (await searchBotPrs(gh))).filter((pr) => pr.author === BOT_LOGIN && isForgeDraft(pr));
}

/** A PR other than a forge draft (unless it requests his review), and whether his review is requested on it. */
export interface OtherPr {
  pr: ForgePr;
  requested: boolean;
}

/**
 * The bot's open PRs other than the forge's drafts (which loadForgePrs
 * lists), oldest first, each marked with whether it requests his
 * review: from `searched`, searchBotPrs' answer (else searched), and a
 * search for the requests. A forge draft requesting his review is here
 * too, so loadWaiting reads its request (and its age, and whether he
 * reviewed the head) like any other's: the bot asks on drafts. Only
 * those the request search finds, so the extra reads per poll are
 * bounded by his open requests, not by the forge's drafts.
 */
export async function loadOtherPrs(gh: GitHub, searched?: readonly ForgePr[]): Promise<OtherPr[]> {
  const all = searched ?? (await searchBotPrs(gh));
  const requested = await searchPrs(gh, REQUESTED_QUERY);
  const want = new Set(requested.map((p) => refKey(p.ref).toLowerCase()));
  const merged = new Map([...all, ...requested].filter((pr) => pr.author === BOT_LOGIN).map((pr) => [refKey(pr.ref).toLowerCase(), pr]));
  return [...merged.values()].map((pr) => ({ pr, requested: want.has(refKey(pr.ref).toLowerCase()) })).filter((o) => o.requested || !isForgeDraft(o.pr));
}

/** Every PR a search finds, oldest first. */
async function searchPrs(gh: GitHub, query: string): Promise<ForgePr[]> {
  const out: ForgePr[] = [];
  const q = encodeURIComponent(query);
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const r = await gh.get<{ items?: RawSearchIssue[]; total_count?: number }>(
      `/search/issues?q=${q}&sort=created&order=asc&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const items = r.data.items ?? [];
    for (const raw of items) {
      const pr = parseSearchPr(raw);
      if (pr) out.push(pr);
    }
    if (items.length < PAGE_SIZE || out.length >= (r.data.total_count ?? 0)) break;
  }
  return out;
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface RawPull {
  requested_reviewers?: { login?: string }[];
  number: number;
  html_url: string;
  title?: string;
  body?: string | null;
  draft?: boolean;
  state?: string;
  merged_at?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  head: { sha: string; ref?: string; repo?: { full_name?: string } | null };
  base: { sha?: string; ref?: string; repo?: { full_name?: string; private?: boolean; parent?: { full_name?: string } } };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

export interface VerdictEntry {
  /** The PR's updated_at when this was read; a newer one means re-read. */
  updatedAt: string;
  head: string;
  verdict: Verdict;
  /** The bot commented after his latest decision (see botRepliedSince). */
  botReplied?: boolean;
}

/**
 * Read the verdicts of PRs whose updated_at moved since `known` (a push
 * or a review both move it). Heads come from one open-PR list per
 * repository, conditionally; reviews from each changed PR.
 */
export async function refreshVerdicts(
  gh: GitHub,
  prs: readonly ForgePr[],
  known: ReadonlyMap<string, VerdictEntry>,
): Promise<Map<string, VerdictEntry>> {
  const stale = prs.filter((p) => known.get(refKey(p.ref))?.updatedAt !== p.updatedAt);
  const out = new Map<string, VerdictEntry>();
  for (const p of prs) {
    const k = known.get(refKey(p.ref));
    if (k && k.updatedAt === p.updatedAt) out.set(refKey(p.ref), k);
  }
  if (stale.length === 0) return out;
  const repos = [...new Set(stale.map((p) => `${p.ref.owner}/${p.ref.repo}`))];
  const heads = new Map<string, string>();
  await mapLimit(repos, FETCH_CONCURRENCY, async (repo) => {
    const r = await gh.getAll<RawPull>(`/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}`);
    for (const pull of r.data) heads.set(`${repo}#${pull.number}`, pull.head.sha);
  });
  await mapLimit(stale, FETCH_CONCURRENCY, async (p) => {
    const key = refKey(p.ref);
    const head = heads.get(key);
    // Not open any more (the search lags): nothing to decide.
    if (!head) {
      out.set(key, { updatedAt: p.updatedAt, head: "", verdict: { state: "none" } });
      return;
    }
    out.set(key, { updatedAt: p.updatedAt, head, ...(await readVerdict(gh, p.ref, head)) });
  });
  return out;
}

/** His verdict on a PR at `head`, and whether the bot replied since he asked for changes. */
async function readVerdict(gh: GitHub, ref: IssueRef, head: string): Promise<{ verdict: Verdict; botReplied: boolean; reviewedCurrentHead?: boolean }> {
  const { reviews, comments } = await readDecisions(gh, ref);
  const verdict = reviewVerdict(reviews, head, OPERATOR, comments);
  const reviewed = reviews.some((r) => r.user?.login === OPERATOR && r.commit_id === head && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(r.state ?? ""));
  const current = reviewed ? { reviewedCurrentHead: true } : {};
  if (verdict.state !== "changes-requested") return { verdict, botReplied: false, ...current };
  // Replies to his line comments are review comments; read them only when they matter.
  const replies = await gh.getAll<RawTimed>(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=${PAGE_SIZE}`);
  return { verdict, botReplied: botRepliedSince(verdict.at, [...comments, ...replies.data]), ...current };
}

/** His reviews and conversation comments on a PR: what bot-pr decides by. */
async function readDecisions(gh: GitHub, ref: IssueRef): Promise<{ reviews: RawReview[]; comments: RawIssueComment[] }> {
  const repo = `/repos/${ref.owner}/${ref.repo}`;
  const [reviews, comments] = await Promise.all([
    gh.getAll<RawReview>(`${repo}/pulls/${ref.number}/reviews?per_page=${PAGE_SIZE}`),
    gh.getAll<RawIssueComment>(`${repo}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`),
  ]);
  return { reviews: reviews.data, comments: comments.data };
}

/**
 * The required status checks of a branch, from its rulesets (readable
 * without admin rights). Classic branch protection isn't readable, so a
 * repository using only that never lists a PR for a rerun.
 */
async function requiredChecks(gh: GitHub, repo: string, branch: string): Promise<string[]> {
  const r = await gh.get<{ type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[]>(
    `/repos/${repo}/rules/branches/${branch.split("/").map(encodeURIComponent).join("/")}?per_page=${PAGE_SIZE}`,
  );
  return r.data.filter((x) => x.type === "required_status_checks").flatMap((x) => (x.parameters?.required_status_checks ?? []).flatMap((c) => (c.context ? [c.context] : [])));
}

/** Pages of a head's check runs to read at most (a big CI matrix runs past one). */
const MAX_CHECK_PAGES = 3;

/** The latest check runs on a commit, every page up to MAX_CHECK_PAGES. */
async function headCheckRuns(gh: GitHub, repo: string, sha: string): Promise<RawAppCheckRun[]> {
  const out: RawAppCheckRun[] = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const r = await gh.get<{ total_count?: number; check_runs?: RawAppCheckRun[] }>(
      `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const runs = r.data.check_runs ?? [];
    out.push(...runs);
    if (runs.length < PAGE_SIZE || out.length >= (r.data.total_count ?? 0)) break;
  }
  return out;
}

/** A PR other than a forge draft the queue lists, and where it stands. */
export interface WaitingPr {
  verdict?: Verdict;
  pr: ForgePr;
  head: string;
  wait: PrWait;
}

/**
 * What loadWaiting read of a PR that moves its updated_at when it
 * changes: the PR, his decisions, and once read, the head's unsigned
 * commits and when he was asked. Reused while the search's updated_at
 * stands (see loadWaiting); by refKey.
 */
export interface WaitingRead {
  /** The search's updated_at when read. */
  updatedAt: string;
  /** When read, in epoch ms. */
  at: number;
  pull: RawPull & { mergeable_state?: string };
  decision: { verdict: Verdict; botReplied: boolean; reviewedCurrentHead?: boolean };
  unsigned?: string[];
  /** Null when the timeline names no request of his. */
  askedAt?: string | null;
}

/**
 * Re-read a PR's own reads at least this often whatever its updated_at
 * says: GitHub recomputes mergeable_state (a conflict after the base
 * moves) without touching it, so this bounds how long one goes unseen.
 */
const WAITING_REUSE_MS = 10 * 60_000;

/**
 * Read what decides whose turn each PR other than a forge draft is (see
 * classifyPr), and keep those that are listed. Upstream that takes the
 * head's check runs, the base's rules and, only when DCO fails, the
 * commits. Check runs move without the PR's updated_at, so they and the
 * rules are re-read each time; the PR's own reads come from `known`
 * while the search's updated_at for it is unchanged (a push, a review, a
 * comment or a review request all move it), since even conditional
 * reads cost a request each across dozens of PRs every poll. A PR that
 * can't be read is left out, reported in `errors` and named in `failed`;
 * `reads` holds what to pass as `known` next time.
 */
export async function loadWaiting(
  gh: GitHub,
  others: readonly OtherPr[],
  known: ReadonlyMap<string, WaitingRead> = new Map(),
  now = Date.now(),
): Promise<{ prs: WaitingPr[]; errors: string[]; failed: Set<string>; reads: Map<string, WaitingRead> }> {
  const rules = new Map<string, Promise<string[]>>();
  const errors: string[] = [];
  const failed = new Set<string>();
  const reads = new Map<string, WaitingRead>();
  const read = await mapLimit(others, FETCH_CONCURRENCY, async ({ pr, requested }): Promise<WaitingPr | undefined> => {
    try {
      const { ref } = pr;
      const repo = `${ref.owner}/${ref.repo}`;
      const k = known.get(refKey(ref));
      // GitHub answers "unknown" until it has computed mergeability: ask again.
      const reuse = k && pr.updatedAt && k.updatedAt === pr.updatedAt && now - k.at < WAITING_REUSE_MS && k.pull.mergeable_state !== "unknown";
      let own: WaitingRead;
      if (reuse) own = { ...k };
      else {
        const pull = (await gh.get<RawPull & { mergeable_state?: string }>(pullPath(ref))).data;
        const open = pull.state === "open" && !pull.merged_at;
        own = { updatedAt: pr.updatedAt, at: now, pull, decision: open ? await readVerdict(gh, ref, pull.head.sha) : { verdict: { state: "none" }, botReplied: false } };
      }
      // Stored now, so the reads below that fill it in are kept too.
      reads.set(refKey(ref), own);
      const { pull } = own;
      if (pull.state !== "open" || pull.merged_at) return undefined;
      const head = pull.head.sha;
      const { verdict, botReplied, reviewedCurrentHead } = own.decision;
      const facts: PrFacts = {
        owner: ref.owner,
        requested: pull.requested_reviewers === undefined ? requested : pull.requested_reviewers.some((r) => r.login?.toLowerCase() === OPERATOR.toLowerCase()),
        verdict,
        botReplied,
        conflicting: pull.mergeable_state === "dirty",
        dcoFailing: false,
        unsigned: [],
        failedRequired: [],
      };
      if (pr.author === BOT_LOGIN && !isOwnOwner(ref.owner)) {
        const base = pull.base.ref ?? "";
        const key = `${repo}:${base}`;
        // Rules this token can't read mean none; any other failure fails
        // the PR's read, so it keeps its last standing instead of losing a rerun.
        if (!rules.has(key)) rules.set(key, requiredChecks(gh, repo, base).catch((e: unknown) => (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !(e instanceof RateLimited) ? [] : Promise.reject(e))));
        const [required, runs] = await Promise.all([
          rules.get(key) as Promise<string[]>,
          headCheckRuns(gh, repo, head),
        ]);
        facts.dcoFailing = dcoFailing(runs, required);
        // A check's details can link a run anywhere; only this repo's can be rerun from here.
        const here = (run: RunRef) => run.owner.toLowerCase() === ref.owner.toLowerCase() && run.repo.toLowerCase() === ref.repo.toLowerCase();
        facts.failedRequired = failedRequired(runs, required).map(({ run, ...c }) => (run && here(run) ? { ...c, run } : c));
        if (facts.dcoFailing) {
          // The commits move only with the head, so with the PR's own reads.
          own.unsigned ??= unsignedCommits((await gh.getAll<RawPrCommit>(`${pullPath(ref)}/commits?per_page=${PAGE_SIZE}`, 3)).data);
          facts.unsigned = own.unsigned;
        }
      }
      const freshPr = { ...pr, title: pull.title ?? pr.title, draft: pull.draft === true, body: pull.body ?? "" };
      const wait: PrWait | undefined = classifyPr(facts) ?? (promotionAction(freshPr, verdict) ? { reasons: [], onBot: false } : undefined);
      if (wait) {
        if (reviewedCurrentHead) wait.reviewedCurrentHead = true;
        if (facts.requested && own.askedAt === undefined) {
          const events = await gh.getAll<{ event?: string; created_at?: string; requested_reviewer?: { login?: string } }>(`/repos/${repo}/issues/${ref.number}/timeline?per_page=${PAGE_SIZE}`).catch(() => undefined);
          // Only the age shown: a failed read isn't worth a request every poll, so it waits for the PR's next re-read like the rest.
          own.askedAt = events?.data.findLast((e) => e.event === "review_requested" && e.requested_reviewer?.login === OPERATOR)?.created_at ?? null;
        }
        if (facts.requested && own.askedAt) wait.askedAt = own.askedAt;
      }
      return wait ? { pr: freshPr, head, wait, verdict } : undefined;
    } catch (e) {
      errors.push(`${refKey(pr.ref)}: ${e instanceof Error ? e.message : String(e)}`);
      failed.add(refKey(pr.ref));
      return undefined;
    }
  });
  return { prs: read.filter((w): w is WaitingPr => w !== undefined), errors, failed, reads };
}

export interface Commit {
  sha: string;
  /** Its first parent: the base of its own diff. */
  parent?: string;
  url: string;
  message: string;
  author: string;
  date?: string;
}

export interface FileDiff {
  filename: string;
  previous?: string;
  status: string;
  additions: number;
  deletions: number;
  /** The file's blob at the diff's end (for a removed file, GitHub's placeholder). */
  sha?: string;
  /** Absent when GitHub omits it (binary, or too large). */
  patch?: string;
  url?: string;
}

export interface PrDetail {
  ref: IssueRef;
  url: string;
  /** The PR's updated_at when read; the search's moving past it means stale. */
  updatedAt: string;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  head: string;
  /** The base commit the PR's diff starts from, as GitHub last computed it. */
  baseSha?: string;
  headRef?: string;
  /** The repository the head branch is in, `owner/repo`. */
  headRepo?: string;
  baseRef?: string;
  /** The fork's parent repository, `owner/repo`. */
  parent?: string;
  isPrivate?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The PR's total; `commits` holds at most 250 (the API's limit). */
  commitCount: number;
  commits: Commit[];
  files: FileDiff[];
  checks: CiCheck[];
  verdict: Verdict;
  /** The bot's review guide for this PR, if it posted one. */
  guide: GuideState;
  /**
   * False when the commit list doesn't end at the head: right after a
   * push GitHub can serve the old commits and diff with the new head, and
   * approving then would approve code he didn't see.
   */
  consistent: boolean;
  /** Problems reading optional parts, shown but not fatal. */
  warnings: string[];
}

interface RawCommit {
  sha: string;
  parents?: { sha: string }[];
  html_url: string;
  commit: { message?: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}

interface RawFile {
  filename: string;
  sha?: string | null;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  blob_url?: string;
}

/** Pages of files to read at most (the API stops at 3000 files). */
export const MAX_FILE_PAGES = 30;
/** Commits the API lists for a PR at most. */
const MAX_LISTED_COMMITS = 250;

export function pullPath(ref: IssueRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

function fileDiff(f: RawFile): FileDiff {
  const out: FileDiff = { filename: f.filename, status: f.status ?? "modified", additions: f.additions ?? 0, deletions: f.deletions ?? 0 };
  if (f.previous_filename) out.previous = f.previous_filename;
  if (f.sha) out.sha = f.sha;
  if (f.patch !== undefined) out.patch = f.patch;
  if (f.blob_url) out.url = f.blob_url;
  return out;
}

/** Everything the review pane shows about one PR. */
export async function loadPrDetail(gh: GitHub, ref: IssueRef): Promise<PrDetail> {
  const base = pullPath(ref);
  const pull = (await gh.get<RawPull>(base)).data;
  const head = pull.head.sha;
  const repo = `/repos/${ref.owner}/${ref.repo}`;
  const warnings: string[] = [];
  const optional = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      warnings.push(`Couldn't read ${what}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const [commits, files, runs, status, decisions, repoInfo] = await Promise.all([
    gh.getAll<RawCommit>(`${base}/commits?per_page=${PAGE_SIZE}`, 3).then((r) => r.data),
    gh.getAll<RawFile>(`${base}/files?per_page=${PAGE_SIZE}`, MAX_FILE_PAGES).then((r) => r.data),
    // The same read as the queue's, so the badge here agrees with the row's: a rerun's superseded attempts left out, a big matrix past one page.
    optional("check runs", headCheckRuns(gh, `${ref.owner}/${ref.repo}`, head), []),
    optional("commit statuses", gh.get<{ statuses?: RawStatus[] }>(`${repo}/commits/${head}/status`).then((r) => r.data.statuses ?? []), []),
    readDecisions(gh, ref),
    optional("the repository", gh.get<{ private?: boolean; parent?: { full_name?: string } }>(repo).then((r) => r.data), {}),
  ]);
  const commitCount = pull.commits ?? commits.length;
  // Past the API's listing limit the last commit listed isn't the head,
  // so there is nothing to check; below it, a stale list (shorter or not)
  // ends elsewhere.
  const consistent = commitCount > MAX_LISTED_COMMITS || commits.at(-1)?.sha === head;
  if (!consistent) warnings.push("GitHub is still updating this PR after a push: the commits and diff may not be the head's yet. Reload (r) before approving.");
  const detail: PrDetail = {
    ref,
    url: pull.html_url,
    updatedAt: pull.updated_at ?? "",
    title: pull.title ?? "(no title)",
    body: pull.body ?? "",
    author: pull.user?.login ?? "ghost",
    state: pull.merged_at ? "merged" : (pull.state ?? "unknown"),
    draft: pull.draft === true,
    head,
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? files.length,
    commitCount,
    commits: commits.map((c) => {
      const out: Commit = { sha: c.sha, url: c.html_url, message: c.commit.message ?? "", author: c.author?.login ?? c.commit.author?.name ?? "unknown" };
      if (c.parents?.[0]?.sha) out.parent = c.parents[0].sha;
      if (c.commit.author?.date) out.date = c.commit.author.date;
      return out;
    }),
    files: files.map(fileDiff),
    checks: ciChecks(runs, status),
    verdict: reviewVerdict(decisions.reviews, head, OPERATOR, decisions.comments),
    guide: findGuide(decisions.reviews, ref, head),
    consistent,
    warnings,
  };
  if (pull.base.sha) detail.baseSha = pull.base.sha;
  if (pull.head.ref) detail.headRef = pull.head.ref;
  if (pull.head.repo?.full_name) detail.headRepo = pull.head.repo.full_name;
  if (pull.base.ref) detail.baseRef = pull.base.ref;
  if (repoInfo.parent?.full_name) detail.parent = repoInfo.parent.full_name;
  if (typeof repoInfo.private === "boolean") detail.isPrivate = repoInfo.private;
  return detail;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** Files a compare lists at most; past it, the view says so. */
export const MAX_COMPARE_FILES = 300;

/**
 * The files changed between two commits of the PR (`base` an ancestor of
 * `to`), for viewing one commit or a range of them.
 */
export async function loadRangeFiles(gh: GitHub, ref: IssueRef, base: string, to: string): Promise<FileDiff[]> {
  if (!SHA_RE.test(base) || !SHA_RE.test(to)) throw new Error(`not a commit range: ${base}...${to}`);
  const r = await gh.get<{ files?: RawFile[] }>(`/repos/${ref.owner}/${ref.repo}/compare/${base}...${to}?per_page=1`);
  return (r.data.files ?? []).map(fileDiff);
}

/** Files larger than this aren't fetched for context. */
export const MAX_CONTEXT_FILE_BYTES = 1_000_000;

/** A file's lines at a commit, for expanding the unchanged context around the diff. */
export async function loadFileLines(gh: GitHub, ref: IssueRef, path: string, sha: string): Promise<string[]> {
  if (!SHA_RE.test(sha)) throw new Error(`not a commit id: ${sha}`);
  // Git has no such path components; in a URL they would climb the API path.
  if (path.split("/").some((p) => p === "" || p === "." || p === "..")) throw new Error(`not a repository path: ${path}`);
  const enc = path.split("/").map(encodeURIComponent).join("/");
  const r = await gh.get<{ type?: string; encoding?: string; content?: string; size?: number }>(`/repos/${ref.owner}/${ref.repo}/contents/${enc}?ref=${sha}`);
  const f = r.data;
  if (f.type !== "file") throw new Error(`${path} is not a file at ${sha.slice(0, 10)}`);
  if ((f.size ?? 0) > MAX_CONTEXT_FILE_BYTES || f.encoding !== "base64" || f.content === undefined) {
    throw new Error(`${path} is too large to show its context here`);
  }
  const bin = atob(f.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  const text = new TextDecoder("utf-8").decode(bytes).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Submit his reviews of the head he was shown (the last request; any
 * before it carry line comments on earlier commits). The PR is re-read
 * first, unconditionally, and a moved head refuses: an approval must
 * name the commit he read (bot-pr's promote only honours it for the
 * head), and a change request on stale code confuses the bot.
 */
export async function submitReview(
  gh: GitHub,
  ref: IssueRef,
  review: ReviewRequest | readonly ReviewRequest[],
  onSent: (index: number) => void = () => {},
): Promise<string> {
  const reviews = Array.isArray(review) ? (review as readonly ReviewRequest[]) : [review as ReviewRequest];
  const main = reviews.at(-1);
  if (!main) throw new Error("nothing to send");
  const fresh = await gh.send<RawPull>("GET", pullPath(ref));
  if (fresh.state !== "open") throw new Error(`the PR is ${fresh.merged_at ? "merged" : (fresh.state ?? "not open")}; nothing was sent`);
  if (fresh.head.sha !== main.commit_id) {
    throw new Error(
      `the PR's head moved to ${fresh.head.sha.slice(0, 12)} since you opened it; nothing was sent. Reload (r) to review the new commits.`,
    );
  }
  let url = fresh.html_url;
  for (const [i, r] of reviews.entries()) {
    try {
      url = (await gh.send<{ html_url?: string }>("POST", `${pullPath(ref)}/reviews`, r)).html_url ?? url;
    } catch (e) {
      const sent = i === 0 ? "nothing was sent" : `the comments on ${i} earlier commit${i > 1 ? "s" : ""} went out, the rest didn't`;
      throw new Error(`${e instanceof Error ? e.message : String(e)} (${sent})`);
    }
    onSent(i);
  }
  return url;
}
