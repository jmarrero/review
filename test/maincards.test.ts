// The real main.ts hooks, not a parallel implementation of their writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { GitHub } from "../src/github/api.ts";
import { type ApprovalEvidence, type Ask, type ReviewBucket, parseNeedsYou } from "../src/github/holds.ts";
import { type Card, inboxCards, publishedCards, refusal } from "../src/github/inbox.ts";
import { fillInbox } from "../src/github/inboxview.ts";
import { fillState, homeSkeleton } from "../src/github/homeview.ts";
import { newestDraft, type ReviewDraftConfig } from "../src/github/reviewdrafts.ts";
import { CHAT_CONFIG } from "../src/github/chatconfig.ts";
import { fields, fixture, rawAsk, rawNeedsYou, scriptedFetch, type Scripted } from "./helpers.ts";

const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), { url: "https://review.example/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, HTMLElement: dom.window.HTMLElement,
  ResizeObserver: class { observe() {} disconnect() {} }, fetch: async () => { throw new Error("network forbidden"); } });
dom.window.confirm = () => true;
const { inboxHooks, snapshot } = await import("../src/github/main.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const target = "jmarrero-forge/tracker#50";
const url = "https://github.com/jmarrero-forge/tracker/issues/50";
const path = "/repos/jmarrero-forge/tracker/issues/50";
const head = "a".repeat(40);
const replacement = "b".repeat(40);

for (const cached of [false, true]) test(`browser snapshot retains ${cached ? "cached" : "failed"} freshness without legacy derivation`, () => {
  const r = setup(() => undefined);
  const source = { state: cached ? "ok" as const : "unavailable" as const, fetchedAt: 100, ...(cached ? {} : { error: "publication read failed" }) };
  r.state.active = { at: 100, fromCache: cached, sources: { holds: source }, warnings: [] };
  r.state.sources = {};
  const model = snapshot(r.state);
  assert.equal(model.schema, "review-inbox-state/v1");
  assert.equal(model.sources.holds!.state, cached ? "cached" : "unavailable");
  assert.equal(source.state, cached ? "ok" : "unavailable");
  const home = homeSkeleton({ toggled() {} });
  fillState(home, model);
  assert.equal(home.slots.freshness.hidden, false);
  assert.match(home.slots.freshness.textContent!, cached ? /holds: cached/ : /holds: unavailable.*publication read failed/);
});

// Verbatim producer projection at agent-board 957cb936, not a live capture.
const approvalFixture = fixture<{ rows: { key: string; head: string }[]; approval_evidence: { schema: string; observed_at: string; omitted: number; items: Record<string, Omit<ApprovalEvidence, "observed_at">> } }>("approval-evidence-needs-you.json");
function approvalPublication(extension: unknown = approvalFixture.approval_evidence, over: Record<string, unknown> = {}) {
  const items = approvalFixture.rows.map((row) => rawAsk(Number(row.key.split("#")[1]), { key: row.key, item: row.key, source: "reviews", kind: "review-approve", epic: "none", topEpic: "none",
    action: { type: "approve_pull_request", repository: "jmarrero-forge/tracker", number: Number(row.key.split("#")[1]), head: row.head } }));
  const parsed = parseNeedsYou(JSON.parse(JSON.stringify(rawNeedsYou(items, "2026-11-05T12:00:00Z", { approval_evidence: extension, ...over }))));
  assert.ok(typeof parsed === "object");
  return parsed;
}

test("producer approval projection: exact-head facts, unknown omissions, no drawing/poll reads", (t) => {
  t.mock.method(Date, "now", () => Date.parse(approvalFixture.approval_evidence.observed_at));
  const r = setup(() => { throw new Error("No target reads on draw"); });
  const list = approvalPublication();
  r.state.published = { asks: list.items, list, unavailable: false };
  for (let poll = 0; poll < 2; poll++) fillInbox(r.list, inboxCards({ published: r.state.published }), inboxHooks(r.state));
  const rows = [...r.list.querySelectorAll(".approval-evidence")];
  assert.match(rows[0]!.textContent!, /Diff \+12\/−3 · CI green · Review approved at .* · head a{40} · observed .*published, not live/);
  assert.match(rows[1]!.textContent!, /Diff unknown · CI unknown \(partial\) · Review unknown/);
  assert.ok(rows.slice(2).every((row) => /no matching published evidence/.test(row.textContent!)));
  assert.equal(r.calls.length, 0);
});

test("approval evidence fails closed on malformed, oversized, unread and wrong-head success", (t) => {
  t.mock.method(Date, "now", () => Date.parse(approvalFixture.approval_evidence.observed_at));
  const extension = approvalFixture.approval_evidence;
  const key = approvalFixture.rows[0]!.key;
  const good = extension.items[key]!;
  for (const bad of [null, { ...extension, schema: "future/v2" }, { ...extension, observed_at: "bad" },
    { ...extension, items: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`o/r#${i + 1}`, good])) },
    ...[{ assessed_head: replacement }, { diff: { additions: -1, deletions: 3 } }, { ci: { state: "success", complete: true } }, { review: { verdict: "approved", at: "bad" } }].map((v) => ({ ...extension, items: { [key]: { ...good, ...v } } }))]) {
    assert.equal(approvalPublication(bad).items[0]!.approvalEvidence, undefined);
  }
  for (const state of ["partial", "unread"]) assert.equal(approvalPublication(extension, { sources: { reviews: state } }).items[0]!.approvalEvidence, undefined);
  const wrong = rawAsk(1, { key, source: "reviews", action: { type: "approve_pull_request", repository: "other/repo", number: 1, head } });
  assert.equal(approvalPublication(extension, { items: [wrong] }).items[0]!.approvalEvidence, undefined);
  const r = setup(() => undefined);
  const a = approvalPublication().items[0]!;
  for (const patch of [{ carried: true }, { requestsUnreadable: true }, { requests: [{ forge: "github.com", quality: "unverified-carried", actions: [] }] }]) {
    fillInbox(r.list, publishedCards([{ ...a, ...patch }]), inboxHooks(r.state), true);
    assert.match(r.list.querySelector(".approval-evidence")!.textContent!, /no matching published evidence/);
  }
  const partial = { ...a, approvalEvidence: { ...a.approvalEvidence!, ci: { state: "green" as const, complete: false } } };
  fillInbox(r.list, publishedCards([partial]), inboxHooks(r.state), true);
  assert.match(r.list.querySelector(".approval-evidence")!.textContent!, /CI unknown \(partial\)/);
  fillInbox(r.list, publishedCards([a], true), inboxHooks(r.state), true);
  assert.match(r.list.querySelector(".approval-evidence")!.textContent!, /no matching published evidence/);
  assert.equal(r.calls.length, 0);
});

for (const state of ["busy", "", "sent"]) test(`evidence refreshes beside a retained ${state || "uncertain"} receipt, never across heads`, (t) => {
  t.mock.method(Date, "now", () => Date.parse(approvalFixture.approval_evidence.observed_at));
  const r = setup(() => undefined);
  const card = publishedCards(approvalPublication().items)[0]!;
  fillInbox(r.list, [card], inboxHooks(r.state));
  const original = r.list.firstElementChild!;
  const receipt = document.createElement("p");
  receipt.setAttribute(state === "sent" ? "data-sent" : "data-keep", state);
  original.append(receipt);
  fillInbox(r.list, publishedCards(approvalPublication(null).items).slice(0, 1), inboxHooks(r.state));
  assert.equal(r.list.firstElementChild, original);
  assert.match(original.querySelector(".approval-evidence")!.textContent!, /no matching published evidence/);
  fillInbox(r.list, [card], inboxHooks(r.state));
  assert.match(original.querySelector(".approval-evidence")!.textContent!, /CI green/);
  assert.ok("ask" in card);
  const moved = { ...card, ask: { ...card.ask, action: { ...card.ask.action, head: replacement }, approvalEvidence: { ...card.ask.approvalEvidence!, assessed_head: replacement } } };
  fillInbox(r.list, [moved], inboxHooks(r.state));
  assert.doesNotMatch(original.querySelector(".approval-evidence")!.textContent!, /CI green|b{40}/);
  if (state !== "sent") {
    fillInbox(r.list, [], inboxHooks(r.state));
    assert.equal(r.list.firstElementChild, original);
    assert.match(original.querySelector(".approval-evidence")!.textContent!, /no matching published evidence/);
  }
  assert.equal(r.calls.length, 0);
});

for (const evidence of [null, approvalFixture.approval_evidence]) test(`withheld indicator remains readable ${evidence ? "with" : "without"} evidence`, () => {
  const r = setup(() => undefined);
  const a = { ...approvalPublication(evidence).items[0]!, kind: "review-withheld" };
  fillInbox(r.list, publishedCards([a]), inboxHooks(r.state));
  assert.match(r.list.querySelector(".card-head")!.textContent!, /Review withheld/);
});

test("stale and future-clock evidence stays unknown without changing approval authority", (t) => {
  const r = setup(() => undefined);
  const cards = publishedCards(approvalPublication().items);
  for (const minutes of [-1, 71]) {
    t.mock.method(Date, "now", () => Date.parse(approvalFixture.approval_evidence.observed_at) + minutes * 60_000);
    fillInbox(r.list, cards, inboxHooks(r.state));
    assert.match(r.list.querySelector(".approval-evidence")!.textContent!, /no matching published evidence/);
    assert.equal(cards[0]!.kind, "approve");
  }
  assert.equal(r.calls.length, 0);
});

for (const [name, requests, navigation] of [
  ["legacy", undefined, true], ["GitHub", [{ key: "o/r#7", forge: "github.com", quality: "decision", actions: [] }], true],
  ["foreign", [{ key: "o/r#7", forge: "other.example", quality: "decision", actions: [] }], false],
  ["malformed", [{ key: "o/r#7", forge: "github.com", quality: "broken", actions: [] }], false],
  ["missing", [], false], ["oversized", Array.from({ length: 501 }, () => ({ key: "o/r#7" })), false],
] as const) test(`missing detail preserves ${name} descriptor restrictions without Answer authority`, () => {
  const r = setup(() => undefined);
  const list = parseNeedsYou(rawNeedsYou([], "2026-11-05T12:00:00Z", { count: 1, identities: [{ key: "o/r#7", detail_key: "o/r#7", item: "o/r#7", source: "reviews", kind: "review-withheld", priority: null, waiting_since: "2026-11-05T11:00:00Z" }], ...(requests === undefined ? {} : { requests }) }));
  assert.ok(typeof list === "object");
  const cards = inboxCards({ published: { asks: [], list, unavailable: false } });
  assert.equal(cards[0]!.kind, "open");
  fillInbox(r.list, cards, inboxHooks(r.state));
  assert.equal(!!r.list.querySelector("a[href]"), navigation);
  assert.equal(r.list.querySelector("form, .card-full, button[type=submit]"), null);
  assert.match(r.list.textContent!, /Review withheld/);
  assert.equal(r.calls.length, 0);
});

