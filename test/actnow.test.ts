import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actNowRows, ACT_NOW_LIMIT } from "../src/github/actnow.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { askCard, decisionKey, type Published } from "../src/github/inbox.ts";
import { cardEl, fillActNow, type InboxHooks } from "../src/github/inboxview.ts";
import { homeSkeleton } from "../src/github/homeview.ts";
import { showView } from "../src/github/shell.ts";
import { createRenderer } from "../src/markdown.ts";
import { fixture, installDom, rawActNow, rawAsk, rawNeedsYou } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const AT = "2026-11-06T12:00:00Z";
const NOW = Date.parse(AT);
const key = (n: number) => `jmarrero-forge/tracker#${n}`;
const candidate = (n: number, unblocks = 1) => ({ key: key(n), unblocks });

/** Synthetic records use the shipped producer shape; real replay is below. */
function published(items = [rawAsk(1)], actNow: unknown = [candidate(1)], over: Record<string, unknown> = {}): Published {
  const records = Array.isArray(actNow) ? actNow.map((r: Record<string, unknown>) => ({
    ...rawActNow(items.find((a) => a.key === r.key) ?? rawAsk(0)), ...r,
  })) : actNow;
  const list = parseNeedsYou(rawNeedsYou(items, AT, { act_now: records, ...over }));
  assert.ok(typeof list === "object");
  return { list, asks: list.items, unavailable: false, checkedAt: NOW };
}

const hooks: InboxHooks = { now: NOW, render, mayAct: true, answerEntry: async () => {} };

