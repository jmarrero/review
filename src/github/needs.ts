// Concrete operator asks, each once: unanswered questions, explicit
// current-head review requests, approved forks to promote and escalations.
// The broader legacy queue is kept in Watching and By priority.

import { askProblem, blockedBy, isQuestion, type Item, NO_PRIORITY, PRIORITY_ORDER, waitingSince } from "./board.ts";
import { effectivePriority, type Entry, onBot, priorityRank } from "./queue.ts";
import type { Stop } from "./advance.ts";
import { type Decision, decisionLabel } from "./triage.ts";
import { isBot } from "./authors.ts";
import { OPERATOR } from "./config.ts";
import { isForgeDraft, promotionAction, refKey } from "./forge.ts";

/** The one thing a row asks of him. */
export type NeedAction = "answer" | "review" | "write" | "promote";

export const ACTION_LABEL: Record<NeedAction, string> = {
  answer: "Answer",
  review: "Review",
  write: "Write text",
  promote: "Promote",
};

export const ACTION_TITLE: Record<NeedAction, string> = {
  answer: "pick an option or write an answer; it is posted as a comment by you",
  review: "review the PR; approving, requesting changes or commenting tells the bot",
  write: "the bot asks for something it can't do itself: say what you did or decided",
  promote: "open the approved fork PR and send /promote to publish it upstream",
};

export interface Need {
  /** The entry's key (`pr:…`, `item:…`), or `decision:<node id>` for a decision with no entry. */
  key: string;
  action: NeedAction;
  title: string;
  priority?: string;
  since?: string;
  /** Where it is, e.g. `owner/repo#12`. */
  where: string;
  /** The app route that opens it. */
  href: string;
  /** The entry, when the queue has one. */
  entry?: Entry;
  /** The entry it is nested under (a PR's or item's ask), for context. */
  parent?: Entry;
  /** The decision it is, when it is one (answering it works the same). */
  decision?: Decision;
  /** An open question he can answer on this page. */
  inPlace: boolean;
  why?: string;
  /** Answered from this page: kept, dimmed, until the page reloads. */
  done?: boolean;
}

/** What an entry that waits on him asks of him; "none" for one that does not wait on him at all. */
function actionOf(e: Entry): NeedAction | "none" {
  if (e.kind === "pr") {
    const promotion = e.pr ? promotionAction(e.pr, e.verdict) : undefined;
    if (promotion) return promotion;
    if (e.verdict?.state === "approved") return "none";
    if (e.verdict?.state === "promoted" && !(e.wait?.askedAt && e.verdict.at && e.wait.askedAt > e.verdict.at)) return "none";
    // A draft upstream isn't ready for review whoever asks; a forge draft is
    // what he reviews to promote, and the bot requests his review on it.
    if (e.pr && (!e.pr.draft || isForgeDraft(e.pr)) && e.wait?.reasons.includes("review-requested") && !e.wait.reviewedCurrentHead && e.verdict?.state !== "changes-requested") return "review";
    return "none";
  }
  const item = e.item;
  if (!item || item.kind === "draft" || item.state !== "open") return "none";
  if (isQuestion(item)) return askProblem(item, "question") === undefined ? "answer" : "none";
  if (item.labels.includes("escalate") && item.assignees.includes(OPERATOR)) return "write";
  // Legacy review/chore asks and inferred board blockers are Watching.
  return "none";
}

function needOf(e: Entry, parent: Entry | undefined): Need | undefined {
  const action = actionOf(e);
  if (action === "none") return undefined;
  const n: Need = { key: e.key, action, title: e.title, where: e.where, href: e.href, entry: e, inPlace: action === "answer" && e.item?.ref !== undefined };
  const why = e.pr ? action === "promote" ? "You approved the current head; send /promote to publish it upstream." : action === "write" ? "You approved the current head; the upstream human-text policy requires your title, description and commit messages." : "Your review is requested for the current, unreviewed head." : e.item?.why;
  if (why) n.why = why;
  if (e.pr && action === "promote") n.href = e.pr.url;
  if (e.item?.labels.includes("escalate") && e.item.url) n.href = e.item.url;
  const priority = effectivePriority(e);
  if (priority) n.priority = priority;
  const since = e.pr ? e.wait?.askedAt : e.since;
  if (since) n.since = since;
  if (parent) n.parent = parent;
  return n;
}

