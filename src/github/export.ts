// The queue as data: the `review-queue/v1` JSON document the CLI prints
// (see docs/queue-json.md), and its plain-text rendering. Pure: ranked
// entries in, a document or lines out. It reads the same entries the
// app shows, so what the CLI says needs you is what the app says.

import { commentNote, itemAction } from "./asks.ts";
import { NO_PRIORITY, questionOf } from "./board.ts";
import { entryOrg, filterToken, type QueueFilter } from "./filter.ts";
import { promotionAction, VERDICT_LABEL } from "./forge.ts";
import { effectivePriority, type Entry, type EntryKind, ON_BOT_GROUP, SETTLED_GROUP } from "./queue.ts";
import { type PrReason, type PrWait, REASON_LABEL } from "./waiting.ts";

/** The schema name and major version; a breaking change bumps it. */
export const SCHEMA = "review-queue/v1";

/** Where the app is published; an entry's `appUrl` is this plus its route. */
export const APP_URL = "https://jmarrero.github.io/review/";

/**
 * What to do about an entry, as one verb:
 *
 * - `review`: review a PR (a forge PR in the app, one of the bot's PRs
 *   that asks for it or needs approving to re-sign, or the one a review ask names);
 * - `answer`: answer a question (pick an option, or write);
 * - `rerun`: rerun a chore's or a PR's failed workflow jobs (needs write access);
 * - `comment`: do what a chore or unreadable review ask says, then comment;
 * - `read`: read a Draft item (usually a gist) and decide;
 * - `see-asks`: act on the asks nested under it;
 * - `wait`: nothing: he answered, approved or requested changes, and the bot acts next;
 * - `act-on-github`: the app can't act on it (see `reason`);
 * - `report-bug`: Needs human, but the bot asked nothing; tell it.
 */
export type ActionVerb = "review" | "answer" | "rerun" | "comment" | "read" | "see-asks" | "wait" | "act-on-github" | "report-bug";

export interface ActionJson {
  verb: ActionVerb;
  /** One line for a human. */
  summary: string;
  /** Why the app can't act (act-on-github), or why a review or rerun fell back to a comment. */
  reason?: string;
  /** What to act on, when the ask names it: the PRs to review, the workflow runs to rerun. */
  targets?: string[];
}

export interface QuestionJson {
  ask?: string;
  options: { letter: string; text: string; recommended: boolean }[];
  recommendation?: string;
}

export interface EntryJson {
  key: string;
  kind: EntryKind;
  title: string;
  /** `owner/repo#n`, "draft item" or "item". */
  where: string;
  /** The board's Priority, or null. */
  priority: string | null;
  /** What it ranks and groups by: its own priority, or a more urgent nested ask's; null for none. */
  rankPriority: string | null;
  /** The organization it targets (lowercase), or null when unknown. */
  org: string | null;
  /** When it started waiting (ISO 8601), or null. */
  since: string | null;
  /** He answered (or the bot closed it): waiting on the bot, not him. */
  settled: boolean;
  /** Needs human, yet the bot asked nothing. */
  bug: boolean;
  /** The issue or PR on github.com, or null (a draft item). */
  url: string | null;
  /** The entry in the review app. */
  appUrl: string;
  /** A forge PR's review state, as the app labels it. */
  verdict?: { state: string; label: string; url?: string };
  /** A PR's turn beyond its verdict: on the bot's (listed last, never open), or what he is asked to do. */
  wait?: { onBot: boolean; reasons: PrReason[] };
  /** The upstream issue or PR a top-level ask blocks, as `owner/repo#n`. */
  blocks?: string;
  /** The board item's Why, when it has one. */
  why?: string;
  /** Gists to read, on a Draft item. */
  gists?: string[];
  /** An open question's text and options. */
  question?: QuestionJson;
  /** What a review or chore ask asks, from its `Ask:` line. */
  ask?: string;
  action: ActionJson;
  /** The asks about this entry, nested under it, ranked. */
  asks: EntryJson[];
}

export interface QueueJson {
  schema: typeof SCHEMA;
  generatedAt: string;
  /** The filter applied, as a token (`all`, `composefs+P0`, `org:bootc-dev`). */
  filter: string;
  /** Entries, rows (entries plus nested asks), and rows that need him (not `wait` or `see-asks`), after filtering. */
  counts: { entries: number; rows: number; open: number };
  entries: EntryJson[];
  /** Data that couldn't be read; the queue may be incomplete. */
  warnings: string[];
}

/**
 * A PR's action from whose turn it is (see waiting.ts): nothing while it
 * waits on the bot; else a review for a review request or an update
 * since his change request, approving the head for a re-sign, and a
 * rerun only when that is all it asks. Undefined when the turn says
 * nothing beyond the verdict.
 */
