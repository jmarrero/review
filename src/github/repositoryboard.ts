// Published decisions, not scheduling policy or write authority.
import { h } from "../dom.ts";
import { isObject } from "./heartbeat.ts";
import type { PassView } from "./passview.ts";

interface WorkItem { item: string; kind: string; reason?: string; operator: boolean; taken?: boolean; carried?: boolean; plan_kind?: string; hold_kind?: string; head?: string }
export interface RepositoryWork { reviews_complete: boolean; issues_complete: boolean; count: number; counts: Record<string, number>; omitted: number; items: WorkItem[] }
export interface DispatchableWork { schema: "agent-board/dispatchable-work/v1"; repositories: Record<string, RepositoryWork> }
export interface BoardPublication { work?: DispatchableWork | string | undefined; at?: string | undefined; pass?: PassView | string | undefined; unavailable?: string | undefined }

const repository = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(v) && ![".", ".."].includes(v.split("/")[1]!);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
// The producer truncates to 500 Rust chars (scalar values); a non-BMP char is two UTF-16 units.
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 1000 && [...v].length <= 500;
const token = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v);

/** Bound hostile inventories before rendering; links only use validated identities.
 * The producer caps detail at 200 across repositories. Unknown kinds stay text. */
export function parseDispatchableWork(raw: unknown): DispatchableWork | string {
  const invalid = "Dispatchable work unavailable: malformed or over its publication bounds.";
  if (!isObject(raw) || raw.schema !== "agent-board/dispatchable-work/v1" || !isObject(raw.repositories)) return invalid;
  const entries = Object.entries(raw.repositories);
  if (entries.length > 1000 || new Set(entries.map(([r]) => r.toLowerCase())).size !== entries.length) return invalid;
  let details = 0;
  for (const [name, r] of entries) {
    if (!repository(name) || !isObject(r) || typeof r.reviews_complete !== "boolean" || typeof r.issues_complete !== "boolean"
      || !count(r.count) || !count(r.omitted) || !isObject(r.counts) || Object.keys(r.counts).length > 32
      || Object.entries(r.counts).some(([k, n]) => !token(k) || !count(n) || n > (r.count as number))
      || !Array.isArray(r.items) || (details += r.items.length) > 200 || r.items.length + r.omitted !== r.count) return invalid;
    const seen = new Set<string>();
    for (const i of r.items) {
      if (!isObject(i) || typeof i.item !== "string" || !/^[^#]+#[1-9]\d{0,9}$/.test(i.item)
        || i.item.split("#")[0]!.toLowerCase() !== name.toLowerCase() || seen.has(i.item.toLowerCase())
        || !token(i.kind) || i.reason !== undefined && !text(i.reason) || typeof i.operator !== "boolean"
        || ["taken", "carried"].some((k) => i[k] !== undefined && typeof i[k] !== "boolean")
        || ["plan_kind", "hold_kind"].some((k) => i[k] !== undefined && !token(i[k]))
        || i.head !== undefined && !text(i.head)) return invalid;
      seen.add(i.item.toLowerCase());
    }
    for (const kind of new Set(r.items.map((i) => i.kind))) {
      if (r.items.filter((i) => i.kind === kind).length > ((r.counts[kind] as number | undefined) ?? 0)) return invalid;
    }
  }
  return raw as unknown as DispatchableWork;
}

export function boardRepositories(data: BoardPublication): string[] {
  const names = typeof data.work === "object" ? Object.keys(data.work.repositories) : [];
  if (typeof data.pass === "object") for (const f of data.pass.in_flight) names.push(f.state === "running" ? f.item.split("#")[0]! : f.repository);
  return names;
}

export function boardNote(data: BoardPublication, now: number): HTMLElement {
  const el = h("div", { class: "repository-publication" });
  if (typeof data.work !== "object") el.append(h("p", { class: "note" }, data.work ?? "Dispatchable work not published (off or older producer); ready and blocked are unknown."));
  else {
    const age = data.at ? now - Date.parse(data.at) : NaN;
    el.append(h("p", { class: age > 3_600_000 || age < -60_000 ? "warn" : "note" }, `Work observed ${data.at ?? "unknown"}${age > 3_600_000 ? " · stale (over an hour)" : age < -60_000 ? " · clock is in the future" : ""}. Ready and blocked count this pass's decisions, including taken work, not a live queue.`));
  }
  if (data.unavailable) el.append(h("p", { class: "warn" }, `Pass publication unavailable: ${data.unavailable}; observations are last read, not current.`));
  if (typeof data.pass !== "object") el.append(h("p", { class: "note" }, data.pass ?? "Pass view not published; in flight and in review are unknown."));
  else {
    const p = data.pass, age = now - Date.parse(p.observed_at);
    el.append(h("p", { class: !p.complete || p.omitted || age > 3_600_000 || age < -60_000 ? "warn" : "note" }, `Runs observed ${p.observed_at}${age > 3_600_000 ? " · stale (over an hour)" : age < -60_000 ? " · clock is in the future" : ""} · ${p.complete ? "publisher reports complete" : "incomplete; unread work is unknown"} · ${p.omitted} records omitted. Legacy PR queue/review coverage may be missing.`));
  }
  return el;
}

const itemLink = (item: string, pull = false) => h("a", { href: `https://github.com/${item.replace("#", pull ? "/pull/" : "/issues/")}` }, `#${item.split("#")[1]}`);

/** A single narrow table works at phone widths without a horizontal scroller. */
export function repositoryTable(name: string, data: BoardPublication): HTMLElement {
  const work = typeof data.work === "object" ? Object.entries(data.work.repositories).find(([r]) => r.toLowerCase() === name)?.[1] : undefined;
  const pass = typeof data.pass === "object" ? data.pass : undefined;
  const flights = pass?.in_flight.filter((f) => (f.state === "running" ? f.item.split("#")[0]! : f.repository).toLowerCase() === name) ?? [];
  const readyKinds = ["fix", "rebase", "continue", "merge", "accepted-plan"];
  const unknown = work && Object.keys(work.counts).some((k) => ![...readyKinds, "held"].includes(k));
  const body = h("tbody", {});
  const row = (label: string, n: number | undefined, items: HTMLElement[], listed = false) => body.append(h("tr", {}, h("th", { scope: "row" }, label), h("td", { class: "repository-count" }, n === undefined ? "Unknown" : `${n}${listed ? " listed" : ""}`), h("td", {}, items.length ? h("ul", {}, ...items) : h("span", { class: "note" }, n === 0 ? "None listed" : "No detail published"))));
  const workLine = (i: WorkItem) => h("li", {}, itemLink(i.item), ` · ${i.kind}${i.plan_kind ? ` (${i.plan_kind})` : ""}${i.taken ? " · taken this pass" : ""}${i.carried ? " · carried" : ""}${i.operator ? " · needs operator" : ""}${i.reason ? ` — ${i.reason}` : ""}`);
  row("Ready", work && !unknown ? work.count - (work.counts.held ?? 0) : undefined, work?.items.filter((i) => readyKinds.includes(i.kind)).map(workLine) ?? []);
  row("In flight", pass ? flights.filter((f) => f.state !== "waiting-review").length : undefined, flights.filter((f) => f.state !== "waiting-review").map((f) => {
    if (f.state !== "running") return h("li", {}, itemLink(`${f.repository}#${f.number}`, true), " · merge queue");
    const elapsed = f.started_at ? Date.parse(pass!.observed_at) - Date.parse(f.started_at) : NaN;
    return h("li", {}, itemLink(f.item), " · ", h("a", { class: "run-badge", href: `https://github.com/${f.run.repository}/actions/runs/${f.run.id}` }, `◉ running · ${elapsed >= 0 ? `${Math.floor(elapsed / 60_000)}m at observation` : "runtime unknown"}`), ` · ${f.kind} · ${f.pool}`);
  }), true);
  row("In review", pass ? flights.filter((f) => f.state === "waiting-review").length : undefined, flights.flatMap((f) => f.state === "waiting-review" ? [h("li", {}, itemLink(`${f.repository}#${f.number}`, true), " · waiting review")] : []), true);
  row("Blocked", work ? work.counts.held ?? 0 : undefined, work?.items.filter((i) => i.kind === "held").map(workLine) ?? []);
  const el = h("div", {}, h("table", { class: "repository-table" }, h("caption", {}, `${name} · published work`), h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "State"), h("th", { scope: "col" }, "Count"), h("th", { scope: "col" }, "Items / evidence"))), body));
  if (work) {
    el.append(h("p", { class: !work.reviews_complete || !work.issues_complete || work.omitted ? "warn" : "note" }, `PR decisions ${work.reviews_complete ? "complete" : "incomplete"} · issue plans ${work.issues_complete ? "complete" : "incomplete"} · ${work.count} decisions · ${work.omitted} items omitted. Incomplete coverage is not an empty queue.`));
    el.append(h("p", { class: "note" }, `Published kinds: ${Object.entries(work.counts).map(([k, n]) => `${k}: ${n}`).join(" · ") || "none"}. Accepted-plan counts can include held plans; kinds are not additive.`));
    if (unknown) el.append(h("p", { class: "warn" }, "Unknown decision kinds; ready total unavailable."));
  }
  return el;
}
