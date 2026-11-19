// Pure diff model for the review pane: hunks parsed from the per-file
// patch GitHub gives, rows paired for the split view, word-level changes
// within paired lines, the unchanged stretches between hunks that can be
// expanded from the file at the head, and head-side line ranges mapped
// onto what is shown. No DOM here, so tests cover it directly.

export type RowKind = "ctx" | "add" | "del";

export interface Row {
  kind: RowKind;
  text: string;
  /** Line number in the old file (del, ctx). */
  old?: number;
  /** Line number in the new file (add, ctx). */
  new?: number;
  /** The patch said "\ No newline at end of file" after this line. */
  noNewline?: boolean;
  /** Shown from the file itself (expanded context), not from the patch. */
  expanded?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second @@: usually the enclosing function. */
  section: string;
  rows: Row[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parse the unified diff GitHub gives per file (the `patch` of a PR or
 * compare file: hunks only, no file headers). Lines before the first
 * hunk header are ignored.
 */
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      cur = {
        oldStart: oldNo,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newNo,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? "",
        rows: [],
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "\\") {
      const last = cur.rows.at(-1);
      if (last) last.noNewline = true;
    } else if (mark === "+") cur.rows.push({ kind: "add", text, new: newNo++ });
    else if (mark === "-") cur.rows.push({ kind: "del", text, old: oldNo++ });
    else cur.rows.push({ kind: "ctx", text, old: oldNo++, new: newNo++ });
  }
  return out;
}

/** One line of the split view: the old side, the new side, or both. */
export interface SplitRow {
  left?: Row;
  right?: Row;
}

/**
 * Pair rows for the split view: context on both sides, and each run of
 * deletions with the run of additions right after it, line by line.
 */
export function splitRows(rows: readonly Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i] as Row;
    if (r.kind === "ctx") {
      out.push({ left: r, right: r });
      i++;
      continue;
    }
    const dels: Row[] = [];
    const adds: Row[] = [];
    while (i < rows.length && rows[i]?.kind === "del") dels.push(rows[i++] as Row);
    while (i < rows.length && rows[i]?.kind === "add") adds.push(rows[i++] as Row);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const s: SplitRow = {};
      const d = dels[k];
      const a = adds[k];
      if (d) s.left = d;
      if (a) s.right = a;
      out.push(s);
    }
  }
  return out;
}

/**
 * The deleted and added row paired with each other, as the split view
 * pairs them, for word-level highlighting in either view.
 */
export function pairs(rows: readonly Row[]): Map<Row, Row> {
  const out = new Map<Row, Row>();
  for (const s of splitRows(rows)) {
    if (s.left && s.right && s.left !== s.right) {
      out.set(s.left, s.right);
      out.set(s.right, s.left);
    }
  }
  return out;
}

/** A half-open range of UTF-16 offsets in a line. */
export type Span = readonly [start: number, end: number];

export interface WordDiff {
  /** Changed spans in the old line. */
  old: Span[];
  /** Changed spans in the new line. */
  new: Span[];
}

/** Lines longer than this get no word diff: it would cost more than it tells. */
export const WORD_DIFF_MAX_CHARS = 1000;
/** Nor lines whose token counts multiply past this. */
const WORD_DIFF_MAX_CELLS = 250_000;
/** Above this fraction of changed characters, word highlights are noise. */
const WORD_DIFF_MAX_CHANGED = 0.6;

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

function tokens(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

function mergeSpans(spans: Span[]): Span[] {
  const out: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = out.at(-1);
    if (last && last[1] >= s) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The spans that changed between an old and a new line, by words (runs
 * of letters, digits and _), runs of spaces and single punctuation. A
 * longest common subsequence decides what stayed; nothing is returned
 * when the lines share too little for word highlights to help.
 */
export function wordDiff(a: string, b: string): WordDiff {
  const none: WordDiff = { old: [], new: [] };
  if (a === b || a.length > WORD_DIFF_MAX_CHARS || b.length > WORD_DIFF_MAX_CHARS) return none;
  const ta = tokens(a);
  const tb = tokens(b);
  // Trim the common prefix and suffix first: most edits are small.
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const ma = ta.slice(pre, ta.length - suf);
  const mb = tb.slice(pre, tb.length - suf);
  if (ma.length * mb.length > WORD_DIFF_MAX_CELLS) return none;
  // LCS table over the middle, then walk it for the kept tokens.
  const n = ma.length;
  const m = mb.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = ma[i] === mb[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  const keptA = new Array<boolean>(n).fill(false);
  const keptB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ma[i] === mb[j]) {
      keptA[i++] = true;
      keptB[j++] = true;
    } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) i++;
    else j++;
  }
  const spansOf = (all: string[], kept: boolean[]): { spans: Span[]; changed: number } => {
    const spans: Span[] = [];
    let off = 0;
    let changed = 0;
    for (let i = 0; i < pre; i++) off += (all[i] as string).length;
    for (let i = 0; i < kept.length; i++) {
      const t = all[pre + i] as string;
      if (!kept[i]) {
        spans.push([off, off + t.length]);
        changed += t.length;
      }
      off += t.length;
    }
    return { spans: mergeSpans(spans), changed };
  };
  const oa = spansOf(ta, keptA);
  const ob = spansOf(tb, keptB);
  const total = a.length + b.length;
  if (total > 0 && (oa.changed + ob.changed) / total > WORD_DIFF_MAX_CHANGED) return none;
  return { old: oa.spans, new: ob.spans };
}