/** The refKey of the issue an entry or decision is, lowercased, for matching the two. */
const issueKey = (item: Item | undefined): string | undefined => (item?.ref ? refKey(item.ref).toLowerCase() : undefined);

export interface NeedsInput {
  board?: readonly Item[] | undefined;
  /** The queue, ranked (buildEntries). */
  entries: readonly Entry[];
  /** The open decisions, in order; undefined until read. */
  decisions?: readonly Decision[] | undefined;
  /** Node ids of decisions he answered and the bot has not acted on. */
  decisionsAnswered?: ReadonlySet<string>;
  /** Keys of rows answered from this page: kept (dimmed) after they stop waiting. */
  answeredHere?: ReadonlySet<string>;
}

/**
 * The rows that wait on him, most urgent first, then those he answered
 * from this page (marked `done`). An item with open asks is not a row:
 * its asks are. A decision that is also a question in the queue is that
 * row, labelled as the decision.
 */
export function buildNeeds(input: NeedsInput): Need[] {
  const out: Need[] = [];
  const done: Need[] = [];
  const board = input.board ?? [];
  const keep = input.answeredHere ?? new Set<string>();
  const push = (e: Entry, parent: Entry | undefined) => {
    // Waiting on the bot, or already answered: not his, unless he answered it from here.
    if (onBot(e)) return;
    if (e.settled) {
      const n = keep.has(e.key) ? needOf({ ...e, settled: false }, parent) : undefined;
      if (n) done.push({ ...n, done: true });
      return;
    }
    const n = needOf(e, parent);
    if (n) out.push(n);
  };
  for (const e of input.entries) {
    push(e, undefined);
    for (const c of e.children ?? []) push(c, e);
  }
  const listed = new Set(input.entries.flatMap((e) => [e, ...(e.children ?? [])]).filter((e) => e.kind !== "pr").map((e) => e.item?.nodeId));
  for (const item of board) {
    const since = waitingSince(item);
    if (!listed.has(item.nodeId) && item.labels.includes("escalate") && item.ref) push({ key: `item:${item.nodeId}`, kind: "item", title: item.title, where: refKey(item.ref), href: `#item/${item.nodeId}`, item, ...(item.priority ? { priority: item.priority } : {}), ...(since ? { since } : {}) }, undefined);
  }
  const questions = new Map(out.concat(done).flatMap((n) => (n.action === "answer" && issueKey(n.entry?.item) ? [[issueKey(n.entry?.item) as string, n] as const] : [])));
  for (const d of input.decisions ?? []) {
    if (askProblem(d.item, "question") !== undefined) continue;
    const hit = questions.get(issueKey(d.item) ?? "");
    if (hit) {
      hit.decision = d;
      continue;
    }
    const key = `decision:${d.item.nodeId}`;
    const answered = input.decisionsAnswered?.has(d.item.nodeId) === true;
    if (answered && !keep.has(key)) continue;
    const n: Need = { key, action: "answer", title: d.title, where: d.item.ref ? refKey(d.item.ref) : decisionLabel(d), href: d.item.ref ? `#item/${d.item.nodeId}` : "#", decision: d, inPlace: d.item.ref !== undefined && isQuestion(d.item) };
    if (d.item.createdAt) n.since = d.item.createdAt;
    const priority = board.find((i) => issueKey(i) === issueKey(d.item))?.priority ?? d.item.priority;
    if (priority) n.priority = priority;
    (answered ? done : out).push(answered ? { ...n, done: true } : n);
  }
  const time = (n: Need) => {
    const t = n.since ? Date.parse(n.since) : Number.NaN;
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const focusRank = (n: Need): number => {
    const ask = n.entry?.item ?? n.decision?.item;
    const item = board.find((i) => issueKey(i) !== undefined && issueKey(i) === issueKey(ask)) ?? ask;
    const parent = item ? blockedBy(item) ?? item.parent : undefined;
    let context = parent ? board.find((i) => i.ref && refKey(i.ref).toLowerCase() === refKey(parent).toLowerCase()) : item;
    const seen = new Set<string>();
    let priority = context?.priority ?? n.parent?.priority ?? n.priority;
    while (context?.parent && !seen.has(context.nodeId)) {
      seen.add(context.nodeId);
      const ref = context.parent;
      context = board.find((i) => i.ref && refKey(i.ref).toLowerCase() === refKey(ref).toLowerCase());
      if (context?.priority) priority = context.priority;
    }
    return priorityRank(priority);
  };
  out.sort((a, b) => Number(b.action === "answer") - Number(a.action === "answer") || (a.action === "answer" && b.action === "answer" ? priorityRank(a.priority) - priorityRank(b.priority) : Number(b.priority === "P0") - Number(a.priority === "P0")) || focusRank(a) - focusRank(b) || time(b) - time(a) || a.key.localeCompare(b.key));
  return [...out, ...done];
}

/** How many of the rows still wait on him. */
export const waitingCount = (needs: readonly Need[]): number => needs.filter((n) => !n.done).length;

/** How many of the rows still waiting on him the bot raised (its PR, issue or decision). */
export const botWaitingCount = (needs: readonly Need[]): number =>
  needs.filter((n) => !n.done && isBot(n.entry?.pr?.author ?? n.entry?.item?.author ?? n.decision?.item.author)).length;

/** The rows as a list to step through: answerable questions are answered in place, the rest open. */
export function needStops(needs: readonly Need[]): Stop[] {
  return needs.map((n) => ({ key: n.key, href: n.inPlace ? "#" : n.href, title: n.decision ? `${decisionLabel(n.decision)}: ${n.title}` : n.title, waiting: !n.done, inPlace: n.inPlace }));
}

/** The filter value that shows every row. */
export const ALL_PRIORITIES = "all";
/** The priorities the filter always offers; any other (P3, none) is offered only while a row has it. */
export const FILTER_PRIORITIES: readonly string[] = ["P0", "P1", "P2"];

/** The priority a row is filtered by: the board's name, or NO_PRIORITY. */
export const needPriority = (n: Need): string => n.priority ?? NO_PRIORITY;

/** True for a value the filter can hold: ALL_PRIORITIES, a board priority, or NO_PRIORITY. */
export function isNeedsPriority(v: unknown): v is string {
  return v === ALL_PRIORITIES || v === NO_PRIORITY || (typeof v === "string" && /^P[0-9]$/.test(v));
}

export interface PriorityChip {
  /** ALL_PRIORITIES, a board priority, or NO_PRIORITY. */
  priority: string;
  /** Rows still waiting on him at it. */
  count: number;
}

/**
 * The filter's chips, in order: all, FILTER_PRIORITIES, then whatever
 * else the rows have (or `selected` names, so that a remembered choice
 * can always be seen and undone). Counts leave out rows already answered.
 */
export function priorityChips(needs: readonly Need[], selected: string = ALL_PRIORITIES): PriorityChip[] {
  const waiting = needs.filter((n) => !n.done);
  const counts = new Map<string, number>();
  for (const n of waiting) counts.set(needPriority(n), (counts.get(needPriority(n)) ?? 0) + 1);
  const extra = [...new Set([...counts.keys(), selected])].filter((p) => p !== ALL_PRIORITIES && !FILTER_PRIORITIES.includes(p));
  const rank = (p: string) => (p === NO_PRIORITY ? PRIORITY_ORDER.length + 1 : priorityRank(p));
  extra.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [{ priority: ALL_PRIORITIES, count: waiting.length }, ...[...FILTER_PRIORITIES, ...extra].map((p) => ({ priority: p, count: counts.get(p) ?? 0 }))];
}

/** Whether the filter shows a row. */
export const matchesPriority = (n: Need, selected: string): boolean => selected === ALL_PRIORITIES || needPriority(n) === selected;

/** The rows the filter shows, in their order. */
export function filterNeeds(needs: readonly Need[], selected: string): Need[] {
  return needs.filter((n) => matchesPriority(n, selected));
}
