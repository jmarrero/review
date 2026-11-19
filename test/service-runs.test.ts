import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { parseServiceState, readServiceState, serviceLiveRuns, watchServiceState } from "../src/github/service.ts";
import { liveAgentsView } from "../src/github/liveruns.ts";

// Rust state::tests checks this serialization against recorded GitHub answers.
const replay = () => JSON.parse(readFileSync("service/fixtures/state.json", "utf8"));
const NOW = Date.parse("2026-11-07T12:00:00Z");

describe("independent service runs", () => {
  it("reads full state over bounded credential-free HTTP without requiring decision", async () => {
    const state = await readServiceState("https://control.example", async (url, init) => {
      assert.equal(url, "https://control.example/api/v1/state");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.headers, undefined);
      return Response.json(replay());
    });
    assert.deepEqual(state.runs, replay().runs);
    assert.equal(state.decision, undefined);
    await assert.rejects(readServiceState("https://control.example", async () => new Response("x".repeat(2 * 1024 * 1024 + 1))), /size bound/);
  });
  it("retains producer section metadata without a decision, and filters agent workflows", () => {
    const raw = replay();
    const state = parseServiceState(raw);
    assert.deepEqual(state.runs, raw.runs);
    assert.equal(state.decision, undefined);
    assert.match(state.decisionError!, /unavailable/);
    const live = serviceLiveRuns(state, NOW);
    assert.equal(live.at, NOW);
    assert.deepEqual(live.errors, []);
    assert.deepEqual(live.runs.map((r) => r.run.id), [7001]);
    assert.equal(live.runs[0]!.title, "Agent: investigate build regression");
    raw.decision = { items: [], complete: false, readAt: null, error: null };
    assert.deepEqual(parseServiceState(raw).runs, state.runs);
  });

  it("uses existing run-name interpretation, age filtering and ordering", () => {
    const raw = replay();
    raw.runs.items[1].workflow = "dispatch.yml";
    raw.runs.items[1].title = "implement example/work#42 (test)";
    const live = serviceLiveRuns(parseServiceState(raw), NOW);
    assert.deepEqual(live.runs.map((r) => [r.run.id, r.item, r.kind, r.pool]), [[7001, null, null, null], [9002, "example/work#42", "implement", "test"]]);
    assert.equal(serviceLiveRuns(parseServiceState(raw), NOW + 7 * 3600_000).runs.length, 0);
  });

  it("never reports absent, unread, partial, failed, stale or malformed runs as healthy idle", () => {
    const cases = [
      { ...replay(), runs: undefined },
      { ...replay(), runs: { items: [], complete: false, readAt: null, error: null } },
      ...[{ complete: false }, { error: "read failed" }, { readAt: "2020-01-01T00:00:00Z" }, { readAt: "2030-01-01T00:00:00Z" }].map((change) => { const raw = replay(); Object.assign(raw.runs, change, { items: [] }); return raw; }),
      ...[null, { id: -1 }, { title: "x".repeat(4097) }, { startedAt: "bad" }, { url: "javascript:bad" }, { status: "completed" }].map((change) => { const raw = replay(); raw.runs.items[0] = change === null ? null : { ...raw.runs.items[0], ...change }; return raw; }),
    ];
    const dom = new JSDOM();
    Object.assign(globalThis, { document: dom.window.document });
    for (const raw of cases) {
      const state = parseServiceState(raw);
      const live = serviceLiveRuns(state, NOW);
      assert.ok(live.errors.length);
      const text = liveAgentsView(live, undefined, NOW).textContent!;
      assert.match(text, /Incomplete:/);
      assert.ok(!text.includes("No agent runs in flight."));
    }
    dom.window.close();
  });

  it("one subscription handles pushes, reconnect resyncs, bad generations, bounds and teardown", () => {
    let listener: (e: MessageEvent<string>) => void = () => {};
    let opens = 0, closes = 0;
    const fake = { onopen: () => {}, onerror: () => {}, close() { closes++; }, addEventListener(_: string, f: typeof listener) { listener = f; } };
    const seen: (number | string | undefined)[] = [];
    const stop = watchServiceState((s, error) => seen.push(s?.generation ?? error), (url) => { opens++; assert.equal(url, "/api/events"); return fake as unknown as EventSource; });
    const send = (generation: number, data?: string, id = String(generation)) => listener({ data: data ?? JSON.stringify({ ...replay(), generation }), lastEventId: id } as MessageEvent<string>);
    send(7); send(8); send(6); // backwards while connected is not a resync
    fake.onerror(); fake.onopen(); send(1); // restart fully replaces old facts
    send(2, undefined, "1"); send(2, "{"); send(2, " ".repeat(2 * 1024 * 1024 + 1));
    stop(); send(3); fake.onerror();
    assert.deepEqual(seen, [7, 8, "Unsupported or malformed service resync", "Service stream unavailable; waiting for full resync", 1, ...Array(3).fill("Unsupported or malformed service resync")]);
    assert.equal(opens, 1);
    assert.equal(closes, 1);
  });
});
