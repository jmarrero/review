import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOLDS_MARKER, parseHolds } from "../src/github/holds.ts";
import { activePassView, parsePassView, passView, type PassView, retainPassView } from "../src/github/passview.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const snapshot = () => fixture<{ pass_view: PassView }>("pass-view.json");
const publication = (raw: unknown) => `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
const now = Date.parse("2026-11-05T12:00:00Z");

describe("pass publication replay", () => {
  it("replays #729's docs example without claiming its coverage is complete", () => {
    const raw = fixture<PassView>("pass-view-producer-729.json");
    const data = parsePassView(raw);
    assert.equal(typeof data, "object");
    const el = activePassView(data, now);
    assert.match(el.textContent!, /running 20m · /);
    assert.equal(el.querySelector(".age[data-since='2026-11-05T11:40:00Z']")?.textContent, "20m");
    assert.ok(el.querySelector("a[href$='/actions/runs/41']"));
    assert.match(passView(data, now).textContent!, /ready unknown/);
    raw.in_flight = [];
    for (const rendered of [passView(raw, now), activePassView(raw, now)]) {
      assert.match(rendered.textContent!, /unknown/);
      assert.doesNotMatch(rendered.textContent!, /No running jobs in|No work in flight in|nothing ready/);
    }
  });

  it("summarizes running agents, pool bars and the latest pass from the populated fixture", () => {
    const data = parseHolds(publication(snapshot()))?.passView;
    const el = activePassView(data, now);
    for (const s of ["Live agents", "implement · claude", "running 5m · ", "10% used / 60% allowed", "14:00:00Z", "under pace", "Last pass", "just now", "Started 0"]) assert.ok(el.textContent?.includes(s), s);
    assert.equal(el.querySelectorAll("meter").length, 2);
    assert.equal(el.querySelector("meter")?.getAttribute("value"), "10");
    assert.equal(el.querySelector("meter")?.getAttribute("low"), "60");
    assert.equal(el.querySelector("a[href$='/issues/11']")?.textContent, "example/work#11");
    assert.ok(el.querySelector("a[href='https://github.com/example/runner/actions/runs/42']"));
    assert.doesNotMatch(el.textContent!, /merge-queue|waiting-review|HTTP 503/);
    assert.equal(el.querySelectorAll(".active-pass-grid > div:last-child li").length, 4);
  });

  it("groups all no-start reasons, including when the pass also started work", () => {
    const data = snapshot().pass_view;
    const reasons = data.passes[0]!.reasons;
    reasons.push({ ...reasons[3]!, item: "example/work#16" }, { ...reasons[3]!, item: "example/work#17" });
    const el = activePassView(data, now);
    const rows = el.querySelectorAll(".active-pass-grid > div:last-child li");
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.textContent, "held: Needs operator · 3");
    data.passes.shift();
    data.passes[0]!.reasons = reasons;
    const started = activePassView(data, now);
    assert.match(started.textContent!, /5m ago · success · Started 2/);
    assert.ok(started.querySelector(".active-pass-grid > div:last-child a[href$='/actions/runs/42']"));
    assert.match(started.textContent!, /Needs operator · 3/);
  });

  it("labels missing, stale, unavailable, partial and unknown home publications explicitly", () => {
    assert.match(activePassView(undefined, now).textContent!, /not published/);
    assert.match(activePassView(parsePassView({}), now).textContent!, /unavailable/);
    const data = snapshot().pass_view;
    const stale = activePassView(data, now + 7_200_000, "HTTP 503");
    assert.match(stale.textContent!, /not current/);
    assert.match(stale.textContent!, /stale \(over an hour\)/);
    assert.match(stale.textContent!, /running 5m at observation/);
    assert.equal(stale.querySelector(".age[data-since]"), null);
    assert.match(activePassView(data, now + 3_660_000).textContent!, /running 5m at observation/);
    assert.match(activePassView(data, now - 120_000).textContent!, /clock is in the future/);
    const flight = data.in_flight[0]!;
    assert.equal(flight.state, "running");
    if (flight.state === "running") delete flight.started_at;
    assert.match(activePassView(data, now).textContent!, /runtime unknown/);
    data.complete = false;
    data.omitted = 1;
    data.in_flight = [];
    data.passes = [];
    data.pools = [];
    const partial = activePassView(data, now);
    for (const s of ["partial", "1 records omitted", "unread work is unknown", "Last pass not published", "Capacity not published"]) assert.ok(partial.textContent?.includes(s), s);
  });

  it("renders the synthetic legacy fixture through the holds parser", () => {
    const data = parseHolds(publication(snapshot()))?.passView;
    assert.equal(typeof data, "object");
    const el = passView(data, now);
    for (const s of ["API rate limit exceeded", "HTTP 503", "Started 0", "no-ready-work", "replan-delay", "12:30:00Z", "capped", "held", "10% used / 60% allowed", "in 120m", "readiness coverage unknown", "merge-queue", "waiting-review", "implement · claude"]) assert.ok(el.textContent?.includes(s), s);
    assert.equal(el.querySelector("a[href$='/actions/runs/42']")?.getAttribute("href"), "https://github.com/example/runner/actions/runs/42");
    assert.equal(el.querySelector("a[href$='/pull/14']")?.textContent, "example/work#14");
    assert.match(el.textContent!, /Started nothing; reason not published/);
    assert.equal(el.querySelector("button, input, script"), null);
  });

  it("keeps absence, bad data, unread, partial and stale distinct from an empty queue", () => {
    assert.match(passView(undefined).textContent!, /not published/);
    assert.match(passView(parsePassView({})).textContent!, /unavailable/);
    const raw = snapshot().pass_view;
    raw.complete = false;
    raw.omitted = 3;
    raw.in_flight = [];
    raw.passes[0]!.omitted = 2;
    const el = passView(parsePassView(raw), now + 7_200_000, "HTTP 503");
    for (const s of ["Publication unavailable", "not current", "stale", "partial", "3 records omitted", "2 pass records omitted", "incomplete publication is not an empty queue", "due; awaiting reading"]) assert.ok(el.textContent?.includes(s), s);
    assert.match(passView(raw, now - 120_000).textContent!, /clock is in the future/);
  });

  it("keeps the last readable view across a failed refresh and recovers on the next read", () => {
    const last = parsePassView(snapshot().pass_view) as PassView;
    const fresh = parsePassView({ ...snapshot().pass_view, observed_at: "2026-11-05T12:05:00Z" }) as PassView;
    assert.equal(retainPassView(last, undefined, true), last);
    assert.equal(retainPassView(last, "malformed", true), last);
    assert.equal(retainPassView(last, fresh, true), fresh);
    assert.equal(retainPassView(last, fresh, false), fresh);
    assert.equal(retainPassView(last, undefined, false), undefined);
    assert.equal(retainPassView(undefined, undefined, true), undefined);
    const el = passView(retainPassView(last, undefined, true), now, "HTTP 503");
    for (const s of ["Publication unavailable", "not current", "API rate limit exceeded", "merge-queue"]) assert.ok(el.textContent?.includes(s), s);
  });

  it("renders publisher text as text, and ignores untyped URLs", () => {
    const raw = snapshot().pass_view;
    raw.passes[0]!.reasons[0]!.reason = '<img src=x onerror="alert(1)">';
    Object.assign(raw.in_flight[0]!, { url: "https://invalid.example/" });
    const el = passView(parsePassView(raw), now);
    assert.equal(el.querySelector("img, [onerror], a[href*='invalid']"), null);
    assert.ok(el.textContent?.includes("<img"));
  });

  it("rejects malformed or over-bound arrays, addresses, counts and text without losing holds", () => {
    const mutations: ((v: PassView) => void)[] = [
      (v) => { v.passes = Array(9).fill(v.passes[0]); },
      (v) => { v.passes[0]!.sections = Array(13).fill(v.passes[0]!.sections[0]); },
      (v) => { v.passes[1]!.started = Array(33).fill(v.passes[1]!.started[0]); },
      (v) => { v.passes[0]!.reasons = Array(33).fill(v.passes[0]!.reasons[0]); },
      (v) => { v.pools = Array(17).fill(v.pools[0]); },
      (v) => { v.in_flight = Array(101).fill(v.in_flight[0]); },
      (v) => { Object.assign(v.in_flight[0]!, { started_at: "bad clock" }); },
      (v) => { v.passes[0]!.sections[0]!.error = "HTTP 503\nsecret detail"; },
      (v) => { v.passes[0]!.sections[0]!.error = "x".repeat(241); },
      (v) => { v.passes[0]!.reasons[1]!.until = null; },
      (v) => { v.pools[0]!.used_percent = 101; },
      (v) => { v.pools[0]!.ready = -1; },
      (v) => { v.passes[1]!.started[0]!.run.repository = "../x"; },
      (v) => { v.passes[1]!.started[0]!.run.id = Number.MAX_SAFE_INTEGER + 1; },
      (v) => { v.passes[0]!.reasons[0]!.item = "https://invalid.example#1"; },
    ];
    for (const mutate of mutations) {
      const raw = snapshot();
      mutate(raw.pass_view);
      const result = parseHolds(publication(raw));
      assert.ok(result);
      assert.equal(typeof result.passView, "string");
    }
  });
});