const bucketFixture = fixture("draft-review-needs-you.json") as { schema: string; group: { reason: string; numbers: number[] }; review_buckets: Record<string, ReviewBucket> };
function bucketCard(over: Record<string, unknown> = {}, askOver: Record<string, unknown> = {}): Card {
  const a = rawAsk(1, { key: "jmarrero-forge/bootc#1", item: "jmarrero-forge/bootc#1", source: "reviews", kind: "review-promote",
    action: { type: "pull_request", repository: "jmarrero-forge/bootc", number: 1 }, group: bucketFixture.group, ...askOver });
  // The shared producer fixture is a projection, not a full publication.
  // Supply the unchanged baseline envelope and consume its schema verbatim.
  const list = parseNeedsYou(JSON.parse(JSON.stringify(rawNeedsYou([a], "2026-11-05T00:00:00Z", { ...bucketFixture, ...over }))));
  assert.equal(typeof list, "object");
  return publishedCards((list as Exclude<typeof list, string>).items)[0]!;
}
const bootcDraft = (n: number) => ({ ...draft(n, n === 2 ? replacement : head), html_url: `https://github.com/jmarrero-forge/bootc/pull/${n}` });
const shown = () => ({ title: "Which way?", body: "Q: Which way?", state: "open", html_url: url, labels: [{ name: "needs-human" }, { name: "needs-design" }, { name: "other" }] });
/** The pass's asks of `raw`. */
function asks(...raw: Record<string, unknown>[]): Ask[] {
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-30T00:00:00Z"));
  assert.ok(typeof l === "object", String(l));
  return l.items;
}
/** The pass's asks of `raw`, as cards. */
const cards = (...raw: Record<string, unknown>[]): Card[] => publishedCards(asks(...raw));
/** The pass's hold on tracker#50, as its card. */
const answerCard = (kind = "needs-human"): Card => cards(rawAsk(50, { kind, ask: "Which way?" }))[0]!;
const questionIssue = () => ({ ...shown(), labels: [{ name: "question" }, ...shown().labels], user: { login: "jmarrero-bot" }, assignees: [{ login: "jmarrero" }] });
function setup(route: (method: string, path: string) => Scripted | undefined, login = "jmarrero", drafts?: ReviewDraftConfig) {
  const f = scriptedFetch((method, url) => new URL(url).pathname === "/user" ? { body: { login } } : route(method, new URL(url).pathname) ?? (new URL(url).pathname === "/graphql" ? { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [] } } } } } } : undefined));
  const state = { gh: new GitHub(async () => "test", f.fetchImpl) } as Parameters<typeof inboxHooks>[0];
  state.items = [];
  Object.assign(state, { poller: { now() {} }, reviewed: new Map(), pending: new Map(), verdicts: new Map(), waiting: [], details: new Map(), prs: [], forgeKnown: new Set(), answered: new Set(), sent: new Set(), linked: new Set() });
  let list = document.createElement("div");
  document.body.append(list);
  const paint = (card: Card, force = false, remount = false, listed: Ask[] = "ask" in card ? [card.ask] : []) => {
    state.published = { asks: listed, unavailable: false };
    if (remount) { list.remove(); list = document.createElement("div"); document.body.append(list); }
    fillInbox(list, [card], inboxHooks(state, drafts), force);
    for (const fold of list.querySelectorAll<HTMLDetailsElement>(".card-full")) { fold.open = true; fold.dispatchEvent(new dom.window.Event("toggle")); }
  };
  return { ...f, state, paint, get list() { return list; }, writes: () => f.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql")) };
}
async function answer(opts: { login?: string; after?: boolean; fail?: "comment" | "release"; kind?: string } = {}) {
  let posted = false;
  const r = setup((method, p) => {
    if (method === "GET" && p === path) return { body: { ...shown(), ...(opts.after && posted ? { body: "Q: A different ask" } : {}) } };
    if (method === "POST" && p === `${path}/comments`) { posted = true; return { status: opts.fail === "comment" ? 502 : 200, body: { html_url: `${url}#issuecomment-1` } }; }
    if (method === "DELETE") return { status: opts.fail === "release" ? 403 : 204 };
    return undefined;
  }, opts.login);
  const card = answerCard(opts.kind);
  r.paint(card);
  await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  return { r, card, form };
}

const promotion = () => cards(rawAsk(7, { key: "jmarrero-forge/widget#7", kind: "review-promote", action: { type: "pull_request", repository: "jmarrero-forge/widget", number: 7 }, group: { reason: "drafts", numbers: [7, 8] } }))[0]!;
const draft = (n: number, sha = head) => ({ html_url: `https://github.com/jmarrero-forge/widget/pull/${n}`, title: `Draft ${n}`, state: "open", draft: true, user: { login: "jmarrero-bot" }, head: { sha }, body: "<!-- bot-meta -->\n- Upstream: `up/widget`\n<!-- /bot-meta -->" });
async function openMember(r: ReturnType<typeof setup>, n = 0) {
  const d = r.list.querySelectorAll<HTMLDetailsElement>(".member")[n]!;
  d.open = true;
  await settle();
  return d;
}

test("promotion sends exactly the inspected commit; independent sent/uncertain receipts survive reload while changed heads reread", async () => {
  let sha = head;
  const r = setup((method, p) => {
    const n = Number(/\/pulls\/(\d+)/.exec(p)?.[1]);
    if (method === "GET" && p.endsWith("/reviews")) return { body: [] };
    if (method === "GET") return { body: draft(n, sha) };
    return { status: n === 8 ? 502 : 200, body: { html_url: `${draft(n).html_url}#pullrequestreview-1` } };
  });
  const c = promotion();
  r.paint(c);
  for (const n of [0, 1]) {
    const d = await openMember(r, n);
    d.querySelector<HTMLButtonElement>("button")!.click();
    d.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
  }
  assert.deepEqual(r.writes().map((c) => c.body), [{ event: "APPROVE", commit_id: head }, { event: "APPROVE", commit_id: head }]);
  assert.match(r.list.textContent!, /Approval sent:.*Waiting on promoter/s);
  assert.match(r.list.textContent!, /Not sent, or uncertain/);
  assert.equal(r.list.querySelector(".card-done"), null);
  r.paint(c, true, true);
  for (const n of [0, 1]) {
    const d = await openMember(r, n);
    assert.equal(d.querySelector("button")!.disabled, true);
    d.querySelector<HTMLButtonElement>("button")!.click();
  }
  assert.equal(r.writes().length, 2);
  sha = replacement;
  r.paint(c, true, true);
  const d = await openMember(r);
  assert.match(d.textContent!, /bbbbbbb/);
  assert.equal([...d.querySelectorAll("button")].find((b) => b.textContent === "Promote bbbbbbb")!.disabled, false);
  assert.equal(r.writes().length, 2, "rereading does not approve a changed head");
});

for (const failure of ["head", "race", "viewer", "membership", "policy", "closed", "ready", "ineligible", "human-text", "target", "unavailable", "foreign", "unreadable"] as const) {
  test(`promotion guards ${failure} and never authorizes a replacement`, async () => {
    let reads = 0;
    const r = setup((method, p) => {
      if (p.endsWith("/reviews") && method === "GET") {
        if (failure === "race") reads = 99;
        return { body: [] };
      }
      if (method === "POST") return { body: {} };
      reads++;
      const pr = draft(7, failure === "head" && reads > 1 || failure === "race" && reads > 99 ? replacement : head);
      if (reads > 1) {
        if (failure === "closed") pr.state = "closed";
        if (failure === "ready") pr.draft = false;
        if (failure === "ineligible") pr.user.login = "someone";
        if (failure === "human-text") pr.body = pr.body.replace("- Upstream:", "- Contribution policy: `human-text`\n- Upstream:");
        if (failure === "target") pr.html_url = draft(8).html_url;
      }
      return { body: pr };
    }, failure === "viewer" ? "someone-else" : "jmarrero");
    const c = promotion();
    r.paint(c);
    const d = await openMember(r);
    if (["membership", "policy", "unavailable", "foreign", "unreadable"].includes(failure)) {
      const a = r.state.published.asks[0]!;
      if (failure === "membership") a.group!.numbers = [8];
      else if (failure === "unavailable") r.state.published.unavailable = true;
      else if (failure === "unreadable") a.requestsUnreadable = true;
      else a.requests = [{ forge: failure === "foreign" ? "forge.example" : "github.com", quality: "decision", actions: [{ kind: "promote", supported: false, reason: "revoked" }] }];
    }
    d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    assert.equal(r.writes().length, 0);
    assert.equal(d.querySelector("button")!.disabled, true);
    if (failure === "head" || failure === "race") assert.match(d.textContent!, /This member changed.*reread/);
  });
}

test("push after final preflight cannot change the APPROVE payload", async () => {
  let live = head;
  const r = setup((method, p) => {
    if (method === "POST") { live = replacement; return { body: {} }; }
    return { body: p.endsWith("/reviews") ? [] : draft(7, live) };
  });
  r.paint(promotion());
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.equal(live, replacement);
  assert.deepEqual(r.writes().map((c) => c.body), [{ event: "APPROVE", commit_id: head }]);
});

