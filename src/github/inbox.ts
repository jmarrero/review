// The inbox: one card per thing only the operator can do.
//
// - What the pass publishes (holds.ts's needs-you list): its holds that
//   only he releases, review waits, operator-action proposals and digest
//   asks, in the pass's order and no others. A hold or a PR's needs-human
//   is Answer, an approval at a head Approve, a proposal Do, the digest's
//   approvals one Approve as a group, anything else a link to where it is
//   done. Each card reads its target again before it writes.
// - Then what the pass does not read: open decisions document entries
//   (Decide; ticking an option dims one, its About item closing resolves
//   it, comments on the item since the ask mark it) and open review-draft
//   issues (Send; a ticked send box dims one until the tracker's workflow
//   closes it).
//
// The list says how current it is from the pass's own clock, not from the
// HTTP read: a 304 says the comment is unchanged, not that the pass still
// runs. Empty means "nothing waits" only for a complete list the pass
// confirmed recently. A list that can't be read again keeps its cards,
// marked unavailable, and says why.

import type { DocumentEntry, Mark } from "./decisiondocument.ts";
import { OPERATOR } from "./config.ts";
import { type Ask, type AskRef, holdAsks, type NeedsYou } from "./holds.ts";
import type { ApproveItem } from "./maintain.ts";
import type { DraftIssue } from "./reviewdrafts.ts";
import { ago } from "../time.ts";
import type { Item } from "./board.ts";
import type { Heartbeat } from "./heartbeat.ts";
import type { UsageData } from "./usage.ts";
import type { Holds } from "./holds.ts";
import type { ReportBlock } from "./repositories.ts";
import type { Passes } from "./passes.ts";
import type { ProjectStatus } from "./backend.ts";
import type { Sources } from "./freshness.ts";

/** The inbox's last-read context; failed or uncached reads stay undefined. */
export interface Active {
  sources?: Sources;
  status?: ProjectStatus | null;
  statusError?: string;
  board?: Item[];
  /** null means no heartbeat was published. */
  local?: Heartbeat | null;
  usage?: UsageData;
  holds?: Holds;
  repositories?: ReportBlock[];
  passes?: Passes | string | null;
  passPublicationError?: string | undefined;
  warnings: string[];
  at: number;
  /** Read from the cache only, before GitHub answered. */
  fromCache?: boolean;
}

export type CardKind = "answer" | "approve" | "promote" | "open" | "do" | "digest" | "document" | "send";

export const CARD_LABEL: Record<CardKind, string> = {
  answer: "Answer",
  approve: "Approve",
  promote: "Promote",
  open: "Act",
  do: "Do",
  digest: "Approve",
  document: "Decide",
  send: "Send",
};

interface CardBase {
  /** Stable while the thing is the same thing: the view keeps a card by it. */
  key: string;
  title: string;
  /** Where it is, e.g. `owner/repo#12`. */
  where: string;
  /** Its page on GitHub. */
  url?: string;
  since?: string;
  /** He did his part: dimmed until the bot (or a workflow) acts. */
  answered?: boolean;
  /** A line under the title: what changed, or why it waits. */
  note?: string;
  /** The board Priority the pass gave it. */
  priority?: string;
  /** From a list that can't be read now: shown, marked, until one can. */
  unavailable?: boolean;
}

export type Card = CardBase & (
  | { kind: "answer" | "approve" | "promote" | "open" | "do"; ask: Ask }
  | { kind: "digest"; items: ApproveItem[] }
  | { kind: "send"; draft: DraftIssue }
  | { kind: "document"; entry: DocumentEntry; mark?: Mark }
);

const PULLS = ["pull_request", "approve_pull_request", "review_pull_request", "reply_pull_request", "close_pull_request"];

/** The page on GitHub an ask's action is on, made from its parts. */
export function askUrl(r: AskRef): string {
  return `https://github.com/${r.repository}/${PULLS.includes(r.type) ? "pull" : "issues"}/${r.number}${r.comment ? `#issuecomment-${r.comment}` : ""}`;
}

/** Where the app opens it: the PR pane, or the issue's item view. */
export function askHref(r: AskRef): string {
  return `#${PULLS.includes(r.type) ? "pr" : "issue"}/${r.repository}/${r.number}`;
}

const open = (state: string | undefined): boolean => state === undefined || state === "open";

/** The forge this client writes to; a request on another is shown, never acted on. */
export const GITHUB_FORGE = "github.com";

/** Whether resolving this ask through GitHub (including navigation) is safe. */
export const githubTarget = (a: Ask): boolean => !a.requestsUnreadable && (a.requests ?? []).every((r) => r.forge === GITHUB_FORGE);

