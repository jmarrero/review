import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { onlyRepository, parseService, parseServiceState, repositorySection } from "../src/github/service.ts";
import { serviceBoardView, serviceRepositories } from "../src/github/serviceboard.ts";
import { run } from "../src/cli/controlplane.ts";
import { fixture } from "./helpers.ts";

// Rust state::tests checks this serialization against recorded GitHub answers;
// the decision is the pinned producer fixture. Failures below are mutations.
const replay = () => JSON.parse(readFileSync("service/fixtures/state.json", "utf8"));
const producer = () => fixture<{ decision: unknown }>("service-decision-producer.json");
const combined = () => ({ ...replay(), decision: producer().decision });
const NOW = Date.parse("2026-11-07T12:00:00Z");

function dom() {
  const d = new JSDOM();
  Object.assign(globalThis, { document: d.window.document, Event: d.window.Event });
  return d;
}

const BAD_PRS: Record<string, unknown>[] = [
  { number: 0 }, { number: 1.5 }, { url: "https://github.com/bootc-dev/bootc/issues/1201" }, { url: "javascript:alert(1)" },
  { repository: "bootc-dev/../x" }, { repository: "no-slash" }, { title: "x".repeat(4097) }, { title: null },
  { draft: "no" }, { mergeState: "merged" }, { mergeState: "" }, { updatedAt: "yesterday" },
];

const BAD_WAITING: Record<string, unknown>[] = [
  { reasons: [] }, { reasons: ["mentioned"] }, { reasons: ["assigned", "assigned"] }, { reasons: "assigned" },
  { pullRequest: true }, { pullRequest: "no" }, { number: -1 }, { updatedAt: null },
];

describe("service PRs and waiting sections", () => {
  it("keep each section's items, complete, error and original readAt", () => {
    const raw = replay();
    const state = parseServiceState(raw);
    assert.deepEqual(state.prs, raw.prs);
    assert.deepEqual(state.waiting, raw.waiting);
    assert.equal(state.waiting!.complete, false);
    assert.match(state.waiting!.error!, /read 2 of 3 items/);
    assert.equal(state.prsError, undefined);
    assert.equal(state.waitingError, undefined);
  });

  it("accept a null merge state, an issue URL for issues and both reasons", () => {
    const raw = replay();
    raw.prs.items[0].mergeState = null;
    const state = parseServiceState(raw);
    assert.equal(state.prs!.items[0]!.mergeState, null);
    assert.deepEqual(state.waiting!.items.map((w) => w.reasons), [["assigned"], ["review-requested", "assigned"]]);
  });

  for (const [name, list, bad] of [["prs", BAD_PRS, "prsError"], ["waiting", BAD_WAITING, "waitingError"]] as const) {
    it(`a malformed ${name} section hides neither runs, the other list nor the decision`, () => {
      const sectionChanges = [{ items: null }, { complete: "yes" }, { readAt: "bad" }, { error: "x".repeat(16385) }, { items: Array(1001).fill(combined()[name].items[0]) }];
      const cases = [
        ...list.map((change) => { const raw = combined(); raw[name].items[0] = { ...raw[name].items[0], ...change }; return raw; }),
        ...sectionChanges.map((change) => { const raw = combined(); Object.assign(raw[name], change); return raw; }),
        (() => { const raw = combined(); raw[name].items[1] = null; return raw; })(),
        { ...combined(), [name]: undefined },
      ];
      for (const raw of cases) {
        const state = parseServiceState(raw);
        assert.equal(state[name], undefined, JSON.stringify(raw[name])?.slice(0, 200));
        assert.match(state[bad]!, /unavailable or malformed/);
        assert.deepEqual(state.runs, replay().runs);
        const other = name === "prs" ? "waiting" : "prs";
        assert.deepEqual(state[other], replay()[other]);
        assert.deepEqual(state.decision, parseService({ ...producer(), schema: "review-service/v1", generation: 1 }));
      }
    });
  }

  it("narrows to one repository case-insensitively, keeping section-wide health", () => {
    const state = parseServiceState(replay());
    const waiting = onlyRepository(state.waiting!, "BOOTC-DEV/BOOTC");
    assert.deepEqual(waiting.items.map((w) => w.number), [1188]);
    assert.equal(waiting.complete, false);
    assert.equal(waiting.error, state.waiting!.error);
    assert.equal(waiting.readAt, state.waiting!.readAt);
    assert.deepEqual(serviceRepositories(state), ["bootc-dev/bootc", "bootc-dev/jmarrero-devspace-sandbox", "jmarrero-forge/bootc", "jmarrero-forge/tracker"]);
  });
});