test("fresh client recovers existing approval without writing and refuses a full review page", async () => {
  for (const count of [1, 100]) {
    const r = setup((_method, p) => ({ body: p.endsWith("/reviews") ? Array.from({ length: count }, () => ({ user: { login: "jmarrero" }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-03T00:00:00Z" })) : draft(7) }));
    r.paint(promotion());
    const d = await openMember(r);
    d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    assert.equal(r.writes().length, 0);
    assert.match(d.textContent!, count === 1 ? /Already approved:.*Waiting on promoter/ : /Reviews exceed one page/);
  }
});

for (const state of ["CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "APPROVED"]) test(`promotion recovery respects the latest deciding review: ${state}`, async () => {
  const review = (state: string, commit_id = head, login = "jmarrero") => ({ user: { login }, state, commit_id, submitted_at: "2026-11-03T00:00:00Z" });
  const reviews = [review("APPROVED"), review(state, state === "APPROVED" ? replacement : head), review("COMMENTED"), review("APPROVED", head, "other")];
  const r = setup((method, p) => ({ body: method === "POST" ? {} : p.endsWith("/reviews") ? reviews : draft(7) }));
  r.paint(promotion());
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.equal(r.writes().length, state === "COMMENTED" ? 0 : 1);
  assert.match(d.textContent!, state === "COMMENTED" ? /Already approved/ : /Approval sent/);
});

test("a late-submitted pending change request supersedes an approval created later", async () => {
  const reviews = [
    { user: { login: "jmarrero" }, state: "CHANGES_REQUESTED", commit_id: head, submitted_at: "2026-11-03T02:00:00Z" },
    { user: { login: "jmarrero" }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-03T01:00:00Z" },
  ];
  const r = setup((method, p) => ({ body: method === "POST" ? {} : p.endsWith("/reviews") ? reviews : draft(7) }));
  r.paint(promotion());
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.deepEqual(r.writes().map((c) => c.body), [{ event: "APPROVE", commit_id: head }]);
});

for (const failure of [false, true]) for (const policy of ["foreign", "unreadable", "unsupported", "read-failed"] as const) {
  test(`${failure ? "uncertain" : "sent"} member receipt survives ${policy} policy and reload`, async () => {
    let down = false;
    const r = setup((method, p) => down ? { status: 502 } : { status: method === "POST" && failure ? 502 : 200, body: method === "POST" ? { html_url: `${draft(7).html_url}#pullrequestreview-1` } : p.endsWith("/reviews") ? [] : draft(7) });
    const c = promotion() as Card & { kind: "promote" };
    r.paint(c);
    const d = await openMember(r);
    d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    const receipt = failure ? /Not sent, or uncertain/ : /Approval sent:.*pullrequestreview-1/s;
    assert.match(d.textContent!, receipt);
    const restricted = { ...c, ask: { ...c.ask,
      ...(policy === "unreadable" ? { requestsUnreadable: true } : policy === "read-failed" ? {} : { requests: [{ forge: policy === "foreign" ? "forge.example" : "github.com", quality: "decision", actions: [{ kind: "promote", supported: false, reason: "revoked" }] }] }),
    } };
    down = policy === "read-failed";
    for (const remount of [false, true]) {
      r.paint(restricted, true, remount);
      if (policy === "unsupported" || policy === "read-failed") await openMember(r);
      assert.match(r.list.textContent!, receipt);
      assert.equal(r.list.querySelector(".card-body .actions button:not(:disabled)"), null);
      if (policy === "foreign" || policy === "unreadable") {
        assert.equal(r.list.querySelector("a[href]"), null);
        assert.match(r.list.textContent!, /Prior write on jmarrero-forge\/widget#7/);
      }
      assert.equal(r.writes().length, 1);
    }
  });
}

for (const failRead of [false, true]) test(`obsolete member ${failRead ? "failed" : "successful"} read cannot steal a restricted receipt`, async () => {
  let delay = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const r = setup((method, p) => ({ body: method === "POST" ? { html_url: `${draft(7).html_url}#pullrequestreview-1` } : p.endsWith("/reviews") ? [] : draft(7) }));
  r.state.gh = new GitHub(async () => "test", async (url, init) => {
    if (delay && new URL(url).pathname.endsWith("/pulls/7")) {
      await pending;
      if (failRead) return new Response("unavailable", { status: 502 });
    }
    return r.fetchImpl(url, init);
  });
  const c = promotion() as Card & { kind: "promote" };
  r.paint(c);
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  r.paint(c, true);
  delay = true;
  const obsolete = await openMember(r);
  assert.match(obsolete.textContent!, /Reading/);
  r.paint({ ...c, ask: { ...c.ask, requestsUnreadable: true } });
  assert.match(r.list.textContent!, /Prior write.*Approval sent:.*pullrequestreview-1/s);
  release(); await settle();
  assert.match(r.list.textContent!, /Prior write.*Approval sent:.*pullrequestreview-1/s);
  assert.equal(r.list.querySelector("a[href], button"), null);
  assert.equal(r.writes().length, 1);
});

for (const failure of [false, true]) test(`policy revocation keeps a pending member's eventual ${failure ? "uncertain" : "sent"} outcome visible`, async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const r = setup((method, p) => ({ status: method === "POST" && failure ? 502 : 200, body: method === "POST" ? { html_url: `${draft(7).html_url}#pullrequestreview-1` } : p.endsWith("/reviews") ? [] : draft(7) }));
  r.state.gh = new GitHub(async () => "test", async (url, init) => {
    if (init?.method === "POST") await pending;
    return r.fetchImpl(url, init);
  });
  const c = promotion() as Card & { kind: "promote" };
  r.paint(c);
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  const restricted = { ...c, ask: { ...c.ask, requestsUnreadable: true } };
  r.paint(restricted);
  assert.match(r.list.textContent!, /Prior write.*Sending/s);
  release(); await settle();
  assert.match(r.list.textContent!, failure ? /Not sent, or uncertain/ : /Approval sent:.*pullrequestreview-1.*Waiting on promoter/s);
  assert.equal(r.list.querySelector(".card-done"), null, "one member's completion never marks the group done");
  assert.equal(r.list.querySelector("a[href], button"), null);
  r.paint(restricted);
  assert.match(r.list.textContent!, failure ? /Not sent, or uncertain/ : /Approval sent/);
  assert.equal(r.writes().length, 1);
});

test("a pending member preflight's revoked-policy failure survives restricted reloads", async () => {
  let release!: () => void;
  let reads = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const r = setup((_method, p) => ({ body: p.endsWith("/reviews") ? [] : draft(7) }));
  r.state.gh = new GitHub(async () => "test", async (url, init) => {
    if (new URL(url).pathname.endsWith("/pulls/7") && ++reads === 3) await pending;
    return r.fetchImpl(url, init);
  });
  const c = promotion() as Card & { kind: "promote" };
  r.paint(c);
  const d = await openMember(r);
  d.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.equal(reads, 3);
  const restricted = { ...c, ask: { ...c.ask, requestsUnreadable: true } };
  r.paint(restricted);
  release(); await settle();
  for (const remount of [false, true]) {
    r.paint(restricted, true, remount);
    assert.match(r.list.textContent!, /Not sent:.*descriptors could not be read safely/);
    assert.equal(r.list.querySelector("a[href], button"), null);
  }
  assert.equal(r.writes().length, 0);
  r.paint(c, true);
  const fresh = await openMember(r);
  assert.equal(fresh.querySelector("button")!.disabled, false, "a valid policy allows explicit rereading after preflight refusal");
});

for (const failure of [false, true]) test(`inspection preserves pending ordinary approval's live ${failure ? "uncertain" : "sent"} completion`, async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const r = setup((method, p) => ({ status: method === "POST" && failure ? 502 : 200, body: method === "POST" ? { html_url: `${draft(7).html_url}#pullrequestreview-1` } : p.endsWith("/reviews") ? [] : draft(7) }));
  r.state.gh = new GitHub(async () => "test", async (url, init) => {
    if (init?.method === "POST") await pending;
    return r.fetchImpl(url, init);
  });
  r.paint(cards(rawAsk(7, { kind: "review-approve", action: { type: "approve_pull_request", repository: "jmarrero-forge/widget", number: 7, head } }))[0]!);
  r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  const c = promotion() as Card & { kind: "promote" };
  const restricted = { ...c, ask: { ...c.ask, requestsUnreadable: true } };
  r.paint(restricted, true, true);
  assert.match(r.list.textContent!, /Prior write.*Sending/s);
  release(); await settle();
  for (const remount of [false, true]) {
    r.paint(restricted, true, remount);
    assert.match(r.list.textContent!, failure ? /Not sent, or uncertain/ : /Approved:.*pullrequestreview-1/s);
    assert.doesNotMatch(r.list.textContent!, /Sending/);
    assert.equal(r.list.querySelector("a[href], button"), null);
    assert.equal(r.writes().length, 1);
  }
});

test("moved member recovers only after reload, rereading and a new confirmation", async () => {
  let sha = head;
  const r = setup((method, p) => ({ body: method === "POST" ? {} : p.endsWith("/reviews") ? [] : draft(7, sha) }));
  const c = promotion();
  r.paint(c);
  const old = await openMember(r);
  sha = replacement;
  old.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.match(old.textContent!, /This member changed/);
  r.paint(c, true);
  const fresh = await openMember(r);
  assert.notEqual(old, fresh);
  assert.equal(r.writes().length, 0);
  fresh.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.deepEqual(r.writes().map((c) => c.body), [{ event: "APPROVE", commit_id: replacement }]);
});

test("main answer posts, then removes exactly needs-human; sent receipt survives refresh, metadata redraw and remount", async () => {
  const { r, card, form } = await answer();
  assert.deepEqual(r.writes().map((c) => `${c.method} ${new URL(c.url).pathname}`), [`POST ${path}/comments`, `DELETE ${path}/labels/needs-human`]);
  assert.match(form.textContent!, /issuecomment-1/);
  assert.ok(r.list.querySelector(".card")!.classList.contains("card-done"));
  assert.match(r.list.textContent!, /Released: needs-human on jmarrero-forge\/tracker#50, the needs-human hold\. Other holds stay\. Waiting on the agent\./);
  r.paint({ ...card, priority: "P0" }, true, true);
  await settle();
  assert.equal(r.list.querySelector("form"), form);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(r.writes().length, 2);
});

test("main refuses a retained representative answer after a malformed group is published", async () => {
  const r = setup((_method, p) => p === path ? { body: shown() } : undefined);
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Not sent";
  const l = parseNeedsYou(rawNeedsYou([rawAsk(50, { group: { reason: "drafts", numbers: [50, 0] } })], "2026-10-30T00:00:00Z"));
  assert.ok(typeof l === "object");
  r.state.published = { asks: l.items, list: l, unavailable: false };
  fillInbox(r.list, publishedCards(l.items), inboxHooks(r.state));
  assert.equal(form.querySelector("button")!.disabled, true);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.equal(form.querySelector("textarea")!.value, "Not sent");
});

test("main digest approval skips a member the pass has since grouped", async () => {
  const r = setup(() => undefined);
  const digest = (group?: unknown) => rawAsk(7, { kind: "digest-approve", action: { type: "approve_pull_request", repository: "o/r", number: 7, head }, ...(group ? { group } : {}) });
  r.state.published = { asks: asks(digest({ reason: "drafts", numbers: [7, 8] })), unavailable: false };
  const rs = await inboxHooks(r.state).approveDigest!([{ pr: { owner: "o", repo: "r", number: 7 }, head, reason: "ok" }]);
  assert.deepEqual(rs.map((x) => x.status), ["skipped"]);
  assert.match(rs[0]!.note!, /grouped/);
  assert.equal(r.writes().length, 0);
});

const approvalAsk = (n: number, kind = "review-approve") => rawAsk(n, { key: `up/proj#${n}${kind === "digest-approve" ? "/digest" : ""}`, item: `up/proj#${n}`, kind, action: { type: "approve_pull_request", repository: "up/proj", number: n, head } });

for (const lostResponse of [false, true]) test(`ordinary real hook retains ${lostResponse ? "lost-response" : "502"} uncertainty on redraw, reload and remount without another POST`, async () => {
  const r = setup((method, p) => {
    if (method === "POST") {
      if (lostResponse) throw new Error("Response lost");
      return { status: 502 };
    }
    return { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: head } } };
  });
  const c = cards(approvalAsk(7))[0]!;
  r.paint(c);
  r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  for (const force of [false, true]) {
    r.paint({ ...c, priority: "P0" }, force, true);
    assert.match(r.list.textContent!, /Not sent, or uncertain/);
    assert.equal(r.list.querySelector<HTMLButtonElement>(".primary")!.disabled, true);
    r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  }
  assert.equal(r.writes().length, 1);
  const result = await inboxHooks(r.state).approve!("ask" in c ? c.ask : assert.fail(), head);
  assert.equal(result.status, "uncertain");
  assert.equal(r.writes().length, 1, "backend also refuses duplicate writes independently of the DOM");
});

test("approval status never comes from human-readable error text", async () => {
  const r = setup(() => ({ status: 503, body: { message: "already approved at HEAD; MaybeSentError; uncertain" } }));
  const c = cards(approvalAsk(7))[0]!;
  r.paint(c);
  if (!("ask" in c)) assert.fail();
  const result = await inboxHooks(r.state).approve!(c.ask, head);
  assert.equal(result.status, "failed");
  r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  assert.match(r.list.textContent!, /Not sent:/);
  assert.equal(r.list.querySelector("[data-sent]"), null);
  assert.equal(r.list.querySelector<HTMLButtonElement>(".primary")!.disabled, false);
  assert.equal(r.writes().length, 0);
});

test("ordinary preflight failures remain safely retryable, not uncertain", async () => {
  let moved = true;
  const r = setup((method, p) => ({ body: method === "POST" ? {} : p.endsWith("/reviews") ? [] : { state: "open", head: { sha: moved ? replacement : head } } }));
  const c = cards(approvalAsk(7))[0]!;
  r.paint(c);
  r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  assert.match(r.list.textContent!, /Not sent:.*head moved/);
  assert.equal(r.list.querySelector("[data-sent]"), null);
  assert.equal(r.writes().length, 0);
  moved = false;
  r.paint(c, true, true);
  r.list.querySelector<HTMLButtonElement>(".primary")!.click(); await settle();
  assert.match(r.list.textContent!, /Approved:/);
  assert.equal(r.writes().length, 1);
});

test("an already drawn digest cannot overwrite an ordinary uncertain receipt with a later preflight refusal", async () => {
  let moved = false;
  const r = setup((method, p) => method === "POST" ? { status: 502 } : { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: moved ? replacement : head } } });
  const listed = asks(approvalAsk(7), approvalAsk(7, "digest-approve"));
  r.state.published = { asks: listed, unavailable: false };
  fillInbox(r.list, publishedCards(listed), inboxHooks(r.state));
  r.list.querySelector<HTMLButtonElement>(".c-approve .primary")!.click(); await settle();
  moved = true;
  r.list.querySelector<HTMLButtonElement>(".maintain-sec button")!.click(); await settle();
  assert.match(r.list.querySelector(".maintain-results")!.textContent!, /Not sent, or uncertain/);
  assert.equal(r.list.querySelector<HTMLInputElement>(".maintain-sec input")!.disabled, true);
  assert.equal(r.writes().length, 1);
  r.paint(cards(approvalAsk(7))[0]!, true, true);
  assert.match(r.list.textContent!, /Not sent, or uncertain/);
  assert.equal(r.list.querySelector<HTMLButtonElement>(".primary")!.disabled, true);
});

test("an already drawn ordinary card respects digest uncertainty even after the backend receipt expires", async () => {
  const r = setup((method, p) => method === "POST" ? { status: 502 } : { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: head } } });
  const listed = asks(approvalAsk(7), approvalAsk(7, "digest-approve"));
  r.state.published = { asks: listed, unavailable: false };
  fillInbox(r.list, publishedCards(listed), inboxHooks(r.state));
  r.list.querySelector<HTMLButtonElement>(".maintain-sec button")!.click(); await settle();
  const report = r.list.querySelector(".maintain-results")!;
  assert.match(report.textContent!, /Failed or uncertain: up\/proj#7/);
  const realNow = Date.now;
  const later = realNow() + 6 * 60_000;
  Date.now = () => later;
  try {
    r.list.querySelector<HTMLButtonElement>(".c-approve .primary")!.click(); await settle();
    assert.equal(r.list.querySelector(".c-approve .primary"), null);
    assert.match(r.list.querySelector(".c-approve")!.textContent!, /Failed or uncertain: up\/proj#7/);
    assert.match(report.textContent!, /Failed or uncertain: up\/proj#7/);
    assert.equal(r.writes().length, 1, "the session receipt, not the expired backend cache, prevents another POST");
  } finally { Date.now = realNow; }
});

test("adding and removing an ordinary card never steals the digest's detailed receipt", async () => {
  const r = setup((method, p) => method === "POST" ? { status: 502 } : { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: head } } });
  const digest = asks(approvalAsk(7, "digest-approve"));
  r.paint(publishedCards(digest)[0]!, false, false, digest);
  r.list.querySelector<HTMLButtonElement>(".maintain-sec button")!.click(); await settle();
  const report = r.list.querySelector(".maintain-results")!;
  const listed = asks(approvalAsk(7), approvalAsk(7, "digest-approve"));
  r.state.published = { asks: listed, unavailable: false };
  fillInbox(r.list, publishedCards(listed), inboxHooks(r.state));
  assert.match(report.textContent!, /Failed or uncertain: up\/proj#7/);
  assert.match(r.list.querySelector(".c-approve")!.textContent!, /Failed or uncertain: up\/proj#7/);
  r.state.published.asks = digest;
  fillInbox(r.list, publishedCards(digest), inboxHooks(r.state), true);
  assert.match(r.list.querySelector(".maintain-results")!.textContent!, /Failed or uncertain: up\/proj#7/);
  assert.equal(r.writes().length, 1);
});

for (const mode of ["read-failed", "ordinary-read-failed", "changed-head", "member-refused", "foreign", "unreadable", "unsupported"] as const) {
  test(`visible mixed digest keeps its own rows during nonrepresentative member inspection: ${mode}`, async () => {
    let inspecting = false;
    const r = setup((method, p) => {
      const n = Number(/\/pulls\/(\d+)/.exec(p)?.[1]);
      if (method === "POST") return n === 8 ? { status: 502 } : { body: {} };
      if (inspecting && mode.endsWith("read-failed")) return { status: 503 };
      if (n === 10) return { status: 503 };
      if (p.endsWith("/reviews")) return { body: n === 12 ? [{ user: { login: "jmarrero" }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-03T00:00:00Z" }] : [] };
      const pr = draft(n, n === 9 || inspecting && mode === "changed-head" ? replacement : head);
      if (inspecting && mode === "member-refused") pr.draft = false;
      return { body: pr };
    });
    const listed = asks(...[7, 8, 9, 10, 12].map((n) => rawAsk(n, { key: `jmarrero-forge/widget#${n}/digest`, kind: "digest-approve", action: { type: "approve_pull_request", repository: "jmarrero-forge/widget", number: n, head } })));
    r.paint(publishedCards(listed)[0]!, false, false, listed);
    r.list.querySelector<HTMLButtonElement>(".maintain-sec button")!.click(); await settle();
    const report = r.list.querySelector(".maintain-results")!;
    const rows = [...report.children];
    const outcomes = rows.map((row) => row.textContent);
    assert.deepEqual(rows.map((row) => row.className), ["approved", "uncertain", "skipped", "failed", "already-approved"]);
    assert.equal(r.writes().length, 2);
    inspecting = true;
    const group = cards(rawAsk(6, { key: "jmarrero-forge/widget#6", kind: mode === "ordinary-read-failed" ? "review-approve" : "review-promote",
      action: { type: "pull_request", repository: "jmarrero-forge/widget", number: 6 }, group: { reason: "inspect nonrepresentatives", numbers: [6, 7, 8, 12] },
    }))[0]!;
    assert.ok("ask" in group);
    if (mode === "unreadable") group.ask.requestsUnreadable = true;
    if (["foreign", "unsupported"].includes(mode)) group.ask.requests = [{ forge: mode === "foreign" ? "forge.example" : "github.com", quality: "decision", actions: [{ kind: "promote", supported: false, reason: "promotion disabled by publisher" }] }];
    const all = [...publishedCards(listed), group];
    for (const force of [false, true, true]) {
      r.state.published = { asks: [...listed, ...("ask" in group ? [group.ask] : [])], unavailable: false };
      fillInbox(r.list, all, inboxHooks(r.state), force);
      if (!["foreign", "unreadable"].includes(mode)) for (const i of [1, 2, 3]) await openMember(r, i);
      const inspectingCard = r.list.querySelector(".members")?.closest("article") ?? r.list.querySelector(".c-promote")!;
      assert.deepEqual([...report.children], rows, "inspection retains every original row in the visible digest");
      assert.deepEqual(rows.map((row) => row.textContent), outcomes);
      for (const text of [outcomes[0], outcomes[1], outcomes[4]]) assert.ok(inspectingCard.textContent!.includes(text!), text!);
      for (const copy of inspectingCard.querySelectorAll("[data-approval-receipt]")) {
        assert.equal(copy.querySelector("button, input, textarea, select, a[href]"), null);
        assert.ok(!rows.includes(copy), "member sees a copy, not the digest-owned node");
      }
      if (mode === "unsupported") assert.match(inspectingCard.textContent!, /promotion disabled by publisher/);
      if (["foreign", "unreadable"].includes(mode)) assert.equal(inspectingCard.querySelector("a[href], button"), null);
      assert.deepEqual([...r.list.querySelectorAll<HTMLInputElement>(".maintain-sec input")].map((x) => x.disabled), [true, true, false, false, true]);
      assert.equal(r.writes().length, 2, "reload and inspection never POST");
    }
  });
}

test("real digest mixed outcomes retain per-head uncertainty across changed membership and ordinary cards", async () => {
  const r = setup((method, p) => {
    const n = Number(/\/pulls\/(\d+)/.exec(p)?.[1]);
    if (method === "POST") return n === 8 ? { status: 502 } : { body: {} };
    if (n === 10) return { status: 503 };
    if (p.endsWith("/reviews")) return { body: n === 12 ? [{ user: { login: "jmarrero" }, state: "APPROVED", commit_id: head, submitted_at: "2026-11-03T00:00:00Z" }] : [] };
    return { body: { state: "open", head: { sha: n === 9 ? replacement : head } } };
  });
  const raw = [7, 8, 9, 10, 11, 12].map((n) => approvalAsk(n, "digest-approve"));
  const listed = asks(...raw);
  const c = publishedCards(listed)[0]!;
  r.paint(c, false, false, listed);
  r.list.querySelectorAll<HTMLInputElement>("input")[4]!.checked = false;
  r.list.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.deepEqual(r.writes().map((x) => new URL(x.url).pathname), ["/repos/up/proj/pulls/7/reviews", "/repos/up/proj/pulls/8/reviews"]);
  assert.deepEqual([...r.list.querySelectorAll<HTMLInputElement>("input")].map((x) => x.disabled), [true, true, false, false, false, true]);
  assert.match(r.list.textContent!, /Failed or uncertain: up\/proj#8/);
  assert.match(r.list.textContent!, /Not sent: up\/proj#10/);
  assert.match(r.list.textContent!, /Skipped: up\/proj#9/);
  const changed = asks(...raw.slice(1));
  r.paint(publishedCards(changed)[0]!, true, true, changed);
  assert.match(r.list.textContent!, /Failed or uncertain: up\/proj#8/);
  assert.equal(r.list.querySelector<HTMLInputElement>("input")!.disabled, true);
  r.list.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  assert.equal(r.writes().filter((x) => x.url.includes("/pulls/8/")).length, 1);
  const ordinary = cards(approvalAsk(8))[0]!;
  r.paint(ordinary, true, true);
  assert.match(r.list.textContent!, /Failed or uncertain: up\/proj#8/);
  assert.equal(r.list.querySelector(".primary"), null, "a digest receipt also blocks the ordinary approval");
});

for (const promote of [false, true]) test(`${promote ? "Promote" : "ordinary"} grouped members keep independent exact Inspect links when lazy reads fail`, async () => {
  const r = setup(() => ({ status: 502 }));
  const c = promote ? promotion() : byKey("jmarrero-forge/widget#44");
  r.paint(c);
  for (const i of [0, 1]) {
    const d = await openMember(r, i);
    assert.equal(d.querySelector("summary a")!.getAttribute("href"), `#pr/jmarrero-forge/widget/${(promote ? 7 : 44) + i}`);
    assert.match(d.textContent!, /502/);
    assert.equal(d.querySelector("button"), null);
  }
  assert.equal(r.writes().length, 0);
  if (!("ask" in c)) assert.fail();
  for (const patch of [{ requestsUnreadable: true }, { requests: [{ forge: "https://forgejo.example/git", quality: "decision", actions: [] }] }]) {
    r.paint({ ...c, ask: { ...c.ask, ...patch } }, true, true);
    assert.equal(r.list.querySelector("a[href]"), null);
  }
});

test("main refuses wrong viewer and retains the unsent draft across ordinary redraw", async () => {
  const { r, card, form } = await answer({ login: "someone-else" });
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /not jmarrero's/);
  r.paint({ ...card, priority: "P0" });
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("textarea")!.value, "Go left.");
});

test("main refuses a moved ask before commenting, and a changed ask after commenting before release", async () => {
  let reads = 0;
  const r = setup((_method, p) => p === path ? { body: { ...shown(), body: reads++ ? "Q: Changed" : shown().body } } : undefined);
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Answer";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
  const after = await answer({ after: true });
  assert.equal(after.r.writes().length, 1);
  assert.match(after.form.textContent!, /issuecomment-1; release failed: .*ask changed/);
});

test("main keeps a release-failure receipt visible beside a failed remount read", async () => {
  let down = false;
  const r = setup((method, p) => {
    if (down) return { status: 502 };
    if (method === "GET" && p === path) return { body: shown() };
    if (method === "POST" && p === `${path}/comments`) return { body: { html_url: `${url}#issuecomment-1` } };
    if (method === "DELETE") return { status: 403 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.match(form.textContent!, /issuecomment-1; release failed/);
  down = true;
  r.paint({ ...answerCard(), priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  assert.match(r.list.querySelector(".warn")!.textContent!, /502/);
  assert.equal(r.writes().length, 2);
});

test("main refuses a replaced bot-comment ask even when the issue body did not change", async () => {
  let reads = 0;
  const r = setup((_method, p) => {
    if (p === path) return { body: shown() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: reads++ ? "Decision needed: A new question" : "Decision needed: Which way?", author: { login: "jmarrero-bot" } }] } } } } } };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Answer";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
});

test("main checks bot-comment freshness on a question the pass lists", async () => {
  let reads = 0;
  const r = setup((_method, p) => {
    if (p === path) return { body: questionIssue() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: reads++ ? "Decision needed: Changed" : "Decision needed: Which way?", author: { login: "jmarrero-bot" } }] } } } } } };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(form.textContent!, /ask changed/);
});

test("main offers no form for a target that closed or moved since the pass listed it", async () => {
  for (const changed of [{ state: "closed" }, { html_url: "https://github.com/elsewhere/tracker/issues/50" }]) {
    const r = setup((_method, p) => p === path ? { body: { ...questionIssue(), ...changed } } : undefined);
    r.paint(answerCard()); await settle();
    assert.equal(r.list.querySelector("form"), null);
    assert.match(r.list.textContent!, /not answering/);
    assert.equal(r.writes().length, 0);
  }
});

test("main receipts use the target and read ask across redraws of a changed card, but allow a new bot ask", async () => {
  let ask = "Decision needed: Which way?";
  const r = setup((method, p) => {
    if (p === path) return { body: questionIssue() };
    if (p === "/graphql") return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes: [{ body: ask, author: { login: "jmarrero-bot" } }] } } } } } };
    if (method === "POST") return { status: 502 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  r.paint({ ...answerCard(), title: "Refreshed question card" }, true, true); await settle();
  assert.match(r.list.textContent!, /Refreshed question card/);
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  assert.equal(r.writes().length, 1);
  ask = "Decision needed: A genuinely new ask";
  r.paint({ ...answerCard(), title: "New ask" }, true, true); await settle();
  assert.notEqual(r.list.querySelector("form"), form);
  assert.equal(r.list.querySelector<HTMLButtonElement>("form button")!.disabled, false);
  assert.match(r.list.textContent!, /A genuinely new ask/);
});

test("main resolves only an ask-created board question; never closes arbitrary held work or unlabels Blocks targets", async () => {
  const question = { ...shown(), body: "Blocks: https://github.com/up/proj/issues/7\n\nQ: Which way?", labels: [{ name: "question" }, ...shown().labels], user: { login: "jmarrero-bot" }, assignees: [{ login: "jmarrero" }] };
  const r = setup((method, p) => {
    if (p === path) return { body: question };
    if (p.endsWith("/fields")) return { body: fields() };
    if (p.endsWith("/items")) return { body: [{ id: 50, node_id: "PVTI_50", content_type: "Issue", content: question, fields: [] }] };
    if (method === "POST" && p === `${path}/comments`) return { body: { html_url: `${url}#issuecomment-1` } };
    if (method === "DELETE") return { status: 204 };
    return undefined;
  });
  r.paint(answerCard()); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Go left.";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.deepEqual(r.writes().map((c) => `${c.method} ${new URL(c.url).pathname}`), [`POST ${path}/comments`, `PATCH ${path}`, `DELETE ${path}/labels/needs-human`]);
  assert.deepEqual(r.writes()[1]!.body, { state: "closed", state_reason: "completed" });
});

for (const receipt of [null, {}, { html_url: 42 }, { html_url: "" }, { html_url: url },
  { html_url: `${url}#issuecomment-0` }, { html_url: `${url}#issuecomment-1/extra` },
  { html_url: `${url.replace("github.com", "example.com")}#issuecomment-1` },
  { html_url: `${url.replace("/50", "/999")}#issuecomment-1` }]) {
  test(`main does not release a hold after an unconfirmed comment receipt ${JSON.stringify(receipt)}`, async () => {
    const r = setup((method, p) => {
      if (p === path) return { body: shown() };
      if (method === "POST" && p === `${path}/comments`) return { status: 201, body: receipt };
      if (method === "DELETE") return { status: 204 };
      return undefined;
    });
    const card = answerCard();
    r.paint(card); await settle();
    const form = r.list.querySelector("form")!;
    form.querySelector("textarea")!.value = "Go left.";
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
    assert.match(form.textContent!, /Comment failed or uncertain/);
    assert.deepEqual(r.writes().map((c) => c.method), ["POST"]);
    r.paint(card, true, true); await settle();
    assert.equal(r.list.querySelector("form"), form);
    assert.equal(form.querySelector("button")!.disabled, true);
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
    assert.equal(r.writes().length, 1);
  });
}

for (const fail of ["comment", "release"] as const) test(`main keeps ${fail} failure across forced refresh and never offers another comment`, async () => {
  const { r, card, form } = await answer({ fail });
  const count = r.writes().length;
  assert.match(form.textContent!, fail === "release" ? /Answer posted: .*issuecomment-1; release failed/ : /Comment failed or uncertain/);
  r.paint({ ...card, priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("button")!.disabled, true);
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); await settle();
  assert.equal(r.writes().length, count);
});

for (const kind of ["needs-operator", "epic-unplanned"]) test(`main never releases ${kind} with a comment`, async () => {
  const { r, form } = await answer({ kind });
  assert.equal(r.writes().length, 1);
  assert.match(form.textContent!, /Only a comment/);
  assert.match(r.list.textContent!, new RegExp(`Commented only: the ${kind} hold on jmarrero-forge/tracker#50 stays`));
  assert.doesNotMatch(r.list.textContent!, /Released/);
});

test("main digest partial results survive forced redraw without offering approved PRs again", async () => {
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: p.endsWith("/8") ? "b".repeat(40) : head } } } : { body: {} });
  const listed = asks(...[7, 8].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, source: "digest", kind: "digest-approve", recommendation: "Ready", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } })));
  const card = publishedCards(listed)[0]!;
  r.paint(card, false, false, listed);
  r.list.querySelector("button")!.click(); await settle();
  const report = r.list.querySelector(".maintain-results");
  assert.match(report!.textContent!, /Approved up\/proj#7.*Skipped/s);
  r.paint({ ...card, priority: "P0" }, true, true, listed);
  assert.equal(r.list.querySelector(".maintain-results"), report);
  assert.equal(r.list.querySelector<HTMLInputElement>("input")!.disabled, true);
  assert.equal(r.writes().length, 1);
});

