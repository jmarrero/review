import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AdvanceFacts,
  decideAdvance,
  decisionStops,
  EDITED_ATTR,
  overlayVerdicts,
  overlayWaiting,
  type PendingVerdict,
  pickNext,
  queueStops,
  stillReviewed,
  type Stop,
  triageStops,
  writingElsewhere,
} from "../src/github/advance.ts";
import { parseItem } from "../src/github/board.ts";
import { parseDecision } from "../src/github/triage.ts";
import { OPTIMISTIC_TTL_MS } from "../src/github/config.ts";
import type { VerdictEntry, WaitingPr } from "../src/github/prs.ts";
import type { Entry } from "../src/github/queue.ts";
import { installDom, rawBoardItem } from "./helpers.ts";

const stop = (key: string, waiting = true): Stop => ({ key, href: `#item/${key}`, title: key, waiting });
const stops = (spec: string) => spec.split(" ").filter(Boolean).map((k) => (k.endsWith("~") ? stop(k.slice(0, -1), false) : stop(k)));

describe("pickNext", () => {
  // [name, list when opened, current, list now ("~" marks a settled row), want]
  const cases: [string, string, string, string, string | undefined][] = [
    ["the next row", "a b c", "b", "a b c", "c"],
    ["the next row, after the current one left the list", "a b c", "b", "a c", "c"],
    ["skips rows that left or settled meanwhile", "a b c d e", "a", "a c~ e", "e"],
    ["keeps the order he saw, not a re-ranked one", "a b c", "a", "c b", "b"],
    ["the last row wraps to the first still waiting", "a b c", "c", "a b c", "a"],
    ["the last row, with only settled rows left: caught up", "a b c", "c", "a~ b~", undefined],
    ["the only row: caught up", "a", "a", "", undefined],
    ["past the end, a row new since", "a b", "b", "x", "x"],
    ["an entry not in the list (e.g. a PR opened from its ask): the first waiting", "a b", "pr", "a b", "a"],
    ["an empty list", "", "a", "", undefined],
  ];
  for (const [name, from, current, now, want] of cases) {
    it(name, () => assert.equal(pickNext(stops(from), current, stops(now))?.key, want));
  }

  it("follows a filtered queue, children after their parent, skipping settled asks", () => {
    const e = (key: string, priority: string, over: Partial<Entry> = {}): Entry => ({ key, kind: "item", title: key, where: "w", href: `#${key}`, priority, ...over });
    const entries = [
      e("p0-a", "P0", { children: [e("p0-a-ask", "P0", { kind: "question" }), e("p0-a-done", "P0", { kind: "question", settled: true })] }),
      e("p1-a", "P1"),
      e("p0-b", "P0"),
      e("p0-c", "P0", { kind: "question", settled: true }),
    ];
    const p0 = queueStops(entries, { scope: "all", priority: "P0" });
    assert.deepEqual(
      p0.map((s) => `${s.key}${s.waiting ? "" : "~"}`),
      ["p0-a", "p0-a-ask", "p0-a-done~", "p0-b", "p0-c~"],
    );
    assert.equal(pickNext(p0, "p0-a-ask", p0)?.key, "p0-b", "past the settled child, and never into the P1 row the filter hides");
    assert.equal(pickNext(p0, "p0-b", p0)?.key, "p0-a", "wraps within the filter");
    assert.equal(pickNext(p0, "p0-b", p0.filter((s) => s.key === "p0-b"))?.key, undefined);
    assert.equal(queueStops(entries, { scope: "all" }).length, 6);
  });

  it("lists the bot's turns without stopping there", () => {
    const pr = (key: string, onBot: boolean): Entry => ({ key, kind: "pr", title: key, where: "w", href: `#pr/${key}`, wait: { reasons: onBot ? [] : ["review-requested"], onBot } });
    const s = queueStops([pr("a", false), pr("b", true), pr("c", false)], { scope: "all" });
    assert.deepEqual(s.map((x) => x.waiting), [true, false, true]);
    assert.equal(pickNext(s, "a", s)?.key, "c");
    assert.equal(pickNext(s, "c", s.slice(1, 3).map((x) => ({ ...x, waiting: false })))?.key, undefined, "caught up with only the bot's turns left");
  });
});

describe("decideAdvance", () => {
  const ok: AdvanceFacts = { enabled: true, ok: true, stillThere: true, writing: false, stillWaiting: false };
  const next = stop("n");
  const cases: [string, Partial<AdvanceFacts>, Stop | undefined, string][] = [
    ["moves on after a success", {}, next, "go n"],
    ["is caught up when nothing is next", {}, undefined, "caught-up"],
    ["stays when the write failed", { ok: false }, next, "stay failed"],
    ["stays when the write failed, even with nothing next", { ok: false }, undefined, "stay failed"],
    ["stays when turned off", { enabled: false }, next, "stay off"],
    ["stays when he left the view meanwhile", { stillThere: false }, next, "stay left"],
    ["stays while he writes elsewhere", { writing: true }, next, "stay writing"],
    ["stays when the entry still waits on him (a comment-only review)", { stillWaiting: true }, next, "stay waiting"],
  ];
  for (const [name, facts, to, want] of cases) {
    it(name, () => {
      const d = decideAdvance({ ...ok, ...facts }, to);
      assert.equal(d.kind === "go" ? `go ${d.to.key}` : d.kind === "stay" ? `stay ${d.why}` : d.kind, want);
    });
  }
});

