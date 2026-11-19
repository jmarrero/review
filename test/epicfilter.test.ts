import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { epicChips, epicChoice, epicSelection, saveEpicChoice } from "../src/github/epicfilter.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { documentCard, inboxCards } from "../src/github/inbox.ts";
import { fillInbox, type InboxHooks } from "../src/github/inboxview.ts";
import { parseRoute } from "../src/github/keys.ts";
import { createRenderer } from "../src/markdown.ts";
import { parseDocument } from "../src/github/decisiondocument.ts";
import { fixture, installDom } from "./helpers.ts";

const win = installDom();
// agent-board#661's needs_you as the publisher serializes it (see README).
const raw = fixture<Record<string, unknown>>("needs-you-661.json");
const parsed = parseNeedsYou(raw);
assert.ok(typeof parsed === "object");
const cards = inboxCards({ published: { asks: parsed.items, list: parsed, unavailable: false } });
const key = (n: string) => `jmarrero-forge/${n}`;
const hooks: InboxHooks = { now: Date.parse(parsed.validatedAt), mayAct: true, render: createRenderer(win as unknown as Parameters<typeof createRenderer>[0]), answerEntry: async () => {} };

test("661 publication: epic chain, activity map and an identity without its detail", () => {
  assert.equal(parsed.epics?.length, 4);
  assert.deepEqual(parsed.epics?.find((e) => e.focus), { item: key("tracker#976"), active: true, complete: true, focus: true, activeWhy: ["focus", "operator-comment"] });
  const chained = parsed.items.find((a) => a.key === key("agent-board#650"))!;
  assert.deepEqual([chained.epic, chained.topEpic], [key("agent-board#600"), key("tracker#976")]);
  assert.equal(parsed.items.find((a) => a.key === key("tracker#1300"))!.epic, "unknown");
  assert.equal(cards.length, 8, "every published identity is a card, detail or not");
  assert.equal(cards.at(-1)!.key, key("tracker#1310"));
  assert.deepEqual([parsed.complete, parsed.count, parsed.omitted, parsed.detailsOmitted], [false, 8, 0, 1]);
  assert.equal(parsed.identities!.at(-1)!.requestsUnreadable, true, "missing descriptor remains unknown even after detail eviction");
});

