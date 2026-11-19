import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Active } from "../src/github/inbox.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { HOLDS_MARKER, loadPassPublications } from "../src/github/holds.ts";
import { findPasses, MAX_BODY, nothingReady, type Passes, PASSES_MARKER, parsePasses, redactAddresses } from "../src/github/passes.ts";
import { countdown, type PassesRead, passesView, readPasses, schedulerPassView } from "../src/github/passesview.ts";
import { activePassView, parsePassView, passView, type PassView } from "../src/github/passview.ts";
import { usagePath } from "../src/github/usage.ts";
import { fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();
type Raw = Record<string, any>;
const raw = (): Raw => fixture<Raw>("passes.json");
const body = (json: unknown) => `${PASSES_MARKER}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
const comment = (json: unknown, login = "jmarrero-bot"): RawComment => ({ user: { login }, body: body(json) });
const parsed = (json: unknown = raw()): Passes => {
  const p = parsePasses(body(json));
  assert.equal(typeof p, "object", String(p));
  return p as Passes;
};
const NOW = Date.parse("2026-11-05T12:00:00Z");
const view = (read: PassesRead, now = NOW) => passesView(read, now);
const text = (el: Element) => el.textContent ?? "";
const active = (over: Partial<Active>): Active => ({ at: NOW, warnings: [], sources: { holds: { state: "ok" } }, ...over });

describe("pass history parser", () => {
  it("reads the synthetic contract records newest first with typed starts and reasons", () => {
    const p = parsed();
    assert.equal(p.passes.length, 5);
    assert.equal(p.unreadable, 0);
    assert.deepEqual(p.passes.map((x) => x.result), ["success", "success", "partial", "failure", "success"]);
    assert.deepEqual(p.passes[1]!.starts.map((s) => s.state), ["confirmed", "confirmed", "uncertain"]);
    assert.deepEqual(p.passes[0]!.noStart.map((r) => r.reason), ["no-ready-work", "replan-wait", "held"]);
    assert.equal(parsePasses(undefined), undefined);
    assert.equal(parsePasses(`hi\n${body(raw())}`), undefined);
    for (const [json, why] of [
      [{ ...raw(), schema: "agent-board/passes/v2" }, /unknown schema/],
      [{ ...raw(), published_at: "today" }, /malformed header/],
      [{ ...raw(), passes: Array(11).fill(raw().passes[0]) }, /more than 10 passes/],
    ] as const) assert.match(String(parsePasses(body(json))), why);
    assert.match(String(parsePasses(`${PASSES_MARKER}\n${"x".repeat(MAX_BODY)}`)), /over 60000 characters/);
    assert.match(String(parsePasses(`${PASSES_MARKER}\nno fence`)), /no JSON object/);
  });

  const unreadable: [string, (p: Raw) => void][] = [
    ["failed section without error", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: null }; }],
    ["ok section with error", (p) => { p.sections[0].error = "HTTP 503"; }],
    ["multi-line error", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: "HTTP 503\nbody" }; }],
    ["oversize error", (p) => { p.sections[0] = { name: "epics", outcome: "failed", error: "x".repeat(201) }; }],
    ["re-plan wait without time", (p) => { p.no_start[1].until = null; }],
    ["URL item", (p) => { p.no_start[1].item = "javascript:alert(1)#1"; }],
    ["path traversal", (p) => { p.run.repository = "../x"; }],
    ["unsafe run id", (p) => { p.run.id = Number.MAX_SAFE_INTEGER + 1; }],
    ["preview start while applying", (p) => { p.starts = [{ state: "preview", item: "a/b#1", kind: "implement", pool: null, run: null }]; }],
    ["finish before start", (p) => { p.finished_at = "2026-11-05T11:00:00Z"; }],
    ["oversize starts", (p) => { p.starts = Array(21).fill({ state: "confirmed", item: "a/b#1", kind: "implement", pool: null, run: null }); }],
    ["oversize sections", (p) => { p.sections = Array(17).fill(p.sections[0]); }],
    ["oversize reasons", (p) => { p.no_start = Array(21).fill(p.no_start[0]); }],
    ["negative count", (p) => { p.candidates.unread = -1; }],
    ["unknown result", (p) => { p.result = "green"; }],
  ];
  for (const [name, change] of unreadable) it(`counts ${name} as unreadable, keeping other records`, () => {
    const json = raw();
    change(json.passes[0]);
    const p = parsed(json);
    assert.equal(p.unreadable, 1);
    assert.equal(p.passes.length, 4);
  });

  it("unknown start states are uncertain; preview runs and malformed blocks are unknown", () => {
    const json = raw();
    json.passes[1].starts[0].state = "accepted-maybe";
    json.passes[4].starts[0].run = { repository: "a/b", id: 1 };
    json.pools.items[0].used_percent = "12";
    json.in_flight.prs = Array(51).fill(json.in_flight.prs[0]);
    const p = parsed(json);
    assert.equal(p.passes[1]!.starts[0]!.state, "uncertain");
    assert.equal(p.unreadable, 1);
    assert.match(text(view({ data: p })), /Pool pace unreadable.*unknown/);
    assert.match(text(view({ data: p })), /Work in flight unreadable/);
    delete json.pools;
    json.in_flight = null;
    assert.match(text(view({ data: parsed(json) })), /Pool pace not published: unknown/);
  });
});

describe("bounded publication read", () => {
  it("reads holds and the bot's newest history in one request; ignores another author's", async () => {
    const newer = { ...raw(), published_at: "2026-11-05T11:59:00Z" };
    assert.equal((findPasses([comment(raw()), comment(newer), comment(raw(), "someone")]) as Passes).publishedAt, newer.published_at);
    assert.equal(findPasses([comment(raw(), "someone")]), undefined);
    const holds = { user: { login: "jmarrero-bot" }, body: `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-05T11:00:00Z", holds: [] })}\n\`\`\`` };
    const { fetchImpl, calls } = scriptedFetch((_m, url) => url.endsWith(usagePath) ? { body: [holds, comment(raw())] } : undefined);
    const read = await loadPassPublications(new GitHub(async () => "t", fetchImpl));
    assert.equal(read.holds?.at, "2026-11-05T11:00:00Z");
    assert.equal((read.passes as Passes).passes.length, 5);
    assert.equal(calls.length, 1);
  });

  for (const match of [false, true]) it(`full first page is uncertain (older match: ${match})`, async () => {
    const page = Array.from({ length: 100 }, (): RawComment => ({ body: "unrelated" }));
    if (match) page[0] = comment({ ...raw(), published_at: "2026-11-05T10:00:00Z" });
    const { fetchImpl, calls } = scriptedFetch((_m, url) => url.endsWith(usagePath) ? { body: page } : undefined);
    const read = await loadPassPublications(new GitHub(async () => "t", fetchImpl));
    assert.match(String(read.passes), /only the first 100 comments/);
    assert.ok(read.uncertain);
    assert.equal(calls.length, 1);
    const last = parsed();
    const next = readPasses({ data: last }, active({ passes: read.passes ?? null }));
    assert.equal(next.data, last);
    assert.match(next.unavailable!, /newer publication may be unread/);
    assert.doesNotMatch(text(view(next)), /well under pace/);
  });
});