/** The PRs an ask stands for: a group's members, else its own. */
export const members = (a: Ask): number[] => a.group?.numbers ?? [a.action.number];

/** Local receipts track a decision, not changes to its display metadata. */
export const decisionKey = (a: Ask): string => JSON.stringify([a.kind, a.action, a.action.head ? undefined : a.ask]);

/**
 * Decisions, the pass's unit: `known` reported, `listed` in its inventory
 * (several may share one row), `unlisted` the rest (past the pass's cap,
 * or unreadable here: publishedNote names which), so the two add up.
 */
export function inboxCounts(p: Published, completed: ReadonlyMap<string, string> = new Map()): { known: number; listed: number; unlisted: number; completed: number; outstanding: number } {
  const done = p.asks.filter((a) => completed.get(a.key) === decisionKey(a)).length;
  const listed = p.list?.identities?.length ?? p.asks.length;
  const known = Math.max(listed, (p.list?.counts?.decisions ?? p.list?.count ?? p.asks.length) - (p.list?.excludedHolds ?? 0));
  return { known, listed, unlisted: known - listed, completed: done, outstanding: Math.max(0, known - done) };
}

/**
 * Whether a card still waits on the operator here: an ask without a local
 * receipt, or a digest group with a member PR approved at no receipt yet.
 * The heading and the epic chips both count by this.
 */
export function cardOutstanding(c: Card, asks: readonly Ask[], completed: ReadonlyMap<string, string> = new Map()): boolean {
  const done = (a: Ask) => completed.get(a.key) === decisionKey(a);
  if ("ask" in c) return !done(c.ask);
  if (c.kind !== "digest") return true;
  const ref = (repository: string, number: number, head: string | undefined) => `${repository}#${number}@${head}`.toLowerCase();
  const receipts = new Set(asks.filter((a) => !a.group && a.kind === "digest-approve" && done(a)).map((a) => ref(a.action.repository, a.action.number, a.action.head)));
  return c.items.some((it) => !receipts.has(ref(`${it.pr.owner}/${it.pr.repo}`, it.pr.number, it.head)));
}

/**
 * Why a card writes nothing in place, though its kind would: its request
 * is on another forge, or the pass says its step (review-at-head for
 * Approve, check-proposal for Do) is not supported. Without descriptors,
 * the card acts as it always did.
 */
export function refusal(a: Ask, step?: string): string | undefined {
  if (a.detailMissing) return "Details unavailable; inspect the source before acting";
  if (a.requestsUnreadable) return "this request's descriptors could not be read safely; it is read-only";
  const forge = a.requests?.find((r) => r.forge !== GITHUB_FORGE)?.forge;
  if (forge) return `this request is on ${forge}, and this page writes only to ${GITHUB_FORGE}`;
  // One card may stand for several decisions: any that rules the step out rules it out.
  const unsupported = a.requests?.flatMap((r) => r.actions).find((x) => x.kind === step && !x.supported)?.reason;
  if (unsupported) return unsupported;
  if (step && a.requests?.some((r) => !r.actions.some((x) => x.kind === step && x.supported))) return `the pass does not support ${step} for this request`;
  return undefined;
}

/** The card for one published ask. */
export function askCard(a: Ask, unavailable = false): Card {
  const type = a.action.type;
  // A group's answer would land on its representative alone: its members are read and opened one by one.
  // A placeholder answers nothing: it is a two-line Act row, not an Answer with a refusal box.
  const kind = a.detailMissing ? "open" : a.source === "decisions" || a.source === "drafts" ? "open" : a.kind === "review-promote" ? "promote" : a.group ? "open" : type === "operator_action" ? "do" : type === "approve_pull_request" || (a.kind === "digest-approve" && a.action.head) ? "approve" : type === "issue" || type === "pull_request" ? "answer" : "open";
  const diagnostic = a.requests?.find((r) => r.quality !== "decision")?.quality;
  const note = [
    a.group && `${a.group.numbers.length} PRs: ${a.group.reason}`,
    a.recommendation && `Recommendation: ${a.recommendation}`,
    a.carried && "Carried over: the pass did not read its source again.",
    diagnostic && `The pass marks this request ${diagnostic}.`,
  ].filter(Boolean).join(" ");
  return {
    kind, ask: a, key: a.key, title: a.ask, where: a.group ? `${a.action.repository} · ${a.group.reason}` : `${a.item} · ${a.kind}`, ...(githubTarget(a) ? { url: askUrl(a.action) } : {}), since: a.waitingSince,
    ...(a.priority ? { priority: a.priority } : {}), ...(note ? { note } : {}), ...(unavailable ? { unavailable } : {}),
  };
}