describe("Act now publication", () => {
  it("replays agent-board#768's whole fixture, excluding CI, agent and upstream waits", () => {
    // Producer e6fedc8ac1c7dc83cb01fc997e073362bde96548, fixtures/act-now-needs-you.json.
    const raw = fixture<{ needs_you: unknown }>("act-now-needs-you.json");
    const list = parseNeedsYou(raw.needs_you);
    assert.ok(typeof list === "object");
    const rows = actNowRows({ list, asks: list.items, unavailable: false, checkedAt: NOW }, NOW);
    // o/t#10 is the one needs-human decision: decisions rank first.
    assert.deepEqual(rows.map((r) => [r.ask.key, r.unblocks]), [["o/t#10", 1], ["o/t#20", 63], ["o/t#30", 3], ["o/a#1", 1]]);
    const slot = document.createElement("section");
    fillActNow(slot, rows, { ...hooks, writes: new Map(), approve: async () => { throw new Error("replay must not write"); } });
    const rendered = [...slot.querySelectorAll("li")];
    assert.equal(rendered.length, 4);
    assert.match(rendered[0]!.textContent!, /Not offered here:.*reply requires/);
    assert.match(rendered[2]!.textContent!, /Not offered here: Only the poll may merge/);
    assert.match(rendered[3]!.querySelector("button")!.textContent!, /Approve aaaaaaa/);
  });

  for (const type of ["issue", "pull_request", "approve_pull_request", "review_pull_request", "reply_pull_request", "close_pull_request", "operator_action"]) {
    it(`explains why ${type} has no checked shortcut`, () => {
      const action = { type, repository: "jmarrero-forge/tracker", number: 1, head: "a".repeat(40), comment: 123 };
      const p = published([rawAsk(1, { action })]);
      const slot = document.createElement("section");
      fillActNow(slot, actNowRows(p, NOW), hooks);
      assert.match(slot.textContent!, /Not offered here: .+/);
      assert.ok(slot.querySelector("a[href]"));
    });
  }

  it("confirms and shares a SHA-bound merge receipt without duplicate writes", async () => {
    const head = "a".repeat(40);
    const p = published([rawAsk(1, { action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 1, head } })]);
    p.asks[0]!.requests = [{ forge: "github.com", quality: "decision", actions: [{ kind: "merge-or-enqueue", supported: true, reason: "checked" }] }];
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const shared = { ...hooks, writes: new Map<string, HTMLElement>(), merge: async (a: typeof p.asks[number], sha: string) => {
      assert.equal(a.key, key(1));
      assert.equal(sha, head);
      calls++;
      await gate;
      return { state: "enqueued" as const, url: "https://github.com/jmarrero-forge/tracker/pull/1" };
    } };
    const slot = document.createElement("section");
    const paint = () => fillActNow(slot, actNowRows(p, NOW), shared);
    paint();
    win.confirm = () => false;
    slot.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(calls, 0);
    win.confirm = () => true;
    slot.querySelector<HTMLButtonElement>("button")!.click();
    paint();
    slot.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(calls, 1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    paint();
    assert.match(slot.textContent!, /Enqueued, not merged/);
    slot.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(calls, 1);
  });

  it("is off without the optional evidence and never infers readiness from prose", () => {
    const p = published([rawAsk(1, { ask: "Approve and merge: releases 63 holds" })]);
    delete p.list!.actNow;
    assert.deepEqual(actNowRows(p, NOW), []);
    assert.equal(p.asks.length, 1);
    const legacy = parseNeedsYou(rawNeedsYou([rawAsk(1)], AT));
    assert.ok(typeof legacy === "object");
    assert.equal(legacy.actNow, undefined);
  });

  it("accepts ten ranked by unblocked work, priority, then oldest wait", () => {
    const items = Array.from({ length: 10 }, (_, i) => rawAsk(i + 1, { priority: "P0" }));
    Object.assign(items[7]!, { priority: "P2", waiting_since: "2026-10-01T00:00:00Z" });
    Object.assign(items[8]!, { priority: "P1", waiting_since: "2026-11-01T00:00:00Z" });
    Object.assign(items[9]!, { priority: "P1", waiting_since: "2026-10-01T00:00:00Z" });
    const p = published(items, items.map((_, i) => candidate(i + 1, i >= 7 ? 63 : 1)));
    const rows = actNowRows(p, NOW);
    assert.equal(rows.length, ACT_NOW_LIMIT);
    assert.deepEqual(rows.slice(0, 3).map((r) => r.ask.key), [key(10), key(9), key(8)]);
    assert.deepEqual(p.asks.map((a) => a.key), items.map((a) => a.key), "inbox inventory order is unchanged");
  });

  it("renders a published group once with its exact member count and a typed link on every row", () => {
    const p = published([rawAsk(1, { ask: "Approve the three named PRs", action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 1 }, group: { reason: "verdict holds", numbers: [1, 2, 3] } }), rawAsk(4, { ask: "Choose A or B <script>bad()</script>" })], [candidate(1, 63), candidate(4)]);
    const home = homeSkeleton({ toggled: () => {} });
    fillActNow(home.slots.actNow, actNowRows(p, NOW), hooks);
    assert.equal(home.slots.actNow.hidden, false);
    const rows = [...home.slots.actNow.querySelectorAll("li")];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent!, /3 PRs: verdict holds · unblocks 63/);
    assert.deepEqual(rows.map((r) => r.querySelector("a")?.href), ["https://github.com/jmarrero-forge/tracker/pull/1", "https://github.com/jmarrero-forge/tracker/issues/4"]);
    assert.equal(home.slots.actNow.querySelector("script, button"), null, "no representative-only group writes");
    fillActNow(home.slots.actNow, [], hooks);
    assert.equal(home.slots.actNow.hidden, true);
  });

  it("keeps route visibility separate from publication visibility across redraws", () => {
    const home = homeSkeleton({ toggled: () => {} });
    const slot = home.slots.actNow;
    showView(home.el, "inbox");
    assert.ok(slot.closest("[hidden]"), "an absent publication stays hidden on navigation");
    fillActNow(slot, actNowRows(published(), NOW), hooks);
    assert.equal(slot.closest("[hidden]"), null);
    showView(home.el, "status");
    fillActNow(slot, actNowRows(published(), NOW), hooks);
    assert.ok(slot.closest("[hidden]"), "a poll must not expose inbox content on Status");
    showView(home.el, "inbox");
    assert.equal(slot.closest("[hidden]"), null);
    fillActNow(slot, [], hooks);
    showView(home.el, "status");
    showView(home.el, "inbox");
    assert.ok(slot.closest("[hidden]"), "navigation must not expose an empty shortlist");
  });

  for (const [name, raw] of [
    ["non-array", {}], ["negative count", [candidate(1, -1)]], ["fraction", [candidate(1, 1.5)]],
    ["oversized count", [candidate(1, 10001)]], ["zero count", [candidate(1, 0)]], ["duplicate group", [candidate(1), candidate(1)]],
    ["missing target", [candidate(2)]], ["untyped key", [{ key: "https://evil.invalid", unblocks: 1 }]],
    ["oversized inventory", Array.from({ length: 11 }, (_, i) => candidate(i + 1))],
    ["mismatched head", [{ ...candidate(1), action: { type: "issue", repository: "other/repo", number: 1 } }]],
    ["mismatched priority", [{ ...candidate(1), priority: "P0" }]],
    ["mismatched wait", [{ ...candidate(1), waiting_since: AT }]],
  ] as const) it(`disables malformed ${name} without dropping Needs you`, () => {
    const p = published([rawAsk(1)], raw);
    assert.equal(p.list!.actNow, undefined);
    assert.equal(p.asks.length, 1);
  });

  it("requires a detailed key in the published inventory", () => {
    const identity = { ...rawAsk(2), detail_key: key(2) };
    assert.equal(published([rawAsk(1)], [candidate(1)], { identities: [identity] }).list!.actNow, undefined);
  });

  it("excludes unavailable, cached, stale and future lists", () => {
    const p = published();
    for (const over of [{ unavailable: true }, { error: "unreadable" }]) assert.deepEqual(actNowRows({ ...p, ...over }, NOW), []);
    const cached = { ...p };
    delete cached.checkedAt;
    assert.deepEqual(actNowRows(cached, NOW), []);
    assert.deepEqual(actNowRows(p, NOW + 71 * 60_000), []);
    assert.deepEqual(actNowRows(p, NOW - 1), []);
  });

  for (const [name, over] of [
    ["agent wait carried from last pass", { carried: true }],
    ["unknown decision", { requests: [{ quality: "unknown-request", forge: "github.com", actions: [] }] }],
  ] as const) it(`excludes ${name}`, () => {
    const p = published();
    Object.assign(p.asks[0]!, over);
    assert.deepEqual(actNowRows(p, NOW), []);
  });

  it("only includes producer-certified ready asks, not CI/agent/upstream waits, and removes completed ones", () => {
    const p = published([rawAsk(1), rawAsk(2, { ask: "Waiting on CI" }), rawAsk(3, { ask: "Waiting on agent" }), rawAsk(4, { ask: "Waiting upstream" })], [candidate(1)]);
    assert.deepEqual(actNowRows(p, NOW).map((r) => r.ask.key), [key(1)]);
    assert.deepEqual(actNowRows(p, NOW, new Map([[key(1), decisionKey(p.asks[0]!)]])), []);
    p.list!.sources.items = "partial";
    assert.deepEqual(actNowRows(p, NOW), []);
    p.list!.sources.items = "complete";
    p.asks[0]!.requestsUnreadable = true;
    assert.deepEqual(actNowRows(p, NOW), []);
    p.asks[0]!.requestsUnreadable = false;
    p.asks[0]!.requests = [{ quality: "decision", forge: "other.invalid", actions: [] }];
    assert.deepEqual(actNowRows(p, NOW), []);
  });

  it("ranks agent-board#308's decision first from an incomplete list, read-only", () => {
    // The pass read items in part, so #308 cannot be certified. Its count of
    // 12 is synthetic, not a claim about the live issue.
    const board = "jmarrero-forge/agent-board";
    const decision = rawAsk(308, { key: `${board}#308`, item: `${board}#308`, priority: "P1", target: `https://github.com/${board}/issues/308`,
      action: { type: "issue", repository: board, number: 308 }, source_ref: { type: "hold", repository: board, number: 308 }, ask: "Which promotion posture?" });
    const head = "a".repeat(40);
    const review = rawAsk(5, { source: "reviews", kind: "review-approve", action: { type: "approve_pull_request", repository: "jmarrero-forge/tracker", number: 5, head } });
    const pr = rawAsk(6, { action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 6, head } });
    const items = [review, rawAsk(1, { carried: true }), pr, decision];
    const records = [{ key: decision.key, unblocks: 12 }, { key: review.key, unblocks: 3 }];
    const sources = { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "off" };
    const p = published(items, records, { sources });
    assert.equal(p.list!.complete, false);
    const rows = actNowRows(p, NOW);
    assert.deepEqual(rows.map((r) => [r.ask.key, r.unblocks, r.fallback ?? false]),
      [[`${board}#308`, 12, true], [key(1), 0, true], [key(6), 0, true], [key(5), 3, false]]);
    const slot = document.createElement("section");
    fillActNow(slot, rows, { ...hooks, writes: new Map(), merge: async () => { throw new Error("a fallback row must not write"); } });
    assert.match(slot.querySelector("p.note")!.textContent!, /list is incomplete/);
    const rendered = [...slot.querySelectorAll("li")];
    assert.deepEqual(rendered.map((li) => li.querySelector("a")!.href), [`https://github.com/${board}/issues/308`,
      "https://github.com/jmarrero-forge/tracker/issues/1", "https://github.com/jmarrero-forge/tracker/pull/6", "https://github.com/jmarrero-forge/tracker/pull/5"]);
    assert.match(rendered[0]!.textContent!, /Which promotion posture\? · unblocks 12Inspect$/);
    assert.match(rendered[1]!.textContent!, /unblocks unknown · carried over; may be resolved/);
    assert.equal(rendered[2]!.querySelector("button"), null, "a needs-human PR listed directly gets no merge shortcut");

    const complete = published(items, records);
    assert.deepEqual(actNowRows(complete, NOW).map((r) => r.ask.key), [`${board}#308`, key(5)], "a complete list lists only certified rows");
    delete p.list!.actNow;
    assert.deepEqual(actNowRows(p, NOW).map((r) => [r.ask.key, r.unblocks]), [[`${board}#308`, 0], [key(1), 0], [key(6), 0]],
      "an incomplete list without act_now still lists its decisions, counts unknown");
  });

  for (const fullFirst of [true, false]) it(`reuses the head-checked approval and shared receipts (${fullFirst ? "card drawn" : "card paginated"})`, async () => {
    const head = "a".repeat(40);
    const p = published([rawAsk(1, { action: { type: "approve_pull_request", repository: "jmarrero-forge/tracker", number: 1, head }, ask: "Approve this head" })]);
    let sent = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const shared = { ...hooks, writes: new Map<string, HTMLElement>(), approve: async (a: typeof p.asks[number], h: string) => {
      assert.equal(a.key, key(1));
      assert.equal(h, head);
      sent++;
      await gate;
      return { status: "approved" as const, pr: { owner: "jmarrero-forge", repo: "tracker", number: 1 } };
    } };
    let full = fullFirst ? cardEl(askCard(p.asks[0]!), shared) : undefined;
    const slot = document.createElement("section");
    fillActNow(slot, actNowRows(p, NOW), shared);
    // Show more can materialize the card after its shortcut was drawn.
    full ??= cardEl(askCard(p.asks[0]!), shared);
    win.confirm = () => false;
    slot.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(sent, 0, "confirmation is required");
    win.confirm = () => true;
    slot.querySelector<HTMLButtonElement>("button")!.click();
    full.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(sent, 1, "the full inbox cannot send while the shortlist's write is pending");
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(full.querySelector("[data-sent]"), "the receipt stays on the full card");
    full.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(sent, 1, "a sent receipt prevents a duplicate write");
    fillActNow(slot, actNowRows(p, NOW), { ...shared, mayAct: false });
    assert.equal(slot.querySelector("button"), null);
  });
});