describe("writingElsewhere", () => {
  function page() {
    installDom();
    const root = document.createElement("div");
    root.innerHTML = `
      <form class="sent"><textarea></textarea></form>
      <details class="mine"><input type="text" class="title"><textarea class="body"></textarea></details>
      <input type="checkbox" class="box">
      <button type="button">x</button>`;
    document.body.append(root);
    const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
    const sent = q<HTMLFormElement>("form.sent");
    const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
      el.value = value;
      el.setAttribute(EDITED_ATTR, "");
    };
    return { root, sent, q, type };
  }

  it("ignores the text that just went out", () => {
    const { root, sent, q, type } = page();
    type(q("form.sent textarea"), "LGTM");
    q<HTMLTextAreaElement>("form.sent textarea").focus();
    assert.equal(writingElsewhere(root, sent, document.activeElement), false);
  });

  it("ignores prefilled fields he didn't touch", () => {
    const { root, sent, q } = page();
    q<HTMLInputElement>("input.title").value = "the bot's title";
    assert.equal(writingElsewhere(root, sent, null), false);
  });

  it("sees text he typed elsewhere, until he clears it", () => {
    const { root, sent, q, type } = page();
    const body = q<HTMLTextAreaElement>("textarea.body");
    type(body, "half a thought");
    assert.equal(writingElsewhere(root, sent, null), true);
    type(body, "  ");
    assert.equal(writingElsewhere(root, sent, null), false);
  });

  it("sees a text field he is in, but not a focused checkbox or button", () => {
    const { root, sent, q } = page();
    assert.equal(writingElsewhere(root, sent, q("textarea.body")), true);
    assert.equal(writingElsewhere(root, sent, q("input.box")), false);
    assert.equal(writingElsewhere(root, sent, q("button")), false);
    assert.equal(writingElsewhere(root, sent, document.body), false, "outside the view");
  });
});

describe("overlayVerdicts", () => {
  const T = 1_000_000;
  const read = (state: VerdictEntry["verdict"]["state"], head = "h1"): VerdictEntry => ({ updatedAt: "2026-09-01T00:00:00Z", head, verdict: { state } });
  const approved: PendingVerdict = { state: "approved", head: "h1", at: T };
  // [name, GitHub's read (if any), now, verdict shown, still pending]
  const cases: [string, VerdictEntry | undefined, number, string | undefined, boolean][] = [
    ["shows his approval before GitHub has one", read("none"), T + 1000, "approved", true],
    ["shows it for a PR whose reviews aren't read yet", undefined, T + 1000, "approved", true],
    ["lets go once GitHub agrees", read("approved"), T + 1000, "approved", false],
    ["lets go when the head moved (a push makes it moot)", read("none", "h2"), T + 1000, "none", false],
    ["lets GitHub win after the time limit", read("none"), T + OPTIMISTIC_TTL_MS + 1, "none", false],
    ["and then, with no read, shows nothing", undefined, T + OPTIMISTIC_TTL_MS + 1, undefined, false],
  ];
  for (const [name, r, now, shown, still] of cases) {
    it(name, () => {
      const got = overlayVerdicts(new Map(r ? [["o/r#1", r]] : []), new Map([["o/r#1", approved]]), now);
      assert.equal(got.verdicts.get("o/r#1")?.state, shown);
      assert.equal(got.pending.has("o/r#1"), still);
    });
  }

  it("leaves other PRs as GitHub read them", () => {
    const got = overlayVerdicts(new Map([["o/r#2", read("changes-requested")]]), new Map([["o/r#1", approved]]), T);
    assert.equal(got.verdicts.get("o/r#2")?.state, "changes-requested");
  });
});

