// Review and chore asks: the tracker issues, besides questions, through
// which the bot asks jmarrero to do something. Pure functions over issue
// bodies and REST JSON, so tests feed them synthetic payloads.
//
// Every ask is an open issue in the tracker, assigned to him, with one
// of the labels `question`, `review` or `chore`, and a first line naming
// what it blocks (see answer.ts). After that, one ask per line:
//
//     Ask: Re-approve bootc#2500 at its new head
//     Review: `https://github.com/bootc-dev/bootc/pull/2500` at <40-hex sha>
//
//     Ask: Rerun the composefs UKI legs that lost their runner
//     Rerun: `https://github.com/bootc-dev/bootc/actions/runs/123456`
//
// A review names each PR to review and the head the bot expects; a chore
// may name workflow runs whose failed jobs to rerun. He finishes either
// with a comment on the issue, which the app posts for him after it
// reviews or reruns. A `Review:` or `Rerun:` line that doesn't parse
// exactly unlocks nothing: the issue then offers only a comment box.

import { parseBlocks, type Question, unfencedLines } from "../answer.ts";
import { askKind, askProblem, type IssueRef, type Item, questionOf } from "./board.ts";
import { DRAFT, NEEDS_HUMAN } from "./config.ts";
import type { ReviewAction } from "./forge.ts";

/** A PR the bot asks him to review, at the head it expects. */
export interface ReviewTarget {
  url: string;
  ref: IssueRef;
  /** The 40-hex head the bot asked about. */
  head: string;
}

/** A workflow run, by the parts of its github.com URL. */
export interface RunRef {
  url: string;
  owner: string;
  repo: string;
  /** Decimal run id. */
  id: string;
}

/** A review or chore issue's body, as far as the app reads it. */
export interface AskBody {
  /** The URL on the `Blocks:` first line. */
  blocks?: string;
  /** The `Ask:` line, without its prefix. */
  ask?: string;
  reviews: ReviewTarget[];
  reruns: RunRef[];
  /** `Review:` or `Rerun:` lines that didn't parse; any makes the issue comment-only. */
  problems: string[];
}

// GitHub owner and repository names. "." and ".." are refused apart: in
// an API path they would climb out of /repos/{owner}/{repo}.
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const PR_URL_RE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})/pull/([1-9][0-9]{0,9})$`);
const RUN_URL_RE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})/actions/runs/([1-9][0-9]{0,19})$`);
const SHA_RE = /^[0-9a-f]{40}$/;

const ASK_LINE_RE = /^Ask:[ \t]*(.+)$/;
// The URL bare or in a code span (the bot backticks upstream URLs, so
// the mention doesn't land on the upstream timeline).
const REVIEW_RE = /^Review:[ \t]+(`?)(\S+?)\1[ \t]+at[ \t]+(\S+)[ \t]*$/;
const RERUN_RE = /^Rerun:[ \t]+(`?)(\S+?)\1[ \t]*$/;

function dotName(name: string): boolean {
  return name === "." || name === "..";
}

