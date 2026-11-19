import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { ACTIVE_SWEEP, MAX_RECENT_PAGES, checkPass, dispatchPass, passRefusal, runPassControl, type PassControl, type PassFacts } from "../src/github/runpass.ts";
import type { PassView } from "../src/github/passview.ts";
import { activePassView } from "../src/github/passview.ts";
import { fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();
const root = "/repos/jmarrero-forge/tracker";
const workflow = `${root}/actions/workflows/poll.yml`;
function facts(): PassFacts {
  const data = fixture<{ pass_view: PassView }>("pass-view.json").pass_view;
  data.observed_at = new Date().toISOString();
  data.complete = true; data.omitted = 0;
  data.pools[0]!.resets_at = new Date(Date.now() + 3_600_000).toISOString();
  return { data, login: "jmarrero" };
}
function api(over: (method: string, path: string) => ReturnType<Parameters<typeof scriptedFetch>[0]> = () => undefined) {
  const mock = scriptedFetch((method, url) => {
    const u = new URL(url); const path = u.pathname + u.search;
    const replacement = over(method, path);
    if (replacement) return replacement;
    if (path === "/user") return { body: { login: "jmarrero" } };
    if (path === root) return { body: { default_branch: "main", permissions: { push: true } } };
    if (path.startsWith(`${workflow}/runs?`)) return { body: { total_count: 0, workflow_runs: [] } };
    if (method === "POST" && path === `${workflow}/dispatches`) return { body: { workflow_run_id: 73 } };
    return undefined;
  });
  return { gh: new GitHub(async () => "fixture", mock.fetchImpl), calls: mock.calls };
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("manual applying pass", () => {
  it("requires fresh complete under-pace evidence and an operator", () => {
    const good = facts();
    assert.equal(passRefusal(good), undefined);
    for (const f of [{ ...good, login: "other" }, { ...good, unavailable: "offline" }, { ...good, data: undefined }, { ...good, data: "malformed" }]) assert.ok(passRefusal(f));
    const d = good.data as PassView;
    for (const mutation of [() => { d.complete = false; }, () => { d.complete = true; d.omitted = 1; }, () => { d.omitted = 0; d.observed_at = "2020-01-01T00:00:00Z"; }, () => { d.observed_at = new Date().toISOString(); d.pools.forEach((p) => { p.under_pace = null; }); }]) {
      mutation(); assert.ok(passRefusal(good));
    }
  });

  it("rechecks identity, write access and pass activity, then dispatches exactly once", async () => {
    const { gh, calls } = api();
    assert.equal(await dispatchPass(gh, facts), 73);
    assert.equal(calls.length, 3 + ACTIVE_SWEEP.length + 1);
    assert.deepEqual(calls.at(-1)!.body, { ref: "main", inputs: { apply: "true" }, return_run_details: true });
    assert.equal(calls.at(-1)!.url, `https://api.github.com${workflow}/dispatches`);
    assert.equal(calls.at(-1)!.method, "POST");
  });

  it("refuses running, queued, waiting, pending and requested passes, malformed or denied reads", async () => {
    for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const { gh, calls } = api((_m, path) => path.includes(`/runs?status=${status}&`) ? { body: { total_count: 1, workflow_runs: [{ id: 12, status }] } } : undefined);
      await assert.rejects(dispatchPass(gh, facts), /A pass is/);
      assert.equal(calls.some((c) => c.method === "POST"), false);
    }
    for (const response of [{ body: {} }, { status: 403 }, { status: 404 }]) {
      const { gh, calls } = api((_m, path) => path.includes("/runs?") ? response : undefined);
      await assert.rejects(checkPass(gh));
      assert.equal(calls.some((c) => c.method === "POST"), false);
    }
  });

  it("cannot lose a run that changes status between bucket reads", async () => {
    const active = ["requested", "pending", "waiting", "queued", "in_progress"];
    // Every move into a started status, at every point in the sweep. The run
    // is older than the rerun window, so only the buckets see it.
    for (const from of active) for (const to of active.filter((s) => s !== from && !["requested", "pending"].includes(s))) {
      for (let at = 0; at <= ACTIVE_SWEEP.length; at++) {
        let reads = 0;
        const { gh, calls } = api((_m, path) => {
          if (!path.includes("/runs?")) return undefined;
          const status = new URL(path, "https://api.github.com").searchParams.get("status");
          if (!status) return { body: { total_count: 500, workflow_runs: Array.from({ length: 100 }, () => ({ status: "completed", created_at: "2020-01-01T00:00:00Z" })) } };
          const now = reads++ < at ? from : to;
          return { body: status === now ? { total_count: 1, workflow_runs: [{ id: 12, status }] } : { total_count: 0, workflow_runs: [] } };
        });
        await assert.rejects(dispatchPass(gh, facts), /A pass is active/, `${from} → ${to} before read ${at}`);
        assert.equal(calls.some((c) => c.method === "POST"), false);
      }
    }
  });

  // Newest first, one run every ten minutes, like tracker's schedule.
  function history(length: number, status = (_i: number) => "completed") {
    return Array.from({ length }, (_, i) => ({ id: length - i, status: status(i), created_at: new Date(Date.now() - i * 600_000).toISOString() }));
  }
  // Status buckets that lag: they see only completed runs.
  function listing(runs: ReturnType<typeof history>) {
    return api((_m, path) => {
      if (!path.includes("/runs?")) return undefined;
      const params = new URL(path, "https://api.github.com").searchParams;
      if (params.get("status")) return { body: { total_count: 0, workflow_runs: [] } };
      const per = Number(params.get("per_page")); const page = Number(params.get("page"));
      return { body: { total_count: runs.length, workflow_runs: runs.slice((page - 1) * per, page * per) } };
    });
  }

  it("dispatches when idle however long completed history is", async () => {
    const { gh, calls } = listing(history(20_000));
    assert.equal(await dispatchPass(gh, facts), 73);
    // 31 days of ten-minute runs is 4,464, so 45 pages; none further back.
    assert.equal(calls.filter((c) => c.url.includes("/runs?")).length, ACTIVE_SWEEP.length + 45);
  });

  for (const page of [1, 2]) for (const length of [0, 1, 99]) {
    it(`refuses a truncated recent page ${page} with ${length} runs without dispatching`, async () => {
      const { gh, calls } = api((_m, path) => {
        if (!path.includes("/runs?per_page=")) return undefined;
        const current = Number(new URL(path, "https://api.github.com").searchParams.get("page"));
        return { body: { total_count: 200, workflow_runs: history(current === page ? length : 100) } };
      });
      await assert.rejects(dispatchPass(gh, facts), /Pass activity incomplete/);
      assert.equal(calls.some((c) => c.method === "POST"), false);
      assert.equal(calls.filter((c) => c.url.includes("/runs?")).length, ACTIVE_SWEEP.length + page);
    });
  }

  for (const length of [0, 1, 100, 101, 199]) {
    it(`dispatches after a complete recent history of ${length} runs`, async () => {
      const { gh, calls } = listing(history(length));
      assert.equal(await dispatchPass(gh, facts), 73);
      assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    });
  }

  it("refuses an old rerun behind more than 100 newer runs while the status index lags", async () => {
    for (const at of [150, 4000]) {
      const { gh, calls } = listing(history(20_000, (i) => i === at ? "queued" : "completed"));
      await assert.rejects(dispatchPass(gh, facts), /A pass is active \(queued\)/, `rerun at ${at}`);
      assert.equal(calls.some((c) => c.method === "POST"), false);
    }
  });

  it("refuses rather than read past the page bound inside the rerun window", async () => {
    const runs = history(MAX_RECENT_PAGES * 100 + 1).map((r) => ({ ...r, created_at: new Date().toISOString() }));
    const { gh, calls } = listing(runs);
    await assert.rejects(dispatchPass(gh, facts), /cannot exclude an active rerun/);
    assert.equal(calls.some((c) => c.method === "POST"), false);
  });

  it("refuses a recent run the status index has not caught up with", async () => {
    const { gh, calls } = api((_m, path) => path === `${workflow}/runs?per_page=100&page=1`
      ? { body: { total_count: 2, workflow_runs: [{ id: 13, status: "queued" }, { id: 12, status: "completed" }] } } : undefined);
    await assert.rejects(dispatchPass(gh, facts), /A pass is active \(queued\)/);
    assert.equal(calls.some((c) => c.method === "POST"), false);
  });

  it("refuses wrong viewer, missing write permission and evidence expiring during checks", async () => {
    for (const [path, body] of [["/user", { login: "other" }], [root, { default_branch: "main", permissions: { push: false } }]] as const) {
      const { gh, calls } = api((_m, p) => p === path ? { body } : undefined);
      await assert.rejects(dispatchPass(gh, facts));
      assert.equal(calls.some((c) => c.method === "POST"), false);
    }
    const current = facts();
    const { gh, calls } = api((_m, path) => { if (path.includes("/runs?")) current.unavailable = "offline"; return undefined; });
    await assert.rejects(dispatchPass(gh, () => current), /unknown/);
    assert.equal(calls.some((c) => c.method === "POST"), false);
  });

  it("is off until checked and confirmed, preserves the receipt and prevents double dispatch", async () => {
    const { gh, calls } = api(); const state: PassControl = {};
    let confirmed = false;
    const el = runPassControl(gh, facts, state, () => confirmed);
    const [check, run] = el.querySelectorAll("button");
    assert.equal(calls.length, 0); assert.equal(run!.disabled, true);
    check!.click(); await settle(); assert.equal(run!.disabled, false);
    run!.click(); await settle(); assert.equal(calls.length, ACTIVE_SWEEP.length + 1);
    confirmed = true; run!.click(); run!.click(); await settle();
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
    assert.equal(run!.disabled, true);
    assert.equal(runPassControl(gh, facts, state).querySelector("a")!.href, "https://github.com/jmarrero-forge/tracker/actions/runs/73");
  });

  it("updates the mounted view when availability and dispatch finish across snapshot replacement", async () => {
    const { gh } = api(); const state: PassControl = {};
    const original = runPassControl(gh, facts, state, () => true);
    original.querySelectorAll("button")[0]!.click();
    const replaced = runPassControl(gh, facts, state, () => true);
    await settle();
    assert.match(replaced.textContent!, /No active pass found/);
    assert.equal(replaced.querySelectorAll("button")[1]!.disabled, false);
    replaced.querySelectorAll("button")[1]!.click();
    const again = runPassControl(gh, facts, state, () => true);
    await settle();
    assert.match(again.textContent!, /Applying pass requested/);
    assert.equal(again.querySelector("a")!.href, "https://github.com/jmarrero-forge/tracker/actions/runs/73");
  });

  it("keeps successful and uncertain receipts visible after an absent or malformed publication", () => {
    const { gh } = api();
    for (const message of ["Applying pass requested.", "Dispatch outcome may be uncertain."]) {
      for (const data of [undefined, "Pass view malformed"]) {
        const state: PassControl = { sent: true, runId: 73, message };
        const control = runPassControl(gh, () => ({ ...facts(), data }), state);
        const home = activePassView(data, Date.now(), undefined, undefined, control);
        assert.ok(home.textContent!.includes(message));
        assert.equal(home.querySelectorAll("button")[1]!.disabled, true);
        assert.ok(home.querySelector("a[href$='/actions/runs/73']"));
      }
    }
  });

  it("never retries an uncertain write or a successful 204 with no run ID", async () => {
    for (const status of [204, 500, 422]) {
      const { gh, calls } = api((m) => m === "POST" ? { status } : undefined);
      const state: PassControl = {};
      const el = runPassControl(gh, facts, state, () => true);
      const [check, run] = el.querySelectorAll("button");
      check!.click(); await settle(); run!.click(); await settle(); run!.click(); await settle();
      assert.equal(calls.filter((c) => c.method === "POST").length, 1);
      assert.equal(state.sent, true);
      assert.match(el.textContent!, status === 204 ? /returned no run ID/ : /uncertain/);
    }
  });
});
