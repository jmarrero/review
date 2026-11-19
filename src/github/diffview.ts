// One file's diff in the review pane: unified or split, syntax colored,
// with word-level changes, expandable context, review-guide hotspots
// tinted with their callouts, and his draft line comments. Everything
// from the PR (code, paths, the guide's reasons) goes in as text nodes.
//
// A file builds its table only when it is open and near the viewport,
// so a PR with thousands of changed lines opens as fast as a small one.

import { h, kids, link } from "../dom.ts";
import { lineDiff } from "./diff.ts";
import {
  displayItems,
  hiddenParts,
  hunkStarts,
  type Hunk,
  type Item,
  isGenerated,
  languageFor,
  type LineRange,
  pairs,
  parseHunks,
  type Row,
  rowsInRange,
  splitRows,
  wordDiff,
} from "./diff.ts";
import { DIFF_COLLAPSE_LINES } from "./config.ts";
import type { DraftComment } from "./forge.ts";
import { type Hotspot, SEVERITY_LABEL, type Skim, worst } from "./guide.ts";
import { highlightLines, overlay, type Seg } from "./highlight.ts";
import type { FileDiff } from "./prs.ts";
import type { DiffLayout } from "./store.ts";

/** Classes the keyboard handler and the pane look for. */
export const FILE_CLASS = "file";
/** Lines shown per click when expanding context. */
export const EXPAND_STEP = 20;
/** Build a file's table once it comes this close to the viewport. */
const RENDER_MARGIN = "1500px 0px";
/** Height reserved per line before a file's table is built, so scrolling stays put. */
const PLACEHOLDER_ROW_PX = 18;

export type Side = "LEFT" | "RIGHT";

/** A hotspot of the guide, with its place in the guide's order. */
export interface PlacedHotspot {
  index: number;
  total: number;
  hotspot: Hotspot;
}

/** Where a line comment can go, and what the pane does with it. */
export interface FileHooks {
  /** The layout to draw. */
  layout(): DiffLayout;
  /** Whether this row may take a comment on this side. */
  commentable(row: Row, side: Side): boolean;
  /** The file's lines at the view's end commit, for expanding context. */
  loadLines(): Promise<string[]>;
  /** His draft comments on this file in this view. */
  drafts(): readonly DraftComment[];
  /** Save a new or edited draft comment (replacing `old` if given). */
  saveDraft(c: DraftComment, old?: DraftComment): void;
  deleteDraft(c: DraftComment): void;
  /** A hotspot's callout was on screen. */
  sawHotspot(index: number): void;
  /** A row was clicked: it becomes the focused line. */
  focused(file: FileView, item: number, side: Side, extend: boolean): void;
  /** Toggle the viewed mark. */
  setViewed(file: FileView, on: boolean): void;
  /** The view's end commit, which comments are anchored to. */
  commit: string;
  /** The view's base (a commit, or PR_BASE), recorded with drafts to show them only where written. */
  base: string;
}

export interface FileInit {
  file: FileDiff;
  hotspots: readonly PlacedHotspot[];
  skim: readonly Skim[];
  viewed: boolean;
  hooks: FileHooks;
  /** Observer shared by the pane, for building near the viewport. */
  lazy?: IntersectionObserver;
  /** Observer shared by the pane, for noticing hotspot callouts on screen. */
  seen?: IntersectionObserver;
}

const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const SIGN: Record<Row["kind"], string> = { add: "+", del: "-", ctx: " " };

function segsNode(segs: readonly Seg[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const s of segs) {
    if (!s.cls && !s.changed) {
      frag.append(document.createTextNode(s.text));
      continue;
    }
    const span = document.createElement("span");
    if (s.cls) span.className = s.cls;
    if (s.changed) span.classList.add("wd");
    span.textContent = s.text;
    frag.append(span);
  }
  return frag;
}

