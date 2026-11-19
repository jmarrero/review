import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayItems,
  hiddenParts,
  hunkStarts,
  type Item,
  isGenerated,
  languageFor,
  lineDiff,
  type LineRange,
  pairs,
  parseHunks,
  positions,
  type Row,
  rowsInRange,
  splitRows,
  wordDiff,
} from "../src/github/diff.ts";

/** Rows as [kind, old, new, text], for compact expectations. */
const rowTuples = (items: readonly Item[]) =>
  items.map((it) => (it.t === "gap" ? ["gap", it.newStart, it.newEnd ?? null, it.oldStart] : [it.row.kind, it.row.old ?? null, it.row.new ?? null, it.row.text]));

describe("parseHunks", () => {
  it("numbers lines per side and keeps the section heading", () => {
    const [hk, ...rest] = parseHunks("@@ -10,3 +10,4 @@ fn x() {\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n");
    assert.equal(rest.length, 0);
    assert.deepEqual([hk?.oldStart, hk?.oldLines, hk?.newStart, hk?.newLines, hk?.section], [10, 3, 10, 4, "fn x() {"]);
    assert.deepEqual(
      hk?.rows.map((r) => [r.kind, r.old ?? null, r.new ?? null, r.text, r.noNewline ?? false]),
      [
        ["ctx", 10, 10, "a", false],
        ["del", 11, null, "b", false],
        ["add", null, 11, "c", false],
        ["add", null, 12, "d", false],
        ["ctx", 12, 13, "e", true],
      ],
    );
  });

  const cases: [string, string, [number, number, number, number, number][]][] = [
    ["a new file", "@@ -0,0 +1 @@\n+only", [[0, 0, 1, 1, 1]]],
    ["an empty patch", "", []],
    ["CRLF and two hunks", "@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+B\r\n@@ -20 +20,2 @@\r\n x\r\n+y\r\n", [[1, 2, 1, 2, 3], [20, 1, 20, 2, 2]]],
    ["junk before the first hunk", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b", [[1, 1, 1, 1, 2]]],
  ];
  for (const [name, patch, want] of cases) {
    it(name, () => assert.deepEqual(parseHunks(patch).map((hk) => [hk.oldStart, hk.oldLines, hk.newStart, hk.newLines, hk.rows.length]), want));
  }
});

describe("splitRows and pairs", () => {
  it("pairs each run of deletions with the additions after it", () => {
    const rows = parseHunks("@@ -1,5 +1,4 @@\n a\n-b\n-c\n-d\n+B\n+C\n e\n+f")[0]?.rows ?? [];
    const texts = splitRows(rows).map((s) => [s.left?.text ?? null, s.right?.text ?? null]);
    assert.deepEqual(texts, [["a", "a"], ["b", "B"], ["c", "C"], ["d", null], ["e", "e"], [null, "f"]]);
    const p = pairs(rows);
    const byText = (t: string) => rows.find((r) => r.text === t) as Row;
    assert.equal(p.get(byText("b"))?.text, "B");
    assert.equal(p.get(byText("C"))?.text, "c");
    assert.equal(p.has(byText("d")), false);
    assert.equal(p.has(byText("a")), false);
  });
});

describe("wordDiff", () => {
  const slices = (s: string, spans: readonly (readonly [number, number])[]) => spans.map(([a, b]) => s.slice(a, b));
  const cases: [string, string, string, string[], string[]][] = [
    ["one word", "let x = foo(a);", "let x = bar(a);", ["foo"], ["bar"]],
    ["an added argument", "call(a, b)", "call(a, b, c)", [], [", c"]],
    ["unicode words", "naïve café", "naïve cafés", ["café"], ["cafés"]],
    ["identical", "same", "same", [], []],
    ["mostly different: no highlights", "abc def ghi", "xyz uvw rst", [], []],
  ];
  for (const [name, a, b, wantOld, wantNew] of cases) {
    it(name, () => {
      const d = wordDiff(a, b);
      assert.deepEqual([slices(a, d.old), slices(b, d.new)], [wantOld, wantNew]);
    });
  }
  it("gives up on very long lines", () => {
    const long = "x ".repeat(600);
    assert.deepEqual(wordDiff(long, `${long}y`), { old: [], new: [] });
  });
});

describe("lineDiff", () => {
  const kinds = (d: { kind: string; text: string }[]) => d.map((l) => `${l.kind} ${l.text}`);
  it("keeps, adds and deletes lines", () => {
    assert.deepEqual(kinds(lineDiff("a\nb\nc", "a\nx\nc")), ["same a", "add x", "del b", "same c"]);
    assert.deepEqual(kinds(lineDiff("same\r\n", "same")), ["same same"]);
    assert.deepEqual(kinds(lineDiff("a", "a\nb")), ["same a", "add b"]);
    assert.deepEqual(kinds(lineDiff("(none)", "{\n}")), ["add {", "add }", "del (none)"]);
  });
  it("shows a middle too large to compare as replaced whole, keeping the common ends", () => {
    const lines = (p: string) => Array.from({ length: 1001 }, (_, i) => `${p}${i}`).join("\n");
    const d = lineDiff(`top\n${lines("a")}\nend`, `top\n${lines("b")}\nend`);
    assert.equal(d.length, 2004);
    assert.deepEqual(kinds([d[0]!, d[1]!, d[1002]!, d.at(-1)!]), ["same top", "del a0", "add b0", "same end"]);
  });
});

describe("displayItems", () => {
  // Two hunks of a 30-line file: lines 3-5 and 20-22 (new), with one line
  // added in the first, so old = new - 1 after it.
  const patch = "@@ -3,2 +3,3 @@ fn a\n c3\n+n4\n c4\n@@ -19,3 +20,3 @@ fn b\n c19\n-d20\n+n21\n c21";
  const hunks = parseHunks(patch);
  const file = Array.from({ length: 30 }, (_, i) => `L${i + 1}`);

  it("shows gaps around and between hunks, with the end unknown until fetched", () => {
    assert.deepEqual(rowTuples(displayItems(hunks, [], undefined)), [
      ["gap", 1, 2, 1],
      ["ctx", 3, 3, "c3"],
      ["add", null, 4, "n4"],
      ["ctx", 4, 5, "c4"],
      ["gap", 6, 19, 5],
      ["ctx", 19, 20, "c19"],
      ["del", 20, null, "d20"],
      ["add", null, 21, "n21"],
      ["ctx", 21, 22, "c21"],
      ["gap", 23, null, 22],
    ]);
  });

  it("expands ranges from the file, splitting gaps", () => {
    const items = displayItems(hunks, [[1, 2], [6, 7], [18, 19], [29, 40]], file);
    assert.deepEqual(rowTuples(items), [
      ["ctx", 1, 1, "L1"],
      ["ctx", 2, 2, "L2"],
      ["ctx", 3, 3, "c3"],
      ["add", null, 4, "n4"],
      ["ctx", 4, 5, "c4"],
      ["ctx", 5, 6, "L6"],
      ["ctx", 6, 7, "L7"],
      ["gap", 8, 17, 7],
      ["ctx", 17, 18, "L18"],
      ["ctx", 18, 19, "L19"],
      ["ctx", 19, 20, "c19"],
      ["del", 20, null, "d20"],
      ["add", null, 21, "n21"],
      ["ctx", 21, 22, "c21"],
      ["gap", 23, 28, 22],
      ["ctx", 28, 29, "L29"],
      ["ctx", 29, 30, "L30"],
    ]);
    assert.ok(items.filter((it) => it.t === "row" && it.row.expanded).length === 8);
  });

  const noGaps: [string, string, readonly string[]][] = [
    ["a new file", "@@ -0,0 +1,2 @@\n+a\n+b", []],
    ["a deleted file", "@@ -1,2 +0,0 @@\n-a\n-b", []],
    ["a change reaching both ends", "@@ -1,2 +1,2 @@\n-a\n+A\n b", ["A", "b"]],
  ];
  for (const [name, p, lines] of noGaps) {
    it(`has no gaps for ${name}`, () => assert.equal(displayItems(parseHunks(p), [], lines).filter((i) => i.t === "gap").length, 0));
  }

  it("handles a pure deletion hunk in the middle", () => {
    const items = displayItems(parseHunks("@@ -5,2 +4,0 @@\n-x\n-y"), [], ["1", "2", "3", "4", "5", "6"]);
    assert.deepEqual(rowTuples(items), [["gap", 1, 4, 1], ["del", 5, null, "x"], ["del", 6, null, "y"], ["gap", 5, 6, 7]]);
  });
});

describe("range mapping", () => {
  const hunks = parseHunks("@@ -3,2 +3,3 @@\n c3\n+n4\n c4\n@@ -19,3 +20,3 @@\n c19\n-d20\n+n21\n c21");
  const items = displayItems(hunks, [], undefined);
  const texts = (idx: number[]) => idx.map((i) => (items[i] as Extract<Item, { t: "row" }>).row.text);

  it("puts deleted rows at the new line after them", () => {
    assert.deepEqual(positions(items), [-1, 3, 4, 5, -1, 20, 21, 21, 22, -1]);
  });

  const cases: [LineRange, string[], LineRange[]][] = [
    [[4, 4], ["n4"], []],
    [[21, 21], ["d20", "n21"], []],
    [[3, 5], ["c3", "n4", "c4"], []],
    [[5, 8], ["c4"], [[6, 8]]],
    [[10, 12], [], [[10, 12]]],
    [[22, 40], ["c21"], [[23, 40]]],
  ];
  for (const [range, rows, hidden] of cases) {
    it(`maps ${range.join("-")}`, () => {
      assert.deepEqual(texts(rowsInRange(items, range)), rows);
      assert.deepEqual(hiddenParts(items, range), hidden);
    });
  }

  it("finds where each hunk starts, skipping expanded context", () => {
    const expanded = displayItems(hunks, [[1, 2]], Array.from({ length: 30 }, (_, i) => `L${i}`));
    const starts = hunkStarts(expanded);
    assert.deepEqual(starts.map((i) => (expanded[i] as Extract<Item, { t: "row" }>).row.text), ["c3", "c19"]);
  });
});

describe("isGenerated", () => {
  const cases: [string, boolean][] = [
    ["Cargo.lock", true],
    ["crates/x/Cargo.lock", true],
    ["go.sum", true],
    ["vendor/github.com/x/y.go", true],
    ["tests/fixtures/acp/one.jsonl", true],
    ["yarn.lock", true],
    ["web/app.min.js", true],
    ["src/lock.rs", false],
    ["docs/vendor.md", false],
    ["go.mod", false],
  ];
  for (const [path, want] of cases) it(path, () => assert.equal(isGenerated(path), want));
});

describe("languageFor", () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ["src/main.rs", undefined, "rust"],
    ["cmd/x.go", undefined, "go"],
    ["hack/x.sh", undefined, "bash"],
    [".github/workflows/ci.yml", undefined, "yaml"],
    ["Cargo.toml", undefined, "ini"],
    ["src/app.ts", undefined, "typescript"],
    ["bin/tool.mjs", undefined, "javascript"],
    ["x.py", undefined, "python"],
    ["README.md", undefined, "markdown"],
    ["Containerfile", undefined, "dockerfile"],
    ["Dockerfile.cs10", undefined, "dockerfile"],
    ["tests/booted/test-1.nu", undefined, "nu"],
    ["contrib/packaging/bootc.spec", undefined, "rpm-spec"],
    ["lib/x.c", undefined, "c"],
    ["Makefile", undefined, "makefile"],
    ["bin/bot-land", "#!/usr/bin/env node", "javascript"],
    ["bin/bot-pr", "#!/usr/bin/env bash", "bash"],
    ["bin/thing", "#!/usr/bin/env nu", "nu"],
    ["LICENSE", undefined, undefined],
  ];
  for (const [path, first, want] of cases) it(`${path}${first ? ` (${first})` : ""}`, () => assert.equal(languageFor(path, first), want));
});