/** The asks as cards in the pass's order, the digest's approvals one group where the first of them ranks. */
export function publishedCards(asks: readonly Ask[], unavailable = false): Card[] {
  const digest = asks.filter((a) => !a.epic && !a.topEpic && !a.group && a.kind === "digest-approve" && a.action.head && !refusal(a, "review-at-head"));
  const items = digest.map((a): ApproveItem => {
    const [owner = "", repo = ""] = a.action.repository.split("/");
    return { pr: { owner, repo, number: a.action.number }, head: a.action.head!, reason: a.recommendation ?? a.ask };
  });
  return asks.flatMap((a): Card[] => {
    if (!digest.includes(a)) return [askCard(a, unavailable)];
    if (a !== digest[0]) return [];
    return [{ kind: "digest", items, key: "digest", title: `Approve ${items.length} PR${items.length === 1 ? "" : "s"} as a group`, where: "the maintain digest", since: a.waitingSince, ...(unavailable ? { unavailable } : {}) }];
  });
}

/** A Send card for an open review-draft issue; a ticked box waits on the tracker's workflow, which closes the issue. */
export function sendCard(d: DraftIssue & { issue: { state?: string } }): Card | undefined {
  if (!open(d.issue.state)) return undefined;
  return {
    kind: "send",
    draft: d,
    key: `send:${d.issue.number}`,
    title: d.issue.title,
    where: `#${d.issue.number}`,
    url: d.issue.html_url,
    ...(d.box === "ticked" ? { answered: true, note: "Send is ticked: waiting on the tracker's workflow." } : {}),
  };
}

/**
 * A card for an open decisions document entry. Its About item closed or
 * merged resolves it, as the document view does; a ticked option is his
 * answer, waiting on the bot; comments on the item since the ask mark it.
 */
export function documentCard(entry: DocumentEntry, mark: Mark | undefined): Card | undefined {
  if (entry.done) return undefined;
  const about = entry.about ? `${entry.about.repo}#${entry.about.number}` : undefined;
  // A mark read for another About line (an older body) is not this entry's.
  const m = mark && mark.item === about ? mark : undefined;
  if (m && m.state !== "answered") return undefined;
  const answered = entry.options.some((o) => o.checked);
  return {
    kind: "document",
    entry,
    ...(m ? { mark: m } : {}),
    key: `document:${entry.id}`,
    title: `${entry.id} ${entry.title}`,
    where: about ?? entry.id,
    ...(m ? { url: m.url } : about ? { url: `https://github.com/${entry.about!.repo}/issues/${entry.about!.number}` } : {}),
    ...(entry.about?.asked ? { since: entry.about.asked } : {}),
    ...(answered ? { answered: true, note: "Answered: waiting on the bot." } : m ? { note: `Changed since asked: ${m.comments === 1 ? "a comment" : `${m.comments} comments`} on ${m.item}.` } : {}),
  };
}

/** What the inbox last read of the pass's list. */
export interface Published {
  /** The asks to show: the list's, else the snapshot's own operator holds (holdAsks). */
  asks: Ask[];
  /** The last list read, kept while a later read has none. */
  list?: NeedsYou;
  /** When GitHub last confirmed the comment holding `list`, a 304 included; undefined while it is the cache's. */
  checkedAt?: number;
  /** Why the latest read gave no list to use. */
  error?: string;
  /** `asks` are from a read that can't be confirmed now. */
  unavailable: boolean;
  /** Current snapshot holds alongside an unavailable older list; these supersede matching keys. */
  holds?: Ask[];
}

/**
 * What one read of the pass's snapshot says of its needs-you list, with no
 * list read before: the list, else the snapshot's own operator holds and
 * why there is no list. `checkedAt` is when GitHub confirmed the read.
 * The app and control-app's needs-you both read it this way.
 */
export function firstPublished(holds: Holds | undefined, checkedAt?: number): Published {
  const list = holds?.needsYou;
  if (typeof list === "object") return { asks: list.items, list, unavailable: false, ...(checkedAt === undefined ? {} : { checkedAt }) };
  const error = !holds
    ? "The pass has published no hold snapshot"
    : list === undefined
      ? "The pass's snapshot has no needs-you list"
      : `The pass's needs-you list can't be used: ${list}`;
  return { asks: holds ? holdAsks(holds) : [], unavailable: false, error };
}

/**
 * Older than this, the pass's list is not known to be current: the pass
 * writes an unchanged list again once it is an hour old, and runs every
 * ten minutes (tracker's poll.yml).
 */
