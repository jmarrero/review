// The pass's needs-you list through the real entry point: sign-in, the
// poll, the holds comment read with the viewer's token (200 and 304), and
// the inbox it draws, on a fake clock. Nothing reaches the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { usagePath } from "../src/github/usage.ts";
import { DECISIONS_CONFIG } from "../src/github/decisiondocument.ts";
import { fields, fixture, holdsComment, rawActNow, rawAsk, rawNeedsYou, realNeedsYouSnapshot } from "./helpers.ts";
import { needsYou174 } from "./fixtures/needs-you-174.ts";

const T0 = Date.parse("2026-10-30T12:00:00Z");
const MINUTE = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const HOLDS = new URL(`https://api.github.com${usagePath}`).pathname;
const FOCUS = "jmarrero-forge/tracker#976";
/** Act now's direct needs-human read, made only while the pass's list cannot vouch for it. */
const SEARCH = "/search/issues";
const epics = { [FOCUS]: { active: true, activeWhy: ["focus"], complete: true } };
const proposal = (comment: number) => rawAsk(1013, { key: `jmarrero-forge/tracker#1013/comment-${comment}`, source: "proposals", kind: "operator-action", ask: `Decision ${comment}`, action: { type: "operator_action", repository: "jmarrero-forge/tracker", number: 1013, comment } });
const proposalComment = (n: number) => ({ id: `IC_${n}`, databaseId: n, updatedAt: "2026-10-29T12:00:00Z", author: { login: "jmarrero-bot" }, editor: null, lastEditedAt: null,
  body: `\`\`\`agent-board-action\n${JSON.stringify({ schema: "agent-board/operator-action/v1", title: `Decision ${n}`, why: `Reason ${n}`, actions: [{ type: "add_label", repo: "jmarrero-forge/tracker", number: 1013, label: `choice-${n}` }] })}\n\`\`\`` });

/** What the holds comment read answers next: a status, the comments, and whether an unchanged one is a 304. */
interface Holds { status: number; comments: unknown[]; etag: string; gate?: Promise<void>; approvals?: Record<number, string[]>; fail?: number; labels?: string[]; reviewError?: number; writeGate?: Promise<void>; document?: string; merge?: "merged" | "enqueued" | "moved" | "denied";
  /** GitHub answers comment writes 401, as for a token that expired mid-session. */
  expired?: boolean }

let runs = 0;

it("Focus shares the holds poll, ages on 304, and labels failed, malformed and absent publications", async (t) => {
  const data = { ...fixture<Record<string, unknown>>("epic-focus.json"), observed_at: iso(T0) };
  const raw: Record<string, unknown> = { schema: "agent-board/holds/v1", at: iso(T0), holds: [], epic_focus: data };
  const comment = () => ({ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` });
  const holds: Holds = { status: 200, etag: '"focus-1"', comments: [comment()] };
  const app = await boot(t, holds);
  try {
    const panel = () => app.doc.querySelector("[aria-label='Focus']")!;
    assert.equal(panel().querySelectorAll(".focus-card").length, 2);
    assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS, SEARCH], "Focus adds no discovery reads");
    await app.wake(61 * MINUTE);
    assert.match(panel().textContent!, /stale \(over an hour\)/);
    assert.deepEqual(app.reads.holds, [null, '"focus-1"']);
    holds.status = 503;
    await app.reload();
    assert.match(panel().textContent!, /Focus unavailable: .*work and blockers are unknown/);
    assert.equal(panel().querySelectorAll(".focus-card").length, 0);
    holds.status = 200;
    holds.etag = '"focus-2"';
    raw.epic_focus = { invalid: true };
    holds.comments = [comment()];
    await app.reload();
    assert.match(panel().textContent!, /Focus unavailable: unsupported schema/);
    assert.equal(panel().querySelectorAll(".focus-card").length, 0);
    holds.etag = '"focus-3"';
    delete raw.epic_focus;
    holds.comments = [comment()];
    await app.reload();
    assert.match(panel().textContent!, /not published.*unknown/);
    holds.etag = '"focus-4"';
    raw.epic_focus = { ...data, observed_at: iso(T0 + 61 * MINUTE) };
    holds.comments = [comment()];
    await app.reload();
    assert.equal(panel().querySelectorAll(".focus-card").length, 2);
    assert.doesNotMatch(panel().textContent!, /stale|unavailable|not published/);
    assert.equal(app.reads.writes.length, 0);
  } finally { await app.close(); }
});

it("Today shares the inbox read, ages on 304, labels failures and recovers without cost", async (t) => {
  const today = { ...fixture<Record<string, unknown>>("today.json"), day: "2026-10-30", observed_at: iso(T0), cost: undefined,
    changes: { landed: 3, closed: 1, opened: 2, extra: { toString: null }, ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`extra-${i}`, "not a metric"])) } };
  const raw = { schema: "agent-board/holds/v1", at: iso(T0), holds: [], today: today as unknown };
  const comment = () => ({ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` });
  const holds: Holds = { status: 200, etag: '"today-1"', comments: [comment()] };
  const app = await boot(t, holds);
  try {
    const panel = () => app.doc.querySelector("[aria-label='Today']")!;
    assert.equal(panel().querySelectorAll("dd").length, 3);
    assert.equal(panel().querySelector(".today-cost"), null);
    assert.equal(app.reads.holds.length, 1);
    assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS, SEARCH], "only viewer, publication and, with no needs-you list, the direct needs-human read on cold load");
    await app.wake(1441 * MINUTE);
    assert.match(panel().textContent!, /observed 2026-10-30T12:00:00.000Z · stale \(over a day old\)/);
    assert.equal(app.reads.all.filter((r) => r.path !== SEARCH).length, 3, "one conditional publication read on poll");
    const live = app.reads.live.length;
    assert.ok(live >= 12 && live % 6 === 0, `Live agents read each source's in_progress, queued and pending runs (${live})`);
    assert.ok(app.reads.live.slice(6).every((r) => r.etag === '"live"'), "and reread them conditionally");
    holds.status = 503;
    await app.reload();
    assert.match(panel().textContent!, /publication unavailable/);
    holds.status = 200;
    holds.etag = '"today-2"';
    raw.today = { invalid: true };
    holds.comments = [comment()];
    await app.reload();
    assert.match(panel().textContent!, /Today unavailable: malformed/);
    raw.today = undefined;
    holds.etag = '"today-3"';
    holds.comments = [comment()];
    await app.reload();
    assert.match(panel().textContent!, /Today not published/);
    raw.today = { ...today, day: "2026-10-31", observed_at: "2026-10-31T12:00:00Z" };
    holds.etag = '"today-4"';
    holds.comments = [comment()];
    await app.reload();
    assert.equal(panel().querySelectorAll("dd").length, 3);
    assert.doesNotMatch(panel().textContent!, /stale|unavailable|not published/);
    assert.equal(app.reads.writes.length, 0);
  } finally { await app.close(); }
});

