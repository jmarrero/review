import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFocus, focusView, type Focus } from "../src/github/focus.ts";
import { HOLDS_MARKER, parseHolds } from "../src/github/holds.ts";
import { homeSkeleton } from "../src/github/homeview.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
// Verbatim producer fixture: cgwalters-forge/agent-board fixtures/epic-focus.json
// at 7448aaf1deaf840e2833b79d1a61cbb56193ca24, synthetic, not a live capture.
const sample = () => fixture<Focus>("epic-focus.json");
const now = Date.parse("2026-11-08T12:05:00Z");
const snapshot = (epic_focus?: unknown) => parseHolds(`${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ schema: "agent-board/holds/v1", at: "2026-11-08T12:00:00Z", holds: [], epic_focus })}\n\`\`\``)!;

describe("Focus publication", () => {
  it("round-trips the shared fixture through the existing holds parser", () => {
    assert.deepEqual(snapshot(sample()).epicFocus, sample());
    assert.equal(snapshot().epicFocus, undefined);
    assert.match(focusView(undefined, now).textContent!, /Focus is not published.*holds.epicFocus.*blockers are unknown/);
  });

  it("preserves partial/unread sources and all omitted counts", () => {
    const data = sample();
    data.sources.runs = data.sources.board = "unread";
    data.omitted = 3;
    data.epics[0]!.omitted = 4;
    data.epics[0]!.runs_omitted = 2;
    assert.deepEqual(parseFocus(data), data);
    const text = focusView(parseFocus(data), now).textContent!;
    for (const phrase of ["complete:false", "epics: partial", "runs: unread", "board: unread", "3 epics omitted", "1 unread epics", "4 children omitted", "2 runs omitted"]) assert.ok(text.includes(phrase), phrase);
  });

  it("renders nullable producer details and a run without its optional start clock", () => {
    const data = sample();
    const epic = data.epics[0]!;
    epic.title = epic.goal = epic.changed_at = null;
    epic.children[0]!.title = null;
    delete epic.runs[0]!.started_at;
    const parsed = snapshot(data).epicFocus;
    assert.deepEqual(parsed, data);
    const el = focusView(parsed, now);
    assert.equal(el.querySelector("h3 a")!.textContent, "o/t#1");
    assert.match(el.textContent!, /Goal not published.*Change time unknown/s);
    assert.equal(el.querySelector(".focus-children a")!.textContent, "o/t#2");
    assert.equal(el.querySelector(".focus-runs li a:last-child")!.getAttribute("href"), "https://github.com/o/runner/actions/runs/41");
  });

  it("accepts producer Unicode character bounds and renders prose only as text", () => {
    const data = sample();
    data.epics[0]!.title = "🚀".repeat(120);
    data.epics[0]!.goal = "🚀".repeat(240);
    data.epics[0]!.children[0]!.blocker!.reason = "🚀".repeat(240);
    assert.deepEqual(parseFocus(data), data);
    data.epics[0]!.goal = "<img src=x onerror=alert(1)>";
    const el = focusView(snapshot(data).epicFocus, now);
    assert.ok(el.textContent!.includes(data.epics[0]!.goal));
    assert.equal(el.querySelector("img, script"), null);
    data.epics[0]!.children[0]!.blocker!.reason += "🚀";
    assert.equal(typeof parseFocus(data), "string");
  });

  for (const [name, mutate] of Object.entries<(v: any) => void>({
    "unsupported schema": (v) => { v.schema = "future"; },
    "null source": (v) => { v.sources = null; },
    "malformed epic": (v) => { v.epics[1] = null; },
    "malformed child": (v) => { v.epics[0].children[1].blocker = {}; },
    "unknown blocker": (v) => { v.epics[0].blocker = { ...v.epics[0].children[0].blocker, type: "new" }; },
    "unsafe URL": (v) => { v.epics[0].url = "javascript:alert(1)"; },
    "unsafe run repository": (v) => { v.epics[0].runs[0].run.repository = "o/.."; },
    "unsafe pull": (v) => { v.epics[0].children[2].blocker.pull = "o/../x#1"; },
    "negative count": (v) => { v.omitted = -1; },
    "overlong prose": (v) => { v.epics[0].goal = "x".repeat(501); },
    "too many epics": (v) => { v.epics = Array(11).fill(v.epics[0]); },
    "too many children": (v) => { v.epics[0].children = Array(51).fill(v.epics[0].children[0]); },
    "too many runs": (v) => { v.epics[0].runs = Array(9).fill(v.epics[0].runs[0]); },
  })) it(`isolates ${name} from the rest of holds`, () => {
    const data = sample();
    mutate(data);
    const holds = snapshot(data);
    assert.deepEqual(holds.holds, []);
    assert.equal(typeof holds.epicFocus, "string");
    assert.match(focusView(holds.epicFocus, now).textContent!, /Focus unavailable/);
  });
});

