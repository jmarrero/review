import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fillPeople, homeSkeleton, resetExpanded } from "../src/github/homeview.ts";
import type { People, PersonAsk } from "../src/github/people.ts";
import { peopleMeta, peopleView } from "../src/github/peopleview.ts";
import { installDom } from "./helpers.ts";

installDom();
afterEach(resetExpanded);
const row = (n: number, reviewRequested = false): PersonAsk => ({ key: `upstream/widget#${n}`, ref: { owner: "upstream", repo: "widget", number: n }, title: "<script>title</script>", author: "alice", url: `https://github.com/upstream/widget/${reviewRequested ? "pull" : "issues"}/${n}`, action: reviewRequested ? "Review" : "Reply", ci: reviewRequested ? "unknown" : "n/a", notificationIds: [String(n)], reviewRequested });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("header people count", () => {
  it("shows a dash, not a stale or never-filled count, while From people is closed", () => {
    const people: People = { rows: [row(1), row(2)], warnings: [] };
    assert.deepEqual(peopleMeta(undefined, false), { text: "people —", title: "Open From people to read" });
    assert.deepEqual(peopleMeta(people, false), { text: "people —", title: "Open From people to read" });
    assert.equal(peopleMeta(undefined, true).text, "people …");
    assert.equal(peopleMeta(people, true).text, "people 2");
  });
});

describe("From people UI", () => {
  it("sits after Decisions, closed by default, and previews five rows with View all and safe text", () => {
    const home = homeSkeleton({ open: () => true, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
    const people: People = { rows: Array.from({ length: 7 }, (_, i) => row(i + 1)), warnings: [] };
    fillPeople(home, people, Date.now(), { done: async () => {}, changed: () => {} });
    assert.equal(home.el.firstElementChild, home.slots.summary);
    assert.equal(home.el.children[1], home.slots.weekly);
    assert.equal(home.el.children[2]?.id, "sec-needs");
    assert.equal(home.el.children[3], home.slots.status);
    assert.equal(home.el.children[4]?.id, "sec-people");
    assert.equal((home.el.children[4] as HTMLDetailsElement).open, false);
    assert.equal(home.slots.peopleCount.textContent, "7");
    assert.equal(home.slots.people.querySelectorAll(".people-row:not([hidden])").length, 5);
    assert.equal(home.slots.people.querySelector("script"), null);
    assert.match(home.slots.people.textContent ?? "", /request age unknown · CI n\/a/);
    home.slots.people.querySelector<HTMLButtonElement>(".view-all")!.click();
    assert.equal(home.slots.people.querySelectorAll(".people-row:not([hidden])").length, 7);
    fillPeople(home, people, Date.now(), { done: async () => {}, changed: () => {} });
    assert.equal(home.slots.people.querySelectorAll(".people-row:not([hidden])").length, 7);
  });

  it("marks notification-only rows done but retains open review requests", async () => {
    const people: People = { rows: [row(1), row(2, true)], warnings: [] };
    const sent: string[] = [];
    let changes = 0;
    const el = peopleView(people, Date.now(), { done: async (id) => { sent.push(id); }, changed: () => { changes++; } });
    assert.deepEqual([...el.querySelectorAll("a.action")].map((a) => a.getAttribute("href")), ["https://github.com/upstream/widget/issues/1#issuecomment-new", "https://github.com/upstream/widget/pull/2/files"]);
    for (const button of el.querySelectorAll<HTMLButtonElement>("button")) { button.click(); await tick(); }
    assert.deepEqual(sent, ["1", "2"]);
    assert.equal(changes, 2);
    assert.deepEqual(people.rows.map((r) => r.key), ["upstream/widget#2"]);
    assert.deepEqual(people.rows[0]?.notificationIds, []);
  });

  it("labels an unlocated mention and still offers Mark done", () => {
    const people: People = { rows: [{ ...row(1), unlocated: true }], warnings: [] };
    const el = peopleView(people, Date.now(), { done: async () => {}, changed: () => {} });
    assert.match(el.textContent ?? "", /alice · mention \(not located\) · CI n\/a/);
    assert.equal(el.querySelector("button")?.textContent, "Mark done");
  });

  it("reports mark-read failures without dismissing the row and retries only unread IDs", async () => {
    const ask = { ...row(1), notificationIds: ["1", "2"] };
    const people: People = { rows: [ask], warnings: ["Notifications partially unavailable"] };
    const sent: string[] = [];
    let fail = true;
    const el = peopleView(people, Date.now(), { done: async (id) => { sent.push(id); if (id === "2" && fail) throw new Error("denied"); }, changed: () => {} });
    const button = el.querySelector<HTMLButtonElement>("button")!;
    button.click(); button.click(); await tick();
    assert.match(el.textContent ?? "", /Couldn't mark read: denied/);
    assert.equal(button.disabled, false);
    assert.equal(people.rows.length, 1);
    assert.deepEqual(ask.notificationIds, ["2"]);
    fail = false;
    button.click(); await tick();
    assert.deepEqual(sent, ["1", "2", "2"]);
    assert.equal(people.rows.length, 0);
  });

  it("keeps a redrawn mark-read action disabled until the pending write completes", async () => {
    const ask = row(1, true);
    const people: People = { rows: [ask], warnings: [] };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const sent: string[] = [];
    const hooks = { done: async (id: string) => { sent.push(id); await pending; }, changed: () => {} };
    const first = peopleView(people, Date.now(), hooks);
    first.querySelector<HTMLButtonElement>("button")!.click();
    const redraw = peopleView(people, Date.now(), hooks);
    const button = redraw.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.disabled, true);
    assert.match(redraw.textContent ?? "", /Marking read/);
    button.click();
    assert.deepEqual(sent, ["1"]);
    finish();
    await tick();
    assert.equal(ask.marking, undefined);
    assert.equal(peopleView(people, Date.now(), hooks).querySelector("button"), null);
    assert.equal(people.rows.length, 1, "search review request remains actionable");
  });

  it("redraws a failed pending write with its error and an enabled retry", async () => {
    const people: People = { rows: [row(1)], warnings: [] };
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const hooks = { done: () => pending, changed: () => { el = peopleView(people, Date.now(), hooks); } };
    let el = peopleView(people, Date.now(), hooks);
    el.querySelector<HTMLButtonElement>("button")!.click();
    el = peopleView(people, Date.now(), hooks);
    assert.equal(el.querySelector<HTMLButtonElement>("button")!.disabled, true);
    reject(new Error("denied"));
    await tick();
    assert.equal(el.querySelector<HTMLButtonElement>("button")!.disabled, false);
    assert.match(el.textContent ?? "", /Couldn't mark read: denied/);
    assert.deepEqual(people.rows[0]?.notificationIds, ["1"]);
  });
});