/** A line of `lineDiff`, kept, added or deleted. */
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Middles whose line counts multiply past this are shown replaced whole. */
const LINE_DIFF_MAX_CELLS = 1_000_000;

/**
 * The lines of `before` and `after`, ignoring line endings and trailing
 * blank lines, as kept, added or deleted. Like wordDiff, a longest common
 * subsequence decides what stayed over the middle left by the common
 * prefix and suffix; a middle too large for that (a rewritten 64 KiB
 * file) is shown deleted, then added, rather than costing seconds.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const b = after.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);
  const line = (kind: DiffLine["kind"]) => (text: string): DiffLine => ({ kind, text });
  const out = a.slice(0, pre).map(line("same"));
  const n = ma.length;
  const m = mb.length;
  if (n * m > LINE_DIFF_MAX_CELLS) out.push(...ma.map(line("del")), ...mb.map(line("add")));
  else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ma[i] === mb[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
      }
    }
    for (let i = 0, j = 0; i < n || j < m; ) {
      if (i < n && j < m && ma[i] === mb[j]) {
        out.push(line("same")(ma[i++] as string));
        j++;
      } else if (j < m && (i >= n || (dp[i * w + j + 1] as number) >= (dp[(i + 1) * w + j] as number))) out.push(line("add")(mb[j++] as string));
      else out.push(line("del")(ma[i++] as string));
    }
  }
  out.push(...a.slice(a.length - suf).map(line("same")));
  return out;
}

/** An inclusive range of new-side line numbers. */
export type LineRange = readonly [start: number, end: number];

/** What a file's diff shows, in order: rows, and hidden unchanged stretches between them. */
export type Item =
  | { t: "row"; row: Row; hunk: number }
  | {
      t: "gap";
      /** First hidden new-side line. */
      newStart: number;
      /** Last hidden new-side line; undefined when the file's length isn't known yet. */
      newEnd: number | undefined;
      /** Old-side line of newStart. */
      oldStart: number;
      /** The hunk right after the gap (its section heading), if any. */
      before?: Hunk;
    };

function mergeRanges(ranges: readonly LineRange[]): [number, number][] {
  const sorted = [...ranges].filter(([s, e]) => e >= s).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out.at(-1);
    if (last && last[1] + 1 >= s) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * The rows and gaps of a file's diff with some unchanged lines expanded.
 * `lines` is the file at the head (undefined until fetched: then nothing
 * is expanded, and the gap after the last hunk has no known end).
 * Unchanged lines are the same on both sides, so the head's copy serves
 * for both; the offset between hunks gives the old-side numbers.
 */
export function displayItems(hunks: readonly Hunk[], expanded: readonly LineRange[], lines: readonly string[] | undefined): Item[] {
  const out: Item[] = [];
  const shown = lines ? mergeRanges(expanded) : [];
  // The new-side line after the previous hunk, and the old-new offset there.
  let nextNew = 1;
  let delta = 0;
  const gap = (from: number, to: number | undefined, before: Hunk | undefined) => {
    const hidden = (s: number, e: number | undefined): Item => ({ t: "gap", newStart: s, newEnd: e, oldStart: s + delta, ...(before ? { before } : {}) });
    let at = from;
    for (const [s, e] of shown) {
      if (to !== undefined && s > to) break;
      const lo = Math.max(s, at);
      const hi = to === undefined ? e : Math.min(e, to);
      if (lo > hi) continue;
      if (lo > at) out.push(hidden(at, lo - 1));
      for (let n = lo; n <= hi; n++) {
        out.push({ t: "row", hunk: -1, row: { kind: "ctx", text: lines?.[n - 1] ?? "", old: n + delta, new: n, expanded: true } });
      }
      at = hi + 1;
    }
    if (to === undefined || at <= to) out.push(hidden(at, to));
  };
  hunks.forEach((h, i) => {
    // A new file's hunk starts at +1 (or +0 when empty); nothing hides before it.
    const start = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    if (start > nextNew) gap(nextNew, start - 1, h);
    for (const row of h.rows) out.push({ t: "row", row, hunk: i });
    nextNew = h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines;
    delta = (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart + h.oldLines) - nextNew;
  });
  if (hunks.length > 0) gap(nextNew, lines?.length, undefined);
  return out;
}

/**
 * Each item's head-side position, for mapping head-side ranges: a row's
 * new line, and a deleted row's the new line that follows it (so a range
 * pointing at the line after a deletion covers the deletion too). Gaps
 * get -1.
 */
export function positions(items: readonly Item[]): number[] {
  const out = new Array<number>(items.length).fill(-1);
  let next: number | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as Item;
    if (it.t === "gap") {
      next = it.newStart;
      continue;
    }
    if (it.row.new !== undefined) {
      out[i] = it.row.new;
      next = it.row.new;
    } else {
      out[i] = next ?? lastNew(items) + 1;
    }
  }
  return out;
}