it("repository work shares the inbox poll, preserves source clocks on 304 and labels retained data on failure", async (t) => {
  const raw = fixture<Record<string, unknown>>("pass-view.json");
  raw.at = iso(T0);
  raw.dispatchable_work = fixture("dispatchable-work.json");
  const comment = () => ({ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` });
  const holds: Holds = { status: 200, etag: '"work-1"', comments: [comment()] };
  const app = await boot(t, holds);
  try {
    const panel = () => app.doc.querySelector("[aria-label='Repositories']")!;
    assert.equal(panel().querySelectorAll("table").length, 2);
    assert.match(panel().textContent!, /5 decisions · 1 items omitted/);
    assert.equal(app.reads.holds.length, 1);
    await app.wake(61 * MINUTE);
    assert.match(panel().textContent!, /Work observed 2026-10-30T12:00:00.000Z · stale/);
    holds.status = 503;
    await app.reload();
    assert.match(panel().textContent!, /last read, not current/);
    assert.equal(panel().querySelectorAll("table").length, 2);
    holds.status = 200;
    holds.etag = '"work-2"';
    raw.dispatchable_work = { invalid: true };
    holds.comments = [comment()];
    await app.reload();
    assert.match(panel().textContent!, /Dispatchable work unavailable/);
    assert.equal(panel().querySelectorAll("table").length, 1, "run-only repository survives invalid work");
    assert.equal(app.reads.writes.length, 0);
    assert.ok(!app.reads.all.some((r) => r.path.includes("/actions/")), "no additional run or workflow discovery");
  } finally { await app.close(); }
});

it("Repositories shares the pass read, retains unavailable facts, and replaces invalid reports visibly", async (t) => {
  const raw = fixture<Record<string, unknown>>("maintainer-report.json");
  raw.generated_at = iso(T0);
  const report = { id: 42, user: { login: "jmarrero-bot" }, body: `<!-- agent-board-maintainer-report -->\n\`\`\`agent-board/maintainer-report/v1\n${JSON.stringify(raw)}\n\`\`\`` };
  const holds: Holds = { status: 200, comments: [report], etag: '"report-1"' };
  const app = await boot(t, holds);
  try {
    const panel = () => app.doc.querySelector("[aria-label='Repositories']")!;
    await app.until(() => !!panel()?.textContent?.includes("example/project"), "repository panel");
    assert.equal(app.reads.holds.length, 1);
    assert.equal(app.reads.writes.length, 0);
    await app.wake(121 * MINUTE);
    assert.match(panel().textContent!, /stale/); // 304 does not change the run clock.
    holds.status = 503;
    await app.reload();
    assert.match(panel().textContent!, /Publication unavailable/);
    assert.match(panel().textContent!, /example\/project/);
    holds.status = 200;
    holds.etag = '"report-2"';
    holds.comments = [{ ...report, body: report.body.replace('"preview"', '"invalid"') }];
    await app.reload();
    assert.match(panel().textContent!, /Invalid maintainer report/);
    assert.doesNotMatch(panel().textContent!, /example\/project/);
    holds.comments = [];
    holds.etag = '"report-3"';
    await app.reload();
    assert.match(panel().textContent!, /not published/);
  } finally { await app.close(); }
});

/** The app signed in at #inbox, its clock at T0, the holds comment answering as `holds` says. */
async function boot(t: TestContext, holds: Holds) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // Sign-out reloads the page; jsdom implements only hash navigation.
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), { url: "https://review.example/#inbox", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.scrollTo = () => {};
  window.confirm = () => true;
  // Live agents' run lists (liveruns.ts) are their own source, kept apart from the inbox's reads.
  const reads = { all: [] as { method: string; path: string; at: number }[], holds: [] as (string | null)[], writes: [] as string[], reviews: [] as number[], live: [] as { path: string; etag: string | null }[] };
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
      if (method === "GET" && /\/actions\/workflows\/[^/]+\/runs$/.test(url.pathname)) {
        const sent = new Headers(init?.headers).get("If-None-Match");
        reads.live.push({ path: url.pathname + url.search, etag: sent });
        return sent === '"live"' ? json(null, 304, { ETag: '"live"' }) : json({ total_count: 0, workflow_runs: [] }, 200, { ETag: '"live"' });
      }
      reads.all.push({ method, path: url.pathname, at: performance.now() });
      if (method !== "GET" && url.pathname !== "/graphql") reads.writes.push(`${method} ${url.pathname}`);
      if (url.pathname === HOLDS) {
        const sent = new Headers(init?.headers).get("If-None-Match");
        reads.holds.push(sent);
        await holds.gate;
        if (holds.status !== 200) return json({ message: "Server Error" }, holds.status);
        return sent === holds.etag ? json(null, 304, { ETag: holds.etag }) : json(holds.comments, 200, { ETag: holds.etag });
      }
      if (url.pathname === "/user") return json({ login: "jmarrero" });
      if (holds.expired && method === "POST" && /\/issues\/\d+\/comments$/.test(url.pathname)) return json({ message: "Bad credentials" }, 401);
      if (url.pathname.endsWith("/merge") && method === "PUT") {
        assert.equal(JSON.parse(String(init?.body)).sha, "a".repeat(40));
        return holds.merge === "denied" ? json({ message: "Policy refused" }, 403) : json({ merged: true });
      }
      const pull = url.pathname.match(/\/pulls\/(\d+)(\/reviews)?$/);
      if (pull) {
        const n = Number(pull[1]);
        if (method === "POST") {
          await holds.writeGate;
          return json({ html_url: `https://github.com/up/proj/pull/${n}#pullrequestreview-1` }, holds.fail === n ? 502 : 200);
        }
        if (pull[2]) {
          reads.reviews.push(n);
          if (holds.reviewError) return json({ message: "reviews unavailable" }, holds.reviewError);
          return json((holds.approvals?.[n] ?? []).map((commit_id) => ({ user: { login: "jmarrero" }, state: "APPROVED", commit_id, submitted_at: "2026-11-03T00:00:00Z" })));
        }
        return json({ state: "open", head: { sha: "a".repeat(40) } });
      }
      if (url.pathname.endsWith("/fields")) return json(fields());
      if (url.pathname === "/search/issues") return json({ items: [], total_count: 0 });
      if (url.pathname === "/repos/jmarrero-forge/operator/issues/1") {
        if (method === "PATCH") holds.document = (JSON.parse(String(init?.body)) as { body: string }).body;
        return json({ body: holds.document ?? "" });
      }
      if (url.pathname.startsWith("/repos/jmarrero-forge/tracker/issues/") && /\/issues\/\d+$/.test(url.pathname)) {
        const n = url.pathname.split("/").at(-1);
        return json({ title: `Issue ${n}`, body: `Q: Ask ${n}?`, state: "open", html_url: `https://github.com/jmarrero-forge/tracker/issues/${n}`, labels: (holds.labels ?? ["needs-human"]).map((name) => ({ name })) });
      }
      if (url.pathname === "/graphql") {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("enqueuePullRequest")) {
          assert.equal(JSON.parse(String(init?.body)).variables.head, "a".repeat(40));
          reads.writes.push("POST enqueuePullRequest");
          return json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQ_1" } } } });
        }
        if (query.includes("mergeStateStatus")) return json({ data: { repository: {
          squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false,
          pullRequest: { id: "PR_1", url: "https://github.com/jmarrero-forge/tracker/pull/1", state: "OPEN", isDraft: false,
            headRefOid: (holds.merge === "moved" ? "b" : "a").repeat(40), mergeStateStatus: "CLEAN", viewerCanUpdate: true,
            isMergeQueueEnabled: holds.merge === "enqueued", mergeQueueEntry: null },
        } } });
        if (query.includes("issue(number:$number)")) return json({ data: { repository: { issue: { __typename: "Issue", id: "I_5", title: "Issue 5", body: "", url: "https://github.com/jmarrero-forge/tracker/issues/5", state: "OPEN", projectItems: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
        if (query.includes("issueOrPullRequest")) return json({ data: { repository: { issueOrPullRequest: { comments: { nodes: [] } } } } });
        if (query.includes("comments(first")) return json({ data: { repository: { issue: { state: "OPEN", comments: { nodes: [1, 2].map(proposalComment), pageInfo: { hasNextPage: false } } } } } });
        return json({ data: {} });
      }
      return json([]);
    },
  });
  await import(`${process.env.REPLAY_ENTRY ? pathToFileURL(process.env.REPLAY_ENTRY).href : "../src/github/main.ts"}?needsyou=${runs++}`);
  const doc = window.document;
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${what}: ${doc.querySelector("#view")?.textContent}`);
  };
  await until(() => !!doc.querySelector(".signin"), "sign-in");
  doc.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
  doc.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const app = {
    window, doc, reads, until,
    inspect: () => { for (const d of doc.querySelectorAll<HTMLDetailsElement>(".card-full")) { d.open = true; d.dispatchEvent(new window.Event("toggle")); } },
    note: () => doc.querySelector(".published")?.textContent ?? "",
    keys: () => [...doc.querySelectorAll(".inbox-cards > .card")].map((c) => c.getAttribute("data-key")),
    count: () => doc.querySelector("#sec-needs summary .count, #sec-needs summary [class*=count]")?.textContent ?? "",
    empty: () => doc.querySelector<HTMLElement>("#sec-needs .empty")!.hidden === false,
    /** Let the clock run `ms` and bring the page back to the front, as a phone does. */
    wake: async (ms: number) => {
      t.mock.timers.setTime(Date.now() + ms);
      const before = reads.holds.length;
      window.dispatchEvent(new window.Event("focus"));
      await until(() => reads.holds.length > before, "the holds read after waking");
      await settle();
    },
    reload: async () => {
      const before = reads.holds.length;
      doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "r", bubbles: true }));
      await until(() => reads.holds.length > before, "the holds read after r");
      await settle();
    },
    close: async () => {
      doc.querySelector<HTMLButtonElement>("#signout")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      dom.window.close();
    },
  };
  await until(() => !!doc.querySelector(".published") && !app.note().startsWith("Reading"), "the published list");
  // These action/receipt replays deliberately opt in; browser policy tests
  // separately cover the read-only default and confirmation cancellation.
  doc.querySelector<HTMLButtonElement>("#writes")!.click();
  await settle();
  return app;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const listed = (at: number, items: unknown[], over: Record<string, unknown> = {}) => [holdsComment(iso(at), rawNeedsYou(items, iso(at), over))];

describe("Needs you from the pass's published list", () => {
  it("#259 excludes superseded #727/#728 holds and counts only rendered operator rows", async (t) => {
    const raw = fixture<Record<string, unknown>>("needs-you-259.json");
    const comment = () => ({ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` });
    const holds = { status: 200, etag: '"259"', comments: [comment()] };
    const app = await boot(t, holds);
    try {
      assert.deepEqual(app.keys(), []);
      assert.equal(app.count(), "0");
      assert.equal(app.empty(), true);
      assert.match(app.doc.querySelector("#sec-needs .empty")!.textContent!, /nothing needs you/);
      assert.match(app.note(), /2 superseded hold decisions excluded/);
      // An actual published operator hold stays, independent of label/assignment
      // prose; a review wait also stays without an issue hold.
      raw.needs_you = rawNeedsYou([rawAsk(50), rawAsk(51, { source: "reviews", kind: "review-approve", action: { type: "approve_pull_request", repository: "jmarrero-forge/tracker", number: 51, head: "a".repeat(40) } })], iso(T0));
      raw.holds = [{ item: "jmarrero-forge/tracker#50", url: "https://github.com/jmarrero-forge/tracker/issues/50", epic: false, kind: "needs-human", reason: "Operator assigned", operator: true, priority: null, question: null }];
      holds.etag = '"259-current"'; holds.comments = [comment()];
      await app.reload();
      assert.equal(app.keys().length, 2);
      assert.equal(app.count(), "2");
      assert.equal(app.empty(), false);
      assert.equal(app.reads.writes.length, 0);
      assert.ok(app.reads.all.every((r) => r.path === "/user" || r.path === HOLDS), "no per-target ownership discovery");
    } finally { await app.close(); }
  });

  it("actual main retains a typed answer through filtering, eviction and Show everything", async (t) => {
    const holds = { status: 200, etag: '"draft"', comments: listed(T0, [rawAsk(50, { epic: FOCUS, topEpic: FOCUS })], { epics }) };
    const app = await boot(t, holds);
    try {
      const chip = (choice: string) => app.doc.querySelector<HTMLButtonElement>(`[data-epic-choice="${choice}"]`)!;
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".card textarea"), "answer form");
      const text = app.doc.querySelector<HTMLTextAreaElement>(".card textarea")!;
      text.value = "Keep my unsent answer";
      const card = text.closest<HTMLElement>(".card")!;
      chip("none").focus(); chip("none").click();
      assert.equal(app.doc.activeElement, chip("none"));
      assert.equal(card.hidden, true);
      holds.etag = '"gone"';
      holds.comments = listed(T0, [], { epics });
      await app.wake(2 * MINUTE);
      assert.equal(card.hidden, true, "empty selection must not implicitly clear the filter");
      const before = app.reads.all.length;
      chip("all").click();
      assert.equal(card.hidden, false);
      assert.equal(text.value, "Keep my unsent answer");
      assert.match(card.textContent!, /This has left the inbox/);
      assert.equal(card.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled, true);
      text.form!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await settle();
      assert.equal(app.reads.all.length, before, "filter recovery never rereads or writes a target");
      assert.deepEqual(app.reads.writes, []);
    } finally { await app.close(); }
  });

  const decision = () => rawAsk(1, { key: "jmarrero-forge/operator#1/decision-12", item: "jmarrero-forge/operator#1", source: "decisions", kind: "document-decision", action: { type: "issue", repository: "jmarrero-forge/operator", number: 1 } });

  it("excludes a successfully answered document decision immediately, before the publication changes", { skip: !DECISIONS_CONFIG.document && "no decisions document in this deployment" }, async (t) => {
    const app = await boot(t, { status: 200, etag: '"decision"', comments: listed(T0, [decision()]), document: "### D12 Pick one\n- [ ] A) Yes\nReply:\n" });
    try {
      assert.equal(app.count(), "1");
      assert.equal(app.reads.all.filter((r) => r.path.includes("/operator/issues/")).length, 0);
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".entry-answer"), "inspected decision");
      app.doc.querySelector<HTMLInputElement>('.entry-answer input[type=radio]')!.checked = true;
      app.doc.querySelector(".entry-answer")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await app.until(() => app.count() === "0", "immediate completed count");
      assert.match(app.doc.querySelector("#menu-meta")!.textContent!, /0/);
      assert.match(app.doc.querySelector(".inbox-pass")?.textContent ?? app.doc.querySelector("#sec-needs")!.textContent!, /1 rows \(1 with detail\): 0 waiting, 1 done here/);
      assert.deepEqual(app.reads.writes, ["PATCH /repos/jmarrero-forge/operator/issues/1"]);
      await app.reload();
      assert.equal(app.count(), "0", "the unchanged publication must not resurrect a local receipt");
    } finally { await app.close(); }
  });

  it("explicit refresh rereads a changed decision only when inspected again", { skip: !DECISIONS_CONFIG.document && "no decisions document in this deployment" }, async (t) => {
    const holds = { status: 200, etag: '"decision"', comments: listed(T0, [decision()]), document: "### D12 Pick one\n- [ ] A) Old option\nReply:\n" };
    const app = await boot(t, holds);
    try {
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".entry-answer"), "old decision");
      holds.document = holds.document.replace("Old option", "New option");
      const before = app.reads.all.filter((r) => r.path.includes("/operator/issues/")).length;
      await app.reload();
      assert.equal(app.reads.all.filter((r) => r.path.includes("/operator/issues/")).length, before, "r does not fan out target reads");
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".entry-answer")?.textContent?.includes("New option"), "fresh decision");
      assert.equal(app.reads.all.filter((r) => r.path.includes("/operator/issues/")).length, before + 1);
      assert.deepEqual(app.reads.writes, []);
    } finally { await app.close(); }
  });

  it("renders compact identities without discovering missing details, with explicit group totals and context", async (t) => {
    const identities = [1, 2, 3].map((n) => ({ item: `jmarrero-forge/tracker#${n}`, source: "reviews", kind: "review-promote", waiting_since: iso(T0), epic: "unknown", ...(n === 2 ? { detail_key: "jmarrero-forge/tracker#1" } : {}) }));
    const context = { observed_at: iso(T0), wip: { in_flight: 2, limit: 3 }, sources: { step: "complete", run: "unread", usage: "partial" }, omitted: 2,
      items: [{ source: "step", item: "o/r#1", kind: "waiting", reason: "Checks pending", observed_at: iso(T0), since: null, url: "https://untrusted.invalid/" }], limits: { pool: { reason: "pace", used_percent: 80, limit_percent: 40 } } };
    const app = await boot(t, { status: 200, etag: '"inventory"', comments: listed(T0, [], { identities, count: 3, counts: { decisions: 3, groups: 1, members: 3 }, details_omitted: 3, context }) });
    try {
      assert.equal(app.count(), "2", "the heading and chips count rows, not grouped decisions");
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1", "jmarrero-forge/tracker#3"]);
      assert.match(app.doc.querySelector("#sec-needs")!.textContent!, /3 decisions reported: 3 listed, 0 not listed\. 2 rows \(0 with detail\): 2 waiting, 0 done here, 0 hidden by the epic filter\. Groups: 1, members: 3\./);
      const fold = app.doc.querySelector<HTMLDetailsElement>(".published-context")!;
      assert.equal(fold.open, false);
      assert.match(fold.textContent!, /WIP 2\/3.*run unread.*Checks pending/s);
      assert.equal(fold.querySelector("a,button"), null);
      assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS]);
      await app.wake(2 * MINUTE);
      assert.equal(app.reads.all.length, 3);
      assert.equal(app.reads.holds.at(-1), '"inventory"');
    } finally { await app.close(); }
  });

  const approval = (n: number, digest = false) => rawAsk(n, { key: `up/proj#${n}${digest ? "/digest" : ""}`, item: `up/proj#${n}`, kind: digest ? "digest-approve" : "review-approve", source: digest ? "digest" : "reviews", action: { type: "approve_pull_request", repository: "up/proj", number: n, head: "a".repeat(40) } });

  const mergeAsk = () => rawAsk(1, { action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 1, head: "a".repeat(40) } });
  const mergeRequest = () => ({ key: mergeAsk().key, forge: "github.com", quality: "decision", actions: [{ kind: "merge-or-enqueue", supported: true, reason: "checked" }] });

  it("never offers a new merge operation through the legacy missing-descriptor fallback", async (t) => {
    const a = mergeAsk();
    const app = await boot(t, { status: 200, etag: '"no-merge-policy"', comments: listed(T0, [a], { act_now: [rawActNow(a)] }) });
    try {
      assert.equal(app.doc.querySelector(".act-now button"), null);
      assert.match(app.doc.querySelector(".act-now")!.textContent!, /No supported merge-or-enqueue descriptor/);
      assert.deepEqual(app.reads.writes, []);
      assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS]);
    } finally { await app.close(); }
  });

  for (const merge of ["merged", "enqueued", "moved", "denied"] as const) it(`keeps the ${merge} outcome visible through completion redraw and poll`, async (t) => {
    const a = mergeAsk();
    const holds: Holds = { status: 200, etag: '"merge"', merge, comments: listed(T0, [a], { act_now: [rawActNow(a)], requests: [mergeRequest()] }) };
    const app = await boot(t, holds);
    try {
      app.doc.querySelector<HTMLButtonElement>(".act-now button")!.click();
      const expected = merge === "merged" ? /Merged:/ : merge === "enqueued" ? /Enqueued, not merged/ : merge === "moved" ? /PR head moved/ : /Policy refused/;
      const receipt = () => app.doc.querySelector(".merge-receipts")?.textContent ?? "";
      await app.until(() => expected.test(receipt()), "merge outcome after redraw");
      await app.wake(2 * MINUTE);
      assert.match(receipt(), expected);
      const button = app.doc.querySelector<HTMLButtonElement>(".act-now li button");
      if (merge === "moved" || merge === "denied") assert.equal(button?.disabled, true, "no automatic fresh handler after refusal");
      else assert.equal(button, null, "completed ask leaves shortlist but keeps its receipt");
      assert.deepEqual(app.reads.writes, merge === "moved" ? [] : merge === "enqueued" ? ["POST enqueuePullRequest"] : ["PUT /repos/jmarrero-forge/tracker/pulls/1/merge"]);
    } finally { await app.close(); }
  });

  it("Act now uses only the pass read, ranks groups and approves through the canonical card", async (t) => {
    const question = rawAsk(1, { ask: "Choose A or B" });
    const group = rawAsk(2, { ask: "Approve the named PRs", action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 2 }, group: { reason: "shared verdict", numbers: [2, 3, 4] } });
    const act_now = [rawActNow(approval(7), 63), rawActNow(group, 3), rawActNow(question)];
    const holds: Holds = { status: 200, etag: '"act-now"', comments: listed(T0, [question, group, approval(7)], { act_now }) };
    const app = await boot(t, holds);
    try {
      const slot = app.doc.querySelector<HTMLElement>(".act-now")!;
      assert.equal(slot.hidden, false);
      assert.equal(slot.parentElement, app.doc.querySelector(".home")!.firstElementChild, "decisions come before Focus and active work");
      assert.equal(slot.querySelector(".act-now-labelled"), null, "a complete, current list needs no direct read");
      assert.deepEqual([...slot.querySelectorAll("li > a:first-child")].map((a) => a.textContent), ["jmarrero-forge/tracker#2", "jmarrero-forge/tracker#1", "up/proj#7"], "needs-human decisions first, then by count");
      assert.match(slot.textContent!, /3 PRs: shared verdict/);
      assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS], "no target reads to assemble Act now");
      slot.querySelector<HTMLButtonElement>("button")!.click();
      await app.until(() => app.count() === "2", "completed approval excluded");
      assert.equal(slot.querySelectorAll("li").length, 2);
      assert.deepEqual(app.reads.writes, ["POST /repos/up/proj/pulls/7/reviews"]);
      assert.match(app.doc.querySelector('.card[data-key="up/proj#7"]')!.textContent!, /Approved:/);
      holds.status = 503;
      await app.reload();
      assert.equal(slot.querySelectorAll("ol > li").length, 0, "an unavailable publication cannot retain an Act now list");
      assert.equal(slot.hidden, false, "it says so instead of hiding");
      assert.match(slot.querySelector(".act-now-gap")!.textContent!, /Act now may be missing decisions/);
      await app.until(() => !!slot.querySelector(".act-now-labelled")?.textContent?.includes("No open needs-human issue found"), "direct read drawn");
      assert.equal(slot.querySelector(".act-now-labelled button"), null);
    } finally { await app.close(); }
  });

  it("Act now refreshes an idle paginated approval when its ask key changes at the same head", async (t) => {
    const first = [1, 2, 3, 4, 5].map((n) => ({ ...approval(n), priority: "P0" }));
    const old = approval(7);
    old.priority = "P2";
    const replacement = { ...old, key: `${old.key}/comment-123` };
    const holds: Holds = { status: 200, etag: '"idle-old"', comments: listed(T0, [...first, old], { act_now: [rawActNow(old, 63)] }) };
    const app = await boot(t, holds);
    try {
      assert.equal(app.doc.querySelector('.card[data-key="up/proj#7"]'), null, "approval is past the first page");
      assert.ok(app.doc.querySelector(".act-now button"));
      holds.etag = '"idle-new"';
      holds.comments = listed(T0, [...first, replacement], { act_now: [rawActNow(replacement, 63)] });
      await app.reload();
      assert.equal(app.doc.querySelector(`.card[data-key="${replacement.key}"]`), null);
      app.doc.querySelector<HTMLButtonElement>(".act-now button")!.click();
      await app.until(() => app.count() === "5", "replacement approval completed");
      assert.deepEqual(app.reads.writes, ["POST /repos/up/proj/pulls/7/reviews"]);
    } finally { await app.close(); }
  });

  it("hourly renewal advances validation without changing the change clock", async (t) => {
    const changedAt = iso(T0 - 2 * 60 * MINUTE);
    const holds: Holds = { status: 200, etag: '"old"', comments: listed(T0 - 71 * MINUTE, [], { changed_at: changedAt }) };
    const app = await boot(t, holds);
    try {
      assert.equal(app.empty(), false);
      t.mock.timers.setTime(T0 + MINUTE);
      holds.etag = '"renewed"';
      holds.comments = listed(Date.now(), [], { changed_at: changedAt });
      await app.wake(2 * MINUTE);
      assert.equal(app.empty(), true);
      assert.match(app.note(), /confirmed 2m ago, changed 2h ago/);
    } finally { await app.close(); }
  });

  it("real snapshot replay request and timing measurements", async (t) => {
    const raw = realNeedsYouSnapshot();
    const started = performance.now();
    const app = await boot(t, { status: 200, etag: '"real-replay"', comments: [{ user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\`` }] });
    try {
      const cold = { requests: app.reads.all.length, elapsedMs: performance.now() - started, paths: app.reads.all.map((r) => r.path) };
      const before = app.reads.all.length;
      const pollAt = performance.now();
      await app.wake(2 * MINUTE);
      const poll = { requests: app.reads.all.length - before, elapsedMs: performance.now() - pollAt, paths: app.reads.all.slice(before).map((r) => r.path) };
      t.diagnostic(JSON.stringify({ cold, poll }));
      if (!process.env.REPLAY_ENTRY) {
        // The real list is incomplete, so Act now lists needs-human directly too.
        assert.deepEqual(cold.paths, ["/user", HOLDS, SEARCH]);
        assert.deepEqual(poll.paths, [HOLDS, SEARCH]);
        assert.equal(app.reads.writes.length, 0);
      }
    } finally { await app.close(); }
  });

  for (const same of [true, false]) it(`after reload, ${same ? "skips a current" : "writes past an older"} viewer approval`, async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [approval(7)]), approvals: { 7: [(same ? "a" : "b").repeat(40)] } };
    const app = await boot(t, holds);
    try {
      await app.reload();
      assert.deepEqual(app.reads.reviews, [], "no approval reads on poll or reload");
      await app.until(() => !!app.doc.querySelector(".card-body button"), "approval button");
      app.doc.querySelector<HTMLButtonElement>(".card-body button")!.click();
      await app.until(() => !!app.doc.querySelector("[data-sent]"), "approval result");
      assert.deepEqual(app.reads.writes, same ? [] : ["POST /repos/up/proj/pulls/7/reviews"]);
      assert.match(app.doc.querySelector(".card")!.textContent!, same ? /already approved at HEAD/ : /Approved:/);
      assert.ok(app.doc.querySelector(".card-done button:disabled"));
      await app.reload();
      assert.ok(app.doc.querySelector(".card-done button:disabled"), "done receipt survives reload");
    } finally { await app.close(); }
  });

  it("reports skipped, written and failed digest items separately", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [7, 8, 9].map((n) => approval(n, true))), approvals: { 7: ["a".repeat(40)], 8: ["b".repeat(40)] }, fail: 9 });
    try {
      app.doc.querySelector<HTMLButtonElement>(".maintain-sec button")!.click();
      await app.until(() => !!app.doc.querySelector(".maintain-results .uncertain"), "partial batch");
      const results = app.doc.querySelector(".maintain-results")!.textContent!;
      assert.match(results, /Skipped: up\/proj#7 already approved at HEAD/);
      assert.match(results, /Approved up\/proj#8/);
      assert.match(results, /Failed or uncertain: up\/proj#9/);
      assert.equal(app.count(), "1", "only the uncertain member remains outstanding");
      await app.reload();
      assert.equal(app.count(), "1", "unchanged publication does not restore completed decisions");
      assert.deepEqual(app.reads.writes, ["POST /repos/up/proj/pulls/8/reviews", "POST /repos/up/proj/pulls/9/reviews"]);
      assert.deepEqual([...app.doc.querySelectorAll<HTMLInputElement>(".maintain-sec input[type=checkbox]")].map((b) => [b.checked, b.disabled]), [[false, true], [false, true], [false, true]]);
    } finally { await app.close(); }
  });

  it("stops counting a digest once every member is approved here", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [7, 8].map((n) => approval(n, true))) });
    try {
      assert.equal(app.count(), "1");
      app.doc.querySelector<HTMLButtonElement>(".maintain-sec button")!.click();
      await app.until(() => !!app.doc.querySelector(".maintain-results [data-sent]"), "digest result");
      assert.equal(app.count(), "0");
      await app.reload();
      assert.equal(app.count(), "0", "unchanged publication does not restore the completed digest");
    } finally { await app.close(); }
  });

  for (const overlapping of [true, false]) it(`shares ${overlapping ? "an in-flight" : "a completed but still unread"} approval across single and digest cards`, async (t) => {
    let release = () => {};
    const writeGate = new Promise<void>((resolve) => { release = resolve; });
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [approval(7), approval(7, true)]), ...(overlapping ? { writeGate } : {}) });
    try {
      await app.until(() => !!app.doc.querySelector(".c-approve button"), "single approval");
      app.doc.querySelector<HTMLButtonElement>(".c-approve button")!.click();
      await app.until(() => app.reads.writes.length === 1, "first approval write");
      if (!overlapping) await app.until(() => !!app.doc.querySelector(".c-approve [data-sent]"), "completed approval");
      app.doc.querySelector<HTMLButtonElement>(".c-digest button")!.click();
      await settle();
      assert.equal(app.reads.writes.length, 1, "the other card must not post while the first is in flight or lagging");
      release();
      await app.until(() => !!app.doc.querySelector(".maintain-results [data-sent]"), "deduplicated digest result");
      assert.match(app.doc.querySelector(".maintain-results")!.textContent!, overlapping ? /already approved at HEAD/ : /Approved:/);
      assert.deepEqual(app.reads.reviews, [7], "the shared receipt bridges the unread write");
    } finally { release(); await app.close(); }
  });

  for (const capped of [true, false]) it(`refuses approval when reviews are ${capped ? "capped" : "unreadable"}`, async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [approval(7)]), ...(capped ? { approvals: { 7: Array(100).fill("b".repeat(40)) } } : { reviewError: 502 }) });
    try {
      await app.until(() => !!app.doc.querySelector(".card-body button"), "approval button");
      app.doc.querySelector<HTMLButtonElement>(".card-body button")!.click();
      await app.until(() => /Not sent/.test(app.doc.querySelector(".card [role=status]")?.textContent ?? ""), "read refusal");
      assert.deepEqual(app.reads.writes, []);
      assert.match(app.doc.querySelector(".card [role=status]")!.textContent!, capped ? /Reviews exceed one page/ : /reviews unavailable/);
    } finally { await app.close(); }
  });

  for (const removed of [false, true]) it(`refuses review-needs-human release with ${removed ? "a removed" : "no"} label before commenting`, async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(7, { kind: "review-needs-human", action: { type: "pull_request", repository: "jmarrero-forge/tracker", number: 7 } })]), labels: removed ? ["needs-human"] : [] };
    const app = await boot(t, holds);
    try {
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".card textarea"), "answer form");
      holds.labels = [];
      app.doc.querySelector<HTMLTextAreaElement>(".card textarea")!.value = "Proceed";
      app.doc.querySelector(".card form")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }));
      await app.until(() => /not answering|hold is no longer present/.test(app.doc.querySelector(".card [role=status]")?.textContent ?? ""), "release refusal");
      assert.deepEqual(app.reads.writes, []);
    } finally { await app.close(); }
  });

  it("shows a complete current list in the pass's order and count, and an empty one as caught up", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0 - 5 * MINUTE, [rawAsk(9, { priority: "P2" }), rawAsk(3, { priority: "P0" })]) };
    const app = await boot(t, holds);
    try {
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#9", "jmarrero-forge/tracker#3"], "the pass ranks; the app doesn't");
      assert.equal(app.count(), "2");
      assert.match(app.note(), /^The pass's list: confirmed 5m ago/);
      assert.equal(app.empty(), false);
      holds.comments = listed(T0, []);
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual([app.keys(), app.count(), app.empty()], [[], "0", true]);
    } finally { await app.close(); }
  });

  it("says what an incomplete list lacks, and never that nothing waits", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [], { complete: false, sources: { epics: "complete", items: "partial", reviews: "unread", proposals: "complete", digest: "off" } }) });
    try {
      assert.match(app.note(), /Incomplete \(items partial, reviews unread\): more may wait on you\./);
      assert.deepEqual([app.count(), app.empty()], ["0", false]);
    } finally { await app.close(); }
  });

  it("does not call unknown source values complete", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [], { sources: { items: "complete", reviews: "new-value" } }) });
    try {
      assert.match(app.note(), /Incomplete/);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("dates the list by the pass, not by GitHub's 304: an old list stays old however often it is confirmed", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0 - 3 * 60 * MINUTE, []) };
    const app = await boot(t, holds);
    try {
      assert.match(app.note(), /confirmed 3h ago.*checked on GitHub just now\. The pass has not confirmed it for over an hour/);
      assert.equal(app.empty(), false, "an empty list the pass stopped confirming is not caught up");
      await app.wake(2 * MINUTE);
      assert.equal(app.reads.holds.at(-1), '"a"', "a conditional read");
      assert.match(app.note(), /confirmed 3h ago.*checked on GitHub just now\. The pass has not confirmed it/);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("keeps the cards of a list it can't read again, marked unavailable, and recovers on the next read", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1), rawAsk(2)]) };
    const app = await boot(t, holds);
    try {
      holds.status = 502;
      await app.wake(2 * MINUTE);
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1", "jmarrero-forge/tracker#2"]);
      assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 2);
      assert.match(app.note(), /^Couldn't read the pass's snapshot: .*marked unavailable until it can be read again\./);
      assert.equal(app.empty(), false);
      holds.status = 200;
      holds.comments = listed(Date.now(), [rawAsk(2)]);
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual([app.keys(), app.doc.querySelectorAll(".card-unavailable").length], [["jmarrero-forge/tracker#2"], 0]);
      assert.match(app.note(), /^The pass's list: confirmed/);
    } finally { await app.close(); }
  });

  it("shows an older pass's operator holds when the snapshot has no list, and says what isn't listed", async (t) => {
    const at = iso(T0);
    const human = { item: "jmarrero-forge/tracker#446", url: "https://github.com/jmarrero-forge/tracker/issues/446", epic: false, kind: "needs-human", reason: "labelled needs-human", operator: true, priority: "P0", question: "Ship it?" };
    const wip = { item: null, url: null, epic: false, kind: "wip", reason: "2 of 2 runs active", operator: false, priority: null, question: null };
    const old = { user: { login: "jmarrero-bot" }, body: `<!-- agent-board-holds v1 -->\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at, holds: [wip, human] })}\n\`\`\`\n` };
    const app = await boot(t, { status: 200, etag: '"a"', comments: [old] });
    try {
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#446"]);
      assert.match(app.note(), /no needs-you list.*Shown: the snapshot's own operator holds; review waits, proposals and digest asks are not listed\./);
      assert.equal(app.empty(), false);
    } finally { await app.close(); }
  });

  it("keeps unavailable old cards alongside new snapshot holds after the list disappears", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1)]) };
    const app = await boot(t, holds);
    try {
      holds.comments = [holdsComment(iso(T0), undefined, [{ item: "jmarrero-forge/tracker#9", url: "https://github.com/jmarrero-forge/tracker/issues/9", epic: false, kind: "needs-human", reason: "new hold", operator: true, priority: "P0", question: "New ask" }])];
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1", "jmarrero-forge/tracker#9"]);
      assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 1);
      assert.match(app.doc.querySelector('[data-key="jmarrero-forge/tracker#9"]')!.textContent!, /New ask/);
      holds.status = 502;
      for (let poll = 0; poll < 2; poll++) {
        await app.wake(2 * MINUTE);
        assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1", "jmarrero-forge/tracker#9"]);
        assert.equal(app.doc.querySelectorAll(".card-unavailable").length, 2);
      }
    } finally { await app.close(); }
  });

  it("gives each proposal its own card, each read again from its comment", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [proposal(1), proposal(2)]) });
    try {
      app.inspect();
      await app.until(() => [1, 2].every((n) => app.doc.querySelector(`[data-key="jmarrero-forge/tracker#1013/comment-${n}"]`)?.textContent?.includes(`Reason ${n}`)), "both inspected proposals");
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1013/comment-1", "jmarrero-forge/tracker#1013/comment-2"]);
      for (const n of [1, 2]) assert.match(app.doc.querySelector(`[data-key="jmarrero-forge/tracker#1013/comment-${n}"]`)!.textContent!, new RegExp(`Reason ${n}`));
      assert.deepEqual(app.reads.writes, [], "nothing written");
    } finally { await app.close(); }
  });

  it("says when not every summary was read, showing the ask the pass fell back to", async (t) => {
    const app = await boot(t, { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(5, { ask: "labelled needs-human" })], { summaries: "partial" }) });
    try {
      assert.match(app.note(), /Not every summary was read: some asks show the board's question or the hold's reason\./);
      assert.match(app.doc.querySelector(".card .title")!.textContent!, /labelled needs-human/);
    } finally { await app.close(); }
  });

  it("keeps unsent text after its card disappears without counting it outstanding", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1), rawAsk(2)]) };
    const app = await boot(t, holds);
    try {
      app.inspect();
      await app.until(() => !!app.doc.querySelector('[data-key="jmarrero-forge/tracker#1"] textarea'), "the answer form");
      const text = app.doc.querySelector<HTMLTextAreaElement>('[data-key="jmarrero-forge/tracker#1"] textarea')!;
      text.value = "Half an answer";
      // The next read is slow, and lands while he types.
      let release = () => {};
      holds.gate = new Promise((resolve) => { release = resolve; });
      holds.comments = listed(Date.now(), [rawAsk(2)]);
      holds.etag = '"b"';
      t.mock.timers.setTime(Date.now() + 2 * MINUTE);
      app.window.dispatchEvent(new app.window.Event("focus"));
      await app.until(() => app.reads.holds.length === 2, "the slow read");
      assert.equal(app.count(), "2");
      release();
      await app.until(() => !!app.doc.querySelector(".card-stale-note"), "the gone note");
      assert.deepEqual(app.keys().sort(), ["jmarrero-forge/tracker#1", "jmarrero-forge/tracker#2"], "kept where it was, the rest placed around it");
      assert.equal(app.doc.querySelector('[data-key="jmarrero-forge/tracker#1"] textarea'), text);
      assert.equal(text.value, "Half an answer");
      assert.equal(app.count(), "1", "departed drafts do not inflate outstanding decisions");
      assert.equal(app.doc.querySelector(".inbox-more"), null);
      delete holds.gate;
      await app.reload();
      assert.deepEqual([app.keys(), app.count()], [["jmarrero-forge/tracker#2"], "1"]);
    } finally { await app.close(); }
  });

  it("keeps a draft through Status navigation and removes its write authority when it departs", async (t) => {
    const items = [rawAsk(1, { epic: FOCUS, topEpic: FOCUS }), rawAsk(2, { epic: FOCUS, topEpic: FOCUS }), rawAsk(3, { epic: "none", topEpic: "none" })];
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, items, { epics }) };
    const app = await boot(t, holds);
    try {
      app.inspect();
      await app.until(() => !!app.doc.querySelector(".card textarea"), "the answer form");
      const text = app.doc.querySelector<HTMLTextAreaElement>(".card textarea")!;
      const row = text.closest<HTMLElement>(".card")!;
      text.value = "Half an answer";
      app.window.location.hash = "#status";
      await app.until(() => app.doc.querySelector(".home")?.getAttribute("data-view") === "status", "Status");
      holds.comments = listed(T0, items.slice(1), { epics });
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      assert.equal(app.count(), "1");
      app.window.location.hash = "#inbox";
      await app.until(() => app.doc.querySelector(".home")?.getAttribute("data-view") === "inbox", "inbox");
      assert.equal(row.hidden, false);
      assert.equal(app.count(), "1");
      assert.equal(text.value, "Half an answer");
      assert.match(row.textContent!, /This has left the inbox/);
      assert.equal(row.querySelector<HTMLButtonElement>("button")!.disabled, true);
    } finally { await app.close(); }
  });

  // `second` is the next row: in `grouped`, an approval without its detail ahead of every full non-approval row.
  const variants = [
    { variant: "full", listed: 174, total: 174, detailed: 174, approvals: 1, second: "jmarrero-forge/tracker#2000" },
    { variant: "capped", listed: 13, total: 13, detailed: 13, approvals: 1, second: "jmarrero-forge/tracker#2000" },
    { variant: "grouped", listed: 60, total: 22, detailed: 2, approvals: 2, second: "jmarrero-forge/tracker#2058" },
  ] as const;
  for (const { variant, listed: inventory, total, detailed, approvals, second } of variants) it(`174 decisions: operator-path approval first, one unit per count (${variant})`, async (t) => {
    const published = needsYou174(variant);
    const holds: Holds = { status: 200, etag: '"174"', comments: [holdsComment(iso(T0), published)] };
    const app = await boot(t, holds);
    try {
      const line = (waiting: number, done: number) => `174 decisions reported: ${inventory} listed, ${174 - inventory} not listed. ${total} rows (${detailed} with detail): ${waiting} waiting, ${done} done here, 0 hidden by the epic filter.`;
      assert.equal(app.keys()[1], second);
      const row = app.doc.querySelector<HTMLElement>(".inbox-cards > .card")!;
      assert.equal(row.dataset.key, "jmarrero-forge/tracker#1367");
      assert.ok(row.classList.contains("c-approve"));
      assert.match(row.textContent!, /release 21 stale holds/);
      assert.doesNotMatch(row.textContent!, /cap|Detail not published/);
      assert.equal(row.querySelector<HTMLButtonElement>("button")!.textContent, "Approve aaaaaaa");
      assert.equal(row.querySelector(".card-full"), null);
      assert.equal(app.count(), String(total));
      const chip = (choice: string) => app.doc.querySelector<HTMLButtonElement>(`[data-epic-choice="${choice}"]`)!;
      assert.equal(chip("active").textContent, `In progress + approvals · ${total}`);
      assert.equal(chip("all").textContent, `Show everything · ${total}`);
      assert.ok(app.doc.querySelector("#sec-needs")!.textContent!.includes(line(total, 0)));
      // Capped and grouped lists are incomplete: only those read needs-human directly.
      assert.deepEqual(app.reads.all.filter((r) => r.path !== HOLDS && r.path !== "/user").map((r) => r.path), variant === "full" ? [] : [SEARCH]);
      // Explicit filters still select exactly their named epic; only the default
      // retains approval waits outside in-progress epics.
      chip(`epic:${FOCUS}`).click();
      assert.equal(app.count(), String(total - approvals));
      chip("all").click();
      assert.equal(app.count(), String(total));
      assert.equal(app.doc.querySelector<HTMLElement>(".inbox-cards > .card")!.dataset.key, row.dataset.key);
      assert.deepEqual(app.reads.writes, []);
      // A local approval leaves the heading and the chips by one predicate.
      app.doc.querySelector<HTMLButtonElement>(".inbox-cards > .card button")!.click();
      await app.until(() => app.count() === String(total - 1), "completed approval");
      assert.equal(chip("all").textContent, `Show everything · ${total - 1}`);
      assert.equal(chip("active").textContent, `In progress + approvals · ${total - 1}`);
      assert.ok(app.doc.querySelector("#sec-needs")!.textContent!.includes(line(total - 1, 1)));
    } finally { await app.close(); }
  });

  it("661 publication: in-progress epics by default, one click for everything, cap and filter counted apart", async (t) => {
    const published = { ...fixture<Record<string, unknown>>("needs-you-661.json"), validated_at: iso(T0), changed_at: iso(T0) };
    const holds: Holds = { status: 200, etag: '"a"', comments: [holdsComment(iso(T0), published)] };
    const app = await boot(t, holds);
    const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: app.window.localStorage });
    const stored = () => app.window.localStorage.getItem("review.inbox.epic.jmarrero");
    try {
      const chips = () => [...app.doc.querySelectorAll<HTMLButtonElement>(".epic-chips button")];
      const pressed = () => chips().find((b) => b.getAttribute("aria-pressed") === "true")!.getAttribute("data-epic-choice");
      const line = () => app.doc.querySelector("#sec-needs")!.textContent!;
      assert.equal(app.count(), "6", "the heading counts what the default filter shows");
      assert.equal(app.keys().filter((k) => !app.doc.querySelector<HTMLElement>(`[data-key="${k}"]`)!.hidden)[0], "jmarrero-forge/tracker#1261");
      assert.match(app.doc.querySelector(".epic-filter")!.textContent!, /2 epics in progress: tracker#976 \(focus, the operator's comment this week\), tracker#1100/);
      assert.match(line(), /8 decisions reported: 8 listed, 0 not listed\. 8 rows \(7 with detail\): 6 waiting, 0 done here, 2 hidden by the epic filter\./);
      assert.deepEqual(app.reads.all.filter((r) => r.path !== HOLDS && r.path !== "/user").map((r) => r.path), [SEARCH], "the filter reads nothing; the incomplete list reads needs-human once");
      chips().find((b) => b.textContent!.startsWith("Show everything"))!.click();
      assert.deepEqual([app.count(), pressed(), stored()], ["8", "all", '"all"']);
      assert.match(line(), /8 rows \(7 with detail\): 8 waiting, 0 done here, 0 hidden by the epic filter\./);
      app.window.location.hash = "#epic-1100";
      await app.until(() => app.count() === "2", "the #epic-N deep link");
      assert.equal(pressed(), "epic:jmarrero-forge/tracker#1100");
      assert.equal(stored(), '"all"', "a link selects its epic for this visit, not the viewer's default");
      // Past the cap, fit() has cut every detail card first: the two numbers stay apart.
      holds.comments = [holdsComment(iso(T0), { ...published, complete: false, items: [], requests: undefined, omitted: 2, count: 10, counts: { decisions: 10, groups: 0, members: 10 }, details_omitted: 10 })];
      holds.etag = '"b"';
      chips()[0]!.click();
      await app.reload();
      assert.equal(app.count(), "6");
      assert.match(line(), /10 decisions reported: 8 listed, 2 not listed\. 8 rows \(0 with detail\): 6 waiting, 0 done here, 2 hidden by the epic filter\./);
      assert.match(app.note(), /Incomplete \(2 past the pass's cap\)/);
    } finally {
      if (old) Object.defineProperty(globalThis, "localStorage", old);
      else Reflect.deleteProperty(globalThis, "localStorage");
      await app.close();
    }
  });

  // #244: the 661 publication plus a #680 promote group, as Needs you drew it before #237 and #242.
  it("661 publication with a promote group: compact cards, a quiet placeholder and members in the pass's order", async (t) => {
    const published = { ...fixture<Record<string, unknown> & { items: unknown[]; identities: unknown[]; requests: Record<string, unknown>[] }>("needs-you-661.json"), validated_at: iso(T0), changed_at: iso(T0) };
    const bucketed = fixture<{ group: { reason: string; numbers: number[] }; review_buckets: unknown }>("draft-review-needs-you.json");
    const group = "jmarrero-forge/bootc#1";
    const groupRequest = { ...published.requests.find((r) => r.key === "jmarrero-forge/tracker#1261")!, key: group, identity: `github.com/${group}/promote`, question: "3 drafts", target: { type: "pull_request", repository: "jmarrero-forge/bootc", number: 1 } };
    const app = await boot(t, { status: 200, etag: '"a"', comments: [holdsComment(iso(T0), {
      ...published, review_buckets: bucketed.review_buckets, count: 9, counts: { decisions: 9, groups: 1, members: 11 },
      items: [...published.items, rawAsk(1, { key: group, item: group, source: "reviews", kind: "review-promote", ask: "3 drafts", action: { type: "pull_request", repository: "jmarrero-forge/bootc", number: 1 }, group: bucketed.group, epic: FOCUS, topEpic: FOCUS })],
      identities: [...published.identities, { item: group, kind: "review-promote", source: "reviews", waiting_since: "2026-11-04T19:00:00Z", epic: FOCUS }],
      requests: [...published.requests, groupRequest],
    })] });
    try {
      const cards = [...app.doc.querySelectorAll<HTMLElement>(".inbox-cards > .card:not([hidden])")];
      const card = (key: string) => cards.find((c) => c.dataset.key === key)!;
      assert.equal(app.count(), "7");
      assert.deepEqual(cards.map((c) => c.dataset.key), ["jmarrero-forge/tracker#1261", "jmarrero-forge/agentic-job#2900", "jmarrero-forge/tracker#1300", "jmarrero-forge/tracker#1310", "jmarrero-forge/agent-board#650"]);
      assert.match(app.doc.querySelector("#sec-needs")!.textContent!, /9 decisions reported: 9 listed, 0 not listed\. 9 rows \(8 with detail\): 7 waiting, 0 done here, 2 hidden by the epic filter\. Groups: 1, members: 11\./);
      for (const c of cards) {
        // #237 added a "Published decision context" fold beside Context on every card.
        assert.deepEqual([...c.querySelectorAll(":scope > details:not(.card-full, .not-offered) > summary")].map((s) => s.textContent), c.querySelector(":scope > .card-note") ? ["Context"] : [], c.dataset.key);
      }
      assert.match(card("jmarrero-forge/tracker#1261").querySelector(".card-note")!.textContent!, /ownership_evidence/, "the published context is still one click away");
      // #237 drew a detail-less identity as an Answer with a refusal box.
      app.doc.querySelector<HTMLButtonElement>(".inbox-more")!.click();
      const placeholder = app.doc.querySelector('[data-key="jmarrero-forge/tracker#1310"]')!;
      assert.deepEqual([placeholder.querySelector(".kind")!.textContent, placeholder.querySelector(".title")!.textContent], ["Act", "Detail not published: inspect the source before acting"]);
      assert.equal(placeholder.querySelector(".warn, button, a[href], details"), null);
      // #242 drew nav buttons and bucket headings on the group before any read.
      const members = app.doc.querySelector(`[data-key="${group}"] .members`)!;
      assert.equal(members.querySelector("nav, h4, button"), null);
      assert.deepEqual([...members.querySelectorAll<HTMLElement>(".member")].map((d) => d.dataset.member), [1, 2, 3].map((n) => `jmarrero-forge/bootc#${n}`));
      assert.deepEqual(app.reads.all.map((r) => r.path), ["/user", HOLDS, SEARCH], "drawing reads nothing else; the incomplete list reads needs-human directly");
    } finally { await app.close(); }
  });

  it("a missing current list does not use retained epic activity to hide fallback holds", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1, { epic: FOCUS, topEpic: FOCUS })], { epics }) };
    const app = await boot(t, holds);
    try {
      holds.comments = [holdsComment(iso(T0), undefined, [{ item: "jmarrero-forge/tracker#2", url: "https://github.com/jmarrero-forge/tracker/issues/2", epic: false, kind: "needs-human", reason: "Choose", operator: true, priority: "P0", question: "Which path?" }])];
      holds.etag = '"b"';
      await app.wake(2 * MINUTE);
      const fallback = app.doc.querySelector<HTMLElement>('[data-key="jmarrero-forge/tracker#2"]')!;
      assert.ok(fallback);
      assert.equal(fallback.hidden, false);
      assert.equal(app.doc.querySelector(".epic-filter"), null, "no browser ranking or hidden fallback holds");
    } finally { await app.close(); }
  });

  it("draws nothing from a read that lands after sign-out", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1)]) };
    const app = await boot(t, holds);
    let release = () => {};
    holds.gate = new Promise((resolve) => { release = resolve; });
    holds.comments = listed(T0, [rawAsk(1), rawAsk(7)]);
    holds.etag = '"b"';
    t.mock.timers.setTime(Date.now() + 2 * MINUTE);
    app.window.dispatchEvent(new app.window.Event("focus"));
    await app.until(() => app.reads.holds.length === 2, "the slow read");
    app.doc.querySelector<HTMLButtonElement>("#signout")!.click();
    release();
    await settle();
    assert.equal(app.doc.querySelector('[data-key="jmarrero-forge/tracker#7"]'), null);
    app.window.close();
  });
});