test("main Send checks the viewer before ticking, and preserves its refusal on redraw", async () => {
  const c: ReviewDraftConfig = { tracker: "example/tracker", label: "review-draft", authors: ["bot"], sendBox: "Send", workflow: "draft.yml", ref: "main" };
  const issue = { number: 5, title: "Draft", html_url: "https://github.com/example/tracker/issues/5", comments: 0, user: { login: "bot" },
    body: `\`\`\`review-draft\npr = "up/proj#7"\nhead = "${head}"\nevent = "APPROVE"\n\`\`\`\n\n## Review\n\nLooks good.\n\n- [ ] Send\n` };
  const r = setup(() => ({ body: { title: "PR", html_url: "https://github.com/up/proj/pull/7", state: "open", head: { sha: head } } }), "someone-else", c);
  const card: Card = { kind: "send", key: "draft:5", title: "Draft", where: "example/tracker#5", url: issue.html_url, draft: { issue, box: "unticked", found: newestDraft(issue, [], c)! } };
  r.paint(card); await settle();
  r.list.querySelector("button")!.click(); await settle();
  assert.equal(r.writes().length, 0);
  assert.match(r.list.textContent!, /not jmarrero's/);
  const send = r.list.querySelector(".review-draft");
  r.paint({ ...card, priority: "P0" }, true, true); await settle();
  assert.equal(r.list.querySelector(".review-draft"), send);
});

// A redacted list in the shape agent-board's needs-you requests publish
// (agent-board#642, pass/holds/requests.rs): its action kinds and reasons
// verbatim, its repositories, numbers, heads and questions replaced.
const published = (): Card[] => {
  const l = parseNeedsYou(fixture("needs-you-requests.json"));
  assert.ok(typeof l === "object" && l.complete && !l.refused, String(l));
  return publishedCards(l.items);
};
const byKey = (key: string): Card => published().find((c) => c.key === key)!;

test("main draws each published request with only the step the pass and this forge allow", async () => {
  const cases: { key: string; kind: string; button?: string; refused?: RegExp; offered?: string; members?: number; note?: RegExp }[] = [
    { key: "jmarrero-forge/tracker#1101", kind: "answer", offered: "Not offered here: promote, merge or enqueue, close" },
    { key: "jmarrero-forge/widget#41", kind: "promote", members: 2, offered: "Not offered here: merge or enqueue, reply, close", note: /2 PRs: drafts waiting for promotion/ },
    { key: "jmarrero-forge/widget#43", kind: "approve", button: "Approve ccccccc", offered: "Not offered here: promote, merge or enqueue, reply, close" },
    { key: "up/proj#7", kind: "approve", refused: /Not offered here: Use a forge review bound to target\.head/, offered: "Not offered here: merge or enqueue, approve at the head", note: /marks this request unverified-carried/ },
    { key: "jmarrero-forge/widget#44", kind: "open", members: 2, offered: "Not offered here: reply", note: /missing-concrete-decision/ },
    { key: "mid/proj#3", kind: "answer", refused: /on https:\/\/forgejo\.example:3000\/git, and this page writes only to github\.com/ },
  ];
  for (const c of cases) {
    const r = setup(() => undefined);
    const card = byKey(c.key);
    assert.equal(card.kind, c.kind, c.key);
    r.paint(card); await settle();
    const el = r.list.querySelector(".card")!;
    assert.equal(el.querySelector(".card-body.actions button")?.textContent, c.button, c.key);
    if (c.refused) {
      assert.match(el.querySelector(".card-body .warn")!.textContent!, c.refused, c.key);
      assert.equal(el.querySelector("form, .card-body button"), null, c.key);
    }
    assert.equal(el.querySelector(".not-offered summary")?.textContent, c.offered, c.key);
    assert.equal(el.querySelectorAll("details.member").length, c.members ?? 0, c.key);
    if (c.note) assert.match(el.querySelector(".card-note")!.textContent!, c.note, c.key);
    // A group is never answered through its representative.
    if (c.members) assert.equal(el.querySelector("form"), null, c.key);
    assert.equal(r.writes().length, 0, c.key);
  }
});

test("main's chat answers only where the card would, and any descriptor ruling a step out rules it out", { skip: !CHAT_CONFIG && "chat is off in this deployment (no session source)" }, () => {
  const state = { gh: new GitHub(async () => "t", async () => { throw new Error("network forbidden"); }) } as Parameters<typeof inboxHooks>[0];
  const hooks = inboxHooks(state);
  assert.equal(typeof hooks.chatItem!(byKey("jmarrero-forge/tracker#1101"))?.answer, "function");
  assert.equal(hooks.chatItem!(byKey("mid/proj#3"))?.answer, undefined);
  const approve = byKey("jmarrero-forge/widget#43") as Card & { kind: "approve" };
  const [live] = approve.ask.requests!;
  const carried = { ...live!, actions: [{ kind: "review-at-head", supported: false, reason: "carried" }] };
  for (const requests of [[live!, carried], [carried, live!]]) assert.equal(refusal({ ...approve.ask, requests }, "review-at-head"), "carried");
});

const BOT_META = "Fix.\n\n<!-- bot-meta -->\n- Upstream: `up/widget`, base `main`\n<!-- /bot-meta -->";

test("main reads promotion members on demand but respects unsupported descriptors", async () => {
  const B = "b".repeat(40);
  const pulls: Record<number, { body: string; sha: string; moved?: string; post?: number }> = {
    41: { body: BOT_META, sha: head },
    42: { body: BOT_META, sha: head, moved: B },
  };
  const read = new Map<number, number>();
  const r = setup((method, p) => {
    const m = /^\/repos\/jmarrero-forge\/widget\/(?:pulls|issues)\/(\d+)(\/comments)?$/.exec(p);
    const pr = m && pulls[Number(m[1])];
    if (!pr) return undefined;
    if (method === "POST" && m![2]) return { status: pr.post ?? 201, body: { html_url: `https://github.com/jmarrero-forge/widget/pull/${m![1]}#issuecomment-9` } };
    const n = (read.get(Number(m![1])) ?? 0) + 1;
    read.set(Number(m![1]), n);
    return { body: { html_url: `https://github.com/jmarrero-forge/widget/pull/${m![1]}`, title: `Draft ${m![1]}`, state: "open", draft: true, body: pr.body, user: { login: "jmarrero-bot" }, head: { sha: n > 1 && pr.moved ? pr.moved : pr.sha } } };
  });
  r.paint(byKey("jmarrero-forge/widget#41")); await settle();
  assert.equal(read.size, 0, "nothing is read until a member is opened");
  const [first, second] = r.list.querySelectorAll<HTMLDetailsElement>("details.member");
  for (const d of [first!, second!]) { d.open = true; d.dispatchEvent(new dom.window.Event("toggle")); }
  await settle();
  assert.match(first!.textContent!, /Draft 41 · open draft · aaaaaaa · by jmarrero-bot · Review/);
  for (const d of [first!, second!]) {
    assert.equal(d.querySelector("button"), null);
    assert.match(d.textContent!, /promotion evaluation and writes are not implemented/);
  }
  assert.deepEqual(r.writes(), []);
  // An old member report must not freeze the group's live readers on r.
  const report = document.createElement("p");
  report.dataset.keep = "";
  report.dataset.sent = "";
  first!.append(report);
  r.paint(byKey("jmarrero-forge/widget#41"), true);
  const again = r.list.querySelectorAll<HTMLDetailsElement>("details.member")[1]!;
  again.open = true; again.dispatchEvent(new dom.window.Event("toggle")); await settle();
  assert.notEqual(again, second);
  assert.match(again.textContent!, /Draft 42 · open draft · bbbbbbb/);
  assert.deepEqual(r.writes(), []);
});

test("main explains member-specific promotion problems", async () => {
  for (const [body, user, why] of [["No meta.", "jmarrero-bot", /names no upstream/], [BOT_META, "someone", /not a jmarrero-bot PR in jmarrero-forge/]] as const) {
    const r = setup((method, p) => p === "/repos/jmarrero-forge/widget/pulls/41" ? { body: { html_url: "https://github.com/jmarrero-forge/widget/pull/41", title: "T", state: "open", draft: true, body, user: { login: user }, head: { sha: head } } } : undefined);
    r.paint(byKey("jmarrero-forge/widget#41"));
    const d = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    d.open = true; d.dispatchEvent(new dom.window.Event("toggle")); await settle();
    assert.match(d.textContent!, why);
    assert.equal(d.querySelector("button"), null);
  }
});

test("foreign-forge cards offer neither GitHub inspection nor a GitHub chat target", async () => {
  const r = setup(() => { throw new Error("must not read GitHub"); });
  r.paint(byKey("mid/proj#3")); await settle();
  assert.equal(r.list.querySelector("a, button, form"), null);
  assert.equal(r.list.querySelector(".card")!.getAttribute("data-href"), "#");
  assert.equal(r.calls.length, 0);
});

test("digest aggregation leaves foreign and unsupported requests read-only", async () => {
  const items = [7, 8, 9].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, source: "digest", kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } }));
  const requests = items.map((a, i) => ({ key: a.key, forge: i === 1 ? "https://forgejo.example/git" : "github.com", quality: "decision", actions: [{ kind: "review-at-head", supported: i !== 2, reason: "approval unsupported" }] }));
  const l = parseNeedsYou(rawNeedsYou(items, "2026-10-30T00:00:00Z", { requests }));
  assert.ok(typeof l === "object");
  const all = publishedCards(l.items);
  assert.deepEqual(all.map((c) => c.key), ["digest", "up/proj#8/digest", "up/proj#9/digest"]);
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: head } } } : { body: {} });
  for (const card of all.slice(1)) {
    r.paint(card, true, true); await settle();
    assert.equal(r.list.querySelector(".card-body button, input, form"), null);
    assert.match(r.list.textContent!, /Not offered here:/);
  }
  r.paint(all[0]!, true, true, l.items);
  r.list.querySelector("button")!.click(); await settle();
  assert.deepEqual(r.writes().map((c) => new URL(c.url).pathname), ["/repos/up/proj/pulls/7/reviews"]);
});

