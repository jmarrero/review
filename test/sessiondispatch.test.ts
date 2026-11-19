import assert from "node:assert/strict";
import { it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { CHAT_CONFIG, parseChatConfig, type SessionDispatchConfig } from "../src/github/chatconfig.ts";
import { dispatchInputs, sessionDispatchPanel, startRepositorySession } from "../src/github/sessiondispatch.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

const config: SessionDispatchConfig = { repo: "public/caller", workflow: "dispatch.yml", ref: "main", issue: 536, runner: "devspace" };

function api(options: { login?: string; private?: boolean; status?: number; id?: unknown; runStatus?: string } = {}) {
  const { calls, fetchImpl } = scriptedFetch((method, url) => {
    if (url.endsWith("/user")) return { body: { login: options.login ?? "jmarrero" } };
    if (method === "GET" && /\/repos\/public\/(caller|target)$/.test(url)) return { body: { private: options.private ?? false } };
    if (method === "POST" && url.endsWith("/dispatches")) return { status: options.status ?? 200, body: { workflow_run_id: options.id ?? 123 } };
    if (url.endsWith("/actions/runs/123")) return { body: { status: options.runStatus ?? "completed", conclusion: options.runStatus ? null : "success" } };
    return undefined;
  });
  return { gh: new GitHub(async () => "fixture-token", fetchImpl), calls };
}

it("dispatch mode is off by default and validates its closed caller settings", () => {
  // Chat is off in jmarrero's deployment; the settings are checked against a valid chat configuration.
  assert.equal(CHAT_CONFIG?.dispatch ?? null, null);
  const chat = CHAT_CONFIG ?? { tailnetDomain: "example.ts.net", sources: [{ repo: "owner/repo", workflow: "session.yml", issue: 1, publisher: "publisher" }] };
  assert.deepEqual(parseChatConfig({ ...chat, dispatch: config })?.dispatch, config);
  for (const patch of [{ runner: "[self-hosted]" }, { runner: "../secret" }, { repo: "../caller" }, { issue: 0 }, { ref: "" }]) {
    assert.throws(() => parseChatConfig({ ...chat, dispatch: { ...config, ...patch } }));
  }
});

it("uses #3320 inputs and an explicit anchor for repository-only sessions", () => {
  const inputs = dispatchInputs(config, "public/target", "42");
  assert.deepEqual(inputs, {
    repo: "public/target", item: "42", kind: "research", session: "true", runner: "devspace", "idle-minutes": "10",
    task: "The operator opens an interactive session. Wait for the operator's questions. Do not make changes or post a report before the operator asks.",
  });
  assert.equal(dispatchInputs(config, "public/target", "")["item-repo"], config.repo);
  assert.equal(dispatchInputs(config, "public/target", "").item, "536");
  assert.equal(dispatchInputs(config, config.repo, "")["item-repo"], undefined);
  for (const [repo, item] of [["../bad", "1"], ["public/target", "0"], ["public/target", "1\nreview"]]) {
    assert.throws(() => dispatchInputs(config, repo!, item!));
  }
});

it("dispatches once with the viewer's token and returns only the returned run ID", async () => {
  const { gh, calls } = api();
  let attempted = false;
  assert.equal(await startRepositorySession(gh, config, "public/target", "42", () => { attempted = true; }), 123);
  assert.equal(attempted, true);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.headers.Authorization, "Bearer fixture-token");
  assert.deepEqual(posts[0]!.body, { ref: "main", inputs: dispatchInputs(config, "public/target", "42"), return_run_details: true });
  assert.equal(await startRepositorySession(api({ status: 204 }).gh, config, "public/target", "42", () => {}), undefined);
  assert.equal(await startRepositorySession(api({ id: -1 }).gh, config, "public/target", "42", () => {}), undefined);
});

it("refuses non-operators and private targets without attempting a write", async () => {
  for (const options of [{ login: "someone" }, { private: true }]) {
    const { gh, calls } = api(options);
    await assert.rejects(startRepositorySession(gh, config, "public/target", "42", () => assert.fail("attempted")));
    assert.equal(calls.some((c) => c.method === "POST"), false);
  }
});

