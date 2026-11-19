// Concrete operator asks, each once: unanswered questions, explicit
// current-head review requests and approved forks to promote. The inbox
// shows the pass's published list instead (holds.ts); these rows serve
// moving on after an action, and the state export.

import { askProblem, blockedBy, isQuestion, type Item } from "./board.ts";
import { effectivePriority, type Entry, onBot, priorityRank } from "./queue.ts";
import type { Stop } from "./advance.ts";
import { type Decision, decisionLabel } from "./triage.ts";
import { isBot } from "./authors.ts";
import { isForgeDraft, promotionAction, refKey } from "./forge.ts";

/** The one thing a row asks of him. */
export type NeedAction = "answer" | "review" | "write" | "promote";

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
  /** The board Priority of what a row blocks: its item's, else its parent's, up the chain. */
  const focusPriority = (n: Need): string | undefined => {
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
    return priority;
  };
  const focusRank = (n: Need): number => priorityRank(focusPriority(n));
  // A question on an item that isn't on the board itself takes the Priority of the item it blocks.
  for (const n of [...out, ...done]) {
    const priority = n.priority ?? focusPriority(n);
    if (priority) n.priority = priority;
  }
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
