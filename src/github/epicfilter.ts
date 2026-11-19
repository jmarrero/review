// Display-only filtering of the publisher's epic index. No extra forge reads.
import { h } from "../dom.ts";
import { TRACKER_REPO } from "./config.ts";
import type { InboxEpic } from "./holds.ts";
import type { Card } from "./inbox.ts";
import { load, save } from "./store.ts";

export type EpicFilter = "active" | "all" | "other" | "none" | `epic:${string}`;
const valid = (v: unknown): v is EpicFilter => typeof v === "string" && (/^(active|all|other|none)$/.test(v) || /^epic:[a-z0-9_.-]+\/[a-z0-9_.-]+#[1-9]\d{0,9}$/.test(v));

export function epicChoice(login: string | undefined, hash: string): EpicFilter {
  const deep = /^#epic-([1-9]\d{0,9})$/.exec(hash);
  if (deep) return `epic:${TRACKER_REPO.toLowerCase()}#${deep[1]}`;
  return login ? load(`inbox.epic.${login.toLowerCase()}`, "active", valid) : "active";
}

export function saveEpicChoice(login: string | undefined, choice: EpicFilter): void {
  if (login) save(`inbox.epic.${login.toLowerCase()}`, choice);
}

const refs = (c: Card): string[] => "ask" in c ? [c.ask.epic, c.ask.topEpic].filter((v): v is string => !!v && v !== "none") : [];

/** Kinds that wait only on the operator's approving review, even as a placeholder without its detail. */
const APPROVALS = ["review-approve", "review-withheld", "digest-approve"];
const approval = (c: Card): boolean => c.kind === "approve" || c.kind === "digest" || ("ask" in c && APPROVALS.includes(c.ask.kind));

/** `waits` tells the rows the chips count, as the heading does, from those completed here. */
export function epicSelection(cards: readonly Card[], epics: readonly InboxEpic[] | undefined, choice: EpicFilter, waits: (c: Card) => boolean = () => true) {
  const active = (epics ?? []).filter((e) => e.active).sort((a, b) => Number(b.focus) - Number(a.focus));
  const activeIds = new Set(active.map((e) => e.item));
  const partialIds = new Set((epics ?? []).filter((e) => !e.active && !e.complete).map((e) => e.item));
  // Not proof of inactivity (agent-board's docs/pass.md): no epic published, an
  // unknown chain, or an epic whose activity was read in part. The default keeps these.
  const uncertain = (c: Card, ids: string[]): boolean => !("ask" in c) || !c.ask.epic || ids.some((id) => id === "unknown" || partialIds.has(id));
  const inProgress = (c: Card, ids: string[]): boolean => ids.some((id) => activeIds.has(id));
  const matches = (c: Card, f: EpicFilter): boolean => {
    const ids = refs(c);
    // With no epic in progress, the default hides nothing.
    if (f === "all" || (f === "active" && !active.length)) return true;
    if (f === "active") return approval(c) || inProgress(c, ids) || uncertain(c, ids);
    if (f === "none") return "ask" in c && c.ask.epic === "none" && c.ask.topEpic === "none";
    if (f === "other") return !ids.some((id) => activeIds.has(id)) && !matches(c, "none");
    return ids.includes(f.slice(5));
  };
  const selected = cards.filter((c) => matches(c, choice));
  // Approvals first across epics, placeholders included: a detail the pass cut
  // must not bury a decision that only needs his review. Full rows before
  // placeholders within each tier. Unknowns remain distinct from explicit none
  // and reachable through Other / All.
  const epicRanks = new Map(active.map((e, i) => [e.item, i]));
  const groups = new Map(cards.map((c) => {
    const ids = refs(c);
    const rank = Math.min(...ids.map((id) => epicRanks.get(id) ?? active.length), active.length);
    return [c, { rank, item: active[rank]?.item ?? ids[0] ?? "~" }];
  }));
  const local = (c: Card) => c.kind === "document" || c.kind === "send";
  const ordered = [...cards].sort((a, b) => {
    const ag = groups.get(a)!, bg = groups.get(b)!;
    return Number(a.answered === true) - Number(b.answered === true)
      || Number(local(a)) - Number(local(b))
      || Number(approval(b)) - Number(approval(a))
      || Number("ask" in a && !!a.ask.detailMissing) - Number("ask" in b && !!b.ask.detailMissing)
      || (epics === undefined ? 0 : ag.rank - bg.rank
      // Code point order: "~" (no epic) sorts after every OWNER/REPO#N and "unknown".
      || Number(ag.item > bg.item) - Number(ag.item < bg.item)
      || (a.priority ?? "P9").localeCompare(b.priority ?? "P9") || (a.since ?? "~").localeCompare(b.since ?? "~"));
  });
  const unsure = active.length ? cards.filter((c) => !inProgress(c, refs(c)) && uncertain(c, refs(c))).length : 0;
  return { active, unsure, selected, ordered, hidden: cards.length - selected.length, count: (f: EpicFilter) => cards.filter((c) => waits(c) && matches(c, f)).length };
}

/** The pass's activity reasons in words; a newer one is shown as published. */
const WHY: Record<string, string> = { focus: "focus", "recent-run": "a run in 48 hours", "open-pr": "an open PR", "operator-comment": "the operator's comment this week" };

export function epicChips(model: ReturnType<typeof epicSelection>, choice: EpicFilter, choose: (f: EpicFilter) => void): HTMLElement {
  const chip = (f: EpicFilter, label: string, title?: string) => {
    const b = h("button", { type: "button", class: "small", "data-epic-choice": f, "aria-pressed": String(f === choice), ...(title ? { title } : {}) }, `${label} · ${model.count(f)}`);
    b.addEventListener("click", () => choose(f));
    return b;
  };
  // The pass publishes no epic titles: `repo#N`, with the owner where two would read the same.
  const short = (item: string): string => item.slice(item.indexOf("/") + 1);
  const name = (item: string): string => model.active.filter((e) => short(e.item) === short(item)).length > 1 ? item : short(item);
  const why = model.active.map((e) => `${name(e.item)} (${e.activeWhy.map((w) => WHY[w] ?? w).join(", ") || "no reason published"})`).join(", ");
  return h("div", { class: "epic-filter" },
    h("p", { class: "note" }, model.active.length ? `${model.active.length} epic${model.active.length === 1 ? "" : "s"} in progress: ${why}. Shown by default, plus approvals` : "No epic is published as in progress. The default shows all published rows.",
      model.active.length ? (model.unsure ? `, with ${model.unsure} whose epic is unknown or not read whole.` : ".") : ""),
    h("div", { class: "epic-chips", role: "group", "aria-label": "Filter by epic" }, chip("active", model.active.length ? "In progress + approvals" : "Default (all)"),
      ...model.active.map((e) => chip(`epic:${e.item}`, `${e.focus ? "Focus: " : ""}${name(e.item)}`, e.item)),
      chip("other", "Other epics", "Inactive epics, and items whose epic the pass could not read"), chip("none", "No epic"), chip("all", "Show everything")),
    choice !== "active" ? h("p", { class: "note" }, `Selected: ${choice.startsWith("epic:") ? choice.slice(5) : choice === "all" ? "all published rows" : choice === "none" ? "no epic" : "other epics"}.`) : null);
}
