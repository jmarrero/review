// A bounded projection of published facts, not a controller event log.
import { USAGE_ISSUE, USAGE_REPO } from "./config.ts";
import { askUrl, type Published } from "./inbox.ts";
import { redactAddresses } from "./passes.ts";
import { itemHref, runHref, type PassesRead } from "./passesview.ts";
import { ITEM_RE } from "./usage.ts";

export const MAX_ACTIVITY_ROWS = 12;
export const PUBLICATION_HREF = askUrl({ type: "issue", repository: USAGE_REPO, number: USAGE_ISSUE });

export interface ActivityRow {
  key: string;
  text: string;
  href: string;
  linkText: string;
  at?: string | undefined;
  since?: string | undefined;
  source: "context" | "passes";
}

export interface Activity {
  rows: ActivityRow[];
  omitted: number;
  unlinkable: number;
  duplicates: number;
  contextOmitted: number;
  passOmitted: number;
  passUnreadable: number;
  passDetailsOmitted: number;
  displayOmitted: number;
}

/** Parsed inventories are already bounded (40 facts, 10 passes). Never use prose URLs. */
export function publishedActivity(published: Published, passes: PassesRead): Activity {
  const candidates: ActivityRow[] = [];
  let unlinkable = 0;
  const context = published.list?.context;
  for (const f of context?.items ?? []) {
    const match = f.item ? ITEM_RE.exec(f.item) : null;
    const valid = match && !match[1]!.split("/").some((p) => p === "." || p === "..");
    if (f.itemUnreadable || (f.item && !valid)) { unlinkable++; continue; }
    const item = f.item?.toLowerCase();
    candidates.push({ key: JSON.stringify(["context", f.source, item ?? null, f.kind, f.reason, f.since ?? null]),
      text: redactAddresses(`Observed ${f.source} fact · ${f.kind}: ${f.reason}`),
      href: item ? itemHref(item) : PUBLICATION_HREF, linkText: item ?? "Publication source (global fact; not a run receipt)",
      at: f.observedAt ?? context?.observedAt, since: f.since, source: "context" });
  }
  for (const p of passes.data?.passes ?? []) {
    const problems = p.sections.filter((s) => s.outcome === "failed" || s.outcome === "cut-short");
    candidates.push({ key: p.run ? `pass:${runHref(p.run).toLowerCase()}` : JSON.stringify(["pass", p.mode, p.startedAt, p.finishedAt]),
      text: redactAddresses(`Pass ${p.result} · ${p.mode}${problems.map((s) => ` · ${s.name}: ${s.outcome}${s.error ? `: ${s.error}` : ""}`).join("")}`),
      href: p.run ? runHref(p.run) : PUBLICATION_HREF,
      linkText: p.run ? `Pass run ${p.run.id}` : "Publication source (no run published; not a run receipt)",
      at: p.finishedAt, source: "passes" });
  }
  // Unknown clocks sort last; lexical ties also select duplicates deterministically.
  const clock = (r: ActivityRow) => r.at && Number.isFinite(Date.parse(r.at)) ? Date.parse(r.at) : -Infinity;
  const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  candidates.sort((a, b) => clock(b) - clock(a) || cmp(a.key, b.key) || cmp(JSON.stringify(a), JSON.stringify(b)));
  const seen = new Set<string>();
  const unique = candidates.filter((r) => !seen.has(r.key) && !!seen.add(r.key));
  const data = passes.data;
  const contextOmitted = context?.omitted ?? 0;
  const passOmitted = data?.omitted ?? 0;
  const passUnreadable = data?.unreadable ?? 0;
  const passDetailsOmitted = data?.passes.reduce((n, p) => n + p.omitted.sections + p.omitted.starts + p.omitted.noStart, 0) ?? 0;
  const displayOmitted = Math.max(0, unique.length - MAX_ACTIVITY_ROWS);
  const omitted = contextOmitted + passOmitted + passUnreadable + passDetailsOmitted + displayOmitted;
  return { rows: unique.slice(0, MAX_ACTIVITY_ROWS), omitted, unlinkable, duplicates: candidates.length - unique.length,
    contextOmitted, passOmitted, passUnreadable, passDetailsOmitted, displayOmitted };
}
