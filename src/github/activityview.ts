import { h, link } from "../dom.ts";
import { publishedActivity, PUBLICATION_HREF } from "./activity.ts";
import type { Published } from "./inbox.ts";
import { redactAddresses, stale } from "./passes.ts";
import type { PassesRead } from "./passesview.ts";

const clock = (at: string | undefined, now: number): string => at ? `${at}${stale(at, now) ? " (stale / future clock)" : ""}` : "unknown";

export function activityView(published: Published, passes: PassesRead, now = Date.now(), contextReadError?: string): HTMLElement {
  const feed = publishedActivity(published, passes);
  const context = published.list?.context;
  const lastContext = published.unavailable || published.checkedAt === undefined || !!contextReadError;
  const el = h("section", { class: "published-activity", "aria-label": "Published activity" },
    h("h2", {}, "Published activity"),
    h("p", { class: "note" }, "Bounded published observations, not every controller tick or a complete event log. Snapshot facts are not newly created decisions. ", link(PUBLICATION_HREF, "Publication source")),
    h("p", { class: "note" }, `Context: ${context ? "observed " + clock(context.observedAt, now) : "not published / unknown"} · publication validated ${clock(published.list?.validatedAt, now)}${lastContext ? " · last-read / cached; not confirmed" : " · confirmed read"}${published.unavailable ? " · failed/unavailable read" : ""}${contextReadError || published.error ? ` · ${redactAddresses(contextReadError ?? published.error!)}` : ""}. Coverage: ${Object.entries(context?.sources ?? {}).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "unknown"}. ${feed.contextOmitted} context facts omitted; ${feed.unlinkable} unlinkable.`),
    h("p", { class: "note" }, `Passes: published ${clock(passes.data?.publishedAt, now)} · ${passes.data ? `${passes.data.passes.length} readable, newest ${passes.data.retention} retained` : passes.absent ? "not published" : "unknown"}${passes.unavailable ? ` · failed/unavailable read; last-read facts: ${redactAddresses(passes.unavailable)}` : ""}. Coverage: independent bounded pass history only; context is a snapshot.`),
    h("p", { class: "note" }, `Pass coverage: ${feed.passOmitted} passes omitted, ${feed.passUnreadable} unreadable, ${feed.passDetailsOmitted} section/start/reason details omitted. Feed: ${feed.displayOmitted} rows excluded by display cap; ${feed.duplicates} duplicates suppressed. Known total: ${feed.omitted} records/details omitted; unpublished coverage is unknown.`));
  el.append(feed.rows.length ? h("ol", { class: "activity-list" }, ...feed.rows.map((r) => h("li", { class: "activity-row" },
    link(r.href, r.linkText), ` · ${r.text} · ${r.source === "passes" ? "finished" : "observed"} ${clock(r.at, now)}${r.since ? ` · since ${r.since}` : ""}${(r.source === "context" ? lastContext : !!passes.unavailable) ? " · last-read" : ""}`)))
    : h("p", { class: "note" }, "No observed records in these bounded publications; this does not mean no activity."));
  return el;
}
