// Whose turn a PR is: the bot's PRs other than the forge's drafts
// (upstream, in its own repositories and in the forge's own) are in his
// queue only for what he alone can do on them, read from GitHub itself
// rather than from tracker asks:
//
// - his review is requested (GitHub drops the request once he reviews,
//   so a PR he reviewed leaves the queue until the bot asks again);
// - upstream DCO fails on commits that lack his sign-off: approving the
//   head is what lets `bot-pr signoff` add it;
// - a required check failed, and rerunning it needs a maintainer;
// - the bot pushed or replied since he requested changes.
//
// A PR where he requested changes and the bot hasn't pushed or replied
// since is the bot's turn: listed apart, never as his. Pure functions
// over REST JSON, so tests feed them synthetic payloads.

import { type RawCheckRun, type Verdict } from "./forge.ts";
import { BOT_LOGIN, FORGE_ORG, OPERATOR_SIGNOFF } from "./config.ts";
import { isBot } from "./authors.ts";
import { FAILED_CONCLUSIONS, parseRunUrl, type RunRef } from "./asks.ts";

/** What he is asked to do on a PR. */
export type PrReason =
  /** His review is requested (by the bot or anyone else). */
  | "review-requested"
  /** DCO fails on commits without his sign-off: approving the head lets the bot sign off. */
  | "resign"
  /** A required check failed: rerun its failed jobs. */
  | "rerun"
  /** He requested changes, and the bot pushed or replied since. */
  | "updated";

export const REASON_LABEL: Record<PrReason, string> = {
  "review-requested": "review requested",
  resign: "approve to re-sign (DCO)",
  rerun: "required checks failed: rerun",
  updated: "the bot responded to your change request",
};

/** The label of a PR waiting on the bot. */
export const ON_BOT_LABEL = "changes requested; waiting on the bot";

/** Where a listed PR stands. */
export interface PrWait {
  reviewedCurrentHead?: boolean;
  askedAt?: string;
  /** What he is asked to do; empty when it is the bot's turn. */
  reasons: PrReason[];
  /** He requested changes and the bot hasn't pushed or replied since. */
  onBot: boolean;
  /** For resign: the commits (short ids) lacking his sign-off. */
  unsigned?: string[];
  /** For rerun: the failed required checks, and the workflow runs behind them. */
  failed?: string[];
  runs?: RunRef[];
}

/**
 * What a PR outside the forge's drafts waits on after his review from
 * here, until a re-read says: undefined once nothing does. A review
 * answers a review request and an update since his change request, and
 * an approval is also the sign-off a re-sign asks for; a rerun is left.
 * Requesting changes makes it the bot's turn.
 */
export function afterReview(wait: PrWait, verdict: "approved" | "changes-requested"): PrWait | undefined {
  const answered: readonly PrReason[] = verdict === "approved" ? ["review-requested", "updated", "resign"] : ["review-requested", "updated"];
  const reasons = wait.reasons.filter((r) => !answered.includes(r));
  const botTurn = verdict === "changes-requested" || wait.onBot;
  return reasons.length || botTurn ? { ...wait, reasons, onBot: botTurn } : undefined;
}

/** The owners that are the bot itself: no DCO or maintainer reruns there. */
const OWN_OWNERS: readonly string[] = [BOT_LOGIN, FORGE_ORG];

export function isOwnOwner(owner: string): boolean {
  return OWN_OWNERS.some((o) => o.toLowerCase() === owner.toLowerCase());
}

/** The GitHub Apps whose check runs are DCO checks (as bot-pr's dco-detect.sh). */
export const DCO_APP_SLUGS: readonly string[] = ["dco", "dco-2"];
/** A required check with such a name is a DCO check. */
const DCO_NAME_RE = /(^|[^A-Za-z0-9])dco([^A-Za-z0-9]|$)/i;

const PASSING = ["success", "neutral", "skipped"];

/** A check run with the app that posted it. */
export interface RawAppCheckRun extends RawCheckRun {
  app?: { slug?: string } | null;
}

function failed(r: RawCheckRun): boolean {
  return r.status === "completed" && !PASSING.includes(r.conclusion ?? "");
}

/**
 * Whether DCO fails on the head: a DCO app's check run, or a required
 * check named like one, completed and not passing (the DCO app ends
 * "action_required" when a commit lacks a sign-off). On a PR head only
 * the apps and the branch rules count, never a name a PR's own
 * workflow could report.
 */
export function dcoFailing(runs: readonly RawAppCheckRun[], required: readonly string[]): boolean {
  const requiredDco = required.filter((c) => DCO_NAME_RE.test(c));
  return runs.some((r) => failed(r) && (DCO_APP_SLUGS.includes(r.app?.slug ?? "") || requiredDco.includes(r.name ?? "")));
}

/** The subset of a PR's commit (GET .../pulls/N/commits) the app reads. */
export interface RawPrCommit {
  sha: string;
  commit: {
    message?: string;
    author?: { name?: string; email?: string } | null;
    committer?: { name?: string; email?: string } | null;
  };
}

/** His sign-off line, as `bot-pr promote` writes it. */
export function signoffTrailer(): string {
  return `Signed-off-by: ${OPERATOR_SIGNOFF.name} <${OPERATOR_SIGNOFF.email}>`;
}

/**
 * The commits (short ids) his sign-off doesn't cover, as bot-pr's dco_ok
 * reads it: the trailer, and him as the author or committer (a rebase by
 * the bot keeps the trailer but makes the bot the committer, which DCO
 * fails).
 */