function lastNew(items: readonly Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as Item;
    if (it.t === "row" && it.row.new !== undefined) return it.row.new;
    if (it.t === "gap" && it.newEnd !== undefined) return it.newEnd;
  }
  return 0;
}

/** Indexes of the rows whose head-side position is within `range`. */
export function rowsInRange(items: readonly Item[], range: LineRange): number[] {
  const pos = positions(items);
  const out: number[] = [];
  items.forEach((it, i) => {
    const p = pos[i] as number;
    if (it.t === "row" && p >= range[0] && p <= range[1]) out.push(i);
  });
  return out;
}

/** The parts of `range` hidden in gaps: what to expand to show all of it. */
export function hiddenParts(items: readonly Item[], range: LineRange): LineRange[] {
  const out: LineRange[] = [];
  for (const it of items) {
    if (it.t !== "gap") continue;
    const end = it.newEnd ?? Number.MAX_SAFE_INTEGER;
    const s = Math.max(it.newStart, range[0]);
    const e = Math.min(end, range[1]);
    if (s <= e) out.push([s, e]);
  }
  return out;
}

/** Index of the first row of each hunk (and of each expanded stretch run into one), for j/k. */
export function hunkStarts(items: readonly Item[]): number[] {
  const out: number[] = [];
  let prev: number | undefined;
  items.forEach((it, i) => {
    if (it.t !== "row" || it.hunk < 0) {
      prev = undefined;
      return;
    }
    if (it.hunk !== prev) out.push(i);
    prev = it.hunk;
  });
  return out;
}

// Files that are generated, vendored, locked or test data: collapsed by
// default, since reading them line by line is rarely the review.
const GENERATED_NAMES = new Set(["Cargo.lock", "go.sum", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "flake.lock", "uv.lock"]);
const GENERATED_DIRS = new Set(["vendor", "node_modules", "fixtures", "testdata", "__snapshots__"]);
const GENERATED_SUFFIXES = [".lock", ".min.js", ".min.css", ".pb.go", "_pb2.py", ".snap"];

/** Whether a file is generated, vendored, a lock file or a fixture. */
export function isGenerated(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return GENERATED_NAMES.has(name) || parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p)) || GENERATED_SUFFIXES.some((s) => name.endsWith(s));
}

const LANG_BY_EXT: Record<string, string> = {
  rs: "rust", go: "go", sh: "bash", bash: "bash", bats: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", md: "markdown", markdown: "markdown", json: "json",
  c: "c", h: "c", nu: "nu", spec: "rpm-spec", mk: "makefile",
  dockerfile: "dockerfile", containerfile: "dockerfile",
};
const LANG_BY_NAME: Record<string, string> = {
  Dockerfile: "dockerfile", Containerfile: "dockerfile", Makefile: "makefile", GNUmakefile: "makefile",
  Justfile: "makefile", justfile: "makefile", "Cargo.lock": "ini",
};
const SHEBANG_LANG: [RegExp, string][] = [
  [/\b(?:ba|z|da)?sh\b/, "bash"],
  [/\bnode\b|\bdeno\b|\bbun\b/, "javascript"],
  [/\bpython[0-9.]*\b/, "python"],
  [/\bnu\b/, "nu"],
];

/**
 * The highlighting language for a path, by name or extension, else by a
 * `#!` first line when one is known.
 */
export function languageFor(path: string, firstLine?: string): string | undefined {
  const name = path.split("/").at(-1) ?? "";
  const byName = LANG_BY_NAME[name] ?? (/^(?:Docker|Container)file\./.test(name) ? "dockerfile" : undefined);
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const ext = LANG_BY_EXT[name.slice(dot + 1).toLowerCase()];
    if (ext) return ext;
  }
  if (firstLine?.startsWith("#!")) {
    for (const [re, lang] of SHEBANG_LANG) if (re.test(firstLine)) return lang;
  }
  return undefined;
}