describe("serverless", () => {
  it("draws Needs you and Status without a pass view, saying how old the snapshot is and nothing about a server", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0 - 3 * 60 * MINUTE, [rawAsk(1)]) };
    const app = await boot(t, holds);
    try {
      assert.deepEqual(app.keys(), ["jmarrero-forge/tracker#1"]);
      app.window.location.hash = "#status";
      await app.until(() => /Pass view not in the pass's snapshot/.test(app.doc.querySelector("#view")!.textContent!), "Status");
      assert.match(app.doc.querySelector("#view")!.textContent!, /written 3h ago: the pass may have stopped publishing it/);
      assert.doesNotMatch(app.doc.body.textContent!, /server unavailable|service unavailable/i);
    } finally { await app.close(); }
  });

  it("signs out and asks for a new token when GitHub refuses it during a dispatch", async (t) => {
    const holds: Holds = { status: 200, etag: '"a"', comments: listed(T0, [rawAsk(1)]), expired: true };
    const app = await boot(t, holds);
    try {
      app.window.location.hash = "#issue/jmarrero-forge/tracker/5";
      await app.until(() => !!app.doc.querySelector("form.item-dispatch"), "the dispatch form");
      app.doc.querySelector<HTMLTextAreaElement>("form.item-dispatch textarea")!.value = "Look into it";
      app.doc.querySelector("form.item-dispatch")!.dispatchEvent(new app.window.Event("submit", { cancelable: true }));
      await app.until(() => !!app.doc.querySelector(".signin"), "the sign-in form");
      assert.deepEqual(app.reads.writes, ["POST /repos/jmarrero-forge/tracker/issues/5/comments"]);
      assert.match(app.doc.querySelector(".signin")!.textContent!, /GitHub rejected the saved token: it has expired or was revoked\. Paste a new one\./);
    } finally { app.window.close(); }
  });
});