export const NEEDS_YOU_MAX_AGE_MS = 70 * 60_000;

/** A source the pass did not read whole, as "proposals partial". */
const shortfall = (l: NeedsYou): string[] => Object.entries(l.sources).flatMap(([name, read]) => (read === "complete" || read === "off" ? [] : [`${name} ${read}`]));

/**
 * What the inbox says over the cards of the pass's list, and whether an
 * empty inbox may say nothing waits: only a complete list, read now and
 * confirmed by the pass within NEEDS_YOU_MAX_AGE_MS.
 */
export function publishedNote(p: Published, now: number, source: "github" | "service" = "github"): { text: string; settled: boolean } {
  const l = p.list;
  if (!l && !p.error) return { text: "Reading the pass's needs-you list…", settled: false };
  const parts: string[] = [];
  if (p.error) parts.push(`${p.error}.`);
  if (l) {
    const old = now - Date.parse(l.validatedAt) > NEEDS_YOU_MAX_AGE_MS;
    const receipt = source === "service" ? "received from service" : "checked on GitHub";
    parts.push(`${p.unavailable ? "Cards from the list the pass" : "The pass's list:"} confirmed ${ago(l.validatedAt, now)}, changed ${ago(l.changedAt, now)}${p.checkedAt === undefined ? ", shown from this browser's cache" : `, ${receipt} ${ago(new Date(p.checkedAt).toISOString(), now)}`}${p.unavailable ? "; marked unavailable until it can be read again." : "."}`);
    if (old) parts.push("The pass has not confirmed it for over an hour: it may have stopped, and this may be out of date.");
    if (l.excludedHolds) parts.push(`${l.excludedHolds} superseded hold decisions excluded: this snapshot no longer lists them as waiting on the operator.`);
    const missing = [...shortfall(l), ...(l.omitted ? [`${l.omitted} past the pass's cap`] : []), ...(l.refused ? [`${l.refused} unreadable here`] : [])];
    if (!l.complete) parts.push(`Incomplete${missing.length ? ` (${missing.join(", ")})` : ""}: more may wait on you.`);
    if (l.summaries !== "complete") parts.push("Not every summary was read: some asks show the board's question or the hold's reason.");
    return { text: parts.join(" "), settled: !p.error && p.checkedAt !== undefined && l.complete && !old };
  }
  parts.push(p.asks.length && !p.unavailable ? "Shown: the snapshot's own operator holds; review waits, proposals and digest asks are not listed." : "Holds, review waits, proposals and digest asks are not listed.");
  return { text: parts.join(" "), settled: false };
}

export interface InboxInput {
  published?: Published;
  document?: { entries: readonly DocumentEntry[]; marks: ReadonlyMap<string, Mark> };
  drafts?: readonly DraftIssue[];
}

/** Every card: the pass's in its order, then the document's and the drafts', those he did last. */
export function inboxCards(input: InboxInput): Card[] {
  const local = [
    ...(input.document?.entries ?? []).map((e) => documentCard(e, input.document?.marks.get(e.id))),
    ...(input.drafts ?? []).map(sendCard),
  ].filter((c): c is Card => c !== undefined);
  const holds = input.published?.holds ?? [];
  const p = input.published;
  let asks = (p?.asks ?? []).filter((a) => !holds.some((h) => h.key === a.key));
  if (p?.list?.identities) {
    // Inventory order is producer policy. A missing detail is not a missing
    // decision; show a read-only placeholder without discovering its target.
    const details = new Map(asks.map((a) => [a.key, a]));
    const seen = new Set<string>();
    asks = p.list.identities.flatMap((i): Ask[] => {
      if (seen.has(i.detailKey)) return [];
      seen.add(i.detailKey);
      const detail = details.get(i.detailKey);
      if (detail) return [detail];
      const [repository = "", n = ""] = i.item.split("#");
      return [{ ...i, key: i.detailKey, ask: "Detail not published: inspect the source before acting", recommendation: null, action: { type: i.source === "reviews" ? "pull_request" : "issue", repository, number: Number(n) }, detailMissing: true }];
    });
  }
  const published = p?.list?.identities ? asks.map((a) => askCard(a, p.unavailable)) : publishedCards(asks, p?.unavailable);
  return [...published, ...publishedCards(holds), ...local.filter((c) => !c.answered), ...local.filter((c) => c.answered)];
}

/** Whether `login` may act on the inbox's cards: the operator, or a token GitHub hasn't named yet. */
export const mayAct = (login: string | undefined): boolean => login === undefined || login === OPERATOR;
