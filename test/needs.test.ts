import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import type { ForgePr, Verdict } from "../src/github/forge.ts";
import { parseRoute } from "../src/github/keys.ts";
import { botWaitingCount, buildNeeds, type Need, needStops, waitingCount } from "../src/github/needs.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { parseDecision } from "../src/github/triage.ts";
import type { PrWait } from "../src/github/waiting.ts";

const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

/** A tracker issue on the board. */
function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return item(nodeId, { kind: "issue", url: `${TRACKER}/${number}`, ref: { owner: "jmarrero-forge", repo: "tracker", number }, state: "open", author: "jmarrero-bot", assignees: ["jmarrero"], ...over });
}

const QUESTION = "Q: which?\nOptions:\nA) this\nB) that\n";

/** An ask in the tracker blocking `blocks`. */
function ask(nodeId: string, number: number, label: string, blocks: string, body = QUESTION, over: Partial<Item> = {}): Item {
  return tracked(nodeId, number, { labels: [label], body: `Blocks: ${blocks}\n${body}`, ...over });
}

function pr(owner: string, repo: string, number: number): ForgePr {
  return {
    ref: { owner, repo, number },
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `${repo} #${number}`,
    body: "",
    author: "jmarrero-bot",
    createdAt: "2026-01-10T00:00:00Z",
    updatedAt: "2026-01-11T00:00:00Z",
    draft: true,
  };
}

const rows = (needs: readonly Need[]) => needs.map((n) => [n.key, n.action]);
const entriesOf = (items: Item[], answered: string[] = []) => buildEntries(items, [], new Map(), true, new Set(answered));

