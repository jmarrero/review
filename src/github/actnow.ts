// Readiness and dependency counts belong to the pass, never to browser prose parsing.
import type { Ask } from "./holds.ts";
import { decisionKey, githubTarget, NEEDS_YOU_MAX_AGE_MS, refusal, type Published } from "./inbox.ts";
import { issueKey, type LabelledIssue, type NeedsHumanRead } from "./needshuman.ts";

export const ACT_NOW_LIMIT = 10;

/** Hold kinds of a question only the operator answers: these rank first. */
export const DECISION_KINDS: readonly string[] = ["needs-human", "needs-operator", "needs-design", "review-needs-human"];

export interface ActNowRow {
  ask: Ask;
  unblocks: number;
  /** Listed directly because the pass's list is incomplete: read-only, never a write shortcut. */
  fallback?: true;
}

/** A new destructive write never inherits the inbox's legacy descriptor fallback. */
export function mergeRefusal(a: Ask): string | undefined {
  return refusal(a, "merge-or-enqueue") ?? (!a.requests?.length ? "No supported merge-or-enqueue descriptor was published." : undefined);
}

/**
 * One row per published group, independent of the inbox's epic filter.
 * Operator decisions first, then what unblocks most. While the list is
 * incomplete, its open decisions are listed too, ranked by the shortlist's
 * count where it has one, so a decision that blocks work (agent-board#308)
 * does not go unseen because the pass read a source in part.
 */
export function actNowRows(p: Published, now: number, completed: ReadonlyMap<string, string> = new Map()): ActNowRow[] {
  const list = p.list;
  if (!list || p.unavailable || p.error || p.checkedAt === undefined) return [];
  const age = now - Date.parse(list.validatedAt);
  if (!Number.isFinite(age) || age < 0 || age > NEEDS_YOU_MAX_AGE_MS) return [];
  const asks = new Map(p.asks.map((a) => [a.key, a]));
  const done = (a: Ask) => completed.get(a.key) === decisionKey(a);
  const certified = (list.actNow ?? []).flatMap(({ key, unblocks }): ActNowRow[] => {
    const a = asks.get(key);
    // Unknown, carried or incomplete evidence cannot certify "right now".
    if (!a || a.detailMissing || a.carried || !githubTarget(a) || list.sources[a.source] !== "complete" ||
        a.requests?.some((r) => r.quality !== "decision") || done(a)) return [];
    return [{ ask: a, unblocks }];
  });
  const rows = [...certified];
  if (!list.complete) {
    const listed = new Set(certified.map((r) => r.ask.key));
    const counts = new Map((list.actNow ?? []).map((r) => [r.key, r.unblocks]));
    // A placeholder without detail is listed too: it is read-only here anyway.
    for (const a of p.asks) {
      if (!DECISION_KINDS.includes(a.kind) || listed.has(a.key) || !githubTarget(a) || done(a)) continue;
      rows.push({ ask: a, unblocks: counts.get(a.key) ?? 0, fallback: true });
    }
  }
  const decision = (r: ActNowRow) => (DECISION_KINDS.includes(r.ask.kind) ? 0 : 1);
  if (list.producerOrder) return certified.slice(0, ACT_NOW_LIMIT);
  return rows.sort((a, b) => decision(a) - decision(b) || b.unblocks - a.unblocks ||
    (a.ask.priority ?? "P9").localeCompare(b.ask.priority ?? "P9") ||
    Date.parse(a.ask.waitingSince) - Date.parse(b.ask.waitingSince) || a.ask.key.localeCompare(b.ask.key)).slice(0, ACT_NOW_LIMIT);
}

/**
 * Why the pass's list cannot vouch that Act now holds every decision;
 * undefined while it is complete and current, or before its first read ends.
 */
export function actNowGap(p: Published, now: number): string | undefined {
  const list = p.list;
  if (p.error) return p.error;
  if (!list) return undefined;
  if (p.unavailable) return "The pass's needs-you list can't be read now";
  if (p.checkedAt === undefined) return "The pass's needs-you list is this browser's cached copy, not yet checked on GitHub";
  const age = now - Date.parse(list.validatedAt);
  if (!Number.isFinite(age) || age < 0 || age > NEEDS_YOU_MAX_AGE_MS) return "The pass's needs-you list is stale: not confirmed within its age bound";
  if (!list.complete) return "The pass's needs-you list is incomplete";
  return undefined;
}

/** What Act now shows besides its rows while the list cannot vouch for it. */
export interface ActNowCoverage {
  gap: string;
  /** The direct label read; undefined until it has run. */
  read?: NeedsHumanRead;
  /** The read's issues not already shown or done here. */
  issues: readonly LabelledIssue[];
}

/** The direct read's issues, less any shown as a published row or completed here: published evidence wins. */
export function labelledIssues(read: NeedsHumanRead | undefined, rows: readonly ActNowRow[], p: Published, completed: ReadonlyMap<string, string> = new Map()): LabelledIssue[] {
  const target = (a: Ask) => issueKey(a.action.repository, a.action.number);
  const shown = new Set([...rows.map((r) => target(r.ask)), ...p.asks.filter((a) => completed.get(a.key) === decisionKey(a)).map(target)]);
  return (read?.issues ?? []).filter((i) => !shown.has(i.key));
}
