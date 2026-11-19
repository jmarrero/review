import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseItem } from "../src/github/board.ts";
import {
  decisionLabel,
  parseDecision,
  parseUnblocks,
  shortRef,
  sortDecisions,
} from "../src/github/triage.ts";
import { rawBoardItem } from "./helpers.ts";

const item = (n: number, fields: Record<string, string>) => parseItem(rawBoardItem(n, fields));

describe("triage fields", () => {
  it("parses Theme, Verdict and Verdict target", () => {
    const i = item(1, { Status: "Draft", Theme: "composefs-stable", Verdict: "merge", "Verdict target": " https://github.com/o/r/issues/2 " });
    assert.equal(i.theme, "composefs-stable");
    assert.equal(i.verdict, "merge");
    assert.equal(i.verdictTarget, "https://github.com/o/r/issues/2");
  });
  it("leaves them unset when absent or blank", () => {
    const i = item(2, { Status: "Todo", Theme: "  " });
    assert.equal(i.theme, undefined);
    assert.equal(i.verdict, undefined);
    assert.equal(i.verdictTarget, undefined);
  });
});

describe("parseUnblocks", () => {
  const cases: [string, string, string[]][] = [
    [
      "a list after the line, as bot-board writes it",
      "Blocks: https://github.com/jmarrero-forge/tracker/issues/1\n\nUnblocks:\n- https://github.com/jmarrero-forge/bootc/pull/15\n- https://github.com/bootc-dev/bootc/pull/2516\n\nQ: Promote now?",
      ["https://github.com/jmarrero-forge/bootc/pull/15", "https://github.com/bootc-dev/bootc/pull/2516"],
    ],
    [
      "on the line, comma separated, in code spans, duplicates dropped",
      "Unblocks: `https://github.com/o/r/issues/1`, https://github.com/o/r/pull/2 https://github.com/o/r/issues/1\nQ: x",
      ["https://github.com/o/r/issues/1", "https://github.com/o/r/pull/2"],
    ],
    [
      "list items in backticks, with a blank line between, ending at prose",
      "Unblocks:\n* `https://github.com/o/r/issues/1`\n\n1. https://github.com/o/r/issues/3\nThat is all.\n- https://github.com/o/r/issues/4",
      ["https://github.com/o/r/issues/1", "https://github.com/o/r/issues/3"],
    ],
    ["none", "Q: Which?\nOptions:\nA) x\nB) y", []],
    ["only inside a code fence", "```\nUnblocks:\n- https://github.com/o/r/issues/1\n```", []],
    ["not https", "Unblocks:\n- http://github.com/o/r/issues/1\n- javascript:alert(1)", []],
  ];
  for (const [name, body, want] of cases) it(name, () => assert.deepEqual(parseUnblocks(body), want));
});

describe("parseDecision", () => {
  const body = [
    "Blocks: https://github.com/jmarrero-forge/tracker/issues/160",
    "",
    "Declaring stable while upgrades break invites bug reports.",
    "",
    "Unblocks:",
    "- https://github.com/jmarrero-forge/bootc/pull/15",
    "- https://github.com/jmarrero-forge/tracker/issues/160",
    "",
    "Q: Promote forge bootc#15 now, or after bootc#2516?",
    "",
    "Options:",
    "A) After bootc#2516 merges",
    "B) Now",
    "C) After upgrade-path CI too",
    "",
    "Recommended: A, because #2516 is small and already in review",
    "",
    "Answer with a comment on this issue.",
  ].join("\n");
  const decision = (title: string, n = 300) => parseDecision({ ...item(n, { Status: "Needs human" }), title, body, labels: ["question", "decision"] });

  it("reads the D-number, question, options and unblocks", () => {
    const d = decision("D1: Promote the stable declaration when?");
    assert.equal(d.number, 1);
    assert.equal(decisionLabel(d), "D1");
    assert.equal(d.title, "Promote the stable declaration when?");
    assert.equal(d.question.ask, "Promote forge bootc#15 now, or after bootc#2516?");
    assert.deepEqual(
      d.question.options.map((o) => [o.letter, o.recommended]),
      [
        ["A", true],
        ["B", false],
        ["C", false],
      ],
    );
    assert.equal(d.question.optionsProblem, undefined);
    assert.deepEqual(d.unblocks, ["https://github.com/jmarrero-forge/bootc/pull/15", "https://github.com/jmarrero-forge/tracker/issues/160"]);
  });

  it("keeps a title without a D-number whole", () => {
    const d = decision("Dx: something", 301);
    assert.equal(d.number, undefined);
    assert.equal(d.title, "Dx: something");
    assert.equal(decisionLabel(d), "#301");
  });

  it("sorts by D-number, numerically, then those without one", () => {
    const ds = [decision("D10: ten", 1), decision("no number", 2), decision("D2: two", 3), decision("D1: one", 4)];
    assert.deepEqual(sortDecisions(ds).map(decisionLabel), ["D1", "D2", "D10", "#2"]);
  });
});

describe("shortRef", () => {
  const cases: [string, string][] = [
    ["https://github.com/jmarrero-forge/tracker/issues/12", "tracker#12"],
    ["https://github.com/jmarrero-forge/bootc/pull/15", "forge bootc#15"],
    ["https://github.com/bootc-dev/bootc/pull/2516", "bootc#2516"],
    ["https://gist.github.com/x/abc", "https://gist.github.com/x/abc"],
  ];
  for (const [url, want] of cases) it(url, () => assert.equal(shortRef(url), want));
});