test("661 publication: in-progress default, focus first, approvals first, honest chip counts", () => {
  const model = epicSelection(cards, parsed.epics, "active");
  assert.deepEqual(model.active.map((e) => e.item), [key("tracker#976"), key("tracker#1100")]);
  // An unknown chain, and an inactive epic read in part, are no proof of inactivity: kept.
  assert.deepEqual(model.selected.map((c) => c.key).sort(), [key("agent-board#650"), key("agentic-job#2110"), key("agentic-job#2900"), key("tracker#1261"), key("tracker#1300"), key("tracker#1310")].sort());
  assert.deepEqual([model.hidden, model.unsure], [2, 2]);
  // tracker#1261 waits only on an approval: first, ahead of the five-day-old P0 asks outside the epics in progress.
  // tracker#1310, an approval without its detail, still ranks ahead of every full non-approval row.
  assert.deepEqual(model.ordered.map((c) => c.key), [
    key("tracker#1261"), key("agentic-job#2900"), key("tracker#1300"), key("tracker#1310"), key("agent-board#650"),
    key("agentic-job#2110"), key("composefs-rs#33"), key("bot-ops#5/comment-21"),
  ]);
  assert.deepEqual(["other", "none", "all", `epic:${key("tracker#976")}`, `epic:${key("tracker#1100")}`].map((f) => model.count(f as never)), [2, 2, 8, 2, 2]);
  let chosen = "";
  const chips = epicChips(model, "active", (f) => { chosen = f; });
  assert.match(chips.textContent!, /2 epics in progress: tracker#976 \(focus, the operator's comment this week\), tracker#1100 \(a run in 48 hours, an open PR\)\. Shown by default, plus approvals, with 2 whose epic is unknown or not read whole\./);
  const labels = [...chips.querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(labels, ["In progress + approvals · 6", "Focus: tracker#976 · 2", "tracker#1100 · 2", "Other epics · 2", "No epic · 2", "Show everything · 8"]);
  chips.querySelectorAll<HTMLButtonElement>("button")[5]!.click();
  assert.equal(chosen, "all");
  const twin = epicChips(epicSelection(cards, [...parsed.epics!, { item: "other/tracker#976", active: true, activeWhy: ["open-pr"], complete: true, focus: false }], "active"), "active", () => {});
  assert.match(twin.textContent!, /Focus: jmarrero-forge\/tracker#976 · 2.*other\/tracker#976 · 0/, "chips stay distinct without the owner");
});

test("a capped publication: placeholders only, approvals still first, the cap counted apart", () => {
  // fit() cuts context, then every detail card with its descriptors, before any identity.
  const capped = parseNeedsYou({ ...raw, complete: false, items: [], requests: undefined, omitted: 2, omitted_sources: { reviews: 2 }, count: 10, counts: { decisions: 10, groups: 0, members: 10 }, details_omitted: 10 });
  assert.ok(typeof capped === "object");
  assert.deepEqual([capped.complete, capped.omitted, capped.items.length, capped.identities?.length], [false, 2, 0, 8]);
  const placeholders = inboxCards({ published: { asks: [], list: capped, unavailable: false } });
  assert.ok(placeholders.every((c) => "ask" in c && c.ask.detailMissing && c.kind === "open"));
  const model = epicSelection(placeholders, capped.epics, "active");
  assert.deepEqual(model.ordered.slice(0, 4).map((c) => c.key), [key("tracker#1261"), key("agentic-job#2900"), key("tracker#1310"), key("tracker#1300")]);
});

test("missing or malformed activity hides nothing, and neither does a list with no epic in progress", () => {
  const map = raw.epics as Record<string, Record<string, unknown>>;
  const bad = [undefined, Object.values(map), { ...map, x: { active: true, activeWhy: [], complete: true } }, { [key("tracker#1")]: { active: true, activeWhy: ["Focus!"], complete: true } }, { [key("tracker#1")]: { active: true, activeWhy: [] } }];
  for (const epics of bad) {
    const p = parseNeedsYou({ ...raw, epics });
    assert.ok(typeof p === "object");
    assert.equal(p.epics, undefined, JSON.stringify(epics));
  }
  const idle = parsed.epics!.map((e) => ({ ...e, active: false, focus: false }));
  for (const epics of [[], idle]) {
    const model = epicSelection(cards, epics, "active");
    assert.deepEqual([model.selected.length, model.hidden], [8, 0]);
    const chips = epicChips(model, "other", () => {});
    assert.match(chips.textContent!, /No epic is published as in progress\. The default shows all published rows/);
    assert.match(chips.textContent!, /Default \(all\) · 8/);
    assert.doesNotMatch(chips.textContent!, /In progress ·/);
    // With every epic inactive, Other epics is everything but No epic.
    assert.deepEqual(["active", "all", "other", "none"].map((f) => model.count(f as never)), [8, 8, 6, 2]);
    assert.match(chips.textContent!, /Selected: other epics/);
  }
});

test("epic sorting keeps pending published asks before local cards and completed cards last", () => {
  const entry = documentCard(parseDocument("### D1 Pick one\n- [ ] A) Yes\nReply:\n")[0]!, undefined)!;
  const done = { ...entry, key: "done", answered: true };
  const [p0, , chained, approve] = cards;
  const ordered = epicSelection([done, entry, p0!, chained!, approve!], parsed.epics, "all").ordered;
  assert.deepEqual(ordered.map((c) => c.key), [approve!.key, chained!.key, p0!.key, entry.key, "done"]);
});

test("bare epic links and viewer-specific choices survive blocked storage", () => {
  assert.deepEqual(parseRoute("#epic-976"), { route: "home", view: "inbox" });
  assert.equal(epicChoice("one", "#epic-976"), "epic:jmarrero-forge/tracker#976");
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storageWindow = new JSDOM("", { url: "https://example.test" }).window;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storageWindow.localStorage });
  saveEpicChoice("one", "none");
  saveEpicChoice("two", "all");
  assert.equal(epicChoice("ONE", ""), "none");
  assert.equal(epicChoice("two", ""), "all");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  assert.doesNotThrow(() => saveEpicChoice("one", "all"));
  assert.equal(epicChoice("one", ""), "active");
  if (old) Object.defineProperty(globalThis, "localStorage", old);
  else Reflect.deleteProperty(globalThis, "localStorage");
  storageWindow.close();
});

test("approve rows: one line with what the pass publishes, and Approve submits its head", async () => {
  const list = document.createElement("div");
  const calls: string[] = [];
  win.confirm = () => true;
  fillInbox(list, cards, { ...hooks, approve: async (_a, head) => { calls.push(head); return { pr: { owner: "jmarrero-forge", repo: "tracker", number: 1261 }, status: "approved", url: "https://github.com/jmarrero-forge/tracker/pull/1261#review" }; }, answerBody: async () => document.createElement("form") });
  const row = list.querySelector<HTMLElement>(`[data-key="${key("tracker#1261")}"]`)!;
  assert.ok(row.classList.contains("c-approve"));
  assert.match(row.textContent!, /Controller PR approved by the review job.*jmarrero-forge\/tracker#1261 · review-approve/);
  assert.match(row.querySelector(".approval-evidence")!.textContent!, /^Diff, CI and review unknown: no matching published evidenceReview the diff$/);
  assert.equal(row.querySelector<HTMLAnchorElement>(".approval-evidence a")!.getAttribute("href"), "#pr/jmarrero-forge/tracker/1261");
  const withheld = document.createElement("div");
  fillInbox(withheld, cards.filter((c) => c.key === key("tracker#1300")), hooks);
  assert.match(withheld.querySelector(".card-head")!.textContent!, /Review withheld/);
  assert.equal(row.querySelector(".card-full"), null, "nothing to unfold: the row is the action");
  row.querySelector<HTMLButtonElement>("button")!.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["a".repeat(40)]);
  assert.match(row.textContent!, /checks and merge policy still decide/);
  // Compact asks: the generic ask is marked, its body is folded away.
  const generic = list.querySelector<HTMLElement>(`[data-key="${key("agentic-job#2110")}"]`)!;
  assert.match(generic.textContent!, /missing-concrete-decision/);
  assert.equal(generic.querySelector<HTMLDetailsElement>(".card-full")!.open, false);
});

test("filter changes preserve unsent forms without counting or retiring filtered-out cards", () => {
  const host = document.createElement("div");
  const list = document.createElement("div");
  host.append(list);
  document.body.append(host);
  fillInbox(list, cards, hooks);
  const first = list.firstElementChild as HTMLElement;
  const input = document.createElement("input");
  input.type = "text";
  input.value = "unsent";
  const form = document.createElement("form");
  form.append(input);
  first.append(form);
  const only = new Set([cards[1]!.key]);
  assert.equal(fillInbox(list, cards, hooks, false, only), 1);
  assert.equal(first.hidden, true);
  assert.equal(input.value, "unsent");
  assert.equal(first.querySelector(".card-stale-note"), null);
  fillInbox(list, cards, hooks);
  assert.equal(first.hidden, false);
  assert.equal(input.value, "unsent");
  host.remove();
});

test("Show everything recovers a filtered draft after its publication disappears", () => {
  const list = document.createElement("div");
  fillInbox(list, cards, hooks);
  const first = list.firstElementChild as HTMLElement;
  const input = document.createElement("input");
  input.type = "text";
  input.value = "unsent answer";
  const form = document.createElement("form");
  form.append(input);
  first.append(form);
  const only = new Set([cards[1]!.key]);
  fillInbox(list, cards, hooks, false, only);
  const remaining = cards.slice(1);
  assert.equal(fillInbox(list, remaining, hooks, false, only), 1);
  assert.equal(first.hidden, true);
  assert.equal(fillInbox(list, remaining, hooks), remaining.length);
  assert.equal(first.hidden, false);
  assert.equal(input.value, "unsent answer");
  assert.match(first.textContent!, /This has left the inbox/);
  assert.equal(first.getAttribute("data-href"), "#");
});

test("a poll dropping an ask preserves its already-visible draft without counting it", () => {
  const list = document.createElement("div");
  const selection = epicSelection(cards, parsed.epics, "active");
  fillInbox(list, cards, hooks, false, new Set(selection.selected.map((c) => c.key)));
  const shown = list.querySelector<HTMLElement>(`[data-key="${key("agent-board#650")}"]`)!;
  const form = document.createElement("form");
  const text = document.createElement("textarea");
  text.value = "still composing";
  form.append(text);
  shown.append(form);
  const remaining = cards.filter((c) => c.key !== key("agent-board#650"));
  const next = epicSelection(remaining, parsed.epics, "active");
  assert.equal(fillInbox(list, remaining, hooks, false, new Set(next.selected.map((c) => c.key))), 5);
  assert.equal(shown.hidden, false);
  assert.equal(text.value, "still composing");
});
