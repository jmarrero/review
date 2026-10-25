// What happens after he acts on an entry (approves a PR, answers a
// question, reruns a chore's jobs): its known effect is applied at once,
// over what GitHub last said, until a re-read agrees; and, unless he
// turned it off, the app moves on to the next entry of the list he came
// from. Pure, apart from writingElsewhere's look at the DOM, so tests can
// check which entry comes next and when the app stays put.

import { OPTIMISTIC_TTL_MS } from "./config.ts";
import { applyFilter, type QueueFilter } from "./filter.ts";
import { refKey, type Verdict, type VerdictState } from "./forge.ts";
import type { Item } from "./board.ts";
import type { VerdictEntry, WaitingPr } from "./prs.ts";
import { type Entry, onBot } from "./queue.ts";
import { type Decision, decisionLabel } from "./triage.ts";
import { afterReview } from "./waiting.ts";

/** One row of a list he steps through. */
export interface Stop {
  /** The entry's key, e.g. `pr:owner/repo#n` or `item:PVTI_...`. */
  key: string;
  /** The app route that opens it. */
  href: string;
  title: string;
  /** Whether it still waits on him; settled rows are listed but skipped. */
  waiting: boolean;
  /** It is done on the page it is listed on (an inline answer): moving to it focuses it rather than opening it. */
  inPlace?: boolean;
}

/**
 * The list he opened the current entry from: its route, its rows as they
 * were then (the order to step through), and its rows as they are now.
 */
export interface Origin {
  hash: string;
  stops: Stop[];
  live: () => Stop[];
}

/** The queue's rows under `filter`, children after their parent, as queueView lists them. */
export function queueStops(entries: readonly Entry[], filter: QueueFilter): Stop[] {
  return applyFilter(entries, filter).flatMap((e) =>
    // A PR whose turn is the bot's is listed, but doesn't wait on him.
    [e, ...(e.children ?? [])].map((x) => ({ key: x.key, href: x.href, title: x.title, waiting: x.settled !== true && !onBot(x) })),
  );
}

export interface TriageLinks {
  /** Where the triage view opens an item in the app; undefined when it opens on GitHub (no stop). */
  opens: (item: Item) => string | undefined;
  /** For an item without its own queue row (e.g. folded into its PR's): whether it's done from here. */
  settled: (item: Item) => boolean;
}

/**
 * The triage view's rows that open in the app, in the order it lists
 * them (`order`, see triageOrder), waiting as their queue row says, if
 * they have one.
 */
export function triageStops(order: readonly Item[], entries: readonly Entry[], links: TriageLinks): Stop[] {
  const queued = new Map(entries.flatMap((e) => [e, ...(e.children ?? [])]).map((e) => [e.key, e]));
  return order.flatMap((i) => {
    const href = links.opens(i);
    if (!href) return [];
    const key = `item:${i.nodeId}`;
    const e = queued.get(key);
    return [{ key, href, title: i.title, waiting: e ? e.settled !== true && !onBot(e) : !links.settled(i) }];
  });
}

/** The key of a decision's card, as a stop of the decisions view. */
export const decisionKey = (d: Decision): string => `decision:${d.item.nodeId}`;

/** A decision's name in the "Done: …" line, e.g. "D7: Pick a name". */
export const decisionTitle = (d: Decision): string => `${decisionLabel(d)}: ${d.title}`;

/** The decisions view's cards, in its order; answered ones are settled. All live on `hash`, answered in place. */
export function decisionStops(decisions: readonly Decision[], answered: ReadonlySet<string>, hash: string): Stop[] {
  // One without an issue has no form: nothing to move on to there.
  return decisions.map((d) => ({ key: decisionKey(d), href: hash, title: decisionTitle(d), waiting: !answered.has(d.item.nodeId) && d.item.ref !== undefined }));
}

/**
 * The entry to move to after `current`: the first one after it in the
 * list as he saw it (`from`) that still waits on him now (`now`), so rows
 * that left meanwhile are skipped and the order doesn't shift under him.
 * Past the end of the list, or when `current` wasn't in it, the first
 * entry still waiting in today's order, including rows new since.
 * Undefined when nothing else waits: he is caught up.
 */
export function pickNext(from: readonly Stop[], current: string, now: readonly Stop[]): Stop | undefined {
  const waiting = new Map(now.filter((s) => s.waiting && s.key !== current).map((s) => [s.key, s]));
  const at = from.findIndex((s) => s.key === current);
  for (const s of from.slice(at + 1)) {
    const live = waiting.get(s.key);
    if (live) return live;
  }
  return waiting.values().next().value;
}

export interface AdvanceFacts {
  /** The auto-advance setting. */
  enabled: boolean;
  /** Whether the write succeeded. */
  ok: boolean;
  /** Whether he is still on the view he acted from. */
  stillThere: boolean;
  /** Unsent text of his elsewhere on the page (see writingElsewhere). */
  writing: boolean;
  /** Whether the entry still waits on him after the action's effect, e.g. after a comment-only review. */
  stillWaiting: boolean;
}

