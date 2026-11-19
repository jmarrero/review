// Read-only projection of agent-board's docs/pass.md#epic-focus. Never infer
// progress, blockers or ordering from the board or use these facts for writes.
import { h } from "../dom.ts";
import { isObject, time } from "./heartbeat.ts";
import { agoLabel } from "./view.ts";
import { load, save } from "./store.ts";

const STALE_MS = 60 * 60_000;

interface Blocker {
  type: "operator" | "ci" | "review" | "hold" | "not-started" | "unknown";
  kind: string | null;
  reason: string | null;
  since: string | null;
  pull: string | null;
}

interface Child {
  item: string | null;
  url: string | null;
  title: string | null;
  source: "both" | "sub-issue" | "task";
  state: "open" | "done";
  blocker: Blocker | null;
}

interface Epic extends Omit<Child, "source" | "state"> {
  item: string;
  url: string;
  goal: string | null;
  changed_at: string | null;
  progress: { done: number; total: number };
  operator_blocked: number;
  runs: { item: string; kind: string; pool: string; run: { repository: string; id: number }; started_at?: string | null }[];
  runs_omitted: number;
  children: Child[];
  omitted: number;
}

export interface Focus {
  schema: "agent-board/epic-focus/v1";
  observed_at: string;
  priority: "P0";
  complete: boolean;
  sources: { epics: "complete" | "partial" | "unread"; runs: "complete" | "unread"; board: "complete" | "unread" };
  unread_epics: number;
  omitted: number;
  epics: Epic[];
}