describe("service board view", () => {
  it("renders read-only lists with read time, clock, completeness and error", () => {
    const d = dom();
    const el = serviceBoardView(parseServiceState(replay()), NOW, undefined, undefined, () => {});
    const text = el.textContent!;
    assert.match(text, /Bot PRs 2/);
    assert.match(text, /bootc-dev\/bootc#1201 — install: Handle a missing ESP/);
    assert.match(text, /Draft · Merge state: draft/);
    assert.match(text, /Waiting on you 2/);
    assert.match(text, /PR · review-requested, assigned/);
    assert.match(text, /Read: 2026-11-07T12:00:00Z · Current · Incomplete/);
    assert.match(text, /Source error: GET \/search\/issues/);
    assert.equal(el.querySelectorAll("button").length, 0);
    assert.ok([...el.querySelectorAll("a")].every((a) => a.getAttribute("href")!.startsWith("https://github.com/")));
    d.window.close();
  });

  it("filters runs, PRs and waiting to one repository without a request", () => {
    const d = dom();
    const chosen: (string | undefined)[] = [];
    const state = parseServiceState(replay());
    const all = serviceBoardView(state, NOW, undefined, undefined, (r) => chosen.push(r));
    const select = all.querySelector("select")!;
    select.value = "bootc-dev/bootc";
    select.dispatchEvent(new d.window.Event("change"));
    select.value = "";
    select.dispatchEvent(new d.window.Event("change"));
    assert.deepEqual(chosen, ["bootc-dev/bootc", undefined]);
    const one = serviceBoardView(state, NOW, undefined, "bootc-dev/bootc", () => {});
    const text = one.textContent!;
    assert.match(text, /Service runs 0/);
    assert.match(text, /Bot PRs 1/);
    assert.match(text, /Waiting on you 1/);
    assert.ok(!text.includes("jmarrero-forge/tracker#1500"));
    assert.match(text, /still describe the whole section/);
    // Runs are complete and current, so this repository has none; waiting is incomplete.
    assert.match(text, /No items reported\./);
    assert.equal(one.querySelector("select")!.value, "bootc-dev/bootc");
    // A chosen repository with no items left stays chosen and visibly filtered.
    const gone = serviceBoardView(state, NOW, undefined, "example/gone", () => {});
    assert.equal(gone.querySelector("select")!.value, "example/gone");
    assert.match(gone.textContent!, /Waiting on you 0Read: .*No items available; coverage is unknown\.$/);
    d.window.close();
  });

  it("never shows failed, unread, partial, stale, future or disconnected sections as healthy empty lists", () => {
    const d = dom();
    const empty = (change: Record<string, unknown>) => { const raw = replay(); Object.assign(raw.prs, { items: [], ...change }); return parseServiceState(raw); };
    assert.match(serviceBoardView(empty({}), NOW, undefined, undefined, () => {}).textContent!, /Bot PRs 0Read: \S+ · Current · CompleteNo items reported\./);
    const cases: [ReturnType<typeof parseServiceState> | undefined, string | undefined, RegExp][] = [
      [undefined, undefined, /Not yet read; coverage is unknown/],
      [parseServiceState({ ...replay(), prs: { items: [null] } }), undefined, /Service PRs unavailable or malformed; coverage is unknown/],
      [empty({ complete: false }), undefined, /Incomplete/],
      [empty({ error: "rate limited" }), undefined, /Source error: rate limited/],
      [empty({ readAt: null }), undefined, /Read: never · Unavailable/],
      [empty({ readAt: "2026-11-07T10:00:00Z" }), undefined, /Stale/],
      [empty({ readAt: "2026-11-07T13:00:00Z" }), undefined, /Future clock/],
      [empty({}), "Service stream unavailable; waiting for full resync", /coverage is unknown/],
    ];
    for (const [state, error, why] of cases) {
      const board = serviceBoardView(state, NOW, error, undefined, () => {});
      const prs = [...board.querySelectorAll("section section")][1]!.textContent!;
      assert.match(prs, why);
      assert.ok(!prs.includes("No items reported."), prs);
      if (error) assert.match(board.textContent!, /Incomplete: Service stream unavailable/);
    }
    d.window.close();
  });
});

describe("control-app repo from a service", () => {
  async function repo(state: unknown, name = "bootc-dev/BOOTC") {
    let out = "", err = "";
    const code = await run(["repo", name], {
      serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
      fetch: async (url) => { assert.equal(url, "https://control.example/api/v1/state"); return Response.json(state); },
      stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: () => new Date(NOW), isTty: false,
    });
    assert.equal(code, 0, err);
    return JSON.parse(out);
  }

  it("reports the repository's PRs and waiting items with section-wide coverage, without a decision", async () => {
    const body = await repo(replay());
    assert.equal(body.source, "service");
    assert.match(body.unavailable, /decision unavailable/);
    assert.equal(body.work, null);
    assert.equal(body.complete, false);
    assert.deepEqual(body.prs.items.map((p: { number: number }) => p.number), [1201]);
    assert.equal(body.prs.clock, "Current");
    assert.doesNotMatch(body.prs.note, /may be missing/);
    assert.deepEqual(body.waiting.items.map((w: { number: number }) => w.number), [1188]);
    assert.equal(body.waiting.complete, false);
    assert.match(body.waiting.note, /may be missing.*whole section/);
  });

  it("is complete only when the decision and both lists are", async () => {
    // Shift the producer decision's clocks to the state fixture's, as the browser replay does.
    const decision = JSON.parse(JSON.stringify(producer().decision).replaceAll("2026-11-09T12:00:00Z", "2026-11-07T12:00:00Z"));
    const raw = { ...replay(), decision };
    const partial = await repo(raw, "example/work");
    assert.equal(partial.unavailable, null);
    assert.equal(partial.complete, false); // waiting is incomplete
    // The recorded decision is itself partial; mark all three whole to see the flag rise.
    Object.assign(raw.waiting, { complete: true, error: null });
    assert.equal((await repo(raw, "example/work")).complete, false);
    decision.complete = decision.items[0].complete = true;
    assert.equal((await repo(raw, "example/work")).complete, true);
  });

  it("keeps a malformed section unknown beside the others", async () => {
    const raw = replay();
    raw.prs.items[0].mergeState = "merged";
    const body = await repo(raw);
    assert.equal(body.prs.items, null);
    assert.equal(body.complete, false);
    assert.match(body.prs.note, /Service PRs unavailable or malformed; coverage is unknown/);
    assert.equal(body.waiting.items.length, 1);
    assert.deepEqual(repositorySection(undefined, undefined, "a/b", NOW).items, null);
  });
});