export type Advance =
  | { kind: "go"; to: Stop }
  /** Nothing else waits on him. */
  | { kind: "caught-up" }
  | { kind: "stay"; why: "off" | "failed" | "left" | "writing" | "waiting" };

/** Whether, and where, to move on after an action. */
export function decideAdvance(f: AdvanceFacts, next: Stop | undefined): Advance {
  if (!f.ok) return { kind: "stay", why: "failed" };
  if (!f.enabled) return { kind: "stay", why: "off" };
  if (!f.stillThere) return { kind: "stay", why: "left" };
  if (f.stillWaiting) return { kind: "stay", why: "waiting" };
  if (f.writing) return { kind: "stay", why: "writing" };
  return next ? { kind: "go", to: next } : { kind: "caught-up" };
}

/** Marks a text field he typed into, so writingElsewhere can tell his text from a prefilled one. */
export const EDITED_ATTR = "data-edited";

const TEXT_INPUTS = new Set(["text", "search", "email", "url", ""]);

function isTextField(el: Element): el is HTMLTextAreaElement | HTMLInputElement {
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && TEXT_INPUTS.has((el.getAttribute("type") ?? "").toLowerCase());
}

/**
 * Whether he is writing somewhere other than `except` (the form whose
 * text the action just sent): a field under `root` he typed into that
 * still holds text, or a text field he is focused on.
 */
export function writingElsewhere(root: ParentNode, except: Element | null, active: Element | null): boolean {
  const outside = (el: Element) => !except?.contains(el);
  for (const el of root.querySelectorAll(`[${EDITED_ATTR}]`)) {
    if (isTextField(el) && el.value.trim() !== "" && outside(el)) return true;
  }
  if (!active || !(root as Node).contains(active) || !outside(active)) return false;
  return isTextField(active) || (active as HTMLElement).isContentEditable === true;
}

/** A review of his whose effect the queue shows before GitHub's reads do. */
export interface PendingVerdict {
  state: VerdictState;
  /** The head he reviewed. */
  head: string;
  /** When he sent it, in epoch ms. */
  at: number;
}

/**
 * The verdicts to rank the queue by: what GitHub last said (`read`),
 * with his own reviews from this tab (`pending`) over them until a read
 * agrees. Search and the reviews API can lag a write by a while, and
 * without this an approved PR would stay listed, or come back, until
 * they catch up. A pending review is dropped once a read shows the same
 * verdict on the same head, when the head moved (a push makes it moot),
 * or after `ttl`, when GitHub's word wins whatever it is. Returns the
 * pending reviews that still apply.
 */
export function overlayVerdicts(
  read: ReadonlyMap<string, VerdictEntry>,
  pending: ReadonlyMap<string, PendingVerdict>,
  now: number,
  ttl: number = OPTIMISTIC_TTL_MS,
): { verdicts: Map<string, Verdict>; pending: Map<string, PendingVerdict> } {
  const verdicts = new Map([...read].map(([k, v]) => [k, v.verdict]));
  const still = new Map<string, PendingVerdict>();
  for (const [key, p] of pending) {
    const r = read.get(key);
    if (now - p.at > ttl) continue;
    if (r?.head && r.head !== p.head) continue;
    if (r?.head === p.head && r.verdict.state === p.state) continue;
    still.set(key, p);
    verdicts.set(key, { ...r?.verdict, state: p.state });
  }
  return { verdicts, pending: still };
}

/**
 * The same for the PRs listed for what waits on him (a forge draft only
 * when his review is requested on it): his reviews from this tab applied
 * to their waits (see afterReview) and verdicts, so a read that predates
 * a review, or lags it, doesn't list the PR again. The verdict too: the
 * queue takes it over overlayVerdicts' for a forge draft listed here. A review stops applying as
 * overlayVerdicts' do: after `ttl`, once the head moved, or once a read
 * shows its verdict, so what came after it (a bot's reply) shows.
 */
export function overlayWaiting(
  read: readonly WaitingPr[],
  pending: ReadonlyMap<string, PendingVerdict>,
  now: number,
  ttl: number = OPTIMISTIC_TTL_MS,
): WaitingPr[] {
  return read.flatMap((w) => {
    const p = pending.get(refKey(w.pr.ref));
    if (!p || now - p.at > ttl || p.head !== w.head || w.verdict?.state === p.state) return [w];
    if (p.state !== "approved" && p.state !== "changes-requested") return [w];
    const wait = afterReview(w.wait, p.state);
    return wait ? [{ ...w, wait, verdict: { ...w.verdict, state: p.state } }] : [];
  });
}

/**
 * The PRs still "reviewed from here" (refKey → the head he reviewed):
 * a mark is dropped once any read (`heads` gives each source's head for
 * a key) shows the PR at another head, so a push the bot sends him back
 * for reads as his to review again rather than answered, with no TTL:
 * the tab stays open all day and the mark holds as long as the head does.
 */
export function stillReviewed(
  reviewed: ReadonlyMap<string, string>,
  heads: (key: string) => readonly (string | undefined)[],
): Map<string, string> {
  return new Map([...reviewed].filter(([key, head]) => heads(key).every((h) => !h || h === head)));
}