function waitAction(wait: PrWait | undefined): ActionJson | undefined {
  if (!wait) return undefined;
  if (wait.onBot) return { verb: "wait", summary: "you requested changes; the bot acts next" };
  const { reasons } = wait;
  if (!reasons.length) return undefined;
  const summary = reasons.map((r) => REASON_LABEL[r]).join("; ");
  const runs = reasons.includes("rerun") && wait.runs?.length ? { targets: wait.runs.map((r) => r.url) } : {};
  if (reasons.includes("review-requested") || reasons.includes("updated")) return { verb: "review", summary, ...runs };
  if (reasons.includes("resign")) {
    const unsigned = wait.unsigned?.length ? `: ${wait.unsigned.join(", ")} lack your Signed-off-by` : "";
    return { verb: "review", summary: `${summary}${unsigned}`, ...runs };
  }
  return { verb: "rerun", summary: `${summary}${wait.failed?.length ? `: ${wait.failed.join(", ")}` : ""}`, ...runs };
}

function prAction(e: Entry): ActionJson {
  const turn = waitAction(e.wait);
  if (turn) return turn;
  const promotion = e.pr ? promotionAction(e.pr, e.verdict) : undefined;
  if (promotion === "promote") return { verb: "comment", summary: "send /promote on the approved fork PR to publish it upstream" };
  if (promotion === "write") return { verb: "read", summary: "write your title, description and commit messages for the upstream human-text policy" };
  const state = e.verdict?.state ?? "none";
  if (state === "promoted") return { verb: "wait", summary: "you sent /promote; bot-pr acts next" };
  const summary =
    state === "approved-older"
      ? "review the commits pushed since your approval"
      : state === "changes-requested-older"
        ? "review the push since your change request"
        : "review the forge PR (approve to promote it upstream)";
  return { verb: "review", summary };
}

/** The suggested action for an entry: the same choice the app's item view makes. */
export function suggestedAction(e: Entry): ActionJson {
  if (e.kind === "pr") return prAction(e);
  if (!e.item) return { verb: "act-on-github", summary: "open it on GitHub", reason: "no board item" };
  if (e.settled) {
    return e.item.state === "closed"
      ? { verb: "wait", summary: "closed by the bot; nothing to do" }
      : { verb: "wait", summary: "you answered; the bot acts next" };
  }
  const openAsks = (e.children ?? []).filter((c) => c.item?.state !== "closed").length;
  const a = itemAction(e.item, openAsks);
  switch (a.kind) {
    case "answer": {
      const { options } = a.question;
      const rec = options.find((o) => o.recommended);
      const note = rec ? `the bot recommends ${rec.letter}` : options.length ? "no option is recommended" : "in your own words: it offers no options";
      return { verb: "answer", summary: `answer the question (${note})` };
    }
    case "review":
      return {
        verb: "review",
        summary: `review ${a.body.reviews.map((r) => `${r.ref.owner}/${r.ref.repo}#${r.ref.number}`).join(", ")}`,
        targets: a.body.reviews.map((r) => r.url),
      };
    case "rerun":
      return { verb: "rerun", summary: `rerun the failed jobs of ${a.body.reruns.length} workflow run(s)`, targets: a.body.reruns.map((r) => r.url) };
    case "comment": {
      const reason = commentNote(a);
      return { verb: "comment", summary: `do what the ${a.ask} asks, then comment`, ...(reason ? { reason } : {}) };
    }
    case "done":
      return { verb: "wait", summary: "closed by the bot; nothing to do" };
    case "blocked":
      return { verb: "act-on-github", summary: "the app can't act on this; see GitHub", reason: a.reason };
    case "asks":
      return { verb: "see-asks", summary: `act on its ${openAsks} open ask(s)` };
    case "bug":
      return { verb: "report-bug", summary: "Needs human, but the bot asked nothing: tell it" };
    case "read":
      return { verb: "read", summary: e.item.gist.length ? "read the gist and decide" : "read it and decide" };
  }
}

