import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { cancelLiveRun, LIVE_SOURCES, type LiveRun, liveAgentsView, loadLiveRuns, parseRunName } from "../src/github/liveruns.ts";
import type { PassView } from "../src/github/passview.ts";
import { fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();

const API = "https://api.github.com";
const token = async () => "t";
const now = Date.parse("2026-11-07T17:00:00Z");
const [TRACKER, DEVSPACE] = LIVE_SOURCES as [typeof LIVE_SOURCES[0], typeof LIVE_SOURCES[0]];
const raw = (repository: string, id: number, title: string, status = "in_progress", started = "2026-11-07T16:48:00Z") =>
  ({ id, display_title: title, status, created_at: started, run_started_at: started, path: `.github/workflows/${repository === TRACKER.repository ? TRACKER.workflow : DEVSPACE.workflow}`, repository: { full_name: repository } });

describe("parseRunName", () => {
  const cases: [string, ReturnType<typeof parseRunName>][] = [
    ["implement jmarrero-forge/agent-board#733 (claude)", { kind: "implement", item: "jmarrero-forge/agent-board#733", pool: "claude" }],
    ["implement bootc-dev/jmarrero-devspace-sandbox#42 (openai, 4c)", { kind: "implement", item: "bootc-dev/jmarrero-devspace-sandbox#42", pool: "openai" }],
    ["review jmarrero-forge/review#280 0123456789abcdef0123456789abcdef01234567 (claude)", { kind: "review", item: "jmarrero-forge/review#280", pool: "claude" }],
    ["fix o/r#3 (openai) [acp-experiment]", { kind: "fix", item: "o/r#3", pool: "openai" }],
    ["triage o/r#9", { kind: "triage", item: "o/r#9", pool: null }],
    ["supervisor", undefined],
    ["implement o/..#1 (claude)", undefined],
    ["implement o/r#0 (claude)", undefined],
    ["implement o/r#1 (Claude)", undefined],
  ];
  for (const [title, want] of cases) it(title, () => assert.deepEqual(parseRunName(title), want));
});

function world(lists: Record<string, unknown[] | number>) {
  return scriptedFetch((method, url, headers) => {
    const m = /^.*\/repos\/(.+)\/actions\/workflows\/[^/]+\/runs\?status=(\w+)&per_page=100$/.exec(url);
    if (method !== "GET" || !m) return undefined;
    const list = lists[`${m[1]} ${m[2]}`] ?? [];
    if (typeof list === "number") return { status: list, body: { message: "nope" } };
    const etag = `"${m[1]}-${m[2]}-${list.length}"`;
    return headers["If-None-Match"] === etag ? { status: 304, headers: { etag } } : { body: { total_count: list.length, workflow_runs: list }, headers: { etag } };
  });
}

describe("loadLiveRuns", () => {
  for (const [name, body] of Object.entries({ missing: {}, null: null, scalar: "unexpected", array: [], nullRuns: { workflow_runs: null }, objectRuns: { workflow_runs: {} } })) {
    it(`reports a malformed list (${name}) as incomplete, including on conditional rereads`, async () => {
      const { fetchImpl, calls } = scriptedFetch((_, url, headers) => {
        if (!url.includes("in_progress")) return { body: { workflow_runs: [] } };
        return headers["If-None-Match"] ? { status: 304 } : { body, headers: { etag: '"malformed"' } };
      });
      const gh = new GitHub(token, async (url, init) => {
        const response = await fetchImpl(url, init);
        return body === null && url.includes("in_progress") && response.status === 200
          ? new Response("null", { headers: response.headers }) : response;
      });
      for (let poll = 0; poll < 2; poll++) {
        const data = await loadLiveRuns(gh, [TRACKER], now + poll);
        assert.deepEqual(data.runs, []);
        assert.deepEqual(data.errors, [`${TRACKER.repository} ${TRACKER.workflow} (in_progress): invalid workflow runs response`]);
        const text = liveAgentsView(data, undefined, now).textContent!;
        assert.match(text, /Incomplete:.*invalid workflow runs response/);
        assert.match(text, /No runs read; see above/);
        assert.doesNotMatch(text, /No agent runs in flight/);
      }
      assert.equal(calls.length, 6, "no retries or additional discovery requests");
    });
  }

  it("keeps valid runs from other statuses when one list is malformed", async () => {
    const { fetchImpl } = scriptedFetch((_, url) => ({ body: url.includes("in_progress") ? {}
      : { workflow_runs: url.includes("queued") ? [raw(TRACKER.repository, 1, "implement o/r#1", "queued")] : [] } }));
    const data = await loadLiveRuns(new GitHub(token, fetchImpl), [TRACKER], now);
    assert.deepEqual(data.runs.map((r) => r.run.id), [1]);
    assert.equal(data.errors.length, 1);
    assert.match(data.errors[0]!, /\(in_progress\): invalid workflow runs response/);
  });

  it("lists every source's unfinished runs, conditionally, oldest first, a run caught twice once", async () => {
    const moving = raw(TRACKER.repository, 3, "fix o/r#3 (openai)", "queued", "2026-11-07T16:50:00Z");
    const { fetchImpl, calls } = world({
      [`${TRACKER.repository} in_progress`]: [raw(TRACKER.repository, 2, "implement o/r#2 (claude)"), { ...moving, status: "in_progress" }],
      [`${TRACKER.repository} queued`]: [moving],
      [`${DEVSPACE.repository} in_progress`]: [raw(DEVSPACE.repository, 9, "research a/b#9 (claude, 64c)", "in_progress", "2026-11-07T15:00:00Z")],
      [`${DEVSPACE.repository} pending`]: [raw("someone/else", 10, "implement x/y#1 (claude)")],
    });
    const gh = new GitHub(token, fetchImpl);
    const data = await loadLiveRuns(gh, LIVE_SOURCES, now);
    assert.deepEqual(data.errors, []);
    assert.deepEqual(data.runs.map((r) => [r.run.id, r.item, r.kind, r.pool, r.status]), [
      [9, "a/b#9", "research", "claude", "in_progress"],
      [2, "o/r#2", "implement", "claude", "in_progress"],
      [3, "o/r#3", "fix", "openai", "in_progress"],
    ], "another repository's run is not one of the source's");
    assert.equal(calls.length, LIVE_SOURCES.length * 3);
    await loadLiveRuns(gh, LIVE_SOURCES, now);
    assert.ok(calls.slice(LIVE_SOURCES.length * 3).every((c) => c.headers["If-None-Match"]), "every reread is conditional");
  });

  it("does not call a short status-filtered page incomplete when total_count disagrees", async () => {
    const { fetchImpl, calls } = scriptedFetch((_, url) => ({ body: {
      total_count: url.includes("in_progress") ? 4 : 150,
      workflow_runs: url.includes("in_progress") ? [raw(TRACKER.repository, 1, "implement o/r#1")] : [],
    } }));
    const data = await loadLiveRuns(new GitHub(token, fetchImpl), [TRACKER], now);
    assert.deepEqual(data.errors, []);
    assert.equal(data.runs.length, 1);
    assert.equal(calls.length, 3, "no extra requests to reconcile counts");
    assert.ok(calls.every((c) => /\?status=(in_progress|queued|pending)&per_page=100$/.test(c.url)));
  });

  it("says which source it could not read, and that a full page may be cut", async () => {
    const many = Array.from({ length: 100 }, (_, i) => raw(TRACKER.repository, i + 1, `implement o/r#${i + 1}`));
    const { fetchImpl } = scriptedFetch((_, url) => url.includes(DEVSPACE.repository) ? { status: 404, body: { message: "Not Found" } }
      : url.includes("in_progress") ? { body: { total_count: 150, workflow_runs: many } } : { body: { total_count: 0, workflow_runs: [] } });
    const data = await loadLiveRuns(new GitHub(token, fetchImpl), LIVE_SOURCES, now);
    assert.equal(data.runs.length, 100);
    assert.ok(data.errors.some((e) => /dispatch\.yml: first 100 in_progress runs read; more may exist/.test(e)), data.errors.join("\n"));
    assert.ok(data.errors.some((e) => /agent\.yml \(in_progress\): workflow missing/.test(e)), data.errors.join("\n"));
    const el = liveAgentsView(data, undefined, now);
    assert.match(el.textContent!, /Incomplete: /);
  });

  it("omits runs older than six hours, including stuck GitHub records, but keeps the boundary and unknown ages", async () => {
    const { fetchImpl } = world({
      [`${TRACKER.repository} in_progress`]: [
        raw(TRACKER.repository, 39698121265, "implement o/r#1623", "in_progress", "2026-10-22T17:00:00Z"),
        raw(TRACKER.repository, 1, "implement o/r#1", "in_progress", "2026-11-07T10:59:59.999Z"),
        raw(TRACKER.repository, 2, "implement o/r#2", "in_progress", "2026-11-07T11:00:00Z"),
        { ...raw(TRACKER.repository, 3, "implement o/r#3"), created_at: "2026-10-22T17:00:00Z" },
        raw(TRACKER.repository, 4, "implement o/r#4", "in_progress", "unknown"),
      ],
      [`${TRACKER.repository} queued`]: [
        { ...raw(TRACKER.repository, 5, "implement o/r#5", "queued", "2026-10-22T17:00:00Z"), run_started_at: null },
        { ...raw(TRACKER.repository, 6, "implement o/r#6", "queued"), run_started_at: null },
      ],
    });
    const gh = new GitHub(token, fetchImpl);
    const data = await loadLiveRuns(gh, [TRACKER], now);
    assert.deepEqual(data.errors, []);
    assert.deepEqual(data.runs.map((r) => r.run.id), [2, 3, 6, 4]);
    const el = liveAgentsView(data, undefined, now, () => Object.assign(document.createElement("button"), { textContent: "Cancel" }));
    assert.doesNotMatch(el.textContent!, /39698121265|running 2w/);
    assert.equal(el.querySelectorAll("button").length, 4);
    const later = await loadLiveRuns(gh, [TRACKER], now + 1);
    assert.ok(!later.runs.some((r) => r.run.id === 2), "304 responses still age out");
  });
});

describe("liveAgentsView", () => {
  const run = (id: number, over: Partial<LiveRun> = {}): LiveRun => ({ item: `o/r#${id}`, kind: "implement", pool: null, title: `implement o/r#${id}`, status: "in_progress", startedAt: "2026-11-07T16:48:00Z", run: { repository: TRACKER.repository, id }, source: TRACKER, listed: false, ...over });

  it("lists runs without a pass view: item link, kind, pool, elapsed, run link and Cancel", () => {
    const el = liveAgentsView({ at: now, runs: [run(1, { pool: "claude" }), run(2, { status: "queued" }), run(3, { item: null, kind: null, title: "odd title" })], errors: [] }, undefined, now, () => Object.assign(document.createElement("button"), { textContent: "Cancel" }));
    assert.match(el.querySelector("h3")!.textContent!, /Live agents 3/);
    assert.match(el.textContent!, /2 running, 1 queued or waiting/);
    const first = el.querySelector(".live-run")!;
    assert.equal(first.querySelector("a.live-item")!.getAttribute("href"), "https://github.com/o/r/issues/1");
    assert.match(first.textContent!, /implement.*claude.*running 12m.*run 1.*Cancel/);
    assert.equal(first.querySelector("a[href$='/actions/runs/1']")!.getAttribute("href"), `https://github.com/${TRACKER.repository}/actions/runs/1`);
    assert.match(el.textContent!, /queued 12m/);
    assert.match(el.textContent!, /pool \?/);
    assert.match(el.textContent!, /odd title/);
  });

  it("fills a missing pool from the pass view, and says when nothing runs", () => {
    const view = fixture<{ pass_view: PassView }>("pass-view.json").pass_view;
    const flight = view.in_flight.find((f) => f.state === "running")!;
    assert.ok(flight.state === "running");
    const el = liveAgentsView({ at: now, runs: [run(flight.run.id, { run: flight.run })], errors: [] }, view, now);
    assert.match(el.querySelector(".live-run")!.textContent!, new RegExp(flight.pool));
    assert.match(liveAgentsView({ at: now, runs: [], errors: [] }, undefined, now).textContent!, /No agent runs in flight/);
    assert.match(liveAgentsView(undefined, undefined, now).textContent!, /Reading/);
  });
});

describe("cancelLiveRun", () => {
  const target: LiveRun = { item: "o/r#2", kind: "implement", pool: "claude", title: "", status: "in_progress", startedAt: "", run: { repository: TRACKER.repository, id: 2 }, source: TRACKER, listed: false };
  const gitHub = (login: string, got: Record<string, unknown>) => scriptedFetch((method, url) =>
    url === `${API}/user` ? { body: { login }, headers: { "x-oauth-scopes": "repo" } }
      : method === "GET" ? { body: got }
        : method === "POST" && url.endsWith("/cancel") ? { status: 202, body: {} } : undefined);

  it("reads the viewer and the run fresh, then cancels it", async () => {
    const { fetchImpl, calls } = gitHub("jmarrero", raw(TRACKER.repository, 2, "implement o/r#2 (claude)"));
    assert.equal(await cancelLiveRun(new GitHub(token, fetchImpl), target), `https://github.com/${TRACKER.repository}/actions/runs/2`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace(API, "")}`), ["GET /user", `GET /repos/${TRACKER.repository}/actions/runs/2`, `POST /repos/${TRACKER.repository}/actions/runs/2/cancel`]);
  });

  for (const [name, answer] of [["a 5xx", { status: 502, body: { message: "Bad Gateway" } }], ["a lost answer", "throw"]] as const) it(`calls a cancel answered by ${name} uncertain`, async () => {
    const { fetchImpl } = scriptedFetch((method, url) => {
      if (url === `${API}/user`) return { body: { login: "jmarrero" }, headers: { "x-oauth-scopes": "repo" } };
      if (method === "GET") return { body: raw(TRACKER.repository, 2, "") };
      if (answer === "throw") throw new TypeError("network error");
      return answer;
    });
    await assert.rejects(cancelLiveRun(new GitHub(token, fetchImpl), target), (e: Error) => e.name === "MaybeSentError" && /may or may not have gone out/.test(e.message));
  });

  const refusals: [string, string, Record<string, unknown>, LiveRun, RegExp][] = [
    ["another viewer", "visitor", raw(TRACKER.repository, 2, ""), target, /only jmarrero acts/],
    ["a finished run", "jmarrero", raw(TRACKER.repository, 2, "", "completed"), target, /already finished/],
    ["another workflow's run", "jmarrero", { ...raw(TRACKER.repository, 2, ""), path: ".github/workflows/poll.yml" }, target, /poll\.yml, not dispatch\.yml/],
    ["another run", "jmarrero", raw(TRACKER.repository, 3, ""), target, /different run/],
    ["a source not configured", "jmarrero", raw("o/r", 2, ""), { ...target, source: { repository: "o/r", workflow: "x.yml" }, run: { repository: "o/r", id: 2 } }, /not a run of an agent workflow/],
  ];
  for (const [name, login, got, r, why] of refusals) it(`refuses ${name}`, async () => {
    const { fetchImpl, calls } = gitHub(login, got);
    await assert.rejects(cancelLiveRun(new GitHub(token, fetchImpl), r), why);
    assert.ok(!calls.some((c) => c.method === "POST"));
  });
});