test("malformed and capped descriptors never restore legacy writes or navigation", async () => {
  for (const forge of ["github.com", "https://forgejo.example/git"]) {
    const request = { key: target.toLowerCase(), forge, quality: "decision", actions: [{ kind: "reply", supported: false, reason: "unsupported" }] };
    for (const requests of [
      [{ ...request, actions: [{ kind: "reply", supported: false, reason: "" }] }],
      [{ ...request, quality: "future-quality" }],
      [...Array.from({ length: 500 }, () => ({ ...request, key: "other/repo#1" })), request],
      null,
      [{}],
      [],
      [{ ...request, key: "other/repo#1" }],
    ]) {
      const l = parseNeedsYou(rawNeedsYou([rawAsk(50)], "2026-10-30T00:00:00Z", { requests }));
      assert.ok(typeof l === "object" && !l.complete);
      assert.equal(l.items[0]!.requestsUnreadable, true);
      const r = setup(() => { throw new Error("must not read GitHub"); });
      r.paint(publishedCards(l.items)[0]!); await settle();
      assert.match(r.list.textContent!, /descriptors could not be read safely/);
      assert.equal(r.list.querySelector("button, form, a"), null);
      assert.equal(r.calls.length, 0);
    }
  }
});

test("cached approval refusals cannot outlive updated forge or capability restrictions", async () => {
  for (const policy of [
    { forge: "https://forgejo.example/git", actions: [{ kind: "review-at-head", supported: true, reason: "ready" }] },
    { forge: "github.com", actions: [{ kind: "review-at-head", supported: false, reason: "unsupported" }] },
    { forge: "github.com", actions: [] },
    { forge: "github.com", actions: [{ kind: "future-action", supported: true, reason: "ready" }] },
    { forge: "github.com", actions: [{ kind: "review-at-head", supported: true, reason: "" }] },
  ]) {
    const r = setup((_method, p) => p.endsWith("/reviews") ? { body: [] } : p.includes("/pulls/") ? { body: { state: "open", head: { sha: "b".repeat(40) } } } : undefined);
    const raw = rawAsk(7, { key: "up/proj#7", item: "up/proj#7", kind: "review-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 7, head } });
    const initial = cards(raw)[0]!;
    r.paint(initial);
    const old = r.list.querySelector<HTMLButtonElement>(".card-body button")!;
    old.click(); await settle();
    assert.equal(old.disabled, false);
    assert.match(r.list.textContent!, /head moved/);
    const l = parseNeedsYou(rawNeedsYou([raw], "2026-10-30T00:00:00Z", { requests: [{ key: raw.key, quality: "decision", ...policy }] }));
    assert.ok(typeof l === "object");
    const restricted = publishedCards(l.items)[0]!;
    r.paint(restricted);
    assert.equal(old.disabled, true, "a retained receipt loses its obsolete controls");
    assert.equal(r.list.querySelector("a[href]"), null);
    old.click(); await settle();
    assert.equal(r.writes().length, 0);
    r.paint(restricted, true);
    assert.equal(r.list.querySelector(".card-body button, form"), null);
    assert.match(r.list.textContent!, /Not offered here:/);
    assert.equal(r.writes().length, 0);
  }
});

test("a retained answer keeps its text but cannot submit after its forge changes", async () => {
  const r = setup((_method, p) => p === path ? { body: shown() } : undefined);
  const card = answerCard() as Card & { kind: "answer" };
  r.paint(card); await settle();
  const form = r.list.querySelector("form")!;
  form.querySelector("textarea")!.value = "Keep this unsent answer.";
  r.paint({ ...card, ask: { ...card.ask, requestsUnreadable: true } });
  assert.equal(r.list.querySelector("form"), form);
  assert.equal(form.querySelector("textarea")!.value, "Keep this unsent answer.");
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true })); await settle();
  assert.equal(r.writes().length, 0);
  assert.equal(r.list.querySelector("a[href]"), null);
});

