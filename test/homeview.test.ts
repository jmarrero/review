import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import { applyLimit, fillStatus, homeSkeleton, resetExpanded, stepRow, walkRows } from "../src/github/homeview.ts";
import { createRenderer } from "../src/markdown.ts";
import { fixture, installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";
const hooks = { toggled: () => {} };
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
afterEach(resetExpanded);

function tracked(n: number, over: Partial<Item> = {}): Item {
  return { id: n, nodeId: `PVTI_${n}`, kind: "issue", title: `Question ${n}`, body: `Blocks: ${TRACKER}/9\nQ: which?\nOptions:\nA) this\nB) that\n`, why: "", branch: [], gist: [], labels: ["question"], status: "Needs human", url: `${TRACKER}/${n}`, ref: { owner: "jmarrero-forge", repo: "tracker", number: n }, state: "open", author: "jmarrero-bot", assignees: ["jmarrero"], ...over };
}

describe("Needs you and published Status", () => {
  it("mounts Act now's decisions first, then activity, Focus, active summary, inbox, opt-in people and published status", () => {
    const home = homeSkeleton(hooks);
    assert.equal(home.el.firstElementChild, home.slots.actNow.parentElement);
    assert.equal(home.slots.actNow.parentElement!.nextElementSibling, home.slots.activity);
    assert.equal(home.slots.activity.nextElementSibling, home.slots.focus);
    assert.equal(home.slots.focus.nextElementSibling, home.slots.active);
    assert.deepEqual([...home.el.children].map((el) => el.getAttribute("data-view")), ["inbox", "inbox", "inbox", "inbox", "inbox", "inbox", "inbox", "status", "status", "status", null]);
    assert.equal(home.sections.needs.details.nextElementSibling, home.slots.today);
    assert.equal(home.slots.active.nextElementSibling, home.sections.needs.details);
    assert.equal(home.slots.actNow.hidden, true, "off without a producer publication");
    assert.equal(text(home.sections.needs.details.querySelector(".sec-title")), "Needs you");
    assert.equal(home.sections.needs.details.open, true);
    assert.equal(home.el.querySelector<HTMLDetailsElement>("#sec-people")?.open, false);
    assert.equal(home.el.querySelector(".ops, .usage, .summary, .dashboard, .focus, .runs, .dispatch, .chat"), null);
  });

  it("renders sanitized project markdown and preserves expansion on unchanged updates", () => {
    const home = homeSkeleton(hooks);
    const status = { body: "**Working**\n\n[x](javascript:alert(1))\n\n<script>alert(2)</script>\n\nMore", createdAt: "2026-10-01T00:00:00Z" };
    fillStatus(home, status, render);
    const slot = home.slots.statusNote;
    assert.equal(text(slot.querySelector("strong")), "Working");
    assert.equal(slot.querySelector("script, [href^='javascript:']"), null);
    const button = slot.querySelector<HTMLButtonElement>("button")!;
    button.click();
    fillStatus(home, status, render);
    assert.equal(slot.querySelector("button"), button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(slot.querySelector(".status-preview"), null);
  });

  it("updates published age without resetting expansion and labels missing or unread status", () => {
    const home = homeSkeleton(hooks);
    const slot = home.slots.statusNote;
    const status = { body: "First paragraph\n\nSecond paragraph", createdAt: "2026-10-15T10:00:00Z" };
    fillStatus(home, status, render, undefined, Date.parse("2026-10-15T10:30:00Z"));
    assert.equal(text(slot.querySelector(".status-age")), "Published 30m ago");
    slot.querySelector<HTMLButtonElement>("button")!.click();
    fillStatus(home, status, render, undefined, Date.parse("2026-10-15T11:01:00Z"));
    assert.equal(text(slot.querySelector(".status-age")), "Published 1h ago");
    assert.equal(slot.querySelector("button")?.getAttribute("aria-expanded"), "true");
    fillStatus(home, { ...status, createdAt: "invalid" }, render);
    assert.match(text(slot), /Status age unknown/);
    fillStatus(home, null, render);
    assert.match(text(slot), /No project status update yet/);
    fillStatus(home, undefined, render, "Status unavailable");
    assert.match(text(slot), /Status unavailable/);
  });

  it("renders recorded facts and restores only matching truncated board titles", () => {
    const home = homeSkeleton(hooks);
    const status = fixture<{ body: string; createdAt: string }>("project-status.json");
    const full = "Cross-check ostreedev/ostree's CI against bootc's composefs tests";
    fillStatus(home, status, render);
    fillStatus(home, status, render, undefined, Date.now(), [tracked(540, { title: full }), tracked(405, { title: "A different title" })]);
    const slot = home.slots.statusNote;
    assert.doesNotMatch(text(slot), /<!--|bot-board-status-v1|-->/);
    assert.equal(slot.querySelector(`a[href="${TRACKER}/540"]`)?.textContent, full);
    assert.equal(slot.querySelector(`a[href="${TRACKER}/405"]`)?.textContent, "Epic: Clean up the harness:…");
  });
});

describe("row limits and keyboard walking", () => {
  it("previews rows, shows all on request and remembers expansion across redraws", () => {
    const list = () => {
      const slot = document.createElement("div");
      slot.append(...Array.from({ length: 8 }, () => Object.assign(document.createElement("p"), { className: "people-row" })));
      applyLimit(slot);
      return slot;
    };
    const slot = list();
    assert.equal(slot.querySelectorAll(".people-row:not([hidden])").length, 5);
    const last = slot.querySelectorAll<HTMLElement>(".people-row")[7]!;
    slot.querySelector<HTMLButtonElement>(".view-all")!.click();
    assert.equal(last.hidden, false);
    assert.equal(list().querySelectorAll(".people-row:not([hidden])").length, 8);
    slot.querySelector<HTMLButtonElement>(".view-all")!.click();
    assert.equal(slot.querySelectorAll(".people-row:not([hidden])").length, 5);
  });

  it("skips hidden rows and closed folds and clamps at the first and last row", () => {
    const home = homeSkeleton(hooks);
    const row = () => Object.assign(document.createElement("a"), { className: "row" });
    const first = row(), last = row(), hidden = row(), people = row();
    hidden.hidden = true;
    home.sections.needs.body.append(first, hidden, last);
    home.slots.people.append(people);
    assert.deepEqual(walkRows(home.el), [first, last]);
    assert.equal(stepRow([first, last], first, -1), first);
    assert.equal(stepRow([first, last], first, 1), last);
    assert.equal(stepRow([first, last], last, 1), last);
  });
});
