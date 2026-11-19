import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cancelRun, planBlocks, redispatch, retryRun } from "../src/github/agentruns.ts";
import { GitHub } from "../src/github/api.ts";
import { activePassView, type AgentActions, type AgentRun, type PassView, resetAgentActions } from "../src/github/passview.ts";
import { tickAges } from "../src/github/view.ts";
import { fixture, installDom, type Scripted, scriptedFetch } from "./helpers.ts";

installDom();
afterEach(resetAgentActions);

const API = "https://api.github.com";
const RUNS = `${API}/repos/example/runner/actions/runs`;
const token = async () => "t";
const view = () => fixture<{ pass_view: PassView }>("pass-view.json").pass_view;
const RUNNING: AgentRun = { item: "example/work#11", kind: "implement", pool: "claude", run: { repository: "example/runner", id: 42 } };
const FINISHED: AgentRun = { item: "example/work#10", kind: "triage", pool: "openai", run: { repository: "example/runner", id: 40 } };
const run = (id: number, status: string, conclusion: string | null = null) => ({ id, html_url: `https://github.com/example/runner/actions/runs/${id}`, status, conclusion, created_at: "2026-11-05T11:55:00Z", repository: { full_name: "example/runner" } });
const PLAN = '{"schema":"agent-board/job-plan/v1","repo":"example/work","item":10,"kind":"triage","runner":"hosted","brief":"Look"}';
const fenced = (json: string) => `\`\`\`agent-board-plan\n${json}\n\`\`\``;
const comment = (id: number, login: string, body: string, updated: string) => ({ body, author: { login }, editor: null as { login: string } | null, url: `https://github.com/example/work/issues/10#issuecomment-${id}`, createdAt: updated, lastEditedAt: null as string | null });
const PLANS = [
  comment(1, "jmarrero-bot", fenced(PLAN.replace("Look", "Old")), "2026-11-05T10:00:00Z"),
  comment(2, "jmarrero", `Try again.\n\n${fenced(PLAN)}`, "2026-11-05T11:00:00Z"),
  comment(3, "visitor", fenced(PLAN.replace("Look", "Visitor")), "2026-11-05T11:30:00Z"),
  comment(4, "jmarrero-bot", `${fenced(PLAN.replace("Look", "Quoted")).replace(/^/gm, "> ")}\n\n\`\`\`\`\n${fenced(PLAN.replace("Look", "Nested"))}\n\`\`\`\``, "2026-11-05T11:40:00Z"),
];

interface Script { login?: string; scopes?: string; runs?: Record<number, unknown>; jobs?: unknown[]; comments?: unknown[] | ((page: number) => unknown[]); post?: Scripted }

function gitHub(s: Script = {}) {
  const mock = scriptedFetch((method, url) => {
    if (method === "GET" && url === `${API}/user`) return { body: { login: s.login ?? "jmarrero" }, ...(s.scopes === undefined ? {} : { headers: { "x-oauth-scopes": s.scopes } }) };
    const m = /^.*\/actions\/runs\/(\d+)(\/jobs\?filter=latest&per_page=100)?$/.exec(url);
    if (method === "GET" && m && url.startsWith(RUNS)) return m[2] ? { body: { jobs: s.jobs ?? [{ name: "agent", status: "completed", conclusion: "failure" }] } } : { body: (s.runs ?? {})[Number(m[1])] ?? run(Number(m[1]), "in_progress") };
    if (method === "POST" && url === `${API}/graphql`) {
      const { query, variables } = mock.calls.at(-1)!.body as { query: string; variables: { owner: string; name: string; number: number; after: string | null } };
      assert.match(query, /editor \{ login \}.*createdAt lastEditedAt/);
      assert.deepEqual({ ...variables, after: null }, { owner: "example", name: "work", number: 10, after: null });
      const page = variables.after === null ? 1 : Number(variables.after);
      const nodes = typeof s.comments === "function" ? s.comments(page) : s.comments ?? PLANS;
      const more = typeof s.comments === "function" ? s.comments(page + 1).length > 0 : nodes.length === 100;
      return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes, pageInfo: { hasNextPage: more, endCursor: String(page + 1) } } } } } } };
    }
    if (method === "POST") return s.post ?? { status: url.endsWith("/comments") ? 201 : 202, body: url.endsWith("/comments") ? { html_url: `https://github.com/example/work/issues/10#issuecomment-9` } : {} };
    return undefined;
  });
  return mock;
}