/** One entry, and its nested asks, as JSON. */
export function entryJson(e: Entry): EntryJson {
  const url = e.pr?.url ?? e.item?.url ?? null;
  const out: EntryJson = {
    key: e.key,
    kind: e.kind,
    title: e.title,
    where: e.where,
    priority: e.priority ?? null,
    rankPriority: effectivePriority(e) ?? null,
    org: entryOrg(e) ?? null,
    since: e.since ?? null,
    settled: e.settled === true,
    bug: e.bug === true,
    url,
    appUrl: `${APP_URL}${e.href}`,
    action: suggestedAction(e),
    asks: (e.children ?? []).map(entryJson),
  };
  if (e.verdict) {
    out.verdict = { state: e.verdict.state, label: VERDICT_LABEL[e.verdict.state], ...(e.verdict.url ? { url: e.verdict.url } : {}) };
  }
  if (e.wait) out.wait = { onBot: e.wait.onBot, reasons: [...e.wait.reasons] };
  if (e.blocks) out.blocks = e.blocks;
  const item = e.item;
  if (item?.why) out.why = item.why;
  if (item?.gist.length) out.gists = [...item.gist];
  if (item && e.kind === "question" && !e.settled) {
    const q = questionOf(item);
    out.question = {
      ...(q.ask ? { ask: q.ask } : {}),
      options: q.options.map((o) => ({ letter: o.letter, text: o.text, recommended: o.recommended })),
      ...(q.recommendation ? { recommendation: q.recommendation } : {}),
    };
  }
  if (item && (e.kind === "review" || e.kind === "chore")) {
    const a = itemAction(item, 0);
    const ask = "body" in a ? a.body.ask : undefined;
    if (ask) out.ask = ask;
  }
  return out;
}

/** Verbs that aren't work of their own: nothing to do, or the work is the nested asks. */
const NOT_OPEN: readonly ActionVerb[] = ["wait", "see-asks"];

/** The whole document for filtered, ranked entries. */
export function queueJson(entries: readonly Entry[], filter: QueueFilter, now: Date, warnings: readonly string[] = []): QueueJson {
  const json = entries.map(entryJson);
  const all = json.flatMap((e) => [e, ...e.asks]);
  return {
    schema: SCHEMA,
    generatedAt: now.toISOString(),
    filter: filterToken(filter),
    counts: { entries: json.length, rows: all.length, open: all.filter((e) => !NOT_OPEN.includes(e.action.verb)).length },
    entries: json,
    warnings: [...warnings],
  };
}

/** How long ago, roughly: `3d`, `5h`, `now`. */
export function age(since: string | null, now: Date): string {
  const t = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(t)) return "?";
  const hours = Math.floor((now.getTime() - t) / 3_600_000);
  if (hours < 1) return "now";
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function entryLines(e: EntryJson, now: Date, indent: string): string[] {
  const org = e.org ?? "-";
  const lines = [`${indent}${e.kind.padEnd(8)} ${e.where}  ${e.title}  [${org}, ${age(e.since, now)}]${e.bug ? "  BOT BUG" : ""}`];
  const more = `${indent}         `;
  lines.push(`${more}-> ${e.action.verb}: ${e.action.summary}${e.action.reason ? ` (${e.action.reason})` : ""}`);
  if (e.question?.ask) lines.push(`${more}Q: ${e.question.ask}`);
  for (const o of e.question?.options ?? []) lines.push(`${more}   ${o.letter}) ${o.text}${o.recommended ? "  (recommended)" : ""}`);
  if (e.ask) lines.push(`${more}Ask: ${e.ask}`);
  for (const t of e.action.targets ?? []) lines.push(`${more}${t}`);
  if (e.blocks) lines.push(`${more}blocks ${e.blocks}`);
  lines.push(`${more}${e.appUrl}`);
  for (const c of e.asks) lines.push(...entryLines(c, now, `${indent}    `));
  return lines;
}

// Control characters other than newline (C0, DEL, C1, so escape
// sequences) and bidi overrides. Titles and asks come from anyone who
// can open an issue upstream, and must not drive the terminal.
const UNPRINTABLE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** TEXT with whatever could drive a terminal replaced by `?`. */
export const printable = (text: string): string => text.replace(UNPRINTABLE_RE, "?");

/** The document as text for a terminal: priority groups, one block per entry. */
export function queueText(doc: QueueJson, now: Date): string {
  const out: string[] = [];
  const { entries, rows, open } = doc.counts;
  out.push(`${open} open of ${rows} row(s) in ${entries} entr${entries === 1 ? "y" : "ies"} (filter: ${doc.filter})`);
  for (const w of doc.warnings) out.push(`warning: ${w}`);
  // Group as the app does, by walking the same ranked order.
  let group: string | undefined;
  for (const e of doc.entries) {
    const g = e.wait?.onBot ? ON_BOT_GROUP : e.settled ? SETTLED_GROUP : (e.rankPriority ?? NO_PRIORITY);
    if (g !== group) {
      group = g;
      out.push("", `== ${g}`);
    }
    out.push(...entryLines(e, now, ""));
  }
  if (doc.entries.length === 0) out.push("", "Nothing waiting on you.");
  return `${printable(out.join("\n"))}\n`;
}