const repository = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v) && v.length <= 200 && !v.split("/").some((s) => s === "." || s === "..");
const item = (v: unknown): v is string => typeof v === "string" && /^[^#]+#[1-9]\d{0,9}$/.test(v) && repository(v.split("#")[0]);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
// Producer clip() counts Rust chars, not UTF-16 code units. Check the cheap
// upper bound first so a hostile string cannot grow the code-point array.
const text = (v: unknown, max = 240): v is string => typeof v === "string" && v.length <= max * 2 && Array.from(v).length <= max && !/[\r\n]/.test(v);
const nullableText = (v: unknown, max = 240) => v === null || text(v, max);
const clock = (v: unknown) => v === null || !!time(v);
const issueUrl = (ref: string) => `https://github.com/${ref.replace("#", "/issues/")}`;
const pullUrl = (ref: string) => `https://github.com/${ref.replace("#", "/pull/")}`;

function blocker(v: unknown): boolean {
  return v === null || (isObject(v) && ["operator", "ci", "review", "hold", "not-started", "unknown"].includes(v.type as string) &&
    nullableText(v.kind) && nullableText(v.reason) && clock(v.since) && (v.pull === null || item(v.pull)));
}

function child(v: unknown): boolean {
  return isObject(v) && (v.item === null ? v.url === null && v.source === "task" : item(v.item) && v.url === issueUrl(v.item)) &&
    nullableText(v.title, 120) && ["both", "sub-issue", "task"].includes(v.source as string) && ["open", "done"].includes(v.state as string) && blocker(v.blocker);
}

function epic(v: unknown): boolean {
  return isObject(v) && item(v.item) && v.url === issueUrl(v.item) && nullableText(v.title, 120) && nullableText(v.goal) && clock(v.changed_at) &&
    isObject(v.progress) && count(v.progress.done) && count(v.progress.total) && v.progress.done <= v.progress.total && count(v.operator_blocked) && blocker(v.blocker) &&
    Array.isArray(v.runs) && v.runs.length <= 8 && v.runs.every((r) => isObject(r) && item(r.item) && text(r.kind, 64) && text(r.pool, 64) &&
      isObject(r.run) && repository(r.run.repository) && Number.isSafeInteger(r.run.id) && (r.run.id as number) > 0 && (r.started_at === undefined || clock(r.started_at))) &&
    count(v.runs_omitted) && Array.isArray(v.children) && v.children.length <= 50 && v.children.every(child) && count(v.omitted);
}

/** Bound publisher inventories to stop unbounded DOM growth; validate typed
 * identities so publisher-supplied URLs cannot become arbitrary navigation.
 * Reject the extension whole, never drop a malformed child and imply progress. */
export function parseFocus(raw: unknown): Focus | string {
  if (!isObject(raw) || raw.schema !== "agent-board/epic-focus/v1") return "Focus unavailable: unsupported schema";
  if (!time(raw.observed_at) || raw.priority !== "P0" || typeof raw.complete !== "boolean" || !isObject(raw.sources) ||
      !["complete", "partial", "unread"].includes(raw.sources.epics as string) || !["complete", "unread"].includes(raw.sources.runs as string) ||
      !["complete", "unread"].includes(raw.sources.board as string) || !count(raw.unread_epics) || !count(raw.omitted) ||
      !Array.isArray(raw.epics) || raw.epics.length > 10 || !raw.epics.every(epic)) return "Focus unavailable: malformed publication";
  return raw as unknown as Focus;
}

function blockerView(b: Blocker | null): HTMLElement {
  if (!b) return h("span", {}, "Moving");
  const labels = { operator: "Waiting on operator", ci: "Waiting on CI", review: "Waiting on review or merge", hold: `On hold${b.kind ? ` (${b.kind})` : ""}`, "not-started": "Nothing moving it now", unknown: "Blocker unknown" };
  return h("span", {}, labels[b.type], b.reason ? ` — ${b.reason}` : "", b.pull ? h("span", {}, " · ", h("a", { href: pullUrl(b.pull) }, b.pull)) : "");
}

export function focusView(data: Focus | string | undefined, now: number, unavailable?: string, login?: string): HTMLElement {
  const el = h("section", { class: "focus", "aria-label": "Focus" }, h("h2", {}, "Focus"));
  if (!data || typeof data === "string") {
    el.append(h("p", { class: "note" }, data ?? (unavailable
      ? `Focus unavailable: ${unavailable}; work and blockers are unknown.`
      : "Focus is not published (holds.epicFocus is off or unavailable); work and blockers are unknown.")));
    return el;
  }
  if (unavailable) el.append(h("p", { class: "note" }, `Focus unavailable: ${unavailable}; published facts below are not confirmed current.`));
  const age = now - Date.parse(data.observed_at);
  el.append(h("p", { class: "note" }, "P0 · Observed ", agoLabel(data.observed_at, now),
    age > STALE_MS ? " · stale (over an hour); facts are last observed, not current" : age < -60_000 ? " · clock is in the future; current state unknown" : "",
    ` · complete:${data.complete} · ${Object.entries(data.sources).map(([k, v]) => `${k}: ${v}`).join(" · ")} · ${data.omitted} epics omitted · ${data.unread_epics} unread epics`));
  for (const e of data.epics) {
    const open = e.children.filter((c) => c.state === "open");
    const done = e.children.filter((c) => c.state === "done");
    const topBlocker = e.blocker ?? open.find((c) => c.blocker?.type === "operator")?.blocker ?? open.find((c) => c.blocker)?.blocker ?? null;
    const card = h("details", { class: "focus-card" }, h("summary", {},
      h("h3", {}, h("a", { href: issueUrl(e.item) }, e.title ?? e.item)),
      h("p", {}, e.goal ?? "Goal not published"), h("p", { class: "note" }, `${e.progress.done}/${e.progress.total} done · ${e.operator_blocked} operator blocked`),
      h("p", {}, blockerView(topBlocker))));
    const key = login ? `focus.expanded.${login.toLowerCase()}.${e.item.toLowerCase()}` : undefined;
    card.open = key ? load(key, false, (v): v is boolean => typeof v === "boolean") : false;
    card.addEventListener("toggle", (event) => {
      if (event.target === card && key) save(key, card.open);
    });
    card.append(h("p", { class: "note" }, ...(e.changed_at ? ["Changed ", agoLabel(e.changed_at, now)] : ["Change time unknown"])));
    const runs = h("ul", { class: "focus-runs" });
    for (const r of e.runs) runs.append(h("li", {}, h("a", { href: issueUrl(r.item) }, r.item), ` · ${r.kind} · ${r.pool} · `,
      h("a", { href: `https://github.com/${r.run.repository}/actions/runs/${r.run.id}` }, `${r.run.repository}/${r.run.id}`)));
    card.append(runs, h("p", { class: "note" }, `${e.runs.length} runs listed · ${e.runs_omitted} runs omitted`));
    const childrenView = (items: Child[]) => h("ul", { class: "focus-children" }, ...items.map((c) => h("li", {},
      c.item ? h("a", { href: issueUrl(c.item) }, c.title ?? c.item) : h("span", {}, c.title ?? "Untitled task"),
      " · ", c.state === "done" ? h("span", {}, "Done") : blockerView(c.blocker))));
    card.append(childrenView(open));
    if (done.length) card.append(h("details", { class: "focus-done" }, h("summary", {}, `${done.length} done`), childrenView(done)));
    card.append(h("p", { class: "note" }, `${e.omitted} children omitted`));
    el.append(card);
  }
  if (!data.epics.length) el.append(h("p", { class: "note" }, "No P0 epic cards listed; coverage is described above."));
  return el;
}
