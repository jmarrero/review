import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actNowGap, actNowRows, labelledIssues, type ActNowCoverage } from "../src/github/actnow.ts";
import { GitHub } from "../src/github/api.ts";
import { readSource, type Sources } from "../src/github/freshness.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { decisionKey, type Published } from "../src/github/inbox.ts";
import { fillActNow, type InboxHooks } from "../src/github/inboxview.ts";
import { loadNeedsHuman, NEEDS_HUMAN_PAGES, NEEDS_HUMAN_QUERY, type NeedsHumanRead } from "../src/github/needshuman.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom, rawActNow, rawAsk, rawNeedsYou, scriptedFetch, type Scripted } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const AT = "2026-11-06T12:00:00Z";
const NOW = Date.parse(AT);
const ORG = "jmarrero-forge";
const BOARD = `${ORG}/agent-board`;
const issue = (repo: string, n: number) => ({ html_url: `https://github.com/${repo}/issues/${n}`, title: `Issue ${n}` });

function client(route: (page: number) => Scripted) {
  const { fetchImpl, calls } = scriptedFetch((method, url) => {
    const u = new URL(url);
    assert.equal(method, "GET", "the direct read never writes");
    assert.equal(u.pathname, "/search/issues");
    assert.equal(u.searchParams.get("q"), NEEDS_HUMAN_QUERY);
    return route(Number(u.searchParams.get("page")));
  });
  return { gh: new GitHub(async () => "fixture-only", fetchImpl), calls };
}

function published(items: Record<string, unknown>[], unblocks: Record<string, number>, over: Record<string, unknown> = {}): Published {
  const act_now = items.filter((a) => unblocks[a.key as string] !== undefined).map((a) => ({ ...rawActNow(a), unblocks: unblocks[a.key as string] }));
  const list = parseNeedsYou(rawNeedsYou(items, AT, { act_now, ...over }));
  assert.ok(typeof list === "object", String(list));
  return { list, asks: list.items, unavailable: false, checkedAt: NOW };
}

const hooks: InboxHooks = { now: NOW, render, mayAct: true, answerEntry: async () => {} };
const noWrites = { ...hooks, writes: new Map(), merge: async () => { throw new Error("no write"); }, approve: async () => { throw new Error("no write"); } };

function draw(p: Published, read?: NeedsHumanRead): HTMLElement {
  const rows = actNowRows(p, NOW);
  const gap = actNowGap(p, NOW);
  const slot = document.createElement("section");
  const coverage: ActNowCoverage | undefined = gap === undefined ? undefined : { gap, ...(read ? { read } : {}), issues: labelledIssues(read, rows, p) };
  fillActNow(slot, rows, noWrites, coverage);
  return slot;
}

