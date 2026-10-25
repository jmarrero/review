// The one ranked queue: the bot's PRs waiting on him (forge PRs to
// review, and PRs elsewhere with something only he can do: see
// waiting.ts), the bot's asks (questions, reviews and chores) and the
// board items they block, P0 first, then oldest first; PRs waiting on
// the bot come last, apart. Pure, so tests can check the ranking and
// what gets merged or dropped.

import { askKind, blockedBy, isAsk, type Item, NO_PRIORITY, PRIORITY_ORDER, waitingSince } from "./board.ts";
import { DRAFT, FORGE_ORG, NEEDS_HUMAN } from "./config.ts";
import { type ForgePr, parseBotMeta, promotionAction, refKey, type Verdict, waitsOnReviewer } from "./forge.ts";
import { forgeWait, type PrWait } from "./waiting.ts";

/** A PR, an ask of one kind, or another board item. */
export type EntryKind = "pr" | "question" | "review" | "chore" | "item";

/** The kinds that are asks. */
export const ASK_ENTRY_KINDS: readonly EntryKind[] = ["question", "review", "chore"];

export interface Entry {
  /** `pr:owner/repo#n` or `item:PVTI_...`. */
  key: string;
  kind: EntryKind;
  priority?: string;
  /** When it started waiting, as far as the API says (ISO 8601). */
  since?: string;
  title: string;
  /** Where it is, e.g. `owner/repo#12`, or "draft item". */
  where: string;
  /** The app route that opens it. */
  href: string;
  /** The board item: the entry itself, or the one tracking a PR. */
  item?: Item;
  pr?: ForgePr;
  verdict?: Verdict;
  /** A PR's turn beyond its verdict: what he is asked to do, or that it waits on the bot. */
  wait?: PrWait;
  /** The board item is folded into this PR entry: its asks nest here. */
  folded?: boolean;
  /** A question he answered, or the bot closed: waiting on the bot, not him. */
  settled?: boolean;
  /** The asks about this entry's item, nested under it. */
  children?: Entry[];
  /** Needs human, yet no open ask names it: the bot left it without telling him what to do. */
  bug?: boolean;
  /**
   * The priority it ranks and groups by, when an open nested question's
   * outranks its own; `priority` stays what the board says.
   */
  rankPriority?: string;
  /** The item a top-level question blocks, when that isn't in the queue. */
  blocks?: string;
}

/** Group heading for settled questions, listed after everything else. */
export const SETTLED_GROUP = "Answered, waiting on the bot";
/** Group heading for PRs he sent back, listed last: none of them is his. */
export const ON_BOT_GROUP = "Changes requested, waiting on the bot";

/** Whether an entry waits on the bot rather than on him. */
export function onBot(e: Entry): boolean {
  return e.wait?.onBot === true;
}

/** Rank in PRIORITY_ORDER; anything else ranks after it, and none last. */
export function priorityRank(p: string | undefined): number {
  if (p === undefined) return PRIORITY_ORDER.length + 1;
  const i = PRIORITY_ORDER.indexOf(p);
  return i < 0 ? PRIORITY_ORDER.length : i;
}

/** The priority an entry ranks by: its own, or its most urgent open question's. */
export function effectivePriority(e: Entry): string | undefined {
  return e.rankPriority ?? e.priority;
}

/** Settled, then waiting on the bot, last; then priority, then oldest first (no date last), then by key for stability. */
export function rankEntries(entries: readonly Entry[]): Entry[] {
  const time = (e: Entry) => {
    const t = e.since ? Date.parse(e.since) : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const tier = (e: Entry) => (onBot(e) ? 2 : e.settled ? 1 : 0);
  return [...entries].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      priorityRank(effectivePriority(a)) - priorityRank(effectivePriority(b)) ||
      time(a) - time(b) ||
      a.key.localeCompare(b.key),
  );
}

const FORGE_PR_RE = new RegExp(`^https://github\\.com/${FORGE_ORG}/[A-Za-z0-9._-]+/pull/\\d+$`);

export function prHref(pr: ForgePr): string {
  return `#pr/${pr.ref.owner}/${pr.ref.repo}/${pr.ref.number}`;
}

export function itemHref(item: Item): string {
  return `#item/${item.nodeId}`;
}

function itemWhere(item: Item): string {
  if (item.ref) return refKey(item.ref);
  return item.kind === "draft" ? "draft item" : "item";
}

/** What buildEntries takes besides the board and the forge. */
export interface QueueInputs {
  /**
   * The bot's PRs other than the forge's drafts (save those requesting
   * his review, whose standing this then is) that are listed, with
   * where each stands (see classifyPr): those with something for him, and those
   * waiting on the bot.
   */
  others?: readonly { pr: ForgePr; wait: PrWait; verdict?: Verdict }[];
  /** Forge PRs (refKeys) where the bot commented after his latest decision. */
  replied?: ReadonlySet<string>;
  /** Board items outside the queue (In Review) that only rank the PRs in their Branch. */
  linked?: readonly Item[];
}