describe("address redaction", () => {
  const cases = [
    ["connect https://inference.example:8443/v1/chat failed", "connect [address] failed"],
    ["broker at 100.64.1.2:9000 refused", "broker at [address] refused"],
    ["dial tcp 10.0.0.7: refused", "dial tcp [address]: refused"],
    ["lookup gpu-box.tail1234.ts.net: no such host", "lookup [address]: no such host"],
    ["dial [fd7a:115c:a1e0::1]:443 timed out", "dial [address] timed out"],
    ["localhost:11434 closed", "[address] closed"],
    ["HTTP 503 at 2026-11-05T12:30:00Z (12:30:00)", "HTTP 503 at 2026-11-05T12:30:00Z (12:30:00)"],
    ["API rate limit exceeded", "API rate limit exceeded"],
    ["board_forge::pass::Error: closed", "board_forge::pass::Error: closed"],
    ["inference.example.com timed out", "[address] timed out"],
    ["connect to broker.internal refused", "connect to [address] refused"],
    ["lookup 100.64.1.2.nip.io failed", "lookup [address] failed"],
    ["fd7a::1 refused", "[address] refused"],
    ["dial tcp [::1]:11434", "dial tcp [address]"],
    ["dial tcp [fd7a:115c:a1e0::]:443 refused", "dial tcp [address] refused"],
    ["dial tcp [::]:9000 refused", "dial tcp [address] refused"],
    ["fd7a:115c:a1e0:: refused", "[address] refused"],
    ["bind :: failed", "bind [address] failed"],
    ["localhost:8 closed", "[address] closed"],
    ["dial gpu-box:7 refused", "dial [address] refused"],
    ["lookup inference.example: no such host", "lookup [address]: no such host"],
    ["connect broker.corp failed", "connect [address] failed"],
    ["lookup gpu-box on 100.100.100.100:53 failed", "lookup [address] on [address] failed"],
    ["connection to gpu-box refused", "connection to [address] refused"],
    ["broker at gpu-box refused", "broker at [address] refused"],
    ["endpoint=gpu-box refused", "endpoint=[address] refused"],
    ['lookup "gpu-box": no such host', 'lookup "[address]": no such host'],
    ["connect to 'gpu-box' refused", "connect to '[address]' refused"],
    ["dial tcp `gpu-box`, refused", "dial tcp `[address]`, refused"],
    ['host="gpu-box") refused', 'host="[address]") refused'],
    ['connect "gpu-box:7" refused', 'connect "[address]" refused'],
    ["Could not resolve host: gpu-box", "Could not resolve host: [address]"],
    ["resolve host gpu-box", "resolve host [address]"],
    ["connect to gpu-box, refused", "connect to [address], refused"],
    ["connect to: gpu-box", "connect to: [address]"],
    ["connect to \u201cgpu-box\u201d refused", "connect to \u201c[address]\u201d refused"],
    ["dial gpu-box; refused", "dial [address]; refused"],
    ["lookup gpu-box) failed", "lookup [address]) failed"],
    ["server: gpu-box,", "server: [address],"],
    ["failed to connect gpu-box/v1", "failed to connect [address]/v1"],
    ["unknown host gpu-box", "unknown host [address]"],
    ["no route to host gpu-box", "no route to host [address]"],
    ["host 'gpu-box' unreachable", "host '[address]' unreachable"],
    ["proxy at gpu-box", "proxy at [address]"],
    ["lookup \"gpu-box' x", "lookup \"[address]' x"],
    ["dial tcp: lookup gpu-box on [::1]:53", "dial tcp: lookup [address] on [address]"],
    ["connected to the queue", "connected to the queue"],
  ];
  for (const [input, want] of cases) it(input!, () => assert.equal(redactAddresses(input!), want));

  it("redacts single-digit ports and URLs before rendering errors, including legacy reasons", () => {
    const json = raw();
    json.passes[2].sections[0].error = "dial gpu-box:7 refused by https://example.invalid/v1";
    const t = text(view({ data: parsed(json) }));
    assert.match(t, /dial \[address\] refused by \[address\]/);
    assert.doesNotMatch(t, /gpu-box|example.invalid/);
    assert.equal(parsePasses(body({ ...raw(), schema: "http://100.100.1.1/x" })), "unknown schema [address]");
    const legacy = fixture<{ pass_view: PassView }>("pass-view.json").pass_view;
    legacy.passes[0]!.sections[0]!.error = "dial gpu-box:7 refused";
    legacy.passes[0]!.reasons[0]!.reason = "broker.internal:8 refused";
    for (const el of [passView(legacy, NOW, "HTTP 503 from https://example.invalid"), activePassView(legacy, NOW, "broker.internal:8")]) {
      assert.match(text(el), /\[address\]/);
      assert.doesNotMatch(text(el), /gpu-box|broker.internal|example.invalid/);
    }
  });

  for (const error of ["lookup inference.example: no such host", "connect broker.corp failed", "lookup gpu-box on 100.100.100.100:53 failed", 'lookup "gpu-box": no such host', "connect to 'gpu-box', refused", 'server: "gpu-box" closed', "Could not resolve host: gpu-box", "connect to gpu-box, refused", "dial gpu-box; refused"]) {
    it(`redacts DNS targets through parser and DOM: ${error}`, () => {
      const json = raw();
      json.passes[2].sections[0].error = error;
      const el = view({ data: parsed(json) });
      assert.match(text(el), /\[address\]/);
      assert.doesNotMatch(text(el), /inference.example|broker.corp|gpu-box|100\.100/);
      const legacy = fixture<{ pass_view: PassView }>("pass-view.json").pass_view;
      legacy.passes[0]!.sections[0]!.error = error;
      legacy.passes[0]!.reasons[0]!.reason = error;
      for (const rendered of [passView(legacy, NOW), activePassView(legacy, NOW)]) {
        assert.doesNotMatch(text(rendered), /inference.example|broker.corp|gpu-box|100\.100/);
      }
    });
  }
});