export function unsignedCommits(commits: readonly RawPrCommit[]): string[] {
  const trailer = signoffTrailer();
  const email = OPERATOR_SIGNOFF.email.toLowerCase();
  return commits
    .filter((c) => {
      const lines = (c.commit.message ?? "").replace(/\r/g, "").split("\n").map((l) => l.trimEnd());
      if (!lines.includes(trailer)) return true;
      const who = [c.commit.author?.email, c.commit.committer?.email].map((e) => (e ?? "").toLowerCase());
      return !who.includes(email);
    })
    .map((c) => c.sha.slice(0, 12));
}

/** A failed required check, and the workflow run behind it when it is an Actions job. */
export interface FailedCheck {
  name: string;
  run?: RunRef;
}

/** The workflow run a check run belongs to, from its job URL (`.../actions/runs/ID/job/JOB`). */
export function checkRunWorkflow(r: RawCheckRun): RunRef | undefined {
  for (const u of [r.details_url, r.html_url]) {
    const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+)(?:\/job\/\d+)?(?:[?#].*)?$/.exec(u ?? "");
    const run = m ? parseRunUrl(m[1] as string) : undefined;
    if (run) return run;
  }
  return undefined;
}

/**
 * The required checks that failed on the head in a way a rerun can
 * retry, DCO aside (that one is re-signed, not rerun). A run waiting
 * for a maintainer's approval (action_required) isn't one.
 */
export function failedRequired(runs: readonly RawAppCheckRun[], required: readonly string[]): FailedCheck[] {
  const want = new Set(required.filter((c) => !DCO_NAME_RE.test(c)));
  return runs
    .filter((r) => failed(r) && FAILED_CONCLUSIONS.includes(r.conclusion ?? "") && want.has(r.name ?? "") && !DCO_APP_SLUGS.includes(r.app?.slug ?? ""))
    .map((r) => {
      const run = checkRunWorkflow(r);
      return { name: r.name ?? "(unnamed)", ...(run ? { run } : {}) };
    });
}

/** What the app knows about one of the bot's PRs other than the forge's drafts. */
export interface PrFacts {
  owner: string;
  /** His review is requested (from the search). */
  requested: boolean;
  /** His latest decision, against the current head. */
  verdict: Verdict;
  /** The bot commented after that decision. */
  botReplied: boolean;
  /** Its head conflicts with the base: the bot's to rebase, and CI there is moot. */
  conflicting: boolean;
  dcoFailing: boolean;
  unsigned: string[];
  failedRequired: FailedCheck[];
}

/**
 * Whose turn a PR is, or undefined when it isn't listed at all (nothing
 * for him, and not waiting on the bot for him either).
 *
 * - He requested changes at the head and the bot hasn't replied: the
 *   bot's turn, whatever else holds (a re-request comes after the fix).
 * - Review requested: listed as such.
 * - Upstream, DCO failing on commits lacking his sign-off, and he hasn't
 *   approved the head yet (then the bot signs off): approve to re-sign.
 * - Upstream, a required check failed on a PR that doesn't conflict
 *   (then the bot rebases, and CI reruns anyway): rerun, when at least
 *   one is an Actions run. Drafts too: their red legs block review.
 * - He requested changes and the bot pushed or replied since: his turn.
 */
export function classifyPr(f: PrFacts): PrWait | undefined {
  const v = f.verdict.state;
  if (v === "changes-requested" && !f.botReplied && !f.requested) return { reasons: [], onBot: true };
  const reasons: PrReason[] = [];
  const out: PrWait = { reasons, onBot: false };
  if (f.requested) reasons.push("review-requested");
  const upstream = !isOwnOwner(f.owner);
  if (upstream && f.dcoFailing && f.unsigned.length > 0 && v !== "approved") {
    reasons.push("resign");
    out.unsigned = f.unsigned;
  }
  const runs = uniqueRuns(f.failedRequired);
  if (upstream && !f.conflicting && runs.length > 0) {
    reasons.push("rerun");
    out.failed = f.failedRequired.map((c) => c.name);
    out.runs = runs;
  }
  if (!f.requested && (v === "changes-requested-older" || (v === "changes-requested" && f.botReplied))) reasons.push("updated");
  return reasons.length > 0 ? out : undefined;
}

function uniqueRuns(checks: readonly FailedCheck[]): RunRef[] {
  const out: RunRef[] = [];
  for (const c of checks) if (c.run && !out.some((r) => r.url === c.run?.url)) out.push(c.run);
  return out;
}

/** The subset of a comment (issue or review comment) the app reads. */
export interface RawTimed {
  user?: { login?: string } | null;
  created_at?: string;
}

/** Whether the bot commented after `since` (ISO 8601); never without a date. */
export function botRepliedSince(since: string | undefined, comments: readonly RawTimed[]): boolean {
  if (!since) return false;
  return comments.some((c) => isBot(c.user?.login) && (c.created_at ?? "") > since);
}

/**
 * A forge PR's turn, from its verdict: changes requested at the head is
 * the bot's turn until it replies; after a reply, his again.
 */
export function forgeWait(verdict: Verdict, botReplied: boolean): PrWait | undefined {
  if (verdict.state !== "changes-requested") return undefined;
  return botReplied ? { reasons: ["updated"], onBot: false } : { reasons: [], onBot: true };
}