/**
 * Merge the board and the PRs into one ranked list.
 *
 * - A forge PR is listed while it waits on him (see waitsOnReviewer; an
 *   unknown verdict counts as waiting). One he sent back at its head is
 *   the bot's turn (listed last, apart) until the bot replies
 *   (`replied`), then his again. Its priority is its board item's,
 *   found by the item id in its bot-meta section, else by Branch.
 * - Another PR of the bot's (`others`) is listed as classifyPr found it:
 *   what he is asked to do on it, or waiting on the bot. Its priority is
 *   its board item's, by Branch; In Review items (`linked`) count too.
 * - A Draft board item tracking a forge PR is that PR's entry, never a
 *   second one, and so is a Draft or Needs human item tracking another
 *   PR that waits on him: its asks nest under the PR (a Draft one is
 *   never listed apart, even while the PR waits on the bot: a Draft is
 *   ready for his review, and there is nothing to review then). A board item that
 *   is the listed PR itself is never a second entry either (bot-land
 *   puts the bot's own PRs on the board as themselves), unless it is
 *   Needs human while the PR waits on the bot: that is the bot bug the
 *   item flags. A Draft item whose Branch holds only forge PRs, none of
 *   them open and waiting, is stale (promoted or closed) and dropped.
 * - A board item whose own issue or PR is closed or merged is done,
 *   whatever its Status still says (see staleItems), and dropped; asks
 *   are the exception, listed as settled.
 * - Ask issues in the tracker (questions, reviews, chores) are listed by
 *   kind: settled (listed last) once he commented after the bot
 *   (`answered`, by node id) or the bot closed them. One whose blocked
 *   item (its parent issue, else its `Blocks:` URL) is also listed is
 *   nested under that entry rather than listed twice.
 * - Other board items are items: a Draft one (a gist to read), or a
 *   Needs human one, which should have open asks nested under it; one
 *   without is flagged as a bot bug.
 *
 * Until the forge has been read once (`forgeKnown`), nothing is stale:
 * forge-only Draft items are listed as items rather than dropped.
 */
export function buildEntries(
  items: readonly Item[],
  prs: readonly ForgePr[],
  verdicts: ReadonlyMap<string, Verdict>,
  forgeKnown = true,
  answered: ReadonlySet<string> = new Set(),
  inputs: QueueInputs = {},
): Entry[] {
  const byNode = new Map(items.map((i) => [i.nodeId, i]));
  const byUrl = new Map<string, Item>();
  for (const i of items) if (i.url && !byUrl.has(i.url.toLowerCase())) byUrl.set(i.url.toLowerCase(), i);
  const byBranch = new Map<string, Item>();
  for (const i of [...items, ...(inputs.linked ?? [])]) for (const u of i.branch) if (!byBranch.has(u.toLowerCase())) byBranch.set(u.toLowerCase(), i);
  const tracked = new Set<string>();
  const out: Entry[] = [];
  const prEntry = (pr: ForgePr, item: Item | undefined, fold: boolean): Entry => {
    const key = refKey(pr.ref);
    const e: Entry = { key: `pr:${key}`, kind: "pr", title: pr.title, where: key, href: prHref(pr), pr };
    if (item?.priority) e.priority = item.priority;
    if (item) e.item = item;
    if (item && fold) {
      tracked.add(item.nodeId);
      e.folded = true;
    }
    if (pr.createdAt) e.since = pr.createdAt;
    return e;
  };

  // The board item that is the PR itself: never a second entry while the
  // PR is listed, unless it is Needs human with the PR on the bot's turn.
  const trackSelf = (self: Item | undefined, wait: PrWait | undefined) => {
    if (self && (self.status === DRAFT || !wait?.onBot)) tracked.add(self.nodeId);
  };

  for (const searched of prs) {
    const current = inputs.others?.find((o) => refKey(o.pr.ref).toLowerCase() === refKey(searched.ref).toLowerCase());
    const pr = current?.pr ?? searched;
    const metaItem = parseBotMeta(pr.body).item;
    const self = byUrl.get(pr.url.toLowerCase());
    const item = (metaItem ? byNode.get(metaItem) : undefined) ?? byBranch.get(pr.url.toLowerCase()) ?? self;
    // Tracked even when not listed: a Draft item isn't a second entry for its own PR.
    for (const i of [item, self]) if (i?.status === DRAFT) tracked.add(i.nodeId);
    const key = refKey(pr.ref);
    const verdict = current?.verdict ?? verdicts.get(key);
    const wait = current?.verdict ? current.wait : verdict ? forgeWait(verdict, inputs.replied?.has(key) === true) : undefined;
    if (verdict && !wait && !waitsOnReviewer(verdict) && !promotionAction(pr, verdict)) continue;
    const e = prEntry(pr, item, item?.status === DRAFT);
    if (verdict) e.verdict = verdict;
    if (wait) e.wait = wait;
    trackSelf(self, wait);
    out.push(e);
  }

  const listed = new Set(out.map((e) => e.key));
  for (const { pr, wait, verdict } of inputs.others ?? []) {
    if (listed.has(`pr:${refKey(pr.ref)}`)) continue;
    const self = byUrl.get(pr.url.toLowerCase());
    const item = byBranch.get(pr.url.toLowerCase()) ?? self;
    if (item?.status === DRAFT) tracked.add(item.nodeId);
    const e = prEntry(pr, item, !wait.onBot && (item?.status === NEEDS_HUMAN || item?.status === DRAFT));
    e.wait = wait;
    if (verdict) e.verdict = verdict;
    trackSelf(self, wait);
    out.push(e);
  }

  for (const item of items) {
    if (tracked.has(item.nodeId)) continue;
    let kind: EntryKind;
    const ask = askKind(item);
    if (!ask && isClosed(item)) continue;
    if (ask) {
      kind = ask;
    } else if (item.status === DRAFT) {
      const forgeOnly = item.branch.length > 0 && item.branch.every((u) => FORGE_PR_RE.test(u));
      if (forgeOnly && forgeKnown) continue;
      kind = "item";
    } else if (item.status === NEEDS_HUMAN) {
      kind = "item";
    } else {
      continue;
    }
    const e: Entry = { key: `item:${item.nodeId}`, kind, title: item.title, where: itemWhere(item), href: itemHref(item), item };
    if (item.priority) e.priority = item.priority;
    const since = waitingSince(item);
    if (since) e.since = since;
    if (ask && (item.state === "closed" || answered.has(item.nodeId))) e.settled = true;
    out.push(e);
  }
  const top = nestAsks(out);
  for (const e of top) {
    if (e.kind === "item" && e.item?.status === NEEDS_HUMAN && !(e.children ?? []).some((c) => c.item?.state !== "closed")) e.bug = true;
  }
  return rankEntries(top);
}

