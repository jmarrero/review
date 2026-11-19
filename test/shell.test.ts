// The views of the page and the source layer that feeds them: a source is
// read only while a view needing it is on screen.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { HOME_CLASS, homeSkeleton, walkRows } from "../src/github/homeview.ts";
import { SECTIONS } from "../src/github/sections.ts";
import { fillNav, SECTION_VIEW, showView, type ViewId, VIEWS, visibleView } from "../src/github/shell.ts";
import { checkedText, SourceLayer } from "../src/github/sourcelayer.ts";
import { ROW_CLASS } from "../src/github/view.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const hooks = { open: () => true, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} };
// Before any real clock: a read settles at the real time, after it.
const NOW = Date.parse("2020-01-01T12:00:00Z");

let hidden = false;
Object.defineProperty(win.document, "hidden", { configurable: true, get: () => hidden });

/** Let the reads started settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mounted() {
  const home = homeSkeleton(hooks);
  win.document.body.replaceChildren(home.el);
  return home;
}

describe("views", () => {
  beforeEach(() => {
    hidden = false;
  });

  it("shows only Needs you and Status, with freshness in both", () => {
    const home = mounted();
    for (const view of VIEWS) {
      showView(home.el, view);
      for (const id of SECTIONS) assert.equal(home.sections[id].details.hidden, SECTION_VIEW[id] !== view, `${id} in ${view}`);
      assert.equal(home.slots.freshness.hidden, false);
      assert.equal(home.slots.statusNote.hidden, view !== "status");
      assert.equal(home.el.querySelector<HTMLElement>("#sec-people")!.hidden, view !== "inbox");
    }
  });

  it("walks only the rows of the view shown, and keeps a half-written answer across a switch", () => {
    const home = mounted();
    const row = (slot: HTMLElement, key: string) => slot.appendChild(Object.assign(win.document.createElement("a"), { className: ROW_CLASS, href: `#${key}` }));
    const need = row(home.sections.needs.body, "need");
    const status = row(home.slots.statusNote, "status");
    const draft = home.sections.needs.body.appendChild(win.document.createElement("textarea"));
    draft.value = "half written";
    showView(home.el, "inbox");
    assert.deepEqual(walkRows(home.el), [need]);
    showView(home.el, "status");
    assert.deepEqual(walkRows(home.el), [status]);
    showView(home.el, "inbox");
    assert.equal(home.sections.needs.body.querySelector("textarea"), draft);
    assert.equal(draft.value, "half written");
  });

  it("knows the view on screen: none while the tab is hidden or the page isn't shown", () => {
    const home = mounted();
    assert.equal(visibleView(win.document, HOME_CLASS), undefined);
    showView(home.el, "status");
    assert.equal(visibleView(win.document, HOME_CLASS), "status");
    hidden = true;
    assert.equal(visibleView(win.document, HOME_CLASS), undefined);
    hidden = false;
    win.document.body.replaceChildren(win.document.createElement("main"));
    assert.equal(visibleView(win.document, HOME_CLASS), undefined);
  });

  it("links each view, marking the current one", () => {
    const nav = win.document.createElement("nav");
    fillNav(nav, "inbox");
    fillNav(nav, "status");
    assert.deepEqual([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#inbox", "#status"]);
    assert.deepEqual([...nav.querySelectorAll("a")].map((a) => a.textContent), ["Needs you", "Status"]);
    assert.deepEqual([...nav.querySelectorAll("[aria-current=page]")].map((a) => a.textContent), ["Status"]);
  });
});

describe("the source layer", () => {
  beforeEach(() => {
    hidden = false;
  });

  /** A layer over the DOM's view, with a source per view set and a log of reads. */
  function layer(cadence = 60_000) {
    const reads: string[] = [];
    let foldOpen = false;
    const read = (name: string) => async () => {
      reads.push(name);
    };
    const l = new SourceLayer<ViewId>(
      [
        { name: "queue", path: "board", cadence, views: VIEWS },
        { name: "active", path: "heartbeat", cadence, views: VIEWS, read: read("active") },
        { name: "runs", path: "runs", cadence, views: ["status"], read: read("runs") },
        { name: "decisions", path: "issues", cadence, views: ["inbox"], read: read("decisions") },
        { name: "ops", path: "events", cadence, views: ["status"], read: read("ops"), when: () => foldOpen },
      ],
      () => visibleView(win.document, HOME_CLASS),
    );
    return { l, reads, open: (o: boolean) => (foldOpen = o) };
  }

  it("polls a source only while a view needing it is visible", async () => {
    const home = mounted();
    const { l, reads } = layer();
    l.tick(false, NOW);
    assert.deepEqual(reads, [], "nothing before the page shows a view");
    showView(home.el, "inbox");
    l.tick(false, NOW);
    await settle();
    assert.deepEqual(reads, ["active", "decisions"]);
    showView(home.el, "status");
    l.tick(false, NOW + 1_000);
    await settle();
    assert.deepEqual(reads, ["active", "decisions", "runs"], "active isn't due again; runs is new");
    hidden = true;
    l.tick(false, NOW + 120_000);
    assert.deepEqual(reads.length, 3, "nothing while the tab is hidden");
    hidden = false;
    win.document.body.replaceChildren(win.document.createElement("main"));
    l.tick(false, NOW + 120_000);
    assert.deepEqual(reads.length, 3, "nothing while an entry replaces the page");
    win.document.body.replaceChildren(home.el);
    l.tick(false, NOW + 120_000);
    await settle();
    assert.deepEqual(reads.slice(3), ["active", "runs"], "decisions waits for the inbox");
  });

  it("reads at most once per cadence unless forced, and one read at a time", async () => {
    const home = mounted();
    showView(home.el, "inbox");
    let release: () => void = () => {};
    let n = 0;
    const l = new SourceLayer<ViewId>(
      [{ name: "decisions", path: "issues", cadence: 60_000, views: ["inbox"], read: () => { n++; return new Promise<void>((r) => (release = r)); } }],
      () => visibleView(win.document, HOME_CLASS),
    );
    l.tick(false, NOW);
    l.tick(true, NOW + 120_000);
    assert.equal(n, 1, "not while one runs");
    release();
    await settle();
    l.tick(false, NOW + 59_999);
    assert.equal(n, 1);
    l.tick(true, NOW + 59_999);
    assert.equal(n, 2);
  });

  it("reads a source shown in a fold only while it is open, and counts it in the view's age only then", async () => {
    const home = mounted();
    showView(home.el, "status");
    const { l, reads, open } = layer();
    l.checked("queue", NOW);
    l.tick(false, NOW);
    await settle();
    assert.deepEqual(reads, ["active", "runs"]);
    assert.deepEqual(l.freshness("status").sources.map((s) => s.name), ["queue", "active", "runs"]);
    assert.notEqual(l.freshness("status").at, undefined);
    open(true);
    assert.equal(l.freshness("status").at, undefined, "the open fold's source hasn't been read yet");
    l.tick(false, NOW);
    await settle();
    assert.deepEqual(reads, ["active", "runs", "ops"]);
    assert.equal(l.freshness("status").at, NOW, "the oldest check is the queue's");
  });

  it("doesn't count a read that failed, or read nothing, as a check", async () => {
    const home = mounted();
    showView(home.el, "inbox");
    const l = new SourceLayer<ViewId>(
      [
        { name: "failed", path: "x", cadence: 60_000, views: ["inbox"], read: () => Promise.reject(new Error("offline")) },
        { name: "nothing", path: "y", cadence: 60_000, views: ["inbox"], read: async () => false },
      ],
      () => visibleView(win.document, HOME_CLASS),
    );
    const error = console.error;
    console.error = () => {};
    try {
      l.tick(false, NOW);
      await settle();
    } finally {
      console.error = error;
    }
    assert.deepEqual(l.freshness("inbox").sources.map((s) => s.checked), [undefined, undefined]);
    assert.equal(l.freshness("inbox").at, undefined);
  });

  it("says how long ago a view was checked", () => {
    assert.equal(checkedText(undefined, NOW), "checking…");
    assert.equal(checkedText(NOW - 12_400, NOW), "checked 12 s ago");
    assert.equal(checkedText(NOW - 3 * 60_000, NOW), "checked 3 min ago");
    assert.equal(checkedText(NOW + 5_000, NOW), "checked 0 s ago");
  });

  it("refuses to record an unknown source", () => {
    assert.throws(() => layer().l.checked("nope"), /unknown source nope/);
  });
});