describe("representative operator asks", () => {
  const forkBody = "<!-- bot-meta -->\n- Upstream: `upstream/widget`\n- Contribution policy: `human-text`\n<!-- /bot-meta -->";
  const reviewPr = { ...pr("upstream", "widget", 1), draft: false };
  const base: Entry = { key: "pr:upstream/widget#1", kind: "pr", pr: reviewPr, title: "Review this", where: "upstream/widget#1", href: "#pr/upstream/widget/1", wait: { reasons: ["review-requested"], onBot: false } };
  const cases: { name: string; entry: Entry; action?: string }[] = [
    { name: "current explicit review request", entry: base, action: "review" },
    { name: "draft request", entry: { ...base, pr: { ...reviewPr, draft: true } } },
    // The bot asks for his review on forge drafts: that is a concrete ask.
    { name: "forge draft request", entry: { ...base, pr: pr("jmarrero-forge", "widget", 3) }, action: "review" },
    { name: "forge draft request, approved", entry: { ...base, pr: pr("jmarrero-forge", "widget", 3), verdict: { state: "approved" } } },
    { name: "forge draft request, changes requested", entry: { ...base, pr: pr("jmarrero-forge", "widget", 3), verdict: { state: "changes-requested" } } },
    { name: "forge draft without a request", entry: { ...base, pr: pr("jmarrero-forge", "widget", 3), wait: { reasons: ["updated"], onBot: false } } },
    { name: "approved current head", entry: { ...base, verdict: { state: "approved" } } },
    { name: "comment reviewed current head", entry: { ...base, wait: { ...base.wait!, reviewedCurrentHead: true } } },
    { name: "changes requested current head", entry: { ...base, verdict: { state: "changes-requested" } } },
    { name: "reviewed old head, explicit new request", entry: { ...base, verdict: { state: "approved-older" } }, action: "review" },
    { name: "pushed without a request", entry: { ...base, wait: { reasons: ["updated"], onBot: false } } },
    { name: "failed CI without request", entry: { ...base, wait: { reasons: ["rerun"], onBot: false } } },
    { name: "DCO failure without request", entry: { ...base, wait: { reasons: ["resign"], onBot: false } } },
    { name: "bot turn", entry: { ...base, wait: { reasons: [], onBot: true } } },
    { name: "approved human-text fork", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody }, wait: { reasons: [], onBot: false }, verdict: { state: "approved" } }, action: "write" },
    { name: "approved non-draft human-text fork", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody, draft: false }, wait: { reasons: [], onBot: false }, verdict: { state: "approved" } }, action: "write" },
    { name: "approved ordinary fork", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody.replace("human-text", "ai-ok") }, verdict: { state: "approved" } }, action: "promote" },
    { name: "human-authored approved fork", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody, author: "someone" }, verdict: { state: "approved" } } },
    { name: "human-text fork already promoted", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody }, verdict: { state: "promoted" } } },
    { name: "old approval on human-text fork", entry: { ...base, pr: { ...pr("jmarrero-forge", "widget", 2), body: forkBody }, wait: { reasons: [], onBot: false }, verdict: { state: "approved-older" } } },
    { name: "promote already sent", entry: { ...base, verdict: { state: "promoted" } } },
    { name: "new ask after an earlier promote comment", entry: { ...base, verdict: { state: "promoted", at: "2026-10-01T00:00:00Z" }, wait: { reasons: ["review-requested"], onBot: false, askedAt: "2026-10-02T00:00:00Z" } }, action: "review" },
  ];
  for (const c of cases) it(c.name, () => assert.deepEqual(buildNeeds({ entries: [c.entry] }).map((n) => n.action), c.action ? [c.action] : []));

  it("a representative mixed board has only concrete asks, well below fifteen", () => {
    const items = Array.from({ length: 40 }, (_, i) => tracked(`watch${i}`, 200 + i, { status: i % 2 ? "Draft" : "Needs human" }));
    items.push(tracked("question", 10, { labels: ["question"], createdAt: "2026-10-01T00:00:00Z" }), tracked("escalate", 11, { labels: ["escalate"], priority: "P0" }), tracked("answered", 12, { labels: ["question"] }));
    const needs = buildNeeds({ entries: [...entriesOf(items, ["answered"]), ...cases.map((c, i) => ({ ...c.entry, key: `case:${i}` }))] });
    assert.equal(needs.length, 9);
    assert.ok(needs.length <= 15);
    assert.equal(needs[0]?.key, "item:question");
    assert.ok(needs.every((n) => ["answer", "review", "write", "promote"].includes(n.action)));
  });

  it("uses epic priority before the newest ask, with P0 always first", () => {
    const high = tracked("high", 90, { labels: ["epic"], priority: "P1", status: "In Progress" });
    const low = tracked("low", 91, { labels: ["epic"], priority: "P2", status: "In Progress" });
    const questions = [
      ask("new-low", 92, "question", `${TRACKER}/91`, QUESTION, { createdAt: "2026-10-03T00:00:00Z" }),
      ask("old-high", 93, "question", `${TRACKER}/90`, QUESTION, { createdAt: "2026-10-01T00:00:00Z" }),
      ask("p0", 94, "question", `${TRACKER}/91`, QUESTION, { priority: "P0" }),
    ];
    assert.deepEqual(buildNeeds({ entries: entriesOf(questions), board: [high, low] }).map((n) => n.key), ["item:p0", "item:old-high", "item:new-low"]);
  });

  it("uses board parent context for questions read outside the queue", () => {
    const high = tracked("high", 90, { labels: ["epic"], priority: "P1", status: "In Progress" });
    const low = tracked("low", 91, { labels: ["epic"], priority: "P2", status: "In Progress" });
    const old = parseDecision(tracked("I_92", 92, { title: "Old question", labels: ["question"], body: QUESTION }));
    const newer = parseDecision(tracked("I_93", 93, { title: "New question", labels: ["question"], body: QUESTION }));
    old.item.createdAt = "2026-10-01T00:00:00Z";
    newer.item.createdAt = "2026-10-03T00:00:00Z";
    const board = [high, low, tracked("PVTI_92", 92, { parent: high.ref!, priority: "P3" }), tracked("PVTI_93", 93, { parent: low.ref!, priority: "P3" })];
    assert.deepEqual(buildNeeds({ entries: [], decisions: [newer, old], board }).map((n) => n.key), ["decision:I_92", "decision:I_93"]);
  });

  it("does not lose an escalation folded into a PR's board context", () => {
    const item = tracked("context", 95, { labels: ["escalate"], priority: "P0" });
    assert.deepEqual(buildNeeds({ entries: [{ ...base, item, wait: { reasons: [], onBot: true } }], board: [item] }).map((n) => n.key), ["item:context"]);
  });

  it("ages an escalation by its last move on the board, not its issue's creation", () => {
    const moved = tracked("moved", 96, { labels: ["escalate"], createdAt: "2026-07-01T00:00:00Z", movedAt: "2026-10-20T00:00:00Z" });
    const unknown = tracked("unknown", 97, { labels: ["escalate"], createdAt: "2026-07-01T00:00:00Z" });
    const since = new Map(buildNeeds({ entries: [], board: [moved, unknown] }).map((n) => [n.key, n.since]));
    assert.equal(since.get("item:moved"), "2026-10-20T00:00:00Z");
    assert.equal(since.get("item:unknown"), undefined);
  });
});