const links = (el: Element) => [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("needs-human direct read", () => {
  it("lists open issues in the forge organization only, deduplicated and in a fixed order", async () => {
    const { gh, calls } = client(() => ({ body: { total_count: 4, items: [issue(`${ORG}/tracker`, 10), issue(BOARD, 308), issue("other/repo", 1),
      { html_url: `https://github.com/${ORG}/tracker/pull/11`, title: "PR", pull_request: {} }, issue(BOARD, 308)] } }));
    const read = await loadNeedsHuman(gh);
    assert.deepEqual(read.issues.map((i) => [i.key, i.url]), [[`${BOARD}#308`, `https://github.com/${BOARD}/issues/308`], [`${ORG}/tracker#10`, `https://github.com/${ORG}/tracker/issues/10`]]);
    assert.equal(read.partial, undefined);
    assert.equal(calls.length, 1);
  });

  it("stops at its page bound and says how much it left unread", async () => {
    const { gh, calls } = client((page) => ({ body: { total_count: 450, items: Array.from({ length: 100 }, (_, i) => issue(`${ORG}/tracker`, page * 1000 + i)) } }));
    const read = await loadNeedsHuman(gh);
    assert.equal(calls.length, NEEDS_HUMAN_PAGES);
    assert.equal(read.issues.length, 300);
    assert.equal(read.partial, "read the first 300 of 450");
  });

  it("marks GitHub's incomplete search partial", async () => {
    const { gh } = client(() => ({ body: { total_count: 1, incomplete_results: true, items: [issue(BOARD, 308)] } }));
    assert.match((await loadNeedsHuman(gh)).partial!, /incomplete results/);
  });

  it("reports an auth or read failure instead of returning none", async () => {
    const { gh } = client(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const sources: Sources = {};
    assert.equal(await readSource(sources, "needs-human", loadNeedsHuman, gh), undefined);
    assert.equal(sources["needs-human"]!.state, "unavailable");
    assert.ok(sources["needs-human"]!.error);
  });

  for (const items of [undefined, null, {}, "", 0]) it(`rejects malformed search items: ${JSON.stringify(items)}`, async () => {
    const { gh, calls } = client(() => ({ body: { items } }));
    const sources: Sources = {};
    assert.equal(await readSource(sources, "needs-human", loadNeedsHuman, gh), undefined);
    assert.equal(calls.length, 1);
    assert.equal(sources["needs-human"]!.state, "unavailable");
    assert.match(sources["needs-human"]!.error!, /no valid items array/);
  });

  it("accepts an explicitly empty search", async () => {
    const { gh, calls } = client(() => ({ body: { items: [], total_count: 0, incomplete_results: false } }));
    assert.deepEqual(await loadNeedsHuman(gh), { issues: [] });
    assert.equal(calls.length, 1);
  });

  for (const bad of [null, 0, "bad", [], {}, { html_url: 42 }, { ...issue(BOARD, 2), title: {} }]) {
    for (const page of [1, 2]) it(`keeps decisions around a malformed record on page ${page}: ${JSON.stringify(bad)}`, async () => {
      const { gh, calls } = client((n) => ({ body: { items: n < page
        ? Array.from({ length: 100 }, (_, i) => issue(BOARD, i + 10))
        : [issue(BOARD, 1), bad, issue(BOARD, 3)], total_count: 103 } }));
      const read = await loadNeedsHuman(gh);
      assert.equal(read.issues.length, page === 1 ? 2 : 102);
      assert.ok(read.issues.some((i) => i.key === `${BOARD}#1`));
      assert.ok(read.issues.some((i) => i.key === `${BOARD}#3`));
      assert.match(read.partial!, /Some search records could not be read/);
      assert.equal(calls.length, page);
      const slot = draw({ asks: [], unavailable: false, error: "down" }, read);
      assert.match(slot.textContent!, /Partial:.*Some search records could not be read/);
      assert.doesNotMatch(slot.textContent!, /No open needs-human issue found/);
    });
  }

  it("does not claim no decisions when every record is malformed", async () => {
    const { gh } = client(() => ({ body: { items: [null, {}] } }));
    const read = await loadNeedsHuman(gh);
    assert.deepEqual(read.issues, []);
    assert.equal(read.partial, "Some search records could not be read");
    assert.doesNotMatch(draw({ asks: [], unavailable: false, error: "down" }, read).textContent!, /No open needs-human issue found/);
  });

  it("counts malformed records toward pagination and keeps other coverage warnings", async () => {
    const { gh, calls } = client((page) => ({ body: { items: Array.from({ length: 100 }, (_, i) => i ? null : issue(BOARD, page)), total_count: 450, incomplete_results: true } }));
    const read = await loadNeedsHuman(gh);
    assert.equal(calls.length, NEEDS_HUMAN_PAGES);
    assert.deepEqual(read.issues.map((i) => i.key), [1, 2, 3].map((n) => `${BOARD}#${n}`));
    assert.equal(read.partial, "GitHub's search returned incomplete results; read the first 300 of 450; Some search records could not be read");
  });

  for (const failure of [
    { name: "unauthorized", response: { status: 401, body: { message: "Bad credentials" } } },
    { name: "malformed", response: { body: {} } },
    { name: "network failure", response: undefined },
  ]) for (const failedPage of [2, 3]) it(`keeps earlier decisions after ${failure.name} on page ${failedPage}`, async () => {
    const { gh, calls } = client((page) => {
      if (page === failedPage) {
        if (!failure.response) throw new TypeError("Failed to fetch");
        return failure.response;
      }
      return { body: { items: Array.from({ length: 100 }, (_, i) => issue(BOARD, (page - 1) * 100 + i + 1)), total_count: 301, incomplete_results: true } };
    });
    const read = await loadNeedsHuman(gh);
    assert.equal(calls.length, failedPage, "stop at the failed page, without retrying or reading beyond it");
    assert.equal(read.issues.length, (failedPage - 1) * 100);
    assert.equal(read.issues[0]!.key, `${BOARD}#1`);
    assert.equal(read.issues.at(-1)!.key, `${BOARD}#${(failedPage - 1) * 100}`);
    assert.equal(read.error, undefined);
    assert.equal(read.partial, `GitHub's search returned incomplete results; Could not read search page ${failedPage}; only earlier pages are shown`);
    const slot = draw({ asks: [], unavailable: false, error: "publication unavailable" }, read);
    assert.ok(links(slot).includes(`https://github.com/${BOARD}/issues/1`));
    assert.match(slot.textContent!, /Partial:.*only earlier pages are shown/);
    assert.doesNotMatch(slot.textContent!, /No open needs-human issue found/);
    assert.equal(slot.querySelector("button, input, form"), null);
  });

  it("does not claim an empty search when earlier pages contain no in-scope issues", async () => {
    const { gh, calls } = client((page) => page === 1
      ? { body: { items: Array.from({ length: 100 }, (_, i) => issue("other/repo", i + 1)), total_count: 101 } }
      : { status: 401, body: { message: "Bad credentials" } });
    const read = await loadNeedsHuman(gh);
    assert.deepEqual(read.issues, []);
    assert.match(read.partial!, /Could not read search page 2/);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(draw({ asks: [], unavailable: false, error: "down" }, read).textContent!, /No open needs-human issue found/);
  });
});

describe("Act now decisions with the direct read", () => {
  // Twelve is synthetic: published evidence for twelve blocked PRs, not the live count.
  const decision = rawAsk(308, { key: `${BOARD}#308`, item: `${BOARD}#308`, target: `https://github.com/${BOARD}/issues/308`, ask: "Which promotion posture?",
    action: { type: "issue", repository: BOARD, number: 308 }, source_ref: { type: "hold", repository: BOARD, number: 308 } });
  const lower = [rawAsk(1), rawAsk(2, { priority: "P0" }), rawAsk(3)];

  it("ranks agent-board#308's twelve published blockers above lower-impact decisions", () => {
    const counts = { [`${ORG}/tracker#1`]: 3, [`${ORG}/tracker#2`]: 1, [`${BOARD}#308`]: 12 };
    const complete = published([...lower, decision], counts);
    assert.equal(actNowGap(complete, NOW), undefined);
    assert.deepEqual(actNowRows(complete, NOW).map((r) => [r.ask.key, r.unblocks]), [[`${BOARD}#308`, 12], [`${ORG}/tracker#1`, 3], [`${ORG}/tracker#2`, 1]]);
    const slot = draw(complete);
    assert.equal(slot.hidden, false);
    assert.equal(slot.querySelector(".act-now-gap, .act-now-labelled"), null, "a complete, current list needs no direct read");
    assert.match(slot.querySelector("li")!.textContent!, /Which promotion posture\? · unblocks 12/);

    const partial = published([...lower, decision], counts, { sources: { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "off" } });
    const rows = actNowRows(partial, NOW);
    assert.deepEqual(rows.map((r) => [r.ask.key, r.unblocks]), [[`${BOARD}#308`, 12], [`${ORG}/tracker#1`, 3], [`${ORG}/tracker#2`, 1], [`${ORG}/tracker#3`, 0]]);
    const drawn = draw(partial, { issues: [] });
    assert.match(drawn.querySelector(".act-now-gap")!.textContent!, /incomplete: Act now may be missing decisions/);
    assert.match([...drawn.querySelectorAll("ol li")][3]!.textContent!, /unblocks unknown/);
  });

  it("shows labelled issues while an incomplete list has no act_now rows, deduplicated against published rows", () => {
    const p = published([], {}, { complete: false, sources: { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "off" } });
    assert.deepEqual(actNowRows(p, NOW), []);
    const read: NeedsHumanRead = { issues: [{ key: `${BOARD}#308`, item: `${BOARD}#308`, title: "Promotion posture", url: `https://github.com/${BOARD}/issues/308` }] };
    const slot = draw(p, read);
    assert.equal(slot.hidden, false, "never an empty, hidden Act now while the list cannot vouch for it");
    const labelled = slot.querySelector(".act-now-labelled")!;
    assert.match(labelled.textContent!, /not certified/);
    assert.match(labelled.querySelector("li")!.textContent!, /Promotion posture · unblocks unknown/);
    assert.deepEqual(links(labelled.querySelector("ul")!), [`https://github.com/${BOARD}/issues/308`]);
    assert.equal(slot.querySelector("button, input, form"), null, "the direct read offers no write");

    const withPublished = published([decision], { [`${BOARD}#308`]: 12 }, { sources: { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "off" } });
    const both = draw(withPublished, read);
    assert.equal(both.querySelectorAll("li").length, 1, "published evidence wins over the label read");
    assert.match(both.querySelector("ol li")!.textContent!, /unblocks 12/);
    assert.match(both.querySelector(".act-now-labelled")!.textContent!, /Every labelled issue read is listed above or done here/);
  });

  it("drops a labelled issue completed here", () => {
    const p = published([decision], {}, { sources: { epics: "complete", items: "partial", reviews: "complete", proposals: "complete", digest: "off" } });
    const read: NeedsHumanRead = { issues: [{ key: `${BOARD}#308`, item: `${BOARD}#308`, title: "t", url: `https://github.com/${BOARD}/issues/308` }] };
    assert.deepEqual(labelledIssues(read, [], p, new Map([[p.asks[0]!.key, decisionKey(p.asks[0]!)]])), []);
  });

  for (const [name, over, gap] of [
    ["missing", { list: undefined, error: "The pass's snapshot has no needs-you list" }, /has no needs-you list/],
    ["failed", { list: undefined, error: "Couldn't read the pass's snapshot: 502" }, /Couldn't read the pass's snapshot: 502/],
    ["unavailable", { unavailable: true }, /can't be read now/],
    ["cached", { checkedAt: undefined }, /cached copy/],
    ["stale", {}, /stale/],
  ] as const) it(`says the ${name} publication's status rather than an empty Act now`, () => {
    const base = published([decision], { [`${BOARD}#308`]: 12 });
    const p = { ...base, ...over } as Published;
    const now = name === "stale" ? NOW + 2 * 3600_000 : NOW;
    assert.match(actNowGap(p, now)!, gap);
    if (name !== "stale") assert.equal(actNowRows(p, now).length, 0);
  });

  it("waits for the first read of the pass's list before reading labels", () => {
    assert.equal(actNowGap({ asks: [], unavailable: false }, NOW), undefined);
  });

  for (const [name, read, says] of [
    ["unread", undefined, /Listing needs-human issues…/],
    ["failed", { issues: [], error: "GitHub 401: Bad credentials" }, /Couldn't list needs-human issues: GitHub 401: Bad credentials\. Decisions may still be waiting/],
    ["empty partial", { issues: [], partial: "GitHub's search returned incomplete results" }, /Partial: GitHub's search returned incomplete results\. More may be waiting/],
    ["empty", { issues: [] }, /No open needs-human issue found/],
  ] as const) it(`labels the ${name} direct read honestly`, () => {
    const p: Published = { asks: [], unavailable: false, error: "Couldn't read the pass's snapshot: 502" };
    const slot = draw(p, read);
    assert.equal(slot.hidden, false);
    assert.match(slot.textContent!, says);
    if (name !== "empty") assert.doesNotMatch(slot.textContent!, /No open needs-human issue found/);
    for (const href of links(slot)) assert.match(href!, /^https:\/\/github\.com\//);
  });

  it("bounds the labelled list and links the rest to GitHub's search", () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ key: `${ORG}/tracker#${i + 1}`, item: `${ORG}/tracker#${i + 1}`, title: `t${i}`, url: `https://github.com/${ORG}/tracker/issues/${i + 1}` }));
    const slot = draw({ asks: [], unavailable: false, error: "down" }, { issues, partial: "read the first 300 of 450" });
    assert.equal(slot.querySelectorAll(".act-now-labelled li").length, 10);
    assert.match(slot.textContent!, /2 more: search on GitHub/);
    assert.match(slot.textContent!, /read the first 300 of 450/);
  });
});