/** Contiguous runs of row items (split by gaps), as item indexes. */
function runs(items: readonly Item[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  items.forEach((it, i) => {
    if (it.t === "gap") {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Syntax-colored segments for every row item, with word-level changes
 * marked on paired lines. Each contiguous run is highlighted as a block,
 * once for the old side and once for the new.
 */
export function rowSegments(items: readonly Item[], lang: string | undefined): Map<number, Seg[]> {
  const out = new Map<number, Seg[]>();
  for (const run of runs(items)) {
    const rows = run.map((i) => (items[i] as Extract<Item, { t: "row" }>).row);
    const oldIdx = run.filter((_, k) => rows[k]?.old !== undefined);
    const newIdx = run.filter((_, k) => rows[k]?.new !== undefined);
    const text = (i: number) => (items[i] as Extract<Item, { t: "row" }>).row.text;
    const oldSegs = oldIdx.some((i) => (items[i] as Extract<Item, { t: "row" }>).row.kind === "del") ? highlightLines(lang, oldIdx.map(text)) : [];
    const newSegs = highlightLines(lang, newIdx.map(text));
    const byOld = new Map(oldIdx.map((i, k) => [i, oldSegs[k] ?? []]));
    const byNew = new Map(newIdx.map((i, k) => [i, newSegs[k] ?? []]));
    const paired = pairs(rows);
    const rowIdx = new Map(rows.map((r, k) => [r, run[k] as number]));
    run.forEach((i, k) => {
      const row = rows[k] as Row;
      let segs = (row.kind === "del" ? byOld.get(i) : byNew.get(i)) ?? [];
      const other = paired.get(row);
      if (other && rowIdx.has(other)) {
        const wd = row.kind === "del" ? wordDiff(row.text, other.text).old : wordDiff(other.text, row.text).new;
        segs = overlay(segs, wd);
      }
      out.set(i, segs);
    });
  }
  return out;
}

/** An open comment box: on which row and side, from which row for a range, editing which draft. */
interface Composer {
  item: number;
  side: Side;
  start?: number;
  old?: DraftComment;
}

export class FileView {
  readonly el: HTMLDetailsElement;
  readonly file: FileDiff;
  readonly hunks: Hunk[] | undefined;
  readonly generated: boolean;
  readonly hotspots: readonly PlacedHotspot[];
  readonly skim: readonly Skim[];
  #hooks: FileHooks;
  #lazy: IntersectionObserver | undefined;
  #seenObs: IntersectionObserver | undefined;
  #body: HTMLElement;
  #viewedBox: HTMLInputElement;
  #expanded: LineRange[] = [];
  #lines: string[] | undefined;
  #linesError: string | undefined;
  items: Item[] = [];
  #rowEls = new Map<number, HTMLTableRowElement>();
  #built = false;
  #wanted = false;
  /** The draft being edited, and where. */
  #composer: Composer | undefined;
  #focus: { item: number; side: Side } | undefined;

  constructor(init: FileInit) {
    const f = init.file;
    this.file = f;
    this.#hooks = init.hooks;
    this.#lazy = init.lazy;
    this.#seenObs = init.seen;
    this.hotspots = init.hotspots;
    this.skim = init.skim;
    this.hunks = f.patch === undefined ? undefined : parseHunks(f.patch);
    this.generated = isGenerated(f.filename);
    this.items = this.hunks ? displayItems(this.hunks, [], this.#noContext() ? [] : undefined) : [];
    const name = f.previous && f.previous !== f.filename ? `${f.previous} → ${f.filename}` : f.filename;
    this.#viewedBox = h("input", { type: "checkbox", class: "viewed", "aria-label": `Viewed ${f.filename}` });
    this.#viewedBox.checked = init.viewed;
    this.#viewedBox.addEventListener("click", (ev) => ev.stopPropagation());
    this.#viewedBox.addEventListener("change", () => this.#hooks.setViewed(this, this.#viewedBox.checked));
    const sev = worst(init.hotspots.map((p) => p.hotspot));
    const skimAll = init.skim.find((s) => s.start === undefined);
    this.el = h(
      "details",
      { class: FILE_CLASS, "data-path": f.filename },
      h(
        "summary",
        {},
        h("span", { class: `fstatus s-${f.status}` }, f.status),
        h("span", { class: "fname" }, name),
        sev ? h("span", { class: `hs-badge sev-${sev}`, title: "Hotspots from the review guide" }, `${init.hotspots.length} hotspot${init.hotspots.length > 1 ? "s" : ""}`) : null,
        this.generated ? h("span", { class: "badge", title: "Generated, vendored, a lock file or test data: collapsed by default" }, "generated") : null,
        skimAll ? h("span", { class: "badge skim", title: `The review guide says: ${skimAll.reason}` }, "skim") : null,
        h("span", { class: "counts" }, h("span", { class: "plus" }, `+${f.additions}`), " ", h("span", { class: "minus" }, `−${f.deletions}`)),
        h("label", { class: "viewed-l", title: "Mark viewed (v); cleared when the file changes" }, this.#viewedBox, " Viewed"),
      ),
    );
    this.#body = h("div", { class: "fbody" });
    this.el.append(this.#body);
    const rows = this.hunks?.reduce((n, hk) => n + hk.rows.length, 0) ?? 0;
    this.#body.style.minHeight = `${Math.min(rows, DIFF_COLLAPSE_LINES) * PLACEHOLDER_ROW_PX}px`;
    this.el.addEventListener("toggle", () => {
      if (this.el.open) this.want();
    });
    this.el.open = !init.viewed && !this.generated && rows <= DIFF_COLLAPSE_LINES;
    if (this.el.open) this.want();
  }

  /** Added and removed files have no unchanged context to expand. */
  #noContext(): boolean {
    return this.file.status === "added" || this.file.status === "removed";
  }

  get hasDiff(): boolean {
    return this.items.length > 0;
  }

  /** Whether its diff was ever built (shown, or about to be). */
  seen(): boolean {
    return this.#built;
  }

  setViewedBox(on: boolean): void {
    this.#viewedBox.checked = on;
  }

  get viewed(): boolean {
    return this.#viewedBox.checked;
  }

  /** Build the table when it nears the viewport (now, without an observer). */
  want(): void {
    if (this.#built || this.#wanted) return;
    this.#wanted = true;
    if (this.#lazy) this.#lazy.observe(this.el);
    else this.build();
  }

  /** Called by the pane's observer when the file nears the viewport. */
  near(): void {
    if (this.#wanted && this.el.open) this.build();
  }

  build(): void {
    if (this.#built) return;
    this.#built = true;
    this.#lazy?.unobserve(this.el);
    this.#body.style.minHeight = "";
    this.render();
  }

  get built(): boolean {
    return this.#built;
  }

  /** Redraw the table (layout change, expansion, drafts), if built. */
  render(): void {
    if (!this.#built) return;
    this.#rowEls.clear();
    for (const tr of this.#body.querySelectorAll("tr.callout")) this.#seenObs?.unobserve(tr);
    if (!this.hunks || !this.hasDiff) {
      this.#body.replaceChildren(h("p", { class: "note nodiff" }, "No diff to show (binary, too large, or a rename only). ", link(this.file.url, "View the file")));
      return;
    }
    const table = this.#hooks.layout() === "split" ? this.#split() : this.#unified();
    const wrap = h("div", { class: "diffwrap" }, table);
    const notes: HTMLElement[] = [];
    if (this.#linesError) notes.push(h("p", { class: "note" }, `Context unavailable: ${this.#linesError}`));
    this.#body.replaceChildren(...notes, wrap);
    if (this.#focus) this.#rowEls.get(this.#focus.item)?.classList.add("focus");
  }

  #lang(): string | undefined {
    const first = this.#lines?.[0] ?? (this.hunks?.[0]?.newStart === 1 ? this.hunks[0].rows.find((r) => r.new === 1)?.text : undefined);
    return languageFor(this.file.filename, first);
  }

  /**
   * Per item: the hotspots covering it, and before which item each
   * callout goes (its first row, so the reason is read before the lines,
   * or the gap hiding them).
   */
  #hotspotLayout(): { cover: Map<number, PlacedHotspot[]>; before: Map<number, PlacedHotspot[]>; top: PlacedHotspot[] } {
    const cover = new Map<number, PlacedHotspot[]>();
    const before = new Map<number, PlacedHotspot[]>();
    const top: PlacedHotspot[] = [];
    const add = (m: Map<number, PlacedHotspot[]>, k: number, p: PlacedHotspot) => m.set(k, [...(m.get(k) ?? []), p]);
    for (const p of this.hotspots) {
      const idx = rowsInRange(this.items, [p.hotspot.start, p.hotspot.end]);
      for (const i of idx) add(cover, i, p);
      const first = idx[0];
      if (first !== undefined) {
        add(before, first, p);
        continue;
      }
      const gap = this.items.findIndex((it) => it.t === "gap" && it.newStart <= p.hotspot.start && (it.newEnd === undefined || it.newEnd >= p.hotspot.start));
      if (gap >= 0) add(before, gap, p);
      else top.push(p);
    }
    return { cover, before, top };
  }

  #cols(): number {
    return this.#hooks.layout() === "split" ? 4 : 3;
  }

  #unified(): HTMLTableElement {
    const segs = rowSegments(this.items, this.#lang());
    const { cover, before, top } = this.#hotspotLayout();
    const body = h("tbody");
    for (const p of top) body.append(this.#callout(p, true));
    this.items.forEach((it, i) => {
      for (const p of before.get(i) ?? []) body.append(this.#callout(p, false));
      if (it.t === "gap") {
        body.append(this.#gapRow(it, i));
      } else {
        const r = it.row;
        const tr = h("tr", { class: this.#rowClass(r, cover.get(i)), "data-i": String(i) });
        const leftSide: Side = r.kind === "del" ? "LEFT" : "RIGHT";
        tr.append(
          this.#ln(r.old, i, "LEFT", r),
          this.#ln(r.new, i, "RIGHT", r),
          this.#code(r, segs.get(i) ?? [], i, leftSide),
        );
        this.#rowEls.set(i, tr);
        body.append(tr);
        this.#afterRow(body, i, r.kind === "ctx" ? ["LEFT", "RIGHT"] : [leftSide]);
      }
    });
    return h("table", { class: "diff unified" }, body);
  }

  #split(): HTMLTableElement {
    const segs = rowSegments(this.items, this.#lang());
    const { cover, before, top } = this.#hotspotLayout();
    const body = h("tbody");
    for (const p of top) body.append(this.#callout(p, true));
    const idxOf = new Map<Row, number>();
    this.items.forEach((it, i) => {
      if (it.t === "row") idxOf.set(it.row, i);
    });
    let i = 0;
    while (i < this.items.length) {
      const it = this.items[i] as Item;
      if (it.t === "gap") {
        for (const p of before.get(i) ?? []) body.append(this.#callout(p, false));
        body.append(this.#gapRow(it, i));
        i++;
        continue;
      }
      // One contiguous run of rows, paired side by side.
      const run: Row[] = [];
      while (i < this.items.length && this.items[i]?.t === "row") run.push((this.items[i++] as Extract<Item, { t: "row" }>).row);
      for (const s of splitRows(run)) {
        const li = s.left ? (idxOf.get(s.left) as number) : undefined;
        const ri = s.right ? (idxOf.get(s.right) as number) : undefined;
        const main = ri ?? (li as number);
        const hs = [...(li !== undefined ? (cover.get(li) ?? []) : []), ...(ri !== undefined && ri !== li ? (cover.get(ri) ?? []) : [])];
        const calls = new Set<PlacedHotspot>([...(li !== undefined ? (before.get(li) ?? []) : []), ...(ri !== undefined ? (before.get(ri) ?? []) : [])]);
        for (const p of calls) body.append(this.#callout(p, false));
        const tr = h("tr", { class: `split${this.#hsClass(hs)}`, "data-i": String(main) });
        if (s.left && li !== undefined) tr.append(this.#ln(s.left.old, li, "LEFT", s.left, s.left.kind), this.#code(s.left, segs.get(li) ?? [], li, "LEFT", s.left.kind));
        else tr.append(h("td", { class: "ln empty" }), h("td", { class: "code empty" }));
        if (s.right && ri !== undefined) tr.append(this.#ln(s.right.new, ri, "RIGHT", s.right, s.right.kind), this.#code(s.right, segs.get(ri) ?? [], ri, "RIGHT", s.right.kind));
        else tr.append(h("td", { class: "ln empty" }), h("td", { class: "code empty" }));
        if (li !== undefined) this.#rowEls.set(li, tr);
        if (ri !== undefined) this.#rowEls.set(ri, tr);
        body.append(tr);
        const sides: Side[] = [];
        if (li !== undefined) sides.push("LEFT");
        if (ri !== undefined) sides.push("RIGHT");
        // Drafts and the composer go after the pair's row, for either side.
        const done = new Set<number>();
        for (const k of [li, ri]) {
          if (k === undefined || done.has(k)) continue;
          done.add(k);
          this.#afterRow(body, k, sides);
        }
      }
    }
    return h("table", { class: "diff split" }, body);
  }

  #hsClass(hs: readonly PlacedHotspot[] | undefined): string {
    const sev = hs?.length ? worst(hs.map((p) => p.hotspot)) : undefined;
    return sev ? ` hs sev-${sev}` : "";
  }

  #rowClass(r: Row, hs: readonly PlacedHotspot[] | undefined): string {
    return `${r.kind}${r.expanded ? " expanded" : ""}${this.#hsClass(hs)}`;
  }

  #ln(n: number | undefined, item: number, side: Side, row: Row, kind?: Row["kind"]): HTMLTableCellElement {
    const td = h("td", { class: `ln${kind ? ` ${kind}` : ""}` }, n === undefined ? "" : String(n));
    if (n !== undefined && this.#hooks.commentable(row, side)) {
      td.classList.add("can-comment");
      td.title = "Comment on this line (c); shift-click for a range";
      td.addEventListener("click", (ev) => {
        const start = ev.shiftKey ? this.#rangeStart(item, side) : undefined;
        this.#hooks.focused(this, item, side, ev.shiftKey);
        this.openComposer(item, side, start);
      });
    } else if (n !== undefined) {
      td.addEventListener("click", () => this.#hooks.focused(this, item, side, false));
    }
    return td;
  }

  #code(r: Row, segs: readonly Seg[], item: number, side: Side, kind?: Row["kind"]): HTMLTableCellElement {
    const td = h("td", { class: `code${kind ? ` ${kind}` : ""}` });
    td.append(h("span", { class: "sign" }, SIGN[r.kind]), segsNode(segs));
    // Like GitHub, point out text that may display other than it reads (Trojan Source).
    if (BIDI_RE.test(r.text)) td.append(h("span", { class: "bidi", title: "This line has bidirectional control characters: it may read differently than it runs" }, " ⚠ bidi"));
    if (r.noNewline) td.append(h("span", { class: "nonl", title: "No newline at end of file" }, " ⊘"));
    td.addEventListener("click", () => this.#hooks.focused(this, item, side, false));
    return td;
  }

  /** Drafts on this row, and the composer if it is open here. */
  #afterRow(body: HTMLElement, item: number, sides: readonly Side[]): void {
    const it = this.items[item];
    if (!it || it.t !== "row") return;
    const lineOf = (side: Side) => (side === "LEFT" ? it.row.old : it.row.new);
    for (const d of this.#hooks.drafts()) {
      if (sides.includes(d.side) && lineOf(d.side) === d.line && (d.side === "LEFT" || it.row.kind !== "del")) body.append(this.#draftRow(d));
    }
    const c = this.#composer;
    if (c && c.item === item && sides.includes(c.side)) body.append(this.#composerRow());
  }

  #rangeStart(item: number, side: Side): number | undefined {
    const f = this.#focus;
    if (!f || f.side !== side || f.item === item) return undefined;
    const a = this.items[f.item];
    const b = this.items[item];
    // A range stays within one hunk, as the API requires, and starts on a line that takes a comment.
    if (a?.t !== "row" || b?.t !== "row" || a.hunk !== b.hunk || a.hunk < 0) return undefined;
    if (!this.#hooks.commentable(a.row, side)) return undefined;
    return Math.min(f.item, item);
  }

  /** Open the comment box on a row (the focused one by default). */
  openComposer(item: number, side: Side, start?: number, old?: DraftComment): boolean {
    const it = this.items[item];
    if (!it || it.t !== "row" || !this.#hooks.commentable(it.row, side)) return false;
    const end = start !== undefined ? Math.max(start, item) : item;
    this.#composer = { item: end, side, ...(start !== undefined && start !== end ? { start } : {}), ...(old ? { old } : {}) };
    this.el.open = true;
    this.build();
    this.render();
    this.#body.querySelector<HTMLTextAreaElement>("tr.composer textarea")?.focus();
    return true;
  }

  #lineOf(item: number, side: Side): number | undefined {
    const it = this.items[item];
    if (!it || it.t !== "row") return undefined;
    return side === "LEFT" ? it.row.old : it.row.new;
  }

  #composerRow(): HTMLTableRowElement {
    const c = this.#composer as Composer;
    const line = this.#lineOf(c.item, c.side) as number;
    const startLine = c.start !== undefined ? this.#lineOf(c.start, c.side) : undefined;
    const text = h("textarea", { rows: "3", "aria-label": "Line comment", placeholder: "Comment on this line; it goes out with your review" });
    if (c.old) text.value = c.old.body;
    const status = h("span", { class: "status" });
    const save = h("button", { type: "button", class: "primary small" }, c.old ? "Update comment" : "Add to review");
    const cancel = h("button", { type: "button", class: "small" }, "Cancel");
    const close = () => {
      this.#composer = undefined;
      this.render();
    };
    const commit = () => {
      if (!text.value.trim()) {
        status.textContent = "Write something first.";
        return;
      }
      const d: DraftComment = { path: this.file.filename, line, side: c.side, body: text.value, commit: this.#hooks.commit, base: this.#hooks.base };
      if (startLine !== undefined && startLine !== line) {
        d.start_line = startLine;
        d.start_side = c.side;
      }
      this.#hooks.saveDraft(d, c.old);
      close();
    };
    save.addEventListener("click", commit);
    cancel.addEventListener("click", close);
    text.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        commit();
      }
    });
    const where = `${c.side === "LEFT" ? "old" : "new"} line${startLine !== undefined ? `s ${startLine}–${line}` : ` ${line}`}`;
    return h(
      "tr",
      { class: "composer" },
      h("td", { colspan: String(this.#cols()) }, h("div", { class: "box" }, h("div", { class: "tag" }, `Comment on ${where}`), text, h("div", { class: "actions" }, save, cancel, status))),
    );
  }

  #draftRow(d: DraftComment): HTMLTableRowElement {
    const edit = h("button", { type: "button", class: "small" }, "Edit");
    const del = h("button", { type: "button", class: "small" }, "Delete");
    edit.addEventListener("click", () => {
      const item = this.items.findIndex((it) => it.t === "row" && (d.side === "LEFT" ? it.row.old : it.row.new) === d.line && (d.side === "LEFT" || it.row.kind !== "del"));
      if (item >= 0) this.openComposer(item, d.side, undefined, d);
    });
    del.addEventListener("click", () => this.#hooks.deleteDraft(d));
    const where = d.start_line !== undefined ? `lines ${d.start_line}–${d.line}` : `line ${d.line}`;
    return h(
      "tr",
      { class: "draft" },
      h("td", { colspan: String(this.#cols()) }, h("div", { class: "box" }, h("div", { class: "tag" }, `Pending comment on ${where} · goes out with your review`), h("pre", { class: "msg" }, d.body), h("div", { class: "actions" }, edit, del))),
    );
  }

  #callout(p: PlacedHotspot, top: boolean): HTMLTableRowElement {
    const hs = p.hotspot;
    const show = h("button", { type: "button", class: "small" }, "Show these lines");
    show.addEventListener("click", () => void this.reveal([hs.start, hs.end]));
    const hidden = hiddenParts(this.items, [hs.start, hs.end]).length > 0;
    const tr = h(
      "tr",
      { class: `callout sev-${hs.severity}`, "data-hs": String(p.index) },
      h(
        "td",
        { colspan: String(this.#cols()) },
        h(
          "div",
          { class: "box" },
          h("span", { class: `chip sev-${hs.severity}` }, SEVERITY_LABEL[hs.severity]),
          h("span", { class: "tag" }, ` ${hs.category} · hotspot ${p.index + 1} of ${p.total} · lines ${hs.start}–${hs.end}`),
          h("p", { class: "reason" }, hs.reason),
          top ? h("p", { class: "note" }, "These lines aren't in this file's diff.") : hidden ? show : null,
        ),
      ),
    );
    this.#seenObs?.observe(tr);
    return tr;
  }

  #gapRow(it: Extract<Item, { t: "gap" }>, i: number): HTMLTableRowElement {
    const count = it.newEnd === undefined ? undefined : it.newEnd - it.newStart + 1;
    const td = h("td", { colspan: String(this.#cols()) });
    const btn = (label: string, title: string, range: LineRange) => {
      const b = h("button", { type: "button", class: "small expand", title }, label);
      b.addEventListener("click", () => void this.expand(range));
      return b;
    };
    const buttons: HTMLElement[] = [];
    const isFirst = i === 0;
    const isLast = i === this.items.length - 1;
    if (count === undefined) {
      buttons.push(btn("↓ Show the rest", "Show the rest of the file", [it.newStart, Number.MAX_SAFE_INTEGER]));
    } else if (count <= EXPAND_STEP * 2) {
      buttons.push(btn(`↕ Show ${count} line${count > 1 ? "s" : ""}`, "Show the hidden lines", [it.newStart, it.newEnd as number]));
    } else {
      if (!isFirst) buttons.push(btn(`↓ ${EXPAND_STEP}`, `Show ${EXPAND_STEP} more lines below the previous hunk`, [it.newStart, it.newStart + EXPAND_STEP - 1]));
      if (!isLast) buttons.push(btn(`↑ ${EXPAND_STEP}`, `Show ${EXPAND_STEP} more lines above the next hunk`, [(it.newEnd as number) - EXPAND_STEP + 1, it.newEnd as number]));
      buttons.push(btn(`Show all ${count}`, "Show all the hidden lines", [it.newStart, it.newEnd as number]));
    }
    const hk = it.before;
    const header = hk ? `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@${hk.section ? ` ${hk.section}` : ""}` : "";
    td.append(...kids(h("span", { class: "gap-buttons" }, ...buttons), header ? h("span", { class: "section" }, header) : null));
    return h("tr", { class: "gap" }, td);
  }

  /** Show more unchanged lines, fetching the file first if needed. */
  async expand(range: LineRange): Promise<void> {
    if (!this.#lines) {
      try {
        this.#lines = await this.#hooks.loadLines();
        this.#linesError = undefined;
      } catch (e) {
        this.#linesError = e instanceof Error ? e.message : String(e);
        this.render();
        return;
      }
    }
    const end = Math.min(range[1], this.#lines.length);
    this.#expanded.push([range[0], end]);
    this.#relayout();
  }

  #relayout(): void {
    const focusRow = this.#focus ? this.items[this.#focus.item] : undefined;
    const composerRow = this.#composer ? this.items[this.#composer.item] : undefined;
    const composerStart = this.#composer?.start !== undefined ? this.items[this.#composer.start] : undefined;
    this.items = this.hunks ? displayItems(this.hunks, this.#expanded, this.#noContext() ? [] : this.#lines) : [];
    // Keep focus and the open composer on the same rows.
    const find = (it: Item | undefined) => (it?.t === "row" ? this.items.findIndex((x) => x.t === "row" && x.row.old === it.row.old && x.row.new === it.row.new && x.row.kind === it.row.kind) : -1);
    if (this.#focus) {
      const i = find(focusRow);
      this.#focus = i >= 0 ? { ...this.#focus, item: i } : undefined;
    }
    if (this.#composer) {
      const i = find(composerRow);
      const start = find(composerStart);
      this.#composer = i >= 0 ? { item: i, side: this.#composer.side, ...(start >= 0 ? { start } : {}), ...(this.#composer.old ? { old: this.#composer.old } : {}) } : undefined;
    }
    this.render();
  }

  /**
   * Make a head-side range visible: open and build the file, and expand
   * any part of it hidden between hunks. Resolves to its first row.
   */
  async reveal(range: LineRange): Promise<HTMLTableRowElement | undefined> {
    this.el.open = true;
    this.build();
    const hidden = hiddenParts(this.items, range);
    if (hidden.length && !this.#noContext()) {
      for (const part of hidden) await this.expand(part);
    }
    const first = rowsInRange(this.items, range)[0];
    return first === undefined ? undefined : this.#rowEls.get(first);
  }

  /** The callout row of a hotspot, if drawn. */
  calloutEl(index: number): HTMLTableRowElement | null {
    return this.#body.querySelector<HTMLTableRowElement>(`tr.callout[data-hs="${index}"]`);
  }

  /** Item indexes where hunks start, for j/k. */
  hunkStarts(): number[] {
    return hunkStarts(this.items);
  }

  get focus(): { item: number; side: Side } | undefined {
    return this.#focus;
  }

  /** Focus a row (or clear with undefined); returns its element. */
  setFocus(item: number | undefined, side?: Side): HTMLTableRowElement | undefined {
    this.#rowEls.get(this.#focus?.item ?? -1)?.classList.remove("focus");
    if (item === undefined) {
      this.#focus = undefined;
      return undefined;
    }
    const it = this.items[item];
    const s: Side = side ?? (it?.t === "row" && it.row.kind === "del" ? "LEFT" : "RIGHT");
    this.#focus = { item, side: s };
    const el = this.#rowEls.get(item);
    el?.classList.add("focus");
    return el;
  }

  rowEl(item: number): HTMLTableRowElement | undefined {
    return this.#rowEls.get(item);
  }
}

/** A whole-text line diff, one line each marked +, - or space. */
export function lineDiffView(before: string, after: string): HTMLElement {
  const pre = h("pre", { class: "line-diff" });
  for (const l of lineDiff(before, after)) pre.append(h("span", { class: `d-${l.kind}` }, `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`));
  return pre;
}