const requests = (calls: { method: string; url: string }[]) => calls.map((c) => `${c.method} ${c.url.replace(API, "")}`);

describe("cancelRun", () => {
  it("reads the viewer and the run fresh, then cancels it", async () => {
    const { fetchImpl, calls } = gitHub({ scopes: "repo, read:project" });
    assert.equal(await cancelRun(new GitHub(token, fetchImpl), view(), RUNNING), "https://github.com/example/runner/actions/runs/42");
    assert.deepEqual(requests(calls), ["GET /user", "GET /repos/example/runner/actions/runs/42", "POST /repos/example/runner/actions/runs/42/cancel"]);
  });

  const refusals: [string, AgentRun, Script, RegExp, number][] = [
    ["a run the view doesn't list as running", FINISHED, {}, /doesn't list run 40 as running/, 0],
    ["a run listed under another item", { ...RUNNING, item: "example/work#99" }, {}, /doesn't list run 42/, 0],
    ["a non-operator viewer", RUNNING, { login: "someone" }, /signed in as someone; only jmarrero/, 1],
    ["a classic token without repo scope", RUNNING, { scopes: "public_repo, read:project" }, /needs the repo scope/, 1],
    ["a run already finished", RUNNING, { runs: { 42: run(42, "completed", "success") } }, /already finished \(success\)/, 2],
    ["a different run read back", RUNNING, { runs: { 42: { ...run(42, "in_progress"), repository: { full_name: "evil/runner" } } } }, /not in example\/runner/, 2],
    ["a token GitHub refuses Actions writes", RUNNING, { post: { status: 403, body: { message: "Resource not accessible by personal access token" } } }, /can't \(HTTP 403\)/, 3],
  ];
  for (const [name, target, script, want, sent] of refusals) {
    it(`refuses ${name}`, async () => {
      const { fetchImpl, calls } = gitHub(script);
      await assert.rejects(cancelRun(new GitHub(token, fetchImpl), view(), target), want);
      assert.equal(calls.length, sent);
      if (sent < 3) assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });
  }

  it("says a write that failed in transit may have gone out", async () => {
    const { fetchImpl } = gitHub({ post: { status: 502 } });
    await assert.rejects(cancelRun(new GitHub(token, fetchImpl), view(), RUNNING), (e: Error) => e.name === "MaybeSentError");
  });
});

describe("retryRun", () => {
  it("reruns a listed failed run's failed jobs", async () => {
    const { fetchImpl, calls } = gitHub({ runs: { 40: run(40, "completed", "failure") } });
    assert.equal(await retryRun(new GitHub(token, fetchImpl), view(), FINISHED), "https://github.com/example/runner/actions/runs/40");
    assert.deepEqual(requests(calls), ["GET /user", "GET /repos/example/runner/actions/runs/40", "GET /repos/example/runner/actions/runs/40/jobs?filter=latest&per_page=100", "POST /graphql", "POST /repos/example/runner/actions/runs/40/rerun-failed-jobs"]);
  });

  const refusals: [string, AgentRun, Script, RegExp][] = [
    ["a run the view doesn't list", { ...FINISHED, run: { repository: "example/runner", id: 7 } }, {}, /doesn't list run 7/],
    ["a non-operator viewer", FINISHED, { login: "someone" }, /only jmarrero/],
    ["a running run", FINISHED, { runs: { 40: run(40, "in_progress") } }, /in_progress, not completed/],
    ["a successful run", FINISHED, { runs: { 40: run(40, "completed", "success") } }, /ended success/],
  ];
  for (const [name, target, script, want] of refusals) {
    it(`refuses ${name}`, async () => {
      const { fetchImpl, calls } = gitHub(script);
      await assert.rejects(retryRun(new GitHub(token, fetchImpl), view(), target), want);
      assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });
  }
});

describe("redispatch", () => {
  it("replies on the item with the newest writer's plan, verbatim", async () => {
    const { fetchImpl, calls } = gitHub({ runs: { 40: run(40, "completed", "failure") } });
    assert.equal(await redispatch(new GitHub(token, fetchImpl), view(), FINISHED), "https://github.com/example/work/issues/10#issuecomment-9");
    assert.deepEqual(requests(calls), ["GET /user", "GET /repos/example/runner/actions/runs/40", "POST /graphql", "POST /repos/example/work/issues/10/comments"]);
    assert.deepEqual(calls.at(-1)!.body, {
      body: `https://github.com/example/runner/actions/runs/40 ended failure; this repeats the plan in https://github.com/example/work/issues/10#issuecomment-2 to dispatch it again.\n\n${fenced(PLAN)}\n`,
    });
  });

  const refusals: [string, Script, RegExp][] = [
    ["a non-operator viewer", { login: "someone" }, /only jmarrero/],
    ["a running run", {}, /in_progress, not finished/],
    ["a successful run", { runs: { 40: run(40, "completed", "success") } }, /ended success/],
    ["an item without a writer's plan", { runs: { 40: run(40, "completed", "failure") }, comments: [PLANS[2]] }, /no job plan by jmarrero or jmarrero-bot/],
    ["a newest plan of another kind", { runs: { 40: run(40, "completed", "failure") }, comments: [comment(5, "jmarrero", fenced(PLAN.replace("triage", "implement")), "2026-11-05T11:50:00Z")] }, /is for "implement", not the failed triage run/],
    ["a malformed newest plan", { runs: { 40: run(40, "completed", "failure") }, comments: [...PLANS, comment(5, "jmarrero", fenced("{"), "2026-11-05T11:50:00Z")] }, /issuecomment-5, is not an agent-board\/job-plan\/v1 object/],
    ["two plans in one comment", { runs: { 40: run(40, "completed", "failure") }, comments: [comment(5, "jmarrero", `${fenced(PLAN)}\n${fenced(PLAN)}`, "2026-11-05T11:50:00Z")] }, /holds 2 plans/],
    // An earlier redispatch, or a writer's correction the pass already started.
    ["a plan newer than the run", { runs: { 40: run(40, "completed", "failure") }, comments: [...PLANS, comment(5, "jmarrero", fenced(PLAN), "2026-11-05T11:56:00Z")] }, /issuecomment-5, is newer than the run/],
    ["a writer's plan edited away by a collaborator", { runs: { 40: run(40, "completed", "failure") }, comments: [...PLANS, { ...comment(5, "jmarrero", "Withdrawn.", "2026-11-05T09:00:00Z"), lastEditedAt: "2026-11-05T11:50:00Z", editor: { login: "collaborator" } }] }, /issuecomment-5 was last edited by collaborator/],
  ];
  for (const [name, script, want] of refusals) {
    it(`refuses ${name}`, async () => {
      const { fetchImpl, calls } = gitHub(script);
      await assert.rejects(redispatch(new GitHub(token, fetchImpl), view(), FINISHED), want);
      assert.equal(calls.filter((c) => c.method === "POST" && c.url !== `${API}/graphql`).length, 0);
    });
  }

  it("refuses while the view lists the item running", async () => {
    const v = view();
    v.in_flight.push({ state: "running", item: "example/work#10", kind: "triage", pool: "openai", run: { repository: "example/runner", id: 45 } });
    const { fetchImpl, calls } = gitHub({ runs: { 40: run(40, "completed", "failure") } });
    await assert.rejects(redispatch(new GitHub(token, fetchImpl), v, FINISHED), /lists example\/work#10 running/);
    assert.equal(calls.length, 0);
  });

  const page = Array.from({ length: 100 }, (_, i) => comment(i, "visitor", "hi", "2026-11-05T10:00:00Z"));
  it("refuses an item with over 1,000 comments", async () => {
    const { fetchImpl, calls } = gitHub({ runs: { 40: run(40, "completed", "failure") }, comments: page });
    await assert.rejects(redispatch(new GitHub(token, fetchImpl), view(), FINISHED), /over 1000 comments/);
    assert.equal(calls.filter((c) => c.url.endsWith("/graphql")).length, 10);
  });

  it("reads an item with exactly 1,000 comments whole", async () => {
    const { fetchImpl, calls } = gitHub({ runs: { 40: run(40, "completed", "failure") }, comments: (n) => (n === 10 ? [...page.slice(2), ...PLANS.slice(0, 2)] : n > 10 ? [] : page) });
    await redispatch(new GitHub(token, fetchImpl), view(), FINISHED);
    assert.equal(calls.filter((c) => c.url.endsWith("/graphql")).length, 10);
    assert.equal(calls.at(-1)!.method, "POST");
  });
});

describe("planBlocks", () => {
  const cases: [string, string, (string | null)[]][] = [
    ["a plan at the start of a line", `Plan:\n${fenced(PLAN)}`, [PLAN]],
    ["a quoted plan", `> ${fenced(PLAN)}`, []],
    ["a plan inside another fence", `~~~\n${fenced(PLAN)}\n~~~`, []],
    ["a plan inside an HTML comment", `<!--\n${fenced(PLAN)}\n-->`, []],
    ["a longer closing fence does not close a plan", `\`\`\`agent-board-plan\n${PLAN}\n\`\`\`\`\``, [null]],
    ["an open plan", `\`\`\`agent-board-plan\n${PLAN}`, [null]],
    ["a tilde plan is not a plan", `~~~agent-board-plan\n${PLAN}\n~~~`, []],
    ["a longer opening fence is not a plan", `\`\`\`\`agent-board-plan\n${PLAN}\n\`\`\`\``, []],
    ["HTML markers inside task text", fenced(PLAN.replace("Look", "Keep <!-- task -->")), [PLAN.replace("Look", "Keep <!-- task -->")]],
    ["an inline HTML marker does not hide a plan", `text <!--\n${fenced(PLAN)}`, [PLAN]],
    ["an indented example hides its nested plan", `   ~~~markdown\n${fenced(PLAN)}\n   ~~~`, []],
  ];
  for (const [name, body, want] of cases) it(name, () => assert.deepEqual(planBlocks(body), want));
});

describe("fresh recovery state", () => {
  const failed = { 40: run(40, "completed", "failure") };
  const record = { ...comment(6, "jmarrero-bot", "<!-- agent-board-dispatch: 2@2026-11-05T11:00:00Z -->\nDispatched [run](https://github.com/example/runner/actions/runs/40).", "2026-11-05T11:54:00Z"), editor: { login: "jmarrero-bot" }, lastEditedAt: "2026-11-05T11:56:00Z" };
  for (const action of [redispatch, retryRun]) {
    it(`${action.name} ignores an ordinary bot-edited dispatch record`, async () => {
      const { fetchImpl, calls } = gitHub({ runs: failed, comments: [...PLANS, record] });
      await action(new GitHub(token, fetchImpl), view(), FINISHED);
      assert.equal(calls.at(-1)!.method, "POST");
      assert.notEqual(calls.at(-1)!.url, `${API}/graphql`);
    });
    it(`${action.name} accepts its own dispatch record created in the same second`, async () => {
      const { fetchImpl } = gitHub({ runs: failed, comments: [...PLANS, { ...record, createdAt: "2026-11-05T11:55:00Z" }] });
      await action(new GitHub(token, fetchImpl), view(), FINISHED);
    });

    const replacements = [
      { ...comment(5, "jmarrero", fenced(PLAN), "2026-11-05T11:45:00Z"), lastEditedAt: "2026-11-05T11:50:00Z", editor: { login: "collaborator" } },
      { ...comment(5, "jmarrero-bot", fenced(PLAN), "2026-11-05T11:45:00Z"), lastEditedAt: "2026-11-05T11:50:00Z" },
      comment(5, "jmarrero", `\`\`\`agent-board-plan\n${PLAN}`, "2026-11-05T11:50:00Z"),
      comment(5, "jmarrero", fenced(PLAN), "2026-11-05T11:56:00Z"),
      { ...record, createdAt: "2026-11-05T11:56:00Z" },
      { ...record, createdAt: "2026-11-05T11:55:00Z", body: record.body.replace("runs/40", "runs/45") },
      { ...comment(5, "jmarrero", fenced(PLAN), "2026-11-05T11:50:00Z"), lastEditedAt: undefined },
    ];
    for (const [i, replacement] of replacements.entries()) {
      it(`${action.name} refuses replacement/edit state ${i} after a reload`, async () => {
        const { fetchImpl, calls } = gitHub({ runs: failed, comments: [...PLANS, replacement] });
        await assert.rejects(action(new GitHub(token, fetchImpl), view(), FINISHED));
        assert.equal(calls.filter((c) => c.method === "POST" && c.url !== `${API}/graphql`).length, 0);
      });
    }
  }

  it("reposts HTML task text without modifying JSON", async () => {
    const plan = PLAN.replace("Look", "Keep <!-- task --> and <!-- open");
    const { fetchImpl, calls } = gitHub({ runs: failed, comments: [comment(2, "JMARRERO", fenced(plan), "2026-11-05T11:00:00Z")] });
    await redispatch(new GitHub(token, fetchImpl), view(), FINISHED);
    assert.match((calls.at(-1)!.body as { body: string }).body, /Keep <!-- task --> and <!-- open/);
    assert.deepEqual(planBlocks((calls.at(-1)!.body as { body: string }).body), [plan]);
  });

  const valid = JSON.parse(PLAN) as Record<string, unknown>;
  const invalid: unknown[] = [[], null, { schema: valid.schema, kind: "triage" }];
  for (const key of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[key];
    invalid.push(missing, { ...valid, [key]: null });
  }
  for (const [key, values] of Object.entries({
    repo: ["../work", "a/b/c", "a/..", "a b/c"], item: [0, -1, 1.5, 2 ** 53, "10"],
    kind: ["review", ["triage"]], runner: ["devspace"], brief: [" ", "a".repeat(16_001)],
    pool: [null, "", "tier-1", "UPPER", "-start", "a".repeat(33)], effort: [null, "default"],
    stacks_on: [null, 0, 10, 11], unknown: [true],
  })) for (const value of values) invalid.push({ ...valid, [key]: value });
  for (const [i, plan] of invalid.entries()) it(`refuses invalid plan fields ${i}`, async () => {
    const { fetchImpl, calls } = gitHub({ runs: failed, comments: [comment(2, "jmarrero", fenced(JSON.stringify(plan)), "2026-11-05T11:00:00Z")] });
    await assert.rejects(redispatch(new GitHub(token, fetchImpl), view(), FINISHED), /not an agent-board\/job-plan\/v1 object/);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url !== `${API}/graphql`).length, 0);
  });

  it("accepts optional pool and effort and a Unicode brief at the character limit", async () => {
    const { fetchImpl } = gitHub({ runs: failed, comments: [comment(2, "jmarrero", fenced(JSON.stringify({ ...valid, pool: "openai", effort: "heavy", brief: "😀".repeat(16_000) })), "2026-11-05T11:00:00Z")] });
    await redispatch(new GitHub(token, fetchImpl), view(), FINISHED);
  });
});

describe("Live agents actions", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  it("freezes runtime at observation when the deadline passes without a repaint", () => {
    const v = view();
    const observed = Date.parse(v.observed_at);
    const el = activePassView(v, observed);
    const label = el.querySelector<HTMLElement>(".age[data-age-expires]")!;
    assert.ok(label);
    tickAges(el, observed + 3_599_000);
    assert.doesNotMatch(label.textContent!, /at observation/);
    tickAges(el, observed + 3_601_000);
    const frozen = label.textContent;
    assert.match(frozen!, /m at observation/);
    assert.equal(label.hasAttribute("data-since"), false);
    tickAges(el, observed + 7_200_000);
    assert.equal(label.textContent, frozen);
  });
  function hooks(confirmed = true) {
    const sent: string[] = [];
    let settle: (v: string) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const act = (name: string) => (r: AgentRun) => { sent.push(`${name} ${r.run.id}`); return new Promise<string>((res, rej) => { settle = res; fail = rej; }); };
    const actions: AgentActions = { cancel: act("cancel"), retry: act("retry"), redispatch: act("redispatch"), confirm: () => confirmed };
    return { actions, sent, settle: (v: string) => settle(v), fail: (e: Error) => fail(e) };
  }
  const buttons = (el: Element) => [...el.querySelectorAll("button")].map((b) => `${b.textContent} ${b.closest("li")?.querySelector("a[href*='/actions/runs/']")?.textContent}`);

  it("offers Cancel on running rows and Retry and Redispatch on finished starts, only with actions", () => {
    assert.equal(activePassView(view(), now).querySelector("button"), null);
    const el = activePassView(view(), now, undefined, hooks().actions);
    assert.deepEqual(buttons(el), ["Cancel run 42", "Retry run 40", "Redispatch run 40"]);
    assert.match(el.textContent!, /Recently started, not listed running.*example\/work#10 · triage · openai/);
  });

  it("asks first, sends once, and keeps a sent action across redraws", async () => {
    const declined = hooks(false);
    const first = activePassView(view(), now, undefined, declined.actions);
    document.body.replaceChildren(first);
    first.querySelector("button")!.click();
    assert.deepEqual(declined.sent, []);
    const h = hooks();
    const el = activePassView(view(), now, undefined, h.actions);
    document.body.replaceChildren(el);
    const cancel = el.querySelector("button")!;
    cancel.click();
    cancel.click();
    assert.deepEqual(h.sent, ["cancel 42"]);
    assert.equal(cancel.disabled, true);
    const redrawn = activePassView(view(), now, undefined, h.actions);
    document.body.replaceChildren(redrawn);
    h.settle("https://github.com/example/runner/actions/runs/42");
    await new Promise((r) => setTimeout(r));
    const again = redrawn.querySelector("button")!;
    assert.equal(again.disabled, true);
    assert.match(again.parentElement!.textContent!, /Sent: https:\/\/github.com\/example\/runner\/actions\/runs\/42/);
  });

  it("offers a refused action again but keeps an uncertain one off", async () => {
    const h = hooks();
    const el = activePassView(view(), now, undefined, h.actions);
    document.body.replaceChildren(el);
    const [, retry, redispatchButton] = [...el.querySelectorAll("button")];
    retry!.click();
    h.fail(new Error("not rerunning: the run ended success"));
    await new Promise((r) => setTimeout(r));
    assert.equal(retry!.disabled, false);
    assert.match(retry!.parentElement!.textContent!, /Not sent: not rerunning: the run ended success/);
    redispatchButton!.click();
    h.fail(Object.assign(new Error("may or may not have gone out"), { name: "MaybeSentError" }));
    await new Promise((r) => setTimeout(r));
    assert.equal(redispatchButton!.disabled, true);
    assert.match(redispatchButton!.parentElement!.textContent!, /Uncertain: may or may not/);
    // The same run: a retry now could start a second job.
    assert.equal(retry!.disabled, true);
    assert.equal(retry!.parentElement!.textContent, "Retry");
  });
});