/** Whether an item's own issue or PR is closed or merged. */
function isClosed(item: Item): boolean {
  return item.state === "closed" || item.state === "merged";
}

/**
 * The queue's board items (Needs human or Draft) that the queue drops
 * because their own issue or PR is closed or merged: the board is
 * behind (`bot-watch --apply` moves merged PRs to Done), so the bot
 * should move them on. Asks are left out: a closed ask is settled. So
 * is an item that `entries` (buildEntries' result) still carries,
 * folded into a PR's row.
 */
export function staleItems(items: readonly Item[], entries: readonly Entry[] = []): Item[] {
  const shown = new Set(entries.flatMap((e) => [e, ...(e.children ?? [])]).flatMap((e) => (e.item ? [e.item.nodeId] : [])));
  return items.filter((i) => !isAsk(i) && isClosed(i) && !shown.has(i.nodeId));
}

/** Whether an entry is an ask. */
export function isAskEntry(e: Entry): boolean {
  return ASK_ENTRY_KINDS.includes(e.kind);
}

/**
 * The issues and PRs an entry is about, as refKeys: a PR entry stands
 * for its PR and for the board item it folded in (a forge PR's Draft
 * item, often a tracker issue whose asks name that issue, or the Needs
 * human item of a PR waiting on him). A PR entry's item that wasn't
 * folded in has an entry of its own, which is where its asks belong.
 */
function entryRefs(e: Entry): string[] {
  const item = e.kind !== "pr" || e.folded ? e.item : undefined;
  return [e.pr?.ref, item?.ref].flatMap((r) => (r ? [refKey(r).toLowerCase()] : []));
}

/**
 * Move each ask under the entry for the item it blocks, when that is
 * listed and isn't an ask itself; the rest stay top-level, noting what
 * they block. A parent ranks by its most urgent open ask when that
 * outranks it, so nesting never buries a P0 question under a P2 item.
 */
function nestAsks(entries: Entry[]): Entry[] {
  const parents = new Map<string, Entry>();
  for (const e of entries) {
    // An ask is his: never buried under a PR waiting on the bot.
    if (isAskEntry(e) || onBot(e)) continue;
    for (const ref of entryRefs(e)) if (!parents.has(ref)) parents.set(ref, e);
  }
  const top: Entry[] = [];
  for (const e of entries) {
    const blocked = e.item ? blockedBy(e.item) : undefined;
    const parent = blocked ? parents.get(refKey(blocked).toLowerCase()) : undefined;
    if (parent) {
      (parent.children ??= []).push(e);
      continue;
    }
    if (blocked) e.blocks = refKey(blocked);
    top.push(e);
  }
  for (const e of top) {
    if (!e.children) continue;
    e.children = rankEntries(e.children);
    const urgent = e.children.find((c) => !c.settled);
    if (urgent && priorityRank(urgent.priority) < priorityRank(e.priority) && urgent.priority !== undefined) {
      e.rankPriority = urgent.priority;
    }
  }
  return top;
}

export interface EntryGroup {
  priority: string;
  entries: Entry[];
}

/** Consecutive runs of one priority (or settled) in a ranked list, for headings. */
export function groupRanked(entries: readonly Entry[]): EntryGroup[] {
  const out: EntryGroup[] = [];
  for (const e of entries) {
    const p = onBot(e) ? ON_BOT_GROUP : e.settled ? SETTLED_GROUP : (effectivePriority(e) ?? NO_PRIORITY);
    const last = out.at(-1);
    if (last?.priority === p) last.entries.push(e);
    else out.push({ priority: p, entries: [e] });
  }
  return out;
}
