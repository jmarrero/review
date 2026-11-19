import assert from "node:assert/strict";
import { it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { type ItemDispatchState, itemDispatchControl, MAX_RECORD_CHECKS, recordedRun } from "../src/github/itemdispatch.ts";
import type { PassView } from "../src/github/passview.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

const ITEM = "jmarrero-forge/tracker#5";
const ISSUE = "https://api.github.com/repos/jmarrero-forge/tracker/issues/5";
const PLAN = "https://github.com/jmarrero-forge/tracker/issues/5#issuecomment-77";
const RUN = "https://github.com/jmarrero-forge/runner/actions/runs/40";
const POSTED = "2026-11-12T10:00:00Z";
const record = (login: string, at: string, body = `<!-- agent-board-dispatch: 5@${at} -->\nDispatched [run](${RUN}).`) => ({ user: { login }, created_at: at, body });

interface Api { login?: string; state?: string; post?: number; records?: unknown[] }

function api(o: Api = {}) {
  const { fetchImpl, calls } = scriptedFetch((method, url) => {
    if (url.endsWith("/user")) return { body: { login: o.login ?? "jmarrero" } };
    if (method === "GET" && url === ISSUE) return { body: { state: o.state ?? "open", html_url: "https://github.com/jmarrero-forge/tracker/issues/5" } };
    if (method === "POST" && url === `${ISSUE}/comments`) return { status: o.post ?? 201, body: o.post ? { message: "Refused" } : { html_url: PLAN } };
    if (url.endsWith("/issues/comments/77")) return { body: { created_at: POSTED } };
    if (url.startsWith(`${ISSUE}/comments?since=`)) return { body: o.records ?? [] };
    return undefined;
  });
  return { gh: new GitHub(async () => "fixture-token", fetchImpl), calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function mount(o: Api & { view?: PassView; confirm?: boolean } = {}) {
  const win = installDom();
  const { gh, calls } = api(o);
  const state: ItemDispatchState = {};
  let el = itemDispatchControl(gh, ITEM, () => o.view, state, () => o.confirm ?? true, 1);
  win.document.body.append(el);
  // A re-render replaces the form; state carries the plan and the draft.
  const rerender = () => { const next = itemDispatchControl(gh, ITEM, () => o.view, state, () => true, 1); el.replaceWith(next); el = next; };
  const submit = (brief = "Look into it") => {
    const text = el.querySelector("textarea")!;
    text.value = brief; text.dispatchEvent(new win.Event("input"));
    el.dispatchEvent(new win.Event("submit", { cancelable: true }));
  };
  return { gh, calls, state, submit, rerender, el: () => el, posts: () => calls.filter((c) => c.method === "POST") };
}

it("recordedRun takes only the pass's dispatch record made since the plan", () => {
  const since = Date.parse(POSTED);
  assert.equal(recordedRun([record("jmarrero-bot", "2026-11-12T09:59:00Z"), record("someone", "2026-11-12T10:05:00Z"), record("jmarrero-bot", "2026-11-12T10:05:00Z", `Dispatched ${RUN}`)], since), undefined);
  assert.equal(recordedRun([record("jmarrero-bot", "2026-11-12T10:05:00Z")], since), RUN);
});

it("asks first, posts the plan, then links the run once the pass records it", async () => {
  const declined = mount({ confirm: false });
  declined.submit(); await settle();
  assert.equal(declined.calls.length, 0);

  const records: unknown[] = [];
  const m = mount({ records });
  m.submit(); m.submit();
  await settle();
  assert.equal(m.posts().length, 1);
  assert.match((m.posts()[0]!.body as { body: string }).body,/"kind": "triage"[\s\S]*"brief": "Look into it"/);
  assert.equal(m.el().querySelector<HTMLAnchorElement>("a")!.href, PLAN);
  assert.match(m.el().textContent!, /not dispatched yet/);
  records.push(record("jmarrero-bot", "2026-11-12T10:10:00Z"));
  m.rerender();
  await settle();
  assert.equal(m.el().querySelectorAll("a")[1]!.getAttribute("href"), RUN);
  assert.match(m.el().textContent!, /Dispatched by the pass\..*Run 40/);
  assert.equal(m.el().querySelector("button")!.disabled, true);
});

it("stops checking for the dispatch record at its bound", async () => {
  const m = mount();
  m.submit();
  const deadline = Date.now() + 3_000;
  while (!m.el().textContent!.includes("Automatic checks stopped")) {
    assert.ok(Date.now() < deadline, "checks should stop");
    await settle();
  }
  assert.equal(m.calls.filter((c) => c.url.includes("/comments?since=")).length, MAX_RECORD_CHECKS);
});

it("a refused dispatch sends nothing more and can be corrected", async () => {
  const running = { in_flight: [{ state: "running", item: ITEM }] } as unknown as PassView;
  for (const [name, o, want] of [
    ["GitHub's 422", { post: 422 }, /Not dispatching jmarrero-forge\/tracker#5: .*HTTP 422: Refused/],
    ["GitHub's 403", { post: 403 }, /Not dispatching jmarrero-forge\/tracker#5: .*HTTP 403.*Issues write access/],
    ["a closed item", { state: "closed" }, /it is closed, not open/],
    ["another viewer", { login: "someone" }, /only jmarrero acts/],
    ["an item the pass view lists running", { view: running }, /lists jmarrero-forge\/tracker#5 running/],
  ] as const) {
    const m = mount(o);
    m.submit();
    await settle();
    assert.equal(m.posts().length, "post" in o ? 1 : 0, name);
    assert.match(m.el().textContent!, want, name);
    assert.equal(m.el().querySelector("button")!.disabled, false, `${name}: can be corrected`);
  }
  const empty = mount();
  empty.submit("  ");
  await settle();
  assert.equal(empty.calls.length, 0);
  assert.match(empty.el().textContent!, /non-empty brief/);
});

it("a read-only session sends nothing", async () => {
  const m = mount();
  m.gh.readOnly = true;
  m.submit();
  await settle();
  assert.equal(m.calls.length, 0);
  assert.match(m.el().textContent!, /Read-only session/);
});

it("a lost response is never retried", async () => {
  const m = mount({ post: 502 });
  m.submit();
  await settle();
  assert.match(m.el().textContent!, /may or may not have gone out/);
  assert.equal(m.el().querySelector("button")!.disabled, true);
});
