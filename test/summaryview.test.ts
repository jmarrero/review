// The summary at the top of the page: made from what the sections read,
// with no read of its own.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveAgent } from "../src/github/agents.ts";
import type { ControllerData } from "../src/github/controller.ts";
import { fillSummary, homeSkeleton } from "../src/github/homeview.ts";
import type { ActionRun, RunsData } from "../src/github/runs.ts";
import { pageState } from "../src/github/state.ts";
import { parseUsage, USAGE_MARKER } from "../src/github/usage.ts";
import { time } from "../src/github/view.ts";
import { fixture, installDom } from "./helpers.ts";

const win = installDom();
const NOW = Date.parse("2026-10-09T14:00:00Z");
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const noHooks = { open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} };

const run = (id: number, status: string, title: string): ActionRun => ({
  id, title, status, active: true, url: `https://github.com/example/runs/actions/runs/${id}`, startedAt: "2026-10-09T13:30:00Z",
  createdAt: "2026-10-09T13:30:00Z", attempt: 1, jobs: [], metrics: { tokens: null, cost: null },
});

describe("the summary", () => {
  const runs: RunsData = { state: "ok", at: NOW, partial: false, warnings: [], runs: [run(1, "in_progress", "Agent: implement example/work#3"), run(2, "queued", "Agent: review example/work#4")] };
  const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-pools.json"))}\n\`\`\``)!;
  usage.mistral!.budget = { limitUsd: 300, since: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" };
  const state = pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage } }, runs }, NOW);

  it("comes first, and says agents, queued runs and each pool in a line, with held marked", () => {
    const home = homeSkeleton(noHooks);
    win.document.body.replaceChildren(home.el);
    fillSummary(home, state, undefined, NOW);
    assert.equal(home.el.firstElementChild, home.slots.summary);
    const lines = [...home.slots.summary.querySelectorAll("li")].map(text);
    assert.match(lines[0]!, /^Agents \d+ running/);
    assert.match(lines[1]!, /^Queued 1 run · Agent: review example\/work#4$/);
    assert.equal(lines[2], "Scheduler mode and last passes not read: they are read when the ops detail is opened");
    assert.deepEqual(lines.slice(3), [
      "Claude 42% used · 52% of week gone · ~81% at reset · stale: read 23m ago",
      `OpenAI 80% used · 32% of week gone · ~253% at reset · over pace: 30% allowed by now · new work held until ${time("2026-10-13T00:57:18.315Z")}`,
      "Mistral spend not published · $300 a month, 28% gone",
    ]);
    assert.ok(home.slots.summary.querySelectorAll("li")[4]!.classList.contains("hot"));
    assert.equal(home.slots.summary.querySelector<HTMLAnchorElement>("li:nth-child(2) a:not(.sum-jump)")?.href, "https://github.com/example/runs/actions/runs/2");
  });

  it("says what unconfirmed agents are, and a hold with no end given", () => {
    const home = homeSkeleton(noHooks);
    const openai = { ...usage.pools!.openai! };
    delete openai.nextDispatchAt;
    const held = pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage: { ...usage, pools: { openai } } } }, runs }, NOW);
    fillSummary(home, { ...held, agents: { ...held.agents, executionKnown: true, unconfirmed: 7 } }, undefined, NOW);
    const lines = [...home.slots.summary.querySelectorAll("li")].map(text);
    assert.match(lines[0]!, /^Agents \d+ running.* · 7 claimed or last seen, not confirmed running/);
    assert.equal(lines[3], "OpenAI 80% used · 32% of week gone · ~253% at reset · over pace: 30% allowed by now · new work held");

    // A dispatch time already past promises no end, and the reading's age says why.
    const later = Date.parse("2026-10-13T12:00:00Z");
    fillSummary(home, pageState({ active: { warnings: [], at: later, usage: { state: "ok", usage } }, runs }, later), undefined, later);
    const openaiLine = [...home.slots.summary.querySelectorAll("li")].map(text).find((l) => l.startsWith("OpenAI"));
    assert.equal(openaiLine, `OpenAI 80% used · 32% of week gone · ~253% at reset · over pace: 30% allowed by now · new work held (was due to end ${time("2026-10-13T00:57:18.315Z")}) · stale: read 94h 01m ago`);
  });

  it("keeps its lines while what they say is unchanged, and says when usage can't be read", () => {
    const home = homeSkeleton(noHooks);
    fillSummary(home, state, undefined, NOW);
    const first = home.slots.summary.firstElementChild;
    fillSummary(home, state, undefined, NOW);
    assert.equal(home.slots.summary.firstElementChild, first);
    fillSummary(home, pageState({ active: { warnings: [], at: NOW, usage: { state: "unreadable" } }, runs }, NOW), undefined, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[3]), "Resources unreadable with this token");
  });

  it("links open the section they point at without changing the route", () => {
    const home = homeSkeleton(noHooks);
    win.document.body.replaceChildren(home.el);
    Object.assign(win.HTMLElement.prototype, { scrollIntoView() {} });
    fillSummary(home, state, undefined, NOW);
    const hash = win.location.hash;
    assert.equal(home.sections.agents.details.open, false);
    home.slots.summary.querySelector<HTMLAnchorElement>('a[href="#sec-agents"]')!.click();
    assert.equal(home.sections.agents.details.open, true);
    home.slots.summary.querySelector<HTMLAnchorElement>('a[href="#ops"]')!.click();
    assert.equal(home.slots.opsBox.open, true);
    assert.equal(win.location.hash, hash);
  });

  it("reads the scheduler's mode, the poll's pass and the broker probe's run from the controller, once the ops detail has read it", () => {
    const home = homeSkeleton(noHooks);
    const piece = (label: string) => ({ label, what: "x", repo: "example/tracker", workflow: "poll.yml" });
    const controller: ControllerData = { pieces: [
      { piece: piece("Board scheduler"), state: "ok", scheduler: { mode: "preview" }, last: { url: "https://github.com/x", at: "2026-10-09T13:50:00Z", conclusion: "success" } },
      { piece: piece("Poll"), state: "ok", last: { url: "https://github.com/x", at: "2026-10-09T13:55:00Z", conclusion: "success" } },
      { piece: piece("Broker probe"), state: "ok", last: { url: "https://github.com/x", at: "2026-10-09T12:00:00Z", conclusion: "failure" } },
    ] };
    fillSummary(home, state, controller, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[2]), "Scheduler board previewing (dry run) · poll ok 5m ago · broker failure 2h 00m ago");
    controller.pieces[2] = { ...controller.pieces[2]!, last: { url: "https://github.com/x", at: "2026-10-09T13:45:00Z", conclusion: "success" } };
    fillSummary(home, state, controller, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[2]), "Scheduler board previewing (dry run) · poll ok 5m ago · broker ok 15m ago");
    // Its usual state while tracker's BROKER_OUTAGE isn't apply: the job is skipped, not passed.
    controller.pieces[2] = { ...controller.pieces[2]!, last: { url: "https://github.com/x", at: "2026-10-09T13:45:00Z", conclusion: "skipped" } };
    fillSummary(home, state, controller, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[2]), "Scheduler board previewing (dry run) · poll ok 5m ago · broker skipped 15m ago");
    // Not yet read (a workflow with no runs): said, not left out.
    controller.pieces[2] = { piece: piece("Broker probe"), state: "absent" };
    fillSummary(home, state, controller, NOW);
    assert.equal(text(home.slots.summary.querySelectorAll("li")[2]), "Scheduler board previewing (dry run) · poll ok 5m ago · broker no pass");
  });

  const agent = (name: string, more: Partial<ActiveAgent>): ActiveAgent => ({
    name, location: "remote", status: "run", source: "actions", lane: "harness", stale: false,
    ...(more.location === "local" ? {} : { runUrl: `https://github.com/example/runs/actions/runs/${name}` }), ...more,
  });

  it("groups running agents by pool and links the first four, counting the rest", () => {
    const home = homeSkeleton(noHooks);
    const agents = [
      agent("a1", { engine: "claude" }),
      agent("a2", { engine: "openai" }),
      agent("a3", { engine: "claude" }),
      agent("a4", {}),
      agent("a5", { location: "local", itemUrl: "https://github.com/example/work/issues/5", itemRef: "example/work#5" }),
      agent("a6", { engine: "claude" }),
      agent("gone", { engine: "claude", stale: true }),
    ];
    fillSummary(home, { ...state, agents: { ...state.agents, executionKnown: true, unconfirmed: 0, agents } }, undefined, NOW);
    const line = home.slots.summary.querySelector("li")!;
    assert.equal(text(line), "Agents 6 running (claude 3, openai 1, Actions 1, local 1) · a1 · a2 · a3 · a4 · +2");
    assert.deepEqual([...line.querySelectorAll("a:not(.sum-jump)")].map((a) => a.getAttribute("href")), ["a1", "a2", "a3", "a4"].map((n) => `https://github.com/example/runs/actions/runs/${n}`));
  });

  it("shows a link whose URL isn't https as plain text", () => {
    const home = homeSkeleton(noHooks);
    const evil = "javascript:alert(1)";
    const agents = [agent("a1", { engine: "claude", runUrl: evil, itemUrl: evil })];
    const queued = { ...run(9, "queued", "Agent: triage example/work#9"), url: evil };
    fillSummary(home, { ...state, agents: { ...state.agents, executionKnown: true, unconfirmed: 0, agents }, runs: { ...state.runs!, runs: [queued] } }, undefined, NOW);
    const [agentsLine, queuedLine] = home.slots.summary.querySelectorAll("li");
    assert.equal(text(agentsLine), "Agents 1 running (claude 1) · a1");
    assert.equal(text(queuedLine), "Queued 1 run · Agent: triage example/work#9");
    assert.equal(home.slots.summary.querySelectorAll("a:not(.sum-jump)").length, 0);
    assert.ok(![...home.slots.summary.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("javascript:")));
  });

  it("marks a pool over pace that the scheduler hasn't held yet", () => {
    const home = homeSkeleton(noHooks);
    const claude = { ...usage.pools!.claude!, usedPercent: 60, observedAt: "2026-10-09T13:50:00.000Z" };
    fillSummary(home, pageState({ active: { warnings: [], at: NOW, usage: { state: "ok", usage: { ...usage, pools: { claude } } } }, runs }, NOW), undefined, NOW);
    const line = [...home.slots.summary.querySelectorAll("li")].find((l) => text(l).startsWith("Claude"))!;
    assert.equal(text(line), "Claude 60% used · 52% of week gone · ~116% at reset · over pace: 49% allowed by now");
    assert.ok(line.classList.contains("hot"));
  });
});