describe("overlayWaiting", () => {
  const T = 1_000_000;
  const waiting = (n: number, head = "h1"): WaitingPr => ({
    pr: { ref: { owner: "o", repo: "r", number: n }, url: `https://github.com/o/r/pull/${n}`, title: `#${n}`, body: "", author: "bot", createdAt: "", updatedAt: "", draft: false },
    head,
    wait: { reasons: ["review-requested"], onBot: false },
  });
  const pending = (state: PendingVerdict["state"]) => new Map([["o/r#1", { state, head: "h1", at: T }]]);
  // [name, the read, his review, now, reasons left (undefined: not listed)]
  const cases: [string, WaitingPr, PendingVerdict["state"], number, string[] | undefined][] = [
    ["drops a PR he approved that a lagging read still lists", waiting(1), "approved", T + 1000, undefined],
    ["keeps one he asked changes on, on the bot", waiting(1), "changes-requested", T + 1000, []],
    ["lets the read win after the time limit", waiting(1), "approved", T + OPTIMISTIC_TTL_MS + 1, ["review-requested"]],
    ["lets the read win once the head moved", waiting(1, "h2"), "approved", T + 1000, ["review-requested"]],
    ["leaves any other verdict to the read", waiting(1), "promoted", T + 1000, ["review-requested"]],
    ["leaves other PRs as read", waiting(2), "approved", T + 1000, ["review-requested"]],
    // The read has his change request, and lists the PR for the bot's reply since.
    ["lets the read win once it shows his verdict", { ...waiting(1), verdict: { state: "changes-requested" } }, "changes-requested", T + 1000, ["review-requested"]],
  ];
  for (const [name, w, state, now, reasons] of cases) {
    it(name, () => {
      const got = overlayWaiting([w], pending(state), now);
      assert.deepEqual(got[0]?.wait.reasons, reasons);
    });
  }

  it("puts a PR he asked changes on on the bot", () => {
    assert.equal(overlayWaiting([waiting(1)], pending("changes-requested"), T + 1000)[0]?.wait.onBot, true);
  });

  // A requested forge draft is listed here, and the queue takes this verdict over overlayVerdicts'.
  it("shows his change request as the verdict before a read does", () => {
    assert.deepEqual(overlayWaiting([{ ...waiting(1), verdict: { state: "none" } }], pending("changes-requested"), T + 1000)[0]?.verdict, { state: "changes-requested" });
  });
});

describe("triageStops and decisionStops", () => {
  const item = (n: number) => parseItem(rawBoardItem(n, { Status: "Needs human" }));
  const entry = (n: number, over: Partial<Entry> = {}): Entry => ({ key: `item:PVTI_t${n}`, kind: "item", title: `item ${n}`, where: "w", href: `#item/PVTI_t${n}`, ...over });

  it("keeps the triage order, only for rows opening in the app, waiting as their queue row says", () => {
    const entries = [entry(3, { children: [entry(4, { kind: "question", settled: true })] }), entry(1)];
    // 5 opens in the app without a row of its own (folded into its PR's), and is done from here; 6 likewise, not done.
    const links = { opens: (i: { nodeId: string }) => (i.nodeId === "PVTI_t2" ? undefined : `#item/${i.nodeId}`), settled: (i: { nodeId: string }) => i.nodeId === "PVTI_t5" };
    const got = triageStops([item(1), item(2), item(4), item(5), item(3), item(6)], entries, links);
    assert.deepEqual(
      got.map((s) => [s.key, s.href, s.waiting]),
      [
        ["item:PVTI_t1", "#item/PVTI_t1", true],
        ["item:PVTI_t4", "#item/PVTI_t4", false],
        ["item:PVTI_t5", "#item/PVTI_t5", false],
        ["item:PVTI_t3", "#item/PVTI_t3", true],
        ["item:PVTI_t6", "#item/PVTI_t6", true],
      ],
    );
    // From 1, the next still waiting is 3: 2 opens on GitHub, 4 and 5 are settled.
    assert.equal(pickNext(got, "item:PVTI_t1", got)?.key, "item:PVTI_t3");
    assert.equal(pickNext(got, "item:PVTI_t3", got)?.key, "item:PVTI_t6");
  });

  it("steps through the decisions in place, skipping answered ones", () => {
    const withRef = (n: number) => ({ ...item(n), ref: { owner: "jmarrero-forge", repo: "tracker", number: n } });
    const ds = [7, 8, 9].map((n) => parseDecision({ ...withRef(n), title: `D${n}: pick` }));
    const answered = new Set(["PVTI_t8"]);
    const got = decisionStops(ds, answered, "#decisions");
    assert.deepEqual(got.map((s) => [s.key, s.href, s.title, s.waiting]), [
      ["decision:PVTI_t7", "#decisions", "D7: pick", true],
      ["decision:PVTI_t8", "#decisions", "D8: pick", false],
      ["decision:PVTI_t9", "#decisions", "D9: pick", true],
    ]);
    assert.equal(pickNext(got, "decision:PVTI_t7", got)?.key, "decision:PVTI_t9");
  });
});

describe("stillReviewed", () => {
  const reviewed = new Map([["o/r#1", "aaa"], ["o/r#2", "bbb"], ["o/r#3", "ccc"]]);
  const reads: Record<string, (string | undefined)[]> = {
    // A push since his review: the bot sent it back to him.
    "o/r#1": ["aaa", "zzz"],
    // Still the head he reviewed, or not read yet.
    "o/r#2": ["bbb", undefined],
  };

  it("drops a mark once any read shows another head, keeps it while none does", () => {
    const got = stillReviewed(reviewed, (key) => reads[key] ?? []);
    assert.deepEqual([...got], [["o/r#2", "bbb"], ["o/r#3", "ccc"]]);
  });
});