/** A github.com PR URL, strictly: no trailing path, query or fragment. */
export function parsePrUrl(url: string): IssueRef | undefined {
  const m = PR_URL_RE.exec(url);
  if (!m || dotName(m[2] as string)) return undefined;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** A github.com workflow run URL, strictly: not a job, an attempt or anything else under it. */
export function parseRunUrl(url: string): RunRef | undefined {
  const m = RUN_URL_RE.exec(url);
  if (!m || dotName(m[2] as string)) return undefined;
  return { url, owner: m[1] as string, repo: m[2] as string, id: m[3] as string };
}

/** Parse a review or chore issue's body (see the format at the top). */
export function parseAskBody(body: string): AskBody {
  const lines = unfencedLines(body);
  const out: AskBody = { reviews: [], reruns: [], problems: [] };
  const blocks = parseBlocks(lines);
  if (blocks) out.blocks = blocks;
  for (const line of lines) {
    const ask = ASK_LINE_RE.exec(line);
    if (ask) {
      out.ask ??= (ask[1] as string).trim();
      continue;
    }
    if (line.startsWith("Review:")) {
      const m = REVIEW_RE.exec(line);
      const ref = m ? parsePrUrl(m[2] as string) : undefined;
      const head = m?.[3] as string;
      if (!m || !ref || !SHA_RE.test(head)) out.problems.push(`can't read ${JSON.stringify(line)}: expected Review: \`https://github.com/OWNER/REPO/pull/N\` at <40-hex sha>`);
      else out.reviews.push({ url: m[2] as string, ref, head });
    } else if (line.startsWith("Rerun:")) {
      const m = RERUN_RE.exec(line);
      const run = m ? parseRunUrl(m[2] as string) : undefined;
      if (!run) out.problems.push(`can't read ${JSON.stringify(line)}: expected Rerun: \`https://github.com/OWNER/REPO/actions/runs/ID\``);
      else if (!out.reruns.some((r) => r.url === run.url)) out.reruns.push(run);
    }
  }
  return out;
}

/** The subset of GET /repos/{o}/{r}/actions/runs/{id} the app reads. */
export interface RawRun {
  id?: number;
  name?: string | null;
  html_url?: string;
  status?: string | null;
  conclusion?: string | null;
  run_attempt?: number;
  head_sha?: string;
  repository?: { full_name?: string } | null;
}

/** The subset of a job from .../runs/{id}/jobs the app reads. */
export interface RawJob {
  name?: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
}

/** Conclusions of a run, or a job, whose failed jobs GitHub can rerun. */
export const FAILED_CONCLUSIONS: readonly string[] = ["failure", "cancelled", "timed_out", "startup_failure"];

/** The latest attempt's jobs that failed. */
export function failedJobs(jobs: readonly RawJob[]): RawJob[] {
  return jobs.filter((j) => j.status === "completed" && FAILED_CONCLUSIONS.includes(j.conclusion ?? ""));
}

/**
 * Why this run's failed jobs can't be rerun, or undefined if they can:
 * the run read back must be the one the URL names, in the repository it
 * names, completed, failed, with at least one failed job in its latest
 * attempt. A running or successful run is never rerun.
 */
export function rerunProblem(run: RunRef, raw: RawRun, jobs: readonly RawJob[]): string | undefined {
  if (raw.html_url?.toLowerCase() !== run.url.toLowerCase() || String(raw.id ?? "") !== run.id) {
    return `GitHub returned a different run (${raw.html_url ?? "no URL"})`;
  }
  const full = `${run.owner}/${run.repo}`.toLowerCase();
  if (raw.repository?.full_name?.toLowerCase() !== full) return `the run is not in ${run.owner}/${run.repo}`;
  if (raw.status !== "completed") return `the run is ${raw.status ?? "in an unknown state"}, not completed`;
  if (!FAILED_CONCLUSIONS.includes(raw.conclusion ?? "")) return `the run ended ${raw.conclusion ?? "without a conclusion"}; only a failed run's jobs are rerun`;
  if (failedJobs(jobs).length === 0) return "its latest attempt has no failed jobs";
  return undefined;
}

/** What the app comments on the chore after rerunning a run's failed jobs. */
export function rerunComment(run: RunRef): string {
  return `Reran the failed jobs of ${run.url}\n`;
}

/**
 * What the app comments on the review ask after he reviewed its PR, so
 * the bot sees it; undefined for a plain comment review, which settles
 * nothing. It names the head he reviewed, which may not be the one asked
 * about if the PR moved and he confirmed reviewing the new head. The PR
 * and the review's URL go in code spans: bare in a public tracker issue,
 * either would put a "mentioned this" entry on the upstream PR.
 */
export function reviewComment(verb: ReviewAction, pr: IssueRef, head: string, reviewUrl: string): string | undefined {
  const what = `\`${pr.owner}/${pr.repo}#${pr.number}\` at \`${head}\`: \`${reviewUrl}\``;
  switch (verb) {
    case "approve":
      return `Approved ${what}\n`;
    case "request-changes":
      return `Requested changes on ${what}\n`;
    case "comment":
      return undefined;
  }
}

/** What the item view offers for an item. */
export type ItemAction =
  /** An open question: the answer form. */
  | { kind: "answer"; ref: IssueRef; question: Question }
  /** A review ask naming PRs to review in the app's review pane. */
  | { kind: "review"; ref: IssueRef; body: AskBody }
  /** A chore naming runs whose failed jobs to rerun. */
  | { kind: "rerun"; ref: IssueRef; body: AskBody }
  /** Any other chore, or a review or rerun the app can't read: a comment box. */
  | { kind: "comment"; ref: IssueRef; ask: "review" | "chore"; body: AskBody }
  /** An ask the bot closed, or an item with no operator action. */
  | { kind: "done" }
  /** An ask the app can't act on (not assigned to him, say): why. */
  | { kind: "blocked"; reason: string }
  /** Not an ask, and it has open asks: those are the actions. */
  | { kind: "asks" }
  /** Needs human, but the bot left no open ask for it: a bot bug. */
  | { kind: "bug" }
  /** A Draft item: something to read (a gist), or a forge PR's tracking item. */
  | { kind: "read" };

/**
 * Decide what the item view offers. This is the one place that picks
 * it. `openAsks` is how many open asks are nested under the item in the
 * queue: a Needs human item that isn't an ask needs at least one, or the
 * bot left it without telling him what to do.
 */
export function itemAction(item: Item, openAsks: number): ItemAction {
  const kind = askKind(item);
  if (kind === undefined) {
    if (item.status === DRAFT) return { kind: "read" };
    return openAsks > 0 ? { kind: "asks" } : { kind: item.status === NEEDS_HUMAN ? "bug" : "done" };
  }
  if (item.state === "closed") return { kind: "done" };
  const problem = askProblem(item, kind);
  if (problem !== undefined || !item.ref) return { kind: "blocked", reason: problem ?? "no issue" };
  const ref = item.ref;
  if (kind === "question") return { kind: "answer", ref, question: questionOf(item) };
  const body = parseAskBody(item.body);
  if (body.problems.length === 0) {
    if (kind === "review" && body.reviews.length > 0 && body.reruns.length === 0) return { kind: "review", ref, body };
    if (kind === "chore" && body.reruns.length > 0 && body.reviews.length === 0) return { kind: "rerun", ref, body };
  }
  return { kind: "comment", ref, ask: kind, body };
}

/** Why a review or rerun ask fell back to a comment box, if it did. */
export function commentNote(action: ItemAction & { kind: "comment" }): string | undefined {
  const { body, ask } = action;
  if (body.problems.length) return body.problems.join("; ");
  if (ask === "review" && body.reviews.length === 0) return "it names no PR to review (no Review: line)";
  if (ask === "review" && body.reruns.length) return "a review ask can't also ask for reruns";
  if (ask === "chore" && body.reviews.length) return "a chore can't ask for a review; that's a review ask";
  return undefined;
}

/**
 * The open review ask naming this PR, if one is in `items`: it lets the
 * review pane review a PR outside the bot's own space, and tells the bot
 * when he did. The first one wins.
 */
export function reviewAskFor(items: readonly Item[], pr: IssueRef): { item: Item; ref: IssueRef; body: AskBody; target: ReviewTarget } | undefined {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
  for (const item of items) {
    const action = itemAction(item, 0);
    if (action.kind !== "review") continue;
    const target = action.body.reviews.find((r) => `${r.ref.owner}/${r.ref.repo}#${r.ref.number}`.toLowerCase() === key);
    if (target) return { item, ref: action.ref, body: action.body, target };
  }
  return undefined;
}
