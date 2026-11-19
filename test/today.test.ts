import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOLDS_MARKER, parseHolds } from "../src/github/holds.ts";
import { parseToday, todayView, type Today } from "../src/github/today.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const sample = () => fixture<Today>("today.json");
const now = Date.parse("2026-11-07T12:05:00Z");
const text = (data: Today | string | undefined, at = now, unavailable?: string) => todayView(data, at, unavailable).textContent!;
const snapshot = (today?: unknown) => parseHolds(`${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-07T12:00:00Z", holds: [], today })}\n\`\`\``)!;

describe("Today publication", () => {
  it("round-trips the producer fixture through holds without changing its observation clock", () => {
    // agent-board 73b65e696aa53b254f4b2df89d11b861f31bcab6 fixtures/today.json,
    // synthetic serialization, not a capture of the private snapshot.
    assert.deepEqual(snapshot(sample()).today, sample());
    assert.equal(snapshot().today, undefined);
    assert.equal(snapshot({ schema: "future" }).holds.length, 0);
    assert.match(String(snapshot({ schema: "future" }).today), /Today unavailable/);
  });

  for (const [label, change] of Object.entries<Record<string, unknown>>({
    "unknown schema": { schema: "agent-board/today/v2" },
    "bad day": { day: "2026-02-30" },
    "wrong observation day": { observed_at: "2026-11-08T12:00:00Z" },
    "bad clock": { observed_at: "not a clock" },
    "negative count": { changes: { landed: -1, closed: 0, opened: 0 } },
    "unsafe count": { changes: { landed: Number.MAX_SAFE_INTEGER + 1, closed: 0, opened: 0 } },
    "missing changes": { changes: undefined },
    "missing runs": { runs: undefined },
    "too many kinds": { runs: { complete: true, by_kind: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`kind${String.fromCharCode(97 + i)}`, 0])), by_pool: null } },
    "too many pools": { runs: { complete: true, by_kind: {}, by_pool: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`pool${i}`, 0])) } },
    "unsafe name": { runs: { complete: true, by_kind: { "<img src=x>": 1 }, by_pool: null } },
    "overlong name": { runs: { complete: true, by_kind: {}, by_pool: { ["a".repeat(65)]: 1 } } },
    "null cost": { cost: null },
    "wrong cost day": { cost: { ...sample().cost, day: "2026-11-07" } },
    "false complete cost": { cost: { ...sample().cost, unread_runs: 1 } },
    "unpriced total": { cost: { ...sample().cost, complete: false } },
    "infinite cost": { cost: { ...sample().cost, usd: Infinity } },
    "negative budget": { cost: { ...sample().cost, weekly_budget_usd: -1 } },
  })) it(`refuses ${label} without losing holds`, () => {
    assert.equal(typeof parseToday({ ...sample(), ...change }), "string");
    assert.ok(snapshot({ ...sample(), ...change }));
  });

  it("accepts producer rerun kinds, null pool history and RFC3339 offsets", () => {
    const data = { ...sample(), observed_at: "2026-11-07T14:00:00+02:00", runs: { complete: false, by_kind: { "review rerun": 2 }, by_pool: null } };
    assert.deepEqual(parseToday(data), data);
    assert.match(text(data), /By pool: Unknown/);
  });
});

describe("Today section", () => {
  it("renders aggregate counts, coverage and last complete day's cost against the weekly target", () => {
    const el = todayView(sample(), now);
    assert.deepEqual([...el.querySelectorAll("dt")].map((e) => e.textContent), ["landed", "closed", "opened"]);
    assert.deepEqual([...el.querySelectorAll("dd")].map((e) => e.textContent), ["3", "1", "2"]);
    assert.match(el.textContent!, /Incomplete pass history/);
    assert.match(el.textContent!, /By kind: implement 2 · review 1/);
    assert.match(el.textContent!, /2026-11-06 UTC: \$3.00 at list prices/);
    assert.match(el.textContent!, /weekly budget \$100.00 \(comparison, not remaining budget\)/);
    assert.equal(el.querySelector("a, button, script"), null);
  });

  it("hides the entire cost line when cost is absent, without hiding activity", () => {
    const data = sample();
    delete data.cost;
    const el = todayView(data, now);
    assert.equal(el.querySelector(".today-cost"), null);
    assert.doesNotMatch(el.textContent!, /Cost|budget|\$/);
    assert.equal(el.querySelectorAll("dd").length, 3);
  });

  it("ignores unknown changes fields instead of rendering unbounded metrics or coercing objects", () => {
    const data = sample();
    Object.assign(data.changes!, { extra: { toString: null }, ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`extra-${i}`, "not a metric"])) });
    const parsed = parseToday(data);
    assert.equal(typeof parsed, "object");
    const el = todayView(parsed, now);
    assert.equal(el.querySelectorAll("dd").length, 3);
    assert.doesNotMatch(el.textContent!, /extra|not a metric/);
  });

  it("labels missing, malformed, unavailable and stale data instead of inventing a quiet day", () => {
    assert.match(text(undefined), /not published.*unknown/);
    assert.match(text(parseToday(null)), /Today unavailable/);
    assert.doesNotMatch(text(sample(), now + 86_100_000), /over a day old/);
    assert.match(text(sample(), now + 86_400_000), /stale \(over a day old\)/);
    assert.match(text(sample(), now - 600_000), /clock is in the future/);
    assert.match(text(sample(), Date.parse("2026-11-08T00:01:00Z")), /previous UTC day, not today's activity/);
    assert.match(text(sample(), now, "cached"), /unavailable: cached.*last read, not current/);
    assert.match(text({ ...sample(), changes: null, runs: null }), /Changes unavailable.*Starts unavailable/);
  });

  it("distinguishes partial cost, unknown pool coverage and actual zero within coverage", () => {
    const data = sample();
    data.cost = { ...data.cost!, complete: false, usd: null, unpriced_runs: 2, unread_runs: 1, weekly_budget_usd: null };
    assert.match(text(data), /Total unknown · \$3.00 priced subtotal · 2 unpriced runs · 1 unread runs/);
    assert.match(text(data), /weekly budget not published/);
    data.changes = { landed: 0, closed: 0, opened: 0 };
    data.runs = { complete: true, by_kind: {}, by_pool: null };
    assert.match(text(data), /Published pass history carried whole/);
    assert.match(text(data), /By kind: No starts observed/);
    assert.match(text(data), /By pool: Unknown/);
    data.cost = { ...sample().cost!, usd: 0, priced_usd: 0 };
    assert.match(text(data), /\$0.00 at list prices/);
  });
});