describe("buildNeeds", () => {
  it("lists concrete questions, excluding legacy asks and inferred board blockers", () => {
    const home = tracked("PVTI_home", 7, { title: "Home", priority: "P2" });
    const items = [
      ask("PVTI_q", 21, "question", `${TRACKER}/7`, QUESTION, { priority: "P0" }),
      ask("PVTI_review", 22, "review", `${TRACKER}/7`, "Ask: Re-approve it\nReview: `https://github.com/o/r/pull/50` at 0123456789012345678901234567890123456789\n"),
      ask("PVTI_chore", 23, "chore", `${TRACKER}/7`, "Ask: Fix the thing by hand\n"),
      home,
      item("PVTI_lonely", { title: "Nobody asks", priority: "P1" }),
    ];
    const needs = buildNeeds({ entries: entriesOf(items) });
    // The item with asks under it is only their context: its asks are the rows.
    assert.deepEqual(rows(needs), [
      ["item:PVTI_q", "answer"],
    ]);
    assert.equal(needs[0]?.inPlace, true);
    assert.equal(needs[0]?.parent?.title, "Home");
    assert.equal(waitingCount(needs), 1);
  });

  it("leaves out what is answered, closed, or waiting on the bot", () => {
    const items = [
      ask("PVTI_a", 30, "question", `${TRACKER}/9`),
      ask("PVTI_b", 31, "question", `${TRACKER}/9`),
      ask("PVTI_c", 32, "question", `${TRACKER}/9`, QUESTION, { state: "closed" }),
    ];
    assert.deepEqual(rows(buildNeeds({ entries: entriesOf(items, ["PVTI_a"]) })), [["item:PVTI_b", "answer"]]);
  });

  it("keeps a row he answered from the page, dimmed, after it stops waiting", () => {
    const items = [ask("PVTI_a", 30, "question", `${TRACKER}/9`), ask("PVTI_b", 31, "question", `${TRACKER}/9`)];
    const needs = buildNeeds({ entries: entriesOf(items, ["PVTI_a"]), answeredHere: new Set(["item:PVTI_a"]) });
    assert.deepEqual(needs.map((n) => [n.key, n.done ?? false]), [["item:PVTI_b", false], ["item:PVTI_a", true]]);
    assert.equal(waitingCount(needs), 1);
    // Done rows are listed but never next.
    assert.deepEqual(needStops(needs).map((s) => [s.key, s.waiting]), [["item:PVTI_b", true], ["item:PVTI_a", false]]);
  });

  it("counts the bot's rows still waiting from the rows given, whoever raised the rest", () => {
    const items = [ask("PVTI_a", 30, "question", `${TRACKER}/9`), ask("PVTI_b", 31, "question", `${TRACKER}/9`)];
    const needs = buildNeeds({ entries: entriesOf(items, ["PVTI_a"]), answeredHere: new Set(["item:PVTI_a"]) });
    const waiting = needs[0]!;
    const theirs: Need = { ...waiting, key: "item:theirs", entry: { ...waiting.entry!, item: { ...waiting.entry!.item!, author: "someone" } } };
    assert.equal(botWaitingCount(needs), 1);
    assert.equal(botWaitingCount([...needs, theirs]), 1);
    assert.equal(botWaitingCount([]), 0);
  });

  it("lists only explicit review requests on non-draft PRs", () => {
    const wait = (reasons: PrWait["reasons"], onBot = false): PrWait => ({ reasons, onBot });
    const none: Verdict = { state: "none" };
    const forge = pr("jmarrero-forge", "bootc", 1);
    const others = [
      { pr: { ...pr("o", "r", 2), draft: false }, wait: wait(["review-requested"]) },
      { pr: pr("o", "r", 3), wait: wait(["resign"]) },
      { pr: pr("o", "r", 4), wait: wait(["rerun", "review-requested"]) },
      { pr: pr("o", "r", 5), wait: wait(["updated"]) },
      { pr: pr("o", "r", 6), wait: wait([], true) },
    ];
    const entries = buildEntries([], [forge], new Map<string, Verdict>([["jmarrero-forge/bootc#1", none]]), true, new Set(), { others });
    const got = Object.fromEntries(rows(buildNeeds({ entries })));
    assert.deepEqual(got, {
      "pr:o/r#2": "review",
    });
  });

  it("lists a forge draft requesting his review once, from its read request", () => {
    const forge = pr("jmarrero-forge", "bootc", 1);
    const wait: PrWait = { reasons: ["review-requested"], onBot: false, askedAt: "2026-10-03T00:00:00Z" };
    const verdicts = new Map<string, Verdict>([["jmarrero-forge/bootc#1", { state: "none" }]]);
    const entries = buildEntries([], [forge], verdicts, true, new Set(), { others: [{ pr: forge, wait, verdict: { state: "none" } }] });
    const needs = buildNeeds({ entries });
    assert.deepEqual(rows(needs), [["pr:jmarrero-forge/bootc#1", "review"]]);
    assert.equal(needs[0]?.since, "2026-10-03T00:00:00Z");
  });

  it("does not ask again for a PR he sent /promote on", () => {
    const forge = pr("jmarrero-forge", "bootc", 1);
    const entries = buildEntries([], [forge], new Map<string, Verdict>([["jmarrero-forge/bootc#1", { state: "promoted" }]]), true);
    assert.deepEqual(buildNeeds({ entries }), []);
  });

  describe("decisions", () => {
    const decision = (nodeId: string, number: number, title: string, body = `Unblocks:\n- ${TRACKER}/9\n\n${QUESTION}`) =>
      parseDecision(tracked(nodeId, number, { title, body, labels: ["question", "decision"] }));

    it("lists a decision of its own, and folds one that is also a question in the queue into that row", () => {
      const q = ask("PVTI_q", 21, "question", `${TRACKER}/9`, QUESTION, { title: "D1: Which?", priority: "P1" });
      const same = decision("I_21", 21, "D1: Which?");
      const other = decision("I_40", 40, "D2: Another?");
      const needs = buildNeeds({ entries: entriesOf([q]), decisions: [same, other] });
      assert.deepEqual(rows(needs), [["item:PVTI_q", "answer"], ["decision:I_40", "answer"]]);
      assert.equal(needs[0]?.decision?.number, 1);
      assert.equal(needs[1]?.inPlace, true);
      assert.equal(needs[1]?.href, "#item/I_40");
    });

    it("links every in-page row to a route that opens it", () => {
      const q = ask("PVTI_q", 21, "question", `${TRACKER}/9`, QUESTION, { title: "D1: Which?" });
      const needs = buildNeeds({ entries: entriesOf([q]), decisions: [decision("I_kwDOP9abcd", 40, "D2: Another?")] });
      const local = needs.map((n) => n.href).filter((h) => h.startsWith("#") && h !== "#");
      assert.equal(local.length, 2);
      for (const h of local) assert.notEqual(parseRoute(h).route, "home", h);
    });

    it("drops one he answered, unless he did from the page", () => {
      const d = decision("I_40", 40, "D2: Another?");
      assert.deepEqual(buildNeeds({ entries: [], decisions: [d], decisionsAnswered: new Set(["I_40"]) }), []);
      const kept = buildNeeds({ entries: [], decisions: [d], decisionsAnswered: new Set(["I_40"]), answeredHere: new Set(["decision:I_40"]) });
      assert.deepEqual(kept.map((n) => [n.key, n.done]), [["decision:I_40", true]]);
    });

    it("takes a question's priority from the whole board even outside the legacy queue", () => {
      const d = decision("I_40", 40, "D2: Another?");
      const needs = buildNeeds({ entries: [], decisions: [d], board: [tracked("PVTI_40", 40, { labels: ["question"], status: "Todo", priority: "P0" })] });
      assert.equal(needs[0]?.priority, "P0");
    });

    it("is not attached to a row that is not a question", () => {
      const entries = buildEntries([], [pr("jmarrero-forge", "tracker", 9)], new Map<string, Verdict>([["jmarrero-forge/tracker#9", { state: "none" }]]), true);
      const needs = buildNeeds({ entries, decisions: [decision("I_9", 9, "D3: x")] });
      assert.deepEqual(rows(needs), [["decision:I_9", "answer"]]);
      assert.equal(needs[0]?.decision?.number, 3);
    });
  });

  it("ranks by priority, then the newest ask", () => {
    const items = [
      ask("PVTI_new", 41, "question", `${TRACKER}/9`, QUESTION, { priority: "P1", createdAt: "2026-03-01T00:00:00Z" }),
      ask("PVTI_old", 42, "question", `${TRACKER}/9`, QUESTION, { priority: "P1", createdAt: "2026-01-01T00:00:00Z" }),
      ask("PVTI_top", 43, "question", `${TRACKER}/9`, QUESTION, { priority: "P0", createdAt: "2026-06-01T00:00:00Z" }),
    ];
    assert.deepEqual(buildNeeds({ entries: entriesOf(items) }).map((n) => n.key), ["item:PVTI_top", "item:PVTI_new", "item:PVTI_old"]);
  });

  it("steps through questions in place and opens the rest", () => {
    const items = [ask("PVTI_q", 21, "question", `${TRACKER}/9`), tracked("PVTI_r", 22, { labels: ["escalate"] })];
    const stops = needStops(buildNeeds({ entries: entriesOf(items) }));
    assert.deepEqual(stops.map((s) => [s.key, s.href, s.inPlace]), [["item:PVTI_q", "#", true], ["item:PVTI_r", `${TRACKER}/22`, false]]);
  });
});