describe("history replay DOM", () => {
  it("flags an idle under-pace pool even when another pool has ready work", () => {
    const json = raw();
    json.passes[0].candidates.ready = 3;
    json.pools.items[1].ready = 3;
    const el = view({ data: parsed(json) });
    const rows = [...el.querySelectorAll(".pass-pool")].map(text);
    assert.match(rows[0]!, /well under pace with nothing ready/);
    assert.doesNotMatch(rows[1]!, /well under pace/);
    assert.match(text(el), /no ready work reported.*unknown/);
    json.pools.items[0].ready = 1;
    assert.doesNotMatch(text(view({ data: parsed(json) })), /well under pace/);
  });

  for (const reason of ["held", "newer-reason"]) it(`shows a published ${reason} deadline`, () => {
    const json = raw();
    json.passes[0].no_start = [{ reason, item: null, until: "2026-11-05T14:30:00Z", cap: null, hold: "needs-human" }];
    const el = view({ data: parsed(json) });
    assert.match(el.querySelector(".pass-reasons")!.textContent!, /until .*\(in 2h 30m\)/);
  });

  it("shows results, first errors, starts, reasons, pace, reset countdowns and flight links", () => {
    const el = view({ data: parsed() });
    const t = text(el);
    for (const s of ["Published 1m ago", "no ready work (14 candidates read)", "waiting out the re-plan delay until", "(in 2h 30m)", "held (needs-human)", "Started 2, 1 uncertain", "uncertain: check the runs", "capped by wip", "pull-requests: API rate limit exceeded for installation", "schedule: cut short", "did not read everything: unknown", "setup: HTTP 503 from the board", "published no reason: unknown", "Would start at least 1", "Left out to fit: 2 starts.", "run not known", "12.5% used of 55% allowed", "(in 21h)", "well under pace with nothing ready", "Work in flight read 2m ago", "in the merge queue", "waiting for review"]) assert.ok(t.includes(s), s);
    const hrefs = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const suffix of ["tracker/actions/runs/42070000004/attempts/2", "review/issues/245", "tracker/actions/runs/42064057295", "agent-board/pull/680", "review/pull/244"]) assert.ok(hrefs.includes(`https://github.com/jmarrero-forge/${suffix}`));
    assert.equal(el.querySelector("button, input, textarea, form, script, img"), null);
  });

  const uncertain: [string, (j: Raw) => void][] = [
    ["unread candidates", (j) => { j.passes[0].candidates.unread = 1; }],
    ["unknown candidates", (j) => { j.passes[0].candidates = null; }],
    ["partial pools", (j) => { j.pools.complete = false; }],
    ["omitted pools", (j) => { j.pools.omitted = 1; }],
    ["section failed", (j) => { j.passes[0].sections[1] = { name: "epics", outcome: "failed", error: "HTTP 502" }; }],
    ["pass failed", (j) => { j.passes[0].result = "failure"; }],
    ["no sections", (j) => { j.passes[0].sections = []; }],
    ["omitted section", (j) => { j.passes[0].omitted.sections = 1; }],
    ["unread newest record", (j) => { j.passes[0].mode = "newer-mode"; }],
    ["omitted record", (j) => { j.omitted = 1; }],
    ["stale reading", (j) => { j.pools.items[0].observed_at = "2026-11-04T11:58:00Z"; }],
    ["future pool clock", (j) => { j.pools.observed_at = "2099-01-01T00:00:00Z"; }],
    ["future publication", (j) => { j.published_at = "2099-01-01T00:00:00Z"; }],
    ["held unknown", (j) => { j.pools.items[0].held = null; }],
    ["held", (j) => { j.pools.items[0].held = true; }],
    ["reset unknown", (j) => { j.pools.items[0].resets_at = null; }],
    ["reset due", (j) => { j.pools.items[0].resets_at = "2026-11-05T11:00:00Z"; }],
  ];
  for (const [name, change] of uncertain) it(`does not flag nothing ready with ${name}`, () => {
    const json = raw();
    change(json);
    assert.doesNotMatch(text(view({ data: parsed(json) })), /well under pace/);
  });

  it("marks retained, stale, partial and omitted observations unknown, not idle", () => {
    assert.equal(nothingReady(parsed(), NOW), true);
    const json = raw();
    json.in_flight = { observed_at: "2026-11-05T11:58:00Z", complete: false, omitted: 3, runs: [], prs: [] };
    json.passes[3].omitted.starts = 3;
    let t = text(view({ data: parsed(json) }));
    assert.match(t, /Started at least 0/);
    assert.match(t, /None listed: unknown/);
    assert.doesNotMatch(t, /None running|None queued/);
    json.in_flight.complete = true;
    json.in_flight.omitted = 0;
    const data = parsed(json);
    assert.match(text(view({ data })), /None running/);
    for (const read of [{ data, unavailable: "HTTP 503" }, { data }]) {
      t = text(view(read, read.unavailable ? NOW : NOW + 7_200_000));
      assert.doesNotMatch(t, /well under pace|None running|None queued/);
    }
    json.passes = [{ ...json.passes[0], mode: "nope" }];
    assert.match(text(view({ data: parsed(json) })), /No readable pass records: unknown, not idle/);
  });

  it("renders hostile prose as text", () => {
    const json = raw();
    json.passes[3].sections[0].error = "<img src=x onerror=alert(1)>";
    const el = view({ data: parsed(json) });
    assert.equal(el.querySelector("img"), null);
    assert.match(text(el), /setup: <img/);
  });
});