test("new restrictions also retire an old digest's picked members", async () => {
  const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: "b".repeat(40) } } } : { body: {} });
  const raw = [7, 8].map((n) => rawAsk(n, { key: `up/proj#${n}/digest`, item: `up/proj#${n}`, kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: n, head } }));
  r.paint(cards(...raw)[0]!);
  const old = r.list.querySelector<HTMLButtonElement>("button")!;
  old.click(); await settle();
  const l = parseNeedsYou(rawNeedsYou(raw, "2026-10-30T00:00:00Z", { requests: raw.map((a, i) => ({ key: a.key, forge: i ? "https://forgejo.example/git" : "github.com", quality: "decision", actions: [{ kind: "review-at-head", supported: true, reason: "ready" }] })) }));
  assert.ok(typeof l === "object");
  const current = publishedCards(l.items)[0]!;
  r.paint(current);
  assert.equal(old.disabled, true);
  old.click(); await settle();
  assert.equal(r.writes().length, 0);
  r.paint(current, true);
  assert.equal(r.list.querySelectorAll("input").length, 1);
});

test("ordinary groups reread members on r after either success or a failed read", async () => {
  for (const fail of [false, true]) {
    let reads = 0;
    const r = setup((_method, p) => {
      if (p !== "/repos/jmarrero-forge/widget/pulls/44") return undefined;
      reads++;
      return fail && reads === 1 ? { status: 502 } : { body: { html_url: "https://github.com/jmarrero-forge/widget/pull/44", title: "Member", state: "open", body: BOT_META, user: { login: "jmarrero-bot" }, head: { sha: reads === 1 ? head : "b".repeat(40) } } };
    });
    const card = byKey("jmarrero-forge/widget#44");
    r.paint(card);
    const first = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    first.open = true; first.dispatchEvent(new dom.window.Event("toggle")); await settle();
    r.paint(card, true);
    const second = r.list.querySelector<HTMLDetailsElement>("details.member")!;
    assert.notEqual(first, second);
    second.open = true; second.dispatchEvent(new dom.window.Event("toggle")); await settle();
    assert.equal(reads, 2);
    assert.match(second.textContent!, /bbbbbbb/);
  }
});