describe("Focus section", () => {
  it("follows Act now's decisions and published activity, not a route", () => {
    const home = homeSkeleton({ toggled() {} });
    assert.equal(home.el.children[2], home.slots.focus);
  });

  it("renders cards and children in producer order, with blocked, moving and done states and typed links", () => {
    const el = focusView(sample(), now);
    assert.deepEqual([...el.querySelectorAll("h3")].map((n) => n.textContent), ["Issue 1", "Issue 20"]);
    const rows = [...el.querySelectorAll(".focus-children")][0]!.children;
    assert.match(rows[0]!.textContent!, /Issue 2 · Waiting on operator — Ship it\?/);
    assert.equal(rows[1]!.textContent, "Issue 3 · Moving");
    assert.match(rows[2]!.textContent!, /Waiting on CI/);
    assert.match(rows[3]!.textContent!, /Waiting on review or merge/);
    assert.match(rows[4]!.textContent!, /On hold \(blocked\) — board Status is Blocked/);
    assert.match(rows[5]!.textContent!, /Nothing moving it now/);
    assert.match(rows[6]!.textContent!, /Blocker unknown/);
    assert.equal(rows.length, 8);
    const done = el.querySelector(".focus-done")!;
    assert.equal(done.querySelector("summary")!.textContent, "2 done");
    assert.equal(done.querySelectorAll("li")[0]!.textContent, "Issue 4 · Done");
    assert.equal(done.querySelectorAll("li")[1]!.textContent, "Plain task · Done");
    assert.match(el.textContent!, /Ship the thing to users.*2\/10 done · 1 operator blocked/s);
    const links = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const path of ["o/t/issues/1", "o/t/issues/2", "o/t/issues/3", "o/t/issues/4", "o/w/pull/50", "o/w/pull/60", "o/runner/actions/runs/41"]) assert.ok(links.includes(`https://github.com/${path}`), path);
    assert.equal(el.querySelector("button"), null);
  });

  it("shows the epic's own blocker and labels unconfirmed publication", () => {
    const data = sample();
    data.epics[0]!.blocker = data.epics[0]!.children[0]!.blocker;
    const el = focusView(data, now, "cached");
    assert.match(el.textContent!, /Focus unavailable: cached/);
    assert.match(el.querySelector(".focus-card > summary")!.textContent!, /Waiting on operator — Ship it\?/);
  });

  it("links both child-owned and epic-owned runs", () => {
    const data = sample();
    const epic = data.epics[0]!;
    epic.runs.push({ ...epic.runs[0]!, item: epic.item, run: { repository: "other/runner", id: 42 } });
    const el = focusView(snapshot(data).epicFocus, now);
    const links = [...el.querySelectorAll(".focus-card:first-of-type .focus-runs a")].map((a) => a.getAttribute("href"));
    assert.deepEqual(links, ["o/t/issues/3", "o/runner/actions/runs/41", "o/t/issues/1", "other/runner/actions/runs/42"].map((p) => `https://github.com/${p}`));
  });

  it("labels stale and future observations without changing their timestamp", () => {
    const data = sample();
    const at = Date.parse(data.observed_at);
    const text = (offset: number) => focusView(data, at + offset).textContent!;
    assert.doesNotMatch(text(3_600_000), /stale/);
    assert.match(text(3_600_001), /stale \(over an hour\); facts are last observed, not current/);
    assert.doesNotMatch(text(-60_000), /clock is in the future/);
    assert.match(text(-60_001), /clock is in the future; current state unknown/);
    assert.equal(data.observed_at, "2026-11-08T12:00:00Z");
  });

  it("starts collapsed with only the overview in its summary", () => {
    const el = focusView(sample(), now);
    const card = el.querySelector<HTMLDetailsElement>(".focus-card")!;
    assert.equal(card.open, false);
    const summary = card.querySelector("summary")!;
    assert.equal(summary.querySelector("a")!.getAttribute("href"), "https://github.com/o/t/issues/1");
    assert.match(summary.textContent!, /Issue 1.*Ship the thing.*2\/10 done · 1 operator blocked.*Waiting on operator — Ship it\?/);
    assert.doesNotMatch(summary.textContent!, /Issue 3|runs listed|Changed/);
  });

  it("keeps done children collapsed when expanded, and toggles them independently", () => {
    const el = focusView(sample(), now);
    const card = el.querySelector<HTMLDetailsElement>(".focus-card")!;
    card.open = true;
    const done = card.querySelector<HTMLDetailsElement>(".focus-done")!;
    assert.equal(done.open, false);
    assert.equal(card.querySelectorAll(":scope > .focus-children > li").length, 8);
    done.open = true;
    assert.equal(done.querySelectorAll("li").length, 2);
    done.open = false;
    assert.equal(card.open, true);
    assert.equal(el.querySelectorAll(".focus-done").length, 1);
  });

  it("remembers expansion per viewer and epic, without remembering the done fold", () => {
    const values = new Map<string, string>();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    try {
      const card = focusView(sample(), now, undefined, "alice").querySelector<HTMLDetailsElement>(".focus-card")!;
      card.open = true;
      card.dispatchEvent(new window.Event("toggle"));
      const again = focusView(sample(), now, undefined, "ALICE");
      assert.equal(again.querySelector<HTMLDetailsElement>(".focus-card")!.open, true);
      assert.equal(again.querySelectorAll<HTMLDetailsElement>(".focus-card")[1]!.open, false);
      assert.equal(again.querySelector<HTMLDetailsElement>(".focus-done")!.open, false);
      assert.equal(focusView(sample(), now, undefined, "bob").querySelector<HTMLDetailsElement>(".focus-card")!.open, false);
      card.open = false;
      card.dispatchEvent(new window.Event("toggle"));
      assert.equal(focusView(sample(), now, undefined, "alice").querySelector<HTMLDetailsElement>(".focus-card")!.open, false);
      values.set("review.focus.expanded.alice.o/t#1", '"invalid"');
      assert.equal(focusView(sample(), now, undefined, "alice").querySelector<HTMLDetailsElement>(".focus-card")!.open, false);
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
      const blocked = focusView(sample(), now, undefined, "alice").querySelector<HTMLDetailsElement>(".focus-card")!;
      assert.equal(blocked.open, false);
      blocked.open = true;
      assert.doesNotThrow(() => blocked.dispatchEvent(new window.Event("toggle")));
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