describe("history retention", () => {
  it("retains cached independent history without holds through a cold failed read", () => {
    const data = parsed();
    const cached = readPasses({}, active({ passes: data, sources: { holds: { state: "cached" } } }));
    assert.equal(cached.data, data);
    assert.match(cached.unavailable!, /cached/);
    const failed = readPasses(cached, active({ sources: { holds: { state: "unavailable", error: "HTTP 502" } } }));
    assert.equal(failed.data, data);
    assert.match(text(view(failed)), /What follows is the last one read/);
    const bad = readPasses(failed, active({ passes: "malformed header" }));
    assert.equal(bad.data, data);
    assert.match(bad.unavailable!, /can't be used/);
    const validated = readPasses(bad, active({ passes: data, sources: { holds: { state: "ok", checkedAt: NOW + 7_200_000 } } }));
    assert.equal(validated.unavailable, undefined);
    assert.match(text(view(validated, NOW + 7_200_000)), /stale/);
    assert.deepEqual(readPasses(validated, active({ passes: null })), { absent: true });
  });

  it("uses one Status panel, falling back to legacy only on confirmed absence", () => {
    const legacy = parsePassView(fixture<{ pass_view: unknown }>("pass-view.json").pass_view) as PassView;
    assert.match(text(schedulerPassView({ absent: true }, legacy, NOW)), /Poller passes/);
    const rich = schedulerPassView({ data: parsed() }, legacy, NOW);
    assert.equal(rich.querySelectorAll("h2").length, 1);
    assert.doesNotMatch(text(rich), /Poller passes/);
    assert.match(text(schedulerPassView({ unavailable: "HTTP 503" }, legacy, NOW)), /Nothing known about recent passes/);
    const failed = readPasses({ absent: true }, active({ sources: { holds: { state: "unavailable", error: "HTTP 503" } } }));
    assert.match(text(schedulerPassView(failed, legacy, NOW, "HTTP 503")), /Poller passes/);
  });

  for (const [at, want] of [["12:00:00", "due"], ["11:00:00", "due"], ["12:00:20", "in 1m"], ["14:05:00", "in 2h 5m"]]) {
    it(`counts down ${at}`, () => assert.equal(countdown(`2026-11-05T${at}Z`, NOW), want));
  }
});