async function panel(options: Parameters<typeof api>[0] = {}) {
  const win = installDom();
  win.confirm = () => true;
  const { gh, calls } = api(options);
  const p = sessionDispatchPanel(gh, config, 1);
  const slot = win.document.createElement("div");
  win.document.body.append(slot);
  p.mount(slot);
  p.open({ ref: "public/target#42", title: "Untrusted title" });
  const submit = () => slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  return { p, slot, calls, submit, win };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

it("bounds starting-run checks and stops checking on disposal", async () => {
  const { p, calls, submit, slot } = await panel({ runStatus: "queued" });
  submit();
  const deadline = Date.now() + 3_000;
  while (!slot.textContent!.includes("Automatic status checks stopped")) {
    assert.ok(Date.now() < deadline, "status checks should stop at their bound");
    await settle();
  }
  assert.equal(calls.filter((c) => c.url.endsWith("/actions/runs/123")).length, 24);
  p.dispose();
  const next = await panel({ runStatus: "queued" });
  next.submit(); await settle();
  next.p.dispose();
  const count = next.calls.length;
  await settle();
  assert.equal(next.calls.length, count);
});

it("disposal during preflight prevents a late dispatch", async () => {
  const win = installDom();
  win.confirm = () => true;
  let release!: (value: Response) => void;
  const requests: string[] = [];
  const gh = new GitHub(async () => "fixture-token", async (url) => {
    requests.push(url);
    if (url.endsWith("/user")) return new Promise<Response>((resolve) => { release = resolve; });
    return new Response(JSON.stringify({ private: false }));
  });
  const p = sessionDispatchPanel(gh, config);
  const slot = win.document.createElement("div");
  p.mount(slot); p.open({ ref: "public/target#42", title: "Item" });
  slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await settle();
  p.dispose(); release(new Response(JSON.stringify({ login: "jmarrero" })));
  await settle();
  assert.equal(requests.some((url) => url.endsWith("/dispatches")), false);
});

it("prefills item context, confirms, shows the starting run and checks that ID", async () => {
  const { p, slot, calls, submit } = await panel();
  assert.equal(calls.length, 0);
  assert.equal(slot.querySelector<HTMLInputElement>("input")!.value, "public/target");
  submit(); submit();
  await settle();
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.match(slot.textContent!, /Run 123: completed · success/);
  assert.equal(slot.querySelector("a")!.href, "https://github.com/public/caller/actions/runs/123");
  assert.equal(calls.some((c) => c.url.includes("/workflows/dispatch.yml/runs")), false);
  p.dispose();
});

it("waits for attach while the run is in progress, until an attach hook connects", async () => {
  const waiting = await panel({ runStatus: "in_progress" });
  waiting.submit(); await settle();
  assert.match(waiting.slot.textContent!, /Run 123: in_progress\. Waiting for attach\./);
  assert.doesNotMatch(waiting.slot.textContent!, /Chat connection is not available yet/);
  waiting.p.dispose();

  const win = installDom();
  win.confirm = () => true;
  const { gh, calls } = api({ runStatus: "in_progress" });
  const attached: number[] = [];
  const p = sessionDispatchPanel(gh, config, 1, async (id) => { attached.push(id); return true; });
  const slot = win.document.createElement("div");
  p.mount(slot); p.open({ ref: "public/target#42", title: "Item" });
  slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await settle();
  assert.match(slot.textContent!, /Attached\./);
  assert.deepEqual(attached, [123]);
  assert.equal(calls.filter((c) => c.url.endsWith("/actions/runs/123")).length, 1, "no more checks once attached");
  p.dispose();
});

it("does not guess a run on 204 or retry an uncertain dispatch after reopening", async () => {
  for (const status of [204, 500]) {
    const { p, slot, calls, submit } = await panel({ status });
    submit(); await settle();
    p.open({ ref: "public/other#1", title: "Other" });
    submit(); await settle();
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(calls.some((c) => c.url.includes("/actions/runs/")), false);
    assert.match(slot.textContent!, status === 204 ? /no run ID/ : /uncertain/);
    p.dispose();
  }
});

it("confirmation cancellation sends nothing; rejected dispatch can be corrected", async () => {
  const { p, calls, submit, win, slot } = await panel({ status: 403 });
  win.confirm = () => false;
  submit(); await settle();
  assert.equal(calls.length, 0);
  win.confirm = () => true;
  submit(); await settle();
  assert.match(slot.textContent!, /Session not dispatched/);
  assert.equal(slot.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled, false);
  p.dispose();
});