test("a digest that disappears when all members are restricted retains no approval authority", async () => {
  for (const restricted of [
    { forge: "https://forgejo.example/git", supported: true, reason: "ready" },
    { forge: "github.com", supported: false, reason: "unsupported" },
    { forge: "github.com", supported: true, reason: "" },
  ]) {
    const r = setup((method, p) => method === "GET" ? { body: p.endsWith("/reviews") ? [] : { state: "open", head: { sha: "b".repeat(40) } } } : { body: {} });
    const raw = rawAsk(7, { key: "up/proj#7/digest", item: "up/proj#7", kind: "digest-approve", action: { type: "approve_pull_request", repository: "up/proj", number: 7, head } });
    r.paint(cards(raw)[0]!);
    const old = r.list.querySelector<HTMLButtonElement>("button")!;
    old.click(); await settle();
    assert.equal(old.disabled, false);
    const l = parseNeedsYou(rawNeedsYou([raw], "2026-10-30T00:00:00Z", { requests: [{ key: raw.key, forge: restricted.forge, quality: "decision", actions: [{ kind: "review-at-head", supported: restricted.supported, reason: restricted.reason }] }] }));
    assert.ok(typeof l === "object");
    const current = publishedCards(l.items);
    assert.equal(current.some((c) => c.kind === "digest"), false);
    r.paint(current[0]!);
    assert.ok(r.list.contains(old), "the old report remains visible");
    assert.equal(old.disabled, true);
    assert.equal(old.closest(".card")!.querySelector("a[href]"), null);
    old.click(); await settle();
    assert.equal(r.writes().length, 0);
  }
});

