import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { parseService, parseServiceState, readService, serviceProblem, watchService } from "../src/github/service.ts";
import { serviceDecisionView } from "../src/github/serviceview.ts";
import { firstPublished, inboxCards } from "../src/github/inbox.ts";
import { actNowRows } from "../src/github/actnow.ts";
import { run } from "../src/cli/controlplane.ts";
import { fixture } from "./helpers.ts";

const NOW = Date.parse("2026-11-13T12:05:00Z");
const snapshot = () => fixture<Record<string, unknown>>("service-decision.json");
const document = (d: unknown = snapshot(), generation = 7) => ({ schema: "review-service/v1", generation, decision: { items: [d], complete: false, readAt: "2026-11-13T12:00:00Z", error: null } });

describe("shared service decisions", () => {
  it("keeps decisions independently available when runs are missing or malformed", () => {
    for (const runs of [undefined, { items: [null], complete: true, readAt: null, error: null }]) {
      const state = parseServiceState({ ...document(), runs });
      assert.deepEqual(state.decision, parseService(document()));
      assert.equal(state.runs, undefined);
      assert.match(state.runsError!, /unavailable/);
    }
  });
  it("preserves producer identities, shortlist order, reasons and unknowns", () => {
    const d = parseService(document());
    const p = firstPublished(d.holds, NOW);
    assert.deepEqual(inboxCards({ published: p }).map((c) => c.key), ["example/work#2", "example/work#1"]);
    assert.deepEqual(actNowRows(p, NOW).map((r) => [r.ask.key, r.unblocks]), [["example/work#2", 1], ["example/work#1", 9]]);
    assert.deepEqual(d.holds.holds.map((h) => h.reason), ["Choose the next step", "Choose a design"]);
    assert.equal(d.candidates, null);
    assert.equal(d.pools[0]!.hold, null);
    assert.equal(d.holds.wip!.inFlight, null);
    assert.equal(d.holds.dispatchableWork && typeof d.holds.dispatchableWork, "object");
    const dom = new JSDOM();
    Object.assign(globalThis, { document: dom.window.document });
    const view = serviceDecisionView(d, NOW);
    assert.match(view.textContent!, /Generation 7 · partial/);
    assert.match(view.textContent!, /Candidates: unknown/);
    assert.match(view.textContent!, /test: missing.*hold unknown/);
    assert.ok(view.textContent!.indexOf("Choose the next step") < view.textContent!.indexOf("Choose a design"));
    dom.window.close();
  });

  // Written by the Rust producer test (service/src/board.rs), not by hand.
  it("replays the producer's own serialization through HTTP, UI and CLI", async () => {
    const replay = fixture<Record<string, unknown>>("service-decision-producer.json");
    const at = Date.parse("2026-11-09T12:05:00Z");
    const d = await readService("https://control.example", async () => Response.json(replay), at);
    const pools = ["bare-endpoint", "bare-host", "test", "token", "url"];
    assert.equal(serviceProblem(d, at), undefined);
    assert.deepEqual(d.pools.map((p) => p.name), pools);
    assert.deepEqual(d.holds.holds.map((h) => [h.kind, h.reason]), [["pools", "test has no current window; new runs wait"]]);
    assert.equal(d.holds.needsYou, undefined);
    assert.equal(d.candidates, null);
    assert.equal(d.complete, false);
    const dom = new JSDOM();
    Object.assign(globalThis, { document: dom.window.document });
    const text = serviceDecisionView(d, at).textContent!;
    assert.match(text, /Generation 1 · partial/);
    assert.match(text, /Candidates: unknown/);
    assert.ok(text.includes("test has no current window; new runs wait"));
    dom.window.close();
    let out = "";
    const code = await run(["status"], {
      serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
      fetch: async () => Response.json(replay), stdout: (s) => { out += s; }, stderr() {}, now: () => new Date(at), isTty: false,
    });
    assert.equal(code, 0);
    const body = JSON.parse(out);
    assert.deepEqual(body.pools.map((p: { name: string }) => p.name), pools);
    assert.deepEqual(body.holds.map((h: { reason: string }) => h.reason), d.holds.holds.map((h) => h.reason));
    assert.equal(body.candidates, null);
  });

  it("rejects missing, unsupported, oversized and malformed sections", () => {
    for (const d of [null, {}, { ...snapshot(), schema: "agent-board/decision/v2" }, { ...snapshot(), holds: [null] }, { ...snapshot(), pools: Array(17).fill({}) }, { ...snapshot(), work: null }]) assert.throws(() => parseService(document(d)));
    assert.throws(() => parseService({ ...document(), decision: { items: [], complete: false, readAt: null, error: "unavailable" } }));
  });

  it("does not freshen old/future evidence or promote partial coverage", () => {
    assert.match(serviceProblem(parseService(document()), NOW + 7_200_000)!, /stale/);
    assert.match(serviceProblem(parseService(document()), NOW - 7_200_000)!, /future/);
    assert.equal(parseService(document()).complete, false);
    const d = parseService(document({ ...snapshot(), needs_you: null }));
    assert.equal(d.holds.needsYou, undefined);
    assert.equal(firstPublished(d.holds, NOW).asks.length, 2);
    const broken = parseService(document({ ...snapshot(), needs_you: { schema: "new-version" } }));
    assert.equal(typeof broken.holds.needsYou, "string");
  });

  it("uses bounded credential-free HTTP without a GitHub token", async () => {
    const d = await readService("https://control.example", async (url, init) => {
      assert.equal(url, "https://control.example/api/v1/state");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.headers, undefined);
      return Response.json(document());
    }, NOW);
    assert.equal(d.generation, 7);
    await assert.rejects(readService("https://control.example", async () => new Response("x".repeat(2 * 1024 * 1024 + 1)), NOW), /size bound/);
    await assert.rejects(readService("https://control.example", async () => { throw new Error("private response"); }, NOW), /^Error: Service decision unavailable$/);
    await assert.rejects(readService("https://user:secret@control.example", async () => { throw new Error("not reached"); }, NOW), /Invalid service URL/);
  });

  it("full resync replaces generations after disconnect/restart, and mismatched ids fail closed", () => {
    let listener: (event: MessageEvent<string>) => void = () => {};
    let closed = false;
    const fake = { addEventListener: (_: string, f: typeof listener) => { listener = f; }, onerror: () => {}, close: () => { closed = true; } };
    const seen: (number | string | undefined)[] = [];
    const stop = watchService((d, error) => seen.push(d?.generation ?? error), () => fake as unknown as EventSource);
    const send = (generation: number, id = String(generation)) => listener({ data: JSON.stringify(document(snapshot(), generation)), lastEventId: id } as MessageEvent<string>);
    send(7);
    fake.onerror();
    send(1); // server restart is a full resync, not an out-of-order delta
    send(2, "1");
    stop();
    assert.deepEqual(seen, [7, "Service stream unavailable; waiting for full resync", 1, "Unsupported or malformed service resync"]);
    assert.equal(closed, true);
  });

  it("keeps a quiet stream through the longest refresh interval, and its clock still expires", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const seen: (string | undefined)[] = [];
    const stop = watchService((_, error) => seen.push(error), () => ({ addEventListener() {}, close() {} }) as unknown as EventSource);
    t.mock.timers.tick(3600_000);
    assert.deepEqual(seen, []);
    stop();
    assert.match(serviceProblem(parseService(document()), NOW + 3600_000)!, /stale/);
  });

  it("service configuration cannot supply credentials or authority to act commands", async () => {
    let requests = 0;
    const code = await run(["cancel", "42", "--dry-run"], {
      serviceUrl: "https://control.example", token: async () => "viewer-token", now: () => new Date(NOW), isTty: false,
      fetch: async (url) => { requests++; assert.ok(url.startsWith("https://api.github.com/")); return Response.json([]); },
      stdout() {}, stderr() {},
    });
    assert.equal(code, 1); // No independently read GitHub publication authorizes this run.
    assert.equal(requests, 1);
  });

  for (const command of ["needs-you", "act-now"]) {
    for (const outer of [false, true]) for (const decision of [false, true]) for (const list of [false, true]) for (const empty of [false, true]) {
      it(`CLI ${command} preserves coverage: envelope=${outer}, decision=${decision}, list=${list}, empty=${empty}`, async () => {
        const raw = snapshot();
        const queue = raw.needs_you as Record<string, unknown>;
        raw.complete = decision;
        queue.complete = list;
        if (empty) Object.assign(queue, { items: [], act_now: [], count: 0 });
        const response = document(raw);
        response.decision.complete = outer;
        let out = "", err = "", calls = 0;
        const code = await run([command], {
          serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
          fetch: async () => { calls++; return Response.json(response); },
          stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: () => new Date(NOW), isTty: false,
        });
        assert.equal(code, 0, err);
        assert.equal(calls, 1);
        const body = JSON.parse(out);
        assert.equal(body.complete, outer && decision && list);
        assert.equal(body.listComplete, list);
        assert.equal(body.generation, 7);
        if (command === "needs-you") {
          assert.equal(body.settled, outer && decision && list);
          if (!outer || !decision) assert.match(body.note, /Service decision is incomplete/);
        }
        assert.deepEqual((body.cards ?? body.rows).map((r: { key: string }) => r.key), empty ? [] : ["example/work#2", "example/work#1"]);
      });
    }
  }

  for (const command of ["needs-you", "act-now"]) for (const failure of ["stale", "failed"]) it(`CLI ${command} keeps ${failure} warnings ahead of partial coverage`, async () => {
    const response = document();
    if (failure === "stale") response.decision.readAt = "2026-11-12T12:00:00Z";
    const raw = failure === "failed" ? { ...response, decision: { ...response.decision, error: "Preview read failed" } } : response;
    let out = "";
    assert.equal(await run([command], {
      serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
      fetch: async () => Response.json(raw), stdout: (s) => { out += s; }, stderr() {}, now: () => new Date(NOW), isTty: false,
    }), 0);
    const body = JSON.parse(out);
    assert.equal(body.complete, false);
    assert.ok(body.unavailable);
    if (command === "needs-you") assert.equal(body.settled, false);
    else assert.deepEqual(body.rows, []);
    assert.match(body.note ?? body.unavailable, failure === "stale" ? /stale/ : /Preview read failed/);
  });

  for (const command of [["needs-you"], ["act-now"], ["status"], ["repo", "example/work"], ["changes", "--since", "2026-11-12T00:00:00Z"]]) it(`CLI ${command[0]} reads the same generation without token or GitHub polling`, async () => {
    let out = "", err = "", calls = 0;
    const code = await run(command, {
      serviceUrl: "https://control.example", token: async () => { throw new Error("token forbidden"); },
      fetch: async (url, init) => { calls++; assert.equal(url, "https://control.example/api/v1/state"); assert.equal(init?.method, "GET"); return Response.json(document()); },
      stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, now: () => new Date(NOW), isTty: false,
    });
    assert.equal(code, 0, err);
    assert.equal(calls, 1);
    const body = JSON.parse(out);
    assert.equal(body.generation, 7);
    if (command[0] === "act-now") assert.deepEqual(body.rows.map((r: { key: string }) => r.key), ["example/work#2", "example/work#1"]);
    if (command[0] === "needs-you") assert.deepEqual(body.cards.map((r: { key: string }) => r.key), ["example/work#2", "example/work#1"]);
    if (command[0] === "status") assert.equal(body.pools[0].hold, null);
    if (command[0] === "repo") assert.equal(body.work.items[0].reason, "Choose the next step");
  });
});