test("shared #680 projection round trips exact members as labelled rows in the pass's order", async () => {
  assert.equal(bucketFixture.schema, "agent-board/needs-you/v2");
  const r = setup((method, p) => {
    if (p.endsWith("/check-runs")) return { body: { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] } };
    if (p.endsWith("/status")) return { body: { total_count: 0, statuses: [] } };
    return { body: bootcDraft(Number(p.split("/").at(-1))) };
  });
  const c = bucketCard();
  assert.ok("ask" in c);
  assert.deepEqual(c.ask.reviewBuckets, bucketFixture.review_buckets);
  r.paint(c);
  assert.equal(r.calls.length, 0, "initial load does no discovery");
  const order = () => [...r.list.querySelectorAll<HTMLDetailsElement>(".member")].map((d) => d.dataset.member);
  const published = ["jmarrero-forge/bootc#1", "jmarrero-forge/bootc#2", "jmarrero-forge/bootc#3"];
  // #242 drew nav buttons and bucket headings before any read, and moved rows under them.
  assert.equal(r.list.querySelector(".members nav, .members h4, [data-review-group]"), null);
  for (const [n, bucket] of [[1, "quick"], [2, "deep"], [3, "unknown/deep"]] as const) {
    const d = [...r.list.querySelectorAll<HTMLDetailsElement>(".member")].find((d) => d.dataset.member?.endsWith(`#${n}`))!;
    d.open = true; await settle();
    assert.equal(d.dataset.bucket, bucket);
    assert.match(d.textContent!, new RegExp(`${bucket} · CI success`));
    assert.match(d.textContent!, new RegExp(n === 1 ? "Inspected README diff.*Small mechanical" : n === 2 ? "Pending fresh verified.*src/install.rs" : "No fresh review evidence"));
    assert.equal(d.querySelectorAll(".review-evidence").length, 1);
    assert.doesNotMatch(d.querySelector(".review-evidence")!.textContent!, /[0-9a-f]{40}/, "no full heads in the evidence line");
    d.open = false;
  }
  assert.deepEqual(order(), published, "inspection labels rows; it never reorders them");
  const second = r.list.querySelectorAll<HTMLDetailsElement>(".member")[1]!;
  second.open = true; await settle();
  const changed = structuredClone(bucketFixture.review_buckets);
  changed["jmarrero-forge/bootc#2"]!.bucket = "quick";
  const reads = r.calls.length;
  r.paint(bucketCard({ review_buckets: changed })); await settle();
  assert.equal(r.list.querySelector<HTMLDetailsElement>(".member[open]")!.dataset.member, "jmarrero-forge/bootc#2", "refresh keeps typed identity, not group index");
  assert.equal(r.calls.length, reads, "a changed poll restores selection without reading targets");
  assert.match(r.list.querySelector(".member[open]")!.textContent!, /evidence changed/);
  r.paint(bucketCard({ review_buckets: changed }), true); await settle();
  const refreshed = r.list.querySelector<HTMLDetailsElement>(".member[open]")!;
  assert.equal(refreshed?.dataset.member, "jmarrero-forge/bootc#2", "explicit reload reinspects the selected identity");
  assert.match(refreshed.textContent!, /deep · CI success/);
  assert.ok(r.calls.length > reads, "explicit reload reads the selected target");
  assert.deepEqual(order(), published);
  assert.equal(r.writes().length, 0);
});

for (const source of ["drafts", "decisions"]) test(`changed lazy ${source} group preserves selected member without poll reads`, async () => {
  const r = setup(() => ({ body: bootcDraft(1) }));
  r.paint(bucketCard({}, { source }));
  const first = await openMember(r);
  assert.equal(first.dataset.member, "jmarrero-forge/bootc#1");
  const calls = r.calls.length;
  const changed = bucketCard({}, { source, group: { ...bucketFixture.group, reason: "new grouping" } });
  r.state.published = { asks: "ask" in changed ? [changed.ask] : [], unavailable: false };
  fillInbox(r.list, [changed], inboxHooks(r.state));
  await settle();
  assert.ok(r.list.querySelector<HTMLDetailsElement>(".card-full")!.open);
  const selected = r.list.querySelector<HTMLDetailsElement>(".member[open]")!;
  assert.equal(selected.dataset.member, "jmarrero-forge/bootc#1");
  assert.match(selected.textContent!, /evidence changed/);
  assert.equal(r.calls.length, calls);
  selected.open = false; await settle(); selected.open = true; await settle();
  assert.ok(r.calls.length > calls, "only explicit reinspection reads the target");
});

for (const [name, extension, askOver] of [
  ["legacy", undefined, {}], ["malformed", { "jmarrero-forge/bootc#1": { ...bucketFixture.review_buckets["jmarrero-forge/bootc#1"], assessed_head: "short" } }, {}],
  ["unknown extension version", { schema: "v3", members: bucketFixture.review_buckets }, {}],
  ["unknown record version", { "jmarrero-forge/bootc#1": { ...bucketFixture.review_buckets["jmarrero-forge/bootc#1"], version: 3 } }, {}],
  ["carried", bucketFixture.review_buckets, { carried: true }],
  ["stale", { "jmarrero-forge/bootc#1": { ...bucketFixture.review_buckets["jmarrero-forge/bootc#1"], assessed_head: replacement } }, {}],
] as const) test(`${name} assessment cannot classify a member quick`, async () => {
  const r = setup((_, p) => ({ body: p.endsWith("/check-runs") ? { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] } : p.endsWith("/status") ? { total_count: 0, statuses: [] } : bootcDraft(1) }));
  r.paint(bucketCard({ review_buckets: extension }, askOver));
  const row = await openMember(r);
  assert.equal(row.dataset.bucket, "unknown/deep");
  // Only evidence for this member at this head may show its summary.
  if (name === "stale") assert.match(row.querySelector(".review-evidence")!.textContent!, /assessed at bbbbbbb, not this head/);
  assert.doesNotMatch(row.querySelector(".review-evidence")!.textContent!, /README/);
  assert.equal(r.writes().length, 0);
});

test("extension bounds, unread sources, evicted detail and unknown schema never grant quick or approval", () => {
  const c = bucketCard(); assert.ok("ask" in c);
  for (const over of [
    { sources: { reviews: "unread" } },
    { review_buckets: Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`jmarrero-forge/bootc#${i + 1}`, bucketFixture.review_buckets["jmarrero-forge/bootc#1"]])) },
    { review_buckets: { "jmarrero-forge/bootc#1": { ...bucketFixture.review_buckets["jmarrero-forge/bootc#1"], summary: "x".repeat(501) } } },
  ]) {
    const malformed = bucketCard(over); assert.ok("ask" in malformed);
    assert.equal(malformed.ask.reviewBuckets?.["jmarrero-forge/bootc#1"], undefined);
  }
  const raw = rawNeedsYou([], "2026-11-05T00:00:00Z", { review_buckets: bucketFixture.review_buckets, identities: [{ key: c.ask.key, detail_key: c.ask.key, item: c.ask.item, source: "reviews", kind: "review-promote", priority: null, waiting_since: c.ask.waitingSince, carried: false }], count: 1 });
  const list = parseNeedsYou(raw); assert.ok(typeof list === "object");
  const evicted = inboxCards({ published: { asks: [], list, unavailable: false } })[0]!;
  assert.ok("ask" in evicted);
  assert.equal(evicted.ask.reviewBuckets, undefined);
  assert.ok(refusal(evicted.ask, "promote"));
  assert.equal(typeof parseNeedsYou({ ...raw, schema: "agent-board/needs-you/v3" }), "string");
});

for (const race of [false, true]) test(`CI ${race ? "write-boundary race" : "truncated read"} uses the real member hooks without new authority`, async () => {
  let green = true;
  const r = setup((method, p) => {
    if (p.endsWith("/check-runs")) return { body: { total_count: race ? 1 : 101, check_runs: [{ name: "test", status: "completed", conclusion: green ? "success" : "failure" }] } };
    if (p.endsWith("/status")) return { body: { total_count: 0, statuses: [] } };
    if (p.endsWith("/reviews")) { green = false; return { body: [] }; }
    return { body: bootcDraft(1) };
  });
  r.paint(bucketCard()); const row = await openMember(r);
  assert.equal(row.dataset.bucket, race ? "quick" : "unknown/deep");
  if (race) {
    row.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    assert.match(row.textContent!, /CI moved/);
  }
  assert.equal(r.writes().length, 0);
});

test("mixed evidence retains per-member sent and uncertain receipts across bucket and representative moves", async () => {
  const r = setup((method, p) => {
    if (p.endsWith("/check-runs")) return { body: { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] } };
    if (p.endsWith("/status")) return { body: { total_count: 0, statuses: [] } };
    if (p.endsWith("/reviews")) return method === "GET" ? { body: [] } : { status: p.includes("/2/") ? 502 : 200, body: { html_url: "https://github.com/jmarrero-forge/bootc/pull/1#pullrequestreview-1" } };
    return { body: bootcDraft(Number(p.split("/").at(-1))) };
  });
  r.paint(bucketCard());
  for (const number of [1, 2]) {
    const row = [...r.list.querySelectorAll<HTMLDetailsElement>(".member")].find((d) => d.dataset.member?.endsWith(`#${number}`))!;
    row.open = true; await settle(); row.querySelector<HTMLButtonElement>("button")!.click(); await settle();
  }
  const moved = bucketCard({ review_buckets: {} }, { key: "jmarrero-forge/bootc#2", action: { type: "pull_request", repository: "jmarrero-forge/bootc", number: 2 }, group: { reason: "regrouped", numbers: [2, 3, 1] } });
  r.paint(moved); await settle();
  assert.match(r.list.querySelector(".member[open]")!.textContent!, /uncertain/);
  for (const row of r.list.querySelectorAll<HTMLDetailsElement>(".card:not(.card-stale) .member")) {
    row.open = false; await settle(); row.open = true; await settle();
    if (row.dataset.member?.endsWith("#1")) assert.match(row.textContent!, /Approval sent/);
    if (row.dataset.member?.endsWith("#2")) assert.match(row.textContent!, /uncertain/);
  }
  assert.equal(r.writes().length, 2);
  assert.equal(r.list.querySelector(".card-done"), null);
});

test("CI change without push refuses the displayed member; refresh requires another confirmation", async () => {
  let green = true;
  let confirms = 0;
  const confirm = dom.window.confirm;
  dom.window.confirm = () => { confirms++; return true; };
  const r = setup((method, p) => {
    if (p.endsWith("/check-runs")) return { body: { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: green ? "success" : "failure" }] } };
    if (p.endsWith("/status")) return { body: { total_count: 0, statuses: [] } };
    if (p.endsWith("/reviews")) return { body: method === "GET" ? [] : { html_url: "https://github.com/jmarrero-forge/bootc/pull/1#pullrequestreview-1" } };
    return { body: bootcDraft(1) };
  });
  try {
    const c = bucketCard(); r.paint(c);
    const old = await openMember(r);
    green = false;
    old.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    assert.match(old.textContent!, /CI moved.*reread/);
    assert.equal(r.writes().length, 0);
    r.paint(c, true); const fresh = await openMember(r);
    assert.match(fresh.textContent!, /unknown\/deep · CI failure/);
    assert.equal(confirms, 1);
    fresh.querySelector<HTMLButtonElement>("button")!.click(); await settle();
    assert.equal(confirms, 2);
    assert.deepEqual(r.writes().map((c) => c.body), [{ event: "APPROVE", commit_id: head }]);
  } finally { dom.window.confirm = confirm; }
});
