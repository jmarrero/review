// The one page: its sections, their counts and defaults, and the few
// rows shown before "View all".

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Active } from "../src/github/agents.ts";
import type { Item } from "../src/github/board.ts";
import { applyLimit, COUNT_CLASS, DECISION_LIMIT, fillAgents, fillFocus, fillStatus, focusStatus, fillNeeds, fillPriority, fillUsage, type Home, type HomeHooks, homeSkeleton, resetExpanded, reveal, setSectionOpen, stepRow, VIEW_ALL_CLASS, walkRows } from "../src/github/homeview.ts";
import { buildNeeds } from "../src/github/needs.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { needsSignature } from "../src/github/needsview.ts";
import { PREVIEW_ROWS, SECTION_TITLE, SECTIONS, type SectionId } from "../src/github/sections.ts";
import type { RawComment } from "../src/github/heartbeat.ts";
import { findUsage, type MistralAllowance, parseUsage, USAGE_MARKER, type UsageData } from "../src/github/usage.ts";
import { time } from "../src/github/view.ts";
import { createRenderer } from "../src/markdown.ts";
import { fixture, installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const TRACKER = "https://github.com/jmarrero-forge/tracker/issues";
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function hooks(open: SectionId[] = [], log: string[] = []): HomeHooks {
  return {
    open: (id) => open.includes(id),
    toggled: (id, o) => log.push(`${id}:${o}`),
    opsToggled: (o) => log.push(`ops:${o}`),
    themesToggled: (o) => log.push(`themes:${o}`),
  };
}

function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return {
    id: 0, nodeId, kind: "issue", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], status: "Needs human",
    url: `${TRACKER}/${number}`, ref: { owner: "jmarrero-forge", repo: "tracker", number }, state: "open", author: "jmarrero-bot", assignees: ["jmarrero"], ...over,
  };
}

/** n open questions in the tracker. */
function questions(n: number): Item[] {
  return Array.from({ length: n }, (_, i) =>
    tracked(`PVTI_q${i}`, 100 + i, { labels: ["question"], body: `Blocks: ${TRACKER}/9\nQ: which ${i}?\nOptions:\nA) this\nB) that\n`, priority: "P1", createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
  );
}

const needsHooks = (sent: unknown[] = []) => ({
  login: "jmarrero",
  now: Date.parse("2026-02-01T00:00:00Z"),
  render,
  labelOf: () => undefined,
  send: async (n: { key: string }, a: unknown) => (sent.push([n.key, a]), "https://github.com/c/1"),
});

afterEach(() => resetExpanded());

describe("operator dashboard", () => {
  it("shows tracker's current snapshot, not an older one left on the issue", () => {
    const home = homeSkeleton(hooks());
    const usage = findUsage(fixture<RawComment[]>("usage-snapshot.json"))!;
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-18T14:44:00Z"));
    const shown = text(home.slots.weekly);
    assert.match(shown, /Claude.*73\.0% used.*allows by now: 73\.2%\./);
    assert.match(shown, /OpenAI.*1\.0% used.*allows by now: 15\.4%\./);
    assert.doesNotMatch(shown, /held|stale/);
    assert.match(text(home.slots.weekly.querySelector(".mistral .pool-sum")), /\$41\.25 \/ \$300/);
    assert.ok(shown.includes(`Published ${time("2026-10-18T14:42:00Z")}.`), shown);
  });

  it("lists the day's runs under the pools, largest first, with totals by kind and repository", () => {
    const home = homeSkeleton(hooks());
    const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-runs.json"))}\n\`\`\``)!;
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-18T14:44:00Z"));
    const spend = home.slots.weekly.querySelector(".spend")!;
    assert.equal(text(spend.querySelector("h3")), "By run, last day");
    assert.deepEqual([...spend.querySelectorAll("th")].map((th) => text(th)), ["Pool", "Kind", "Repository", "Item", "Tokens", "Finished"]);
    const rows = [...spend.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => text(td)));
    assert.deepEqual(rows.map((r) => r.slice(0, 5)), [
      ["Claude", "implement", "jmarrero-forge/review", "jmarrero-forge/review#99", "44.0M"],
      ["Claude", "review", "jmarrero-forge/review", "jmarrero-forge/review#97", "8.3M"],
      ["OpenAI", "review", "jmarrero-forge/tracker", "jmarrero-forge/tracker#797", "3.1M"],
      ["Mistral", "unknown", "jmarrero-forge/agentic-job", "—", "520k"],
    ]);
    assert.equal(rows[0]?.[5], time("2026-10-18T13:30:00Z"));
    const links = [...spend.querySelectorAll("tbody tr:first-child a")].map((a) => a.getAttribute("href"));
    assert.deepEqual(links, ["https://github.com/jmarrero-forge/review/issues/99", "https://github.com/jmarrero-forge/review/actions/runs/19876543210"]);
    assert.equal(spend.querySelector("tbody td.num")?.getAttribute("title"), "120k input, 310k output, 41.0M cache read, 2.6M cache write, in 412 requests");
    assert.match(text(spend), /By kind: implement 44\.0M \(1 run\) · review 11\.4M \(2 runs\) · unknown 520k \(1 run\)\./);
    assert.match(text(spend), /By repository: jmarrero-forge\/review 52\.3M \(2 runs\) · jmarrero-forge\/tracker 3\.1M \(1 run\) · jmarrero-forge\/agentic-job 520k \(1 run\)\./);
    assert.doesNotMatch(text(spend), /#90/, "the run of two days ago is not shown");
    assert.match(text(home.slots.weekly), /Claude.*73\.0% used/, "the pool rows stay above it");
  });

  it("says when the snapshot attributes nothing to runs, and when no run finished in the day", () => {
    const home = homeSkeleton(hooks());
    const usage = findUsage(fixture<RawComment[]>("usage-snapshot.json"))!;
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-18T14:44:00Z"));
    assert.match(text(home.slots.weekly.querySelector(".spend .fine")), /^Not published: the snapshot carries no runs list/);
    assert.equal(home.slots.weekly.querySelector(".spend-runs"), null);
    fillUsage(home, { state: "ok", usage: { ...usage, runs: [] } }, undefined, Date.parse("2026-10-18T14:44:00Z"));
    assert.match(text(home.slots.weekly.querySelector(".spend")), /No run finished in the last day\./);
  });

  it("reads both published pools, marks held and over-pace usage, and keeps questions open", () => {
    const home = homeSkeleton(hooks());
    const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-pools.json"))}\n\`\`\``)!;
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-09T14:00:00Z"));
    assert.match(text(home.slots.weekly), /Claude.*42\.0% used with 51\.5% of the week gone, so ~81% by its end at this rate\. The tick is what the scheduler allows by now: 49\.2%\./);
    assert.match(text(home.slots.weekly), /OpenAI.*80\.0% used with 31\.7% of the week gone.*allows by now: 30\.1% · over pace · new work held until /);
    assert.match(text(home.slots.weekly), /Publication time unknown/);
    assert.match(text(home.slots.weekly.querySelector(".pool-sum.mistral")), /^Mistral 2,500 requests · 1,234,567 tokens since the broker started$/);
    assert.equal(home.slots.weekly.querySelector(".mistral [role=progressbar]"), null, "counters have no bar");
    const budget = { limitUsd: 300, since: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z", url: "https://github.com/example/tracker/blob/main/pools.json" };
    fillUsage(home, { state: "ok", usage: { ...usage, mistral: { ...usage.mistral!, budget } } }, undefined, Date.parse("2026-10-16T12:00:00Z"));
    const allowed = home.slots.weekly.querySelector<HTMLDetailsElement>('details.mistral[data-pool="mistral"]')!;
    assert.equal(text(allowed.querySelector("summary")), "Mistral spend ? / $300 · 50% of month gone");
    assert.equal(allowed.querySelector(".fill"), null, "no spend is made up from the broker's counters");
    assert.equal(allowed.querySelector(".tick")?.getAttribute("x"), String((100 * 15.5) / 31 - 0.5));
    assert.match(text(allowed.querySelector(".pool-detail")), /\$300\.00 a calendar month, 50% of it gone · resets in 15 days, on Nov 1 UTC\. Allowance ↗.*no spend.*2,500 requests/);
    fillUsage(home, { state: "ok", usage: Object.fromEntries(Object.entries(usage).filter(([k]) => k !== "mistral")) as typeof usage }, undefined, Date.parse("2026-10-09T14:00:00Z"));
    assert.equal(home.slots.weekly.querySelector(".mistral"), null, "an older broker's snapshot shows no Mistral row");
    const withAllowance = (allowance: MistralAllowance) => ({ ...usage, mistral: { ...usage.mistral!, allowance } });
    const now = Date.parse("2026-10-14T10:00:00Z");
    fillUsage(home, { state: "ok", usage: withAllowance({ limitUsd: 300, resetsAt: "2026-11-01T12:00:00Z", spentUsd: 0.92, estimated: false, unpriced: [], lowerBound: false }) }, undefined, now);
    const meter = () => home.slots.weekly.querySelector<HTMLDetailsElement>('details.mistral[data-pool="mistral"]')!;
    assert.equal(text(meter().querySelector("summary")), "Mistral $0.92 / $300 · 18d left");
    assert.equal(meter().querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"), String((100 * 0.92) / 300));
    assert.equal(meter().querySelector(".tick"), null, "no pace without a window start");
    assert.match(text(meter().querySelector(".pool-detail")), /\$0\.92 of the \$300\.00 monthly allowance · resets in 18 days, on Nov 1 UTC .*2,500 requests · 1,234,567 tokens since the broker started\./);
    assert.doesNotMatch(text(meter()), /estimate/i);
    fillUsage(home, { state: "ok", usage: withAllowance({ limitUsd: 300, resetsAt: "2026-11-01T12:00:00Z", spentUsd: 2.75, estimated: true, unpriced: ["codestral-latest"], lowerBound: true }) }, undefined, now);
    assert.equal(text(meter().querySelector("summary")), "Mistral ≥ ~$2.75 / $300 est. · 18d left");
    assert.match(text(meter().querySelector(".pool-detail")), /\(estimate\).*not Mistral's own figure\. No price for codestral-latest\./);
    fillUsage(home, { state: "ok", usage: withAllowance({ limitUsd: 300, resetsAt: "2026-10-01T12:00:00Z", spentUsd: 310, estimated: false, unpriced: [], lowerBound: false }) }, undefined, now);
    assert.ok(meter().classList.contains("over"));
    fillUsage(home, { state: "ok", usage: withAllowance({ limitUsd: 300, resetsAt: "2026-11-01T00:00:00Z", spentUsd: 1, estimated: false, unpriced: [], lowerBound: false }) }, undefined, now);
    assert.match(text(meter().querySelector(".pool-detail")), /on Nov 1 UTC/, "a reset at midnight UTC is on the 1st, whatever the viewer's zone");
    fillUsage(home, { state: "ok", usage: withAllowance({ limitUsd: 300, resetsAt: "2026-10-01T12:00:00Z", spentUsd: 310, estimated: false, unpriced: [], lowerBound: false }) }, undefined, now);
    assert.equal(meter().querySelector(".fill")?.getAttribute("width"), "100");
    assert.match(text(meter()), /reset passed.*reset Oct 1 UTC; the spend is from before/);
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-09T14:00:00Z"));
    assert.doesNotMatch(text(home.slots.usage), /Invalid Date|not reported yet/);
    assert.equal(home.sections.needs.details.open, true);
    assert.equal(home.slots.weekly.nextElementSibling, home.sections.needs.details);
    assert.equal(home.sections.needs.details.nextElementSibling, home.slots.status);
  });

  it("shows each pool as a compact bar with a pace tick, the sentence folded away", () => {
    const home = homeSkeleton(hooks());
    const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-pools.json"))}\n\`\`\``)!;
    const at = (iso: string) => fillUsage(home, { state: "ok", usage }, undefined, Date.parse(iso));
    const pool = (name: string) => home.slots.weekly.querySelector<HTMLDetailsElement>(`details[data-pool="${name}"]`)!;
    const attrs = (el: Element | null, ...names: string[]) => names.map((n) => el?.getAttribute(n));
    at("2026-10-09T13:50:00Z");
    // pool, its label, over pace or held, [valuenow, valuetext], the fill's width and the tick's x
    const cases = [
      ["claude", "42% used · 52% of week gone · ~81% at reset", false, ["42", "42.0% used, 49.2% allowed by pace"], "42", "48.7129230406746"],
      ["openai", `80% used · 32% of week gone · ~253% at reset · new work held until ${time("2026-10-13T00:57:18.315Z")}`, true, ["80", `80.0% used, 30.1% allowed by pace, over pace, new work held until ${time("2026-10-13T00:57:18.315Z")}`], "80", "29.60736748511905"],
    ] as const;
    for (const [name, label, over, aria, fill, tick] of cases) {
      const d = pool(name);
      assert.equal(d.open, false, name);
      assert.equal(text(d.querySelector(".pool-label")), label);
      assert.equal(d.classList.contains("over"), over, name);
      const bar = d.querySelector("summary [role=progressbar]");
      assert.deepEqual(attrs(bar, "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"), ["0", "100", ...aria]);
      assert.deepEqual([attrs(bar!.querySelector(".fill"), "width")[0], attrs(bar!.querySelector(".tick"), "x")[0]], [fill, tick]);
      assert.match(text(d.querySelector(".pool-detail")), /scheduler allows by now: .*resets .*Observed [^·]*\.$/);
      assert.doesNotMatch(text(d.querySelector(".pool-detail")), /stale/);
    }
    assert.equal(home.slots.weekly.querySelector(".warn"), null, "no warning boxes");

    pool("openai").open = true;
    at("2026-10-10T14:00:00Z");
    assert.deepEqual([pool("claude").open, pool("openai").open], [false, true], "a redraw keeps his expander open");
    assert.equal(text(pool("claude").querySelector(".pool-label")), "42% used · 52% of week gone · ~81% at reset · stale: read 24h 23m ago");
    assert.match(pool("claude").querySelector("[role=progressbar]")!.getAttribute("aria-valuetext")!, /, stale$/);
    assert.match(text(pool("claude").querySelector(".pool-detail")), /Observed .*, 24h 23m ago · stale: the usage publisher has not reported since\.$/);

    fillUsage(home, { state: "ok", usage: { ...usage, pools: { claude: { ...usage.pools!.claude!, usedPercent: 130, allowedPercent: 100 } } } }, undefined, Date.parse("2026-10-09T13:50:00Z"));
    const full = pool("claude").querySelector("[role=progressbar]")!;
    assert.deepEqual([attrs(full, "aria-valuenow")[0], attrs(full.querySelector(".fill"), "width")[0], attrs(full.querySelector(".tick"), "x")[0]], ["100", "100", "99"]);
    assert.match(text(home.slots.weekly.querySelector(".pool-sum.none")), /OpenAI No reading · snapshot age unknown/);

    // Two hours into a week: the share gone, but too early to project.
    fillUsage(home, { state: "ok", usage: { ...usage, pools: { openai: { ...usage.pools!.openai!, observedAt: "2026-10-07T10:47:12.000Z", usedPercent: 3 } } } }, undefined, Date.parse("2026-10-07T10:50:00Z"));
    assert.equal(text(pool("openai").querySelector(".pool-label")), `3% used · 1% of week gone · new work held until ${time("2026-10-13T00:57:18.315Z")}`);
    assert.match(text(pool("openai").querySelector(".pool-detail")), /too early to project/);
  });

  it("keeps Mistral and both missing pool rows with the snapshot age", () => {
    const home = homeSkeleton(hooks());
    const usage = parseUsage(`${USAGE_MARKER}\n\`\`\`json\n${JSON.stringify(fixture("usage-null-pools.json"))}\n\`\`\``)!;
    fillUsage(home, { state: "ok", usage }, undefined, Date.parse("2026-10-18T14:47:00Z"));
    const rows = [...home.slots.weekly.querySelectorAll(".pool-sum.none")].map(text);
    assert.deepEqual(rows, ["Claude No reading · snapshot 5m ago.", "OpenAI No reading · snapshot 5m ago.", "Mistral 2,500 requests · 1,234,567 tokens since the broker started"]);
    assert.match(text(home.slots.weekly), /Mistral/);
    assert.doesNotMatch(text(home.slots.weekly), /No usage published/);
    assert.match(text(home.slots.usage), /Mistral/);
  });

  it("puts weekly usage first after the summary, and human requests behind an opt-in disclosure after Decisions", () => {
    const home = homeSkeleton(hooks());
    assert.equal(home.el.firstElementChild, home.slots.summary);
    assert.equal(home.slots.summary.nextElementSibling, home.slots.weekly);
    const people = home.el.querySelector<HTMLDetailsElement>("#sec-people")!;
    assert.equal(people.open, false);
    assert.equal(people.previousElementSibling, home.slots.status);
    fillUsage(home, { state: "ok", usage: {
      updatedAt: "2026-10-08T23:01:01Z", observedAt: "2026-10-08T22:58:47Z", workers: [],
      windows: [{ kind: "seven_day", since: "2026-10-05T23:00:00Z", usedPercent: 40, resetsAt: "2026-10-12T23:00:00Z", requests: 7360, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
    } }, undefined, Date.parse("2026-10-08T23:00:00Z"));
    assert.match(text(home.slots.weekly), /Claude.*40%.*42\.9% of weekly time elapsed.*2\.9 percentage points below pace/);
    assert.match(text(home.slots.weekly), /OpenAI.*not reported/);
    fillUsage(home, { state: "unreadable" }, undefined, Date.now());
    assert.match(text(home.slots.weekly), /cannot read/);
  });

  it("shows promotion actions once and keeps approved reruns, re-signs and context in Watching with states and reasons", () => {
    const home = homeSkeleton(hooks());
    const entries: Entry[] = ["rerun", "resign", "read", "promote", "write", "sent"].map((name, i) => {
      const pr = { ref: { owner: "jmarrero-forge", repo: "widget", number: i + 1 }, url: `https://github.com/jmarrero-forge/widget/pull/${i + 1}`, title: name, body: ["promote", "write", "sent"].includes(name) ? `<!-- bot-meta -->\n- Upstream: \`upstream/widget\`\n- Contribution policy: \`${name === "write" ? "human-text" : "ai-ok"}\`\n<!-- /bot-meta -->` : "", author: "jmarrero-bot", createdAt: "", updatedAt: "", draft: true };
      return { key: `pr:${i}`, kind: "pr", title: name, where: `widget#${i + 1}`, href: `#pr/jmarrero-forge/widget/${i + 1}`, pr, verdict: { state: name === "sent" ? "promoted" : "approved" }, wait: { reasons: name === "rerun" ? ["rerun"] : name === "resign" ? ["resign"] : [], onBot: false } };
    });
    const needs = buildNeeds({ entries });
    assert.equal(needs.find((n) => n.action === "promote")?.href, entries[3]?.pr?.url);
    assert.equal(needs.find((n) => n.action === "write")?.href, entries[4]?.href);
    fillNeeds(home, needs, needsHooks(), entries);
    assert.deepEqual([...home.slots.needs.querySelectorAll(".need .action")].map(text), ["Promote", "Write text"]);
    assert.equal(text(home.slots.needs.querySelector(".watching summary")), "Watching (4)");
    const watching = home.slots.needs.querySelectorAll(".watching-item");
    assert.deepEqual([...watching].map((r) => text(r.querySelector(".state"))), ["approved", "approved", "approved", "/promote sent; bot-pr decides"]);
    assert.match(text(watching[0]), /required checks failed: rerun/);
    assert.match(text(watching[1]), /approve to re-sign/);
    assert.match(text(watching[2]), /No concrete ask; read for context/);
    const sig = needsSignature(needs, needsHooks(), entries);
    for (const change of [{ verdict: { state: "approved-older" as const } }, { wait: { reasons: ["resign" as const], onBot: false } }, { item: tracked("why", 1, { why: "A new context reason" }) }]) {
      assert.notEqual(needsSignature(needs, needsHooks(), [{ ...entries[0]!, ...change }, ...entries.slice(1)]), sig);
    }
  });

  it("renders sanitized project markdown and expands without losing state on an unchanged update", () => {
    const home = homeSkeleton(hooks());
    const status = { body: "**Working**\n\n[x](javascript:alert(1))\n\n<script>alert(2)</script>\n\nMore", createdAt: "2026-10-01T00:00:00Z" };
    fillStatus(home, status, render);
    assert.equal(text(home.slots.status.querySelector("strong")), "Working");
    assert.equal(home.slots.status.querySelector("script, [href^='javascript:']"), null);
    assert.ok(home.slots.status.querySelector(".status-preview"));
    const button = home.slots.status.querySelector<HTMLButtonElement>("button")!;
    button.click();
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(home.slots.status.querySelector(".status-preview"), null);
    fillStatus(home, status, render);
    assert.equal(home.slots.status.querySelector("button"), button);
  });

  it("puts Decisions before Status and refreshes its age without resetting expansion", () => {
    const home = homeSkeleton(hooks());
    assert.ok([...home.el.children].indexOf(home.sections.needs.details) < [...home.el.children].indexOf(home.slots.status));
    const status = { body: "First paragraph\n\nSecond paragraph", createdAt: "2026-10-15T10:00:00Z" };
    fillStatus(home, status, render, undefined, Date.parse("2026-10-15T10:30:00Z"));
    // The locale's clock, as every other time on the page: 12 or 24 hours as it prefers.
    const at = new Date("2026-10-15T10:00:00Z").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    assert.equal(text(home.slots.status.querySelector(".status-age")), `As of ${at}, 30 min ago`);
    assert.equal(home.slots.status.querySelector(".status-age.hot"), null);
    home.slots.status.querySelector<HTMLButtonElement>("button")!.click();
    fillStatus(home, status, render, undefined, Date.parse("2026-10-15T11:01:00Z"));
    assert.match(text(home.slots.status.querySelector(".status-age.hot")), /61 min ago · stale/);
    assert.equal(home.slots.status.querySelector("button")?.getAttribute("aria-expanded"), "true");
    fillStatus(home, { ...status, createdAt: "invalid" }, render);
    assert.match(text(home.slots.status), /Status age unknown/);
  });

  it("renders a recorded status block without its marker, with full titles from the board", () => {
    // Recorded from the board on 21 Oct: every title cut to ~25 characters.
    const status = fixture<{ body: string; createdAt: string }>("project-status.json");
    const home = homeSkeleton(hooks());
    const full = "Cross-check ostreedev/ostree's CI against bootc's composefs tests";
    const board = [
      tracked("cross", 540, { title: full }),
      // A board title the cut label does not start with is not the writer's.
      tracked("other", 405, { title: "A different title" }),
    ];
    fillStatus(home, status, render, undefined, Date.parse(status.createdAt), board);
    const slot = home.slots.status;
    assert.doesNotMatch(slot.textContent ?? "", /<!--|bot-board-status-v1|-->/);
    assert.equal(slot.querySelector(".md > p:last-child")?.textContent, "Full board");
    const link = (n: number) => slot.querySelector(`a[href="${TRACKER}/${n}"]`)?.textContent;
    assert.equal(link(540), full);
    assert.equal(link(405), "Epic: Clean up the harness:…");
    assert.equal(link(528), "Epic: Cut over to the new h…");
    // Restored on a repaint of an unchanged update too, once the board arrives.
    const later = homeSkeleton(hooks());
    fillStatus(later, status, render);
    fillStatus(later, status, render, undefined, Date.now(), board);
    assert.equal(later.slots.status.querySelector(`a[href="${TRACKER}/540"]`)?.textContent, full);
  });

  it("previews the first paragraph even after a heading or list", () => {
    for (const prefix of ["## Update", "- One\n- Two"]) {
      const home = homeSkeleton(hooks());
      fillStatus(home, { body: `${prefix}\n\nSummary.\n\nDetails.`, createdAt: "2026-10-15T10:00:00Z" }, render);
      const body = home.slots.status.querySelector(".status-preview")!;
      assert.deepEqual([...body.children].filter((el) => el.matches(".status-summary")).map(text), ["Summary."]);
    }
  });

  it("shows active epics by priority with progress, running children and gray paused work", () => {
    const home = homeSkeleton(hooks());
    const epic = tracked("epic", 1, { labels: ["epic"], status: "In Progress", priority: "P0", subIssues: { total: 4, completed: 2, percent_completed: 50 } });
    const paused = tracked("paused", 2, { labels: ["epic"], status: "Paused", priority: "P1" });
    fillFocus(home, [paused, epic, tracked("child", 3, { parent: epic.ref!, status: "In Progress", lead: "worker" }), tracked("done", 4, { labels: ["epic"], state: "closed" })]);
    assert.deepEqual([...home.slots.focus.querySelectorAll("article h3")].map(text), ["P0 · epic", "P1 · paused"]);
    assert.equal(home.slots.focus.querySelector("progress")?.getAttribute("value"), "2");
    assert.match(text(home.slots.focus), /child · worker · running/);
    assert.ok(home.slots.focus.querySelector(".paused"));
  });

  const done = { total: 9, completed: 9, percent_completed: 100 };
  const half = { total: 4, completed: 2, percent_completed: 50 };
  const FOCUS_STATUS: { name: string; epic: Partial<Item>; noStatus?: boolean; others?: (epic: Item) => Item[]; text: string; bug: boolean }[] = [
    { name: "an epic in progress shows its Status", epic: { status: "In Progress", subIssues: half }, text: "In Progress", bug: false },
    { name: "an unfinished Needs human epic stays Needs human", epic: { status: "Needs human", subIssues: half }, text: "Needs human", bug: false },
    { name: "an epic without progress shows its Status", epic: { status: "Needs human" }, text: "Needs human", bug: false },
    { name: "a missing Status is flagged as a board bug", noStatus: true, epic: { subIssues: half }, text: "No Status on the board", bug: true },
    { name: "a finished Needs human epic is ready to close, open for its Status", epic: { status: "Needs human", subIssues: done }, text: "Ready to close; still open: Status Needs human", bug: false },
    { name: "a finished 1/1 epic is ready to close", epic: { status: "In Progress", subIssues: { total: 1, completed: 1, percent_completed: 100 } }, text: "Ready to close; still open: Status In Progress", bug: false },
    { name: "a finished epic without Status is ready to close and flagged", noStatus: true, epic: { subIssues: done }, text: "Ready to close; still open: no Status on the board", bug: true },
    {
      name: "a finished epic held open by asks names them, not its Status",
      epic: { status: "Needs human", subIssues: done },
      others: (epic) => [
        tracked("q1", 11, { labels: ["question"], parent: epic.ref! }),
        tracked("q2", 12, { labels: ["chore"], body: `Blocks: ${epic.url}\n` }),
        tracked("closed", 13, { labels: ["question"], parent: epic.ref!, state: "closed" }),
        tracked("elsewhere", 14, { labels: ["question"], body: `Blocks: ${TRACKER}/99\n` }),
      ],
      text: "Ready to close; still open: 2 open asks",
      bug: false,
    },
    { name: "one open ask is singular", noStatus: true, epic: { subIssues: done }, others: (epic) => [tracked("q1", 11, { labels: ["question"], body: `Blocks: ${epic.url}\n` })], text: "Ready to close; still open: 1 open ask; no Status on the board", bug: true },
  ];
  for (const c of FOCUS_STATUS) {
    it(`focus: ${c.name}`, () => {
      const epic = tracked("epic", 1, { labels: ["epic"], ...c.epic });
      if (c.noStatus) delete epic.status;
      const board = [epic, ...(c.others?.(epic) ?? [])];
      assert.deepEqual(focusStatus(epic, board), { text: c.text, bug: c.bug });
      const home = homeSkeleton(hooks());
      fillFocus(home, board);
      const state = home.slots.focus.querySelector(".focus-epic .focus-status")!;
      assert.equal(text(state), c.text);
      // Only the bug is styled: a plain .state would paint any Status as an OK pill.
      assert.equal(state.classList.contains("state"), c.bug);
      assert.equal(state.classList.contains("bug"), c.bug);
    });
  }

  it("keeps overflow in collapsed Watching and reveals it for action continuation", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const entries = buildEntries(questions(DECISION_LIMIT + 3).map((q) => ({ ...q, labels: ["escalate"] })), [], new Map());
    fillNeeds(home, buildNeeds({ entries }), needsHooks(), entries);
    document.body.replaceChildren(home.el);
    assert.equal(walkRows(home.el).length, DECISION_LIMIT);
    const overflow = home.slots.needs.querySelector<HTMLElement>(".watching .need")!;
    reveal(overflow, home.slots.needs, "needs", ".need");
    assert.ok(walkRows(home.el).includes(overflow));
  });

  it("filters by priority before the limit, so a chip's rows are in the list, not in Watching", () => {
    const home = homeSkeleton(hooks(["needs"]));
    // The last three, ranked after the P1s, are past the limit unfiltered.
    const items = questions(DECISION_LIMIT + 3).map((q, i) => ({ ...q, labels: ["escalate"], priority: i < DECISION_LIMIT ? "P1" : "P2" }));
    const entries = buildEntries(items, [], new Map());
    fillNeeds(home, buildNeeds({ entries }), { ...needsHooks(), priority: "P2" }, entries);
    document.body.replaceChildren(home.el);
    const shown = () => walkRows(home.el).map((r) => r.getAttribute("data-priority"));
    const watching = () => text(home.slots.needs.querySelector(".watching summary"));
    assert.deepEqual(shown(), ["P2", "P2", "P2"]);
    assert.equal(home.slots.needs.querySelector<HTMLElement>(".needs-none")?.hidden, true);
    assert.equal(home.slots.needs.querySelector<HTMLElement>(".watching")?.hidden, true);
    const rows = [...home.slots.needs.querySelectorAll(".need")];
    const chip = (label: string) => [...home.slots.needs.querySelectorAll<HTMLButtonElement>(".needs-filter button")].find((b) => text(b).startsWith(label))!;
    chip("All").click();
    assert.equal(shown().length, DECISION_LIMIT);
    assert.equal(watching(), "Watching (3)");
    assert.equal(home.slots.needs.querySelector(".watching .need")?.getAttribute("data-priority"), "P2");
    chip("P2").click();
    assert.deepEqual(shown(), ["P2", "P2", "P2"]);
    assert.equal(home.slots.needs.querySelector(".watching .need"), null);
    assert.deepEqual(new Set(home.slots.needs.querySelectorAll(".need")), new Set(rows), "the rows are moved, not redrawn");
    chip("All").click();
    assert.deepEqual([...home.slots.needs.querySelectorAll(".need")], rows, "back in their order");
  });

  it("keeps every open question visible with its blocked item and answer options", () => {
    const home = homeSkeleton(hooks());
    const entries = buildEntries(questions(DECISION_LIMIT + 3), [], new Map());
    fillNeeds(home, buildNeeds({ entries }), needsHooks(), entries);
    document.body.replaceChildren(home.el);
    assert.equal(walkRows(home.el).length, DECISION_LIMIT + 3);
    assert.match(text(home.slots.needs), /Blocks: tracker#9/);
    assert.equal(home.slots.needs.querySelector(".watching .need"), null);
    assert.ok(home.slots.needs.querySelector("form"));
  });

  it("counts each Watching identity once and excludes decision context", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const question = tracked("question", 100, { labels: ["question"] });
    const entries = buildEntries([question, tracked("watch", 101)], [], new Map());
    const needs = buildNeeds({ entries });
    const duplicate = { ...entries.find((e) => e.item?.nodeId === "watch")!, key: "another-watch" };
    fillNeeds(home, [{ ...needs[0]!, key: "decision:I_100" }], needsHooks(), [...entries, duplicate]);
    assert.equal(text(home.slots.needs.querySelector(".watching summary")), "Watching (1)");
  });
});

describe("homeSkeleton", () => {
  it("has opt-in From people after Decisions and five remembered sections, each with a count", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const sections = [...home.el.querySelectorAll<HTMLDetailsElement>("details.sec")];
    assert.deepEqual(sections.map((d) => text(d.querySelector(".sec-title"))), ["Decisions", "From people (opt in)", ...SECTIONS.filter((id) => id !== "needs").map((id) => SECTION_TITLE[id])]);
    assert.deepEqual(sections.map((d) => d.open), [true, false, false, false, false, false]);
    for (const d of sections) assert.ok(d.querySelector(`summary .${COUNT_CLASS}`), "a count in each header");
    assert.ok(home.slots.opsBox, "the ops detail folds under the agents");
    assert.ok(home.sections.priority.body.contains(home.slots.themesBox), "the themes fold under by-priority");
  });

  it("tells hooks about his toggles only, not the page's own", async () => {
    const log: string[] = [];
    const home = homeSkeleton(hooks([], log));
    document.body.replaceChildren(home.el);
    home.sections.changes.details.open = true;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true"]);
    setSectionOpen(home, "usage", true, false, hooks([], log));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true"], "opened by code, unremembered");
    setSectionOpen(home, "agents", true, true, hooks([], log));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true", "agents:true"], "a jump is remembered once, as his");
    home.sections.changes.details.open = false;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log.at(-1), "changes:false");
  });

  it("tells hooks when the folds open", async () => {
    const log: string[] = [];
    const home = homeSkeleton(hooks([], log));
    document.body.replaceChildren(home.el);
    home.slots.opsBox.open = true;
    home.slots.themesBox.open = true;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log.sort(), ["ops:true", "themes:true"]);
  });
});

describe("applyLimit", () => {
  const list = (n: number) => {
    const slot = document.createElement("div");
    const ul = document.createElement("ul");
    ul.append(...Array.from({ length: n }, (_, i) => Object.assign(document.createElement("li"), { className: "r", textContent: String(i) })));
    slot.append(document.createElement("h3"), ul);
    return slot;
  };
  const shown = (slot: Element) => [...slot.querySelectorAll<HTMLElement>(".r")].filter((r) => !r.hidden).length;

  it("shows a few rows and a View all with the total, which shows the rest and folds back", () => {
    const slot = list(8);
    applyLimit(slot, "t", ".r");
    assert.equal(shown(slot), PREVIEW_ROWS);
    const button = slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`);
    assert.equal(button?.textContent, "View all 8");
    button?.click();
    assert.equal(shown(slot), 8);
    assert.equal(slot.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");
    assert.equal(slot.querySelectorAll(`.${VIEW_ALL_CLASS}`).length, 1);
    slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    assert.equal(shown(slot), PREVIEW_ROWS);
  });

  it("offers nothing when everything fits, and remembers View all across redraws", () => {
    const few = list(PREVIEW_ROWS);
    applyLimit(few, "few", ".r");
    assert.equal(few.querySelector(`.${VIEW_ALL_CLASS}`), null);
    const slot = list(9);
    applyLimit(slot, "again", ".r");
    slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    const redrawn = list(9);
    applyLimit(redrawn, "again", ".r");
    assert.equal(shown(redrawn), 9);
  });

  it("hides the list and heading left with no row showing, and reveal opens it for a row in it", () => {
    const slot = document.createElement("div");
    const lists = [3, 4].map((n) => {
      const ul = document.createElement("ul");
      ul.append(...Array.from({ length: n }, () => Object.assign(document.createElement("li"), { className: "r" })));
      return ul;
    });
    slot.append(document.createElement("h3"), lists[0] as Node, document.createElement("h3"), lists[1] as Node);
    applyLimit(slot, "g", ".r");
    assert.equal(lists[0]?.hidden, false);
    assert.equal(lists[1]?.hidden, false);
    assert.equal((lists[1]?.previousElementSibling as HTMLElement).hidden, false);
    const last = lists[1]?.lastElementChild as HTMLElement;
    assert.ok(last.hidden);
    reveal(last, slot, "g", ".r");
    assert.ok(!last.hidden);
  });
});

describe("row walking", () => {
  function mounted(): Home {
    const home = homeSkeleton(hooks(["needs", "priority"]));
    for (const id of ["needs", "priority", "agents"] as const) {
      const slot = home.slots[id];
      slot.replaceChildren(...Array.from({ length: PREVIEW_ROWS + 2 }, (_, i) =>
        Object.assign(document.createElement("div"), { className: "row", textContent: `${id}:${i}` }),
      ));
      applyLimit(slot, id, ".row");
    }
    document.body.replaceChildren(home.el);
    return home;
  }

  it("j/k skip hidden rows and closed sections, and stop at the last visible row", () => {
    const home = mounted();
    const rows = walkRows(home.el);
    const needs = [...home.slots.needs.querySelectorAll<HTMLElement>(".row")];
    const priority = [...home.slots.priority.querySelectorAll<HTMLElement>(".row")];
    assert.deepEqual(rows, [...needs.slice(0, PREVIEW_ROWS), ...priority.slice(0, PREVIEW_ROWS)]);
    assert.equal(stepRow(rows, needs[PREVIEW_ROWS - 1], 1), priority[0]);
    assert.equal(stepRow(rows, priority[0], -1), needs[PREVIEW_ROWS - 1]);
    assert.equal(rows.at(-1), priority[PREVIEW_ROWS - 1]);
    assert.equal(stepRow(rows, rows.at(-1), 1), rows.at(-1));
    assert.equal(stepRow(rows, rows[0], -1), rows[0]);

    home.slots.needs.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    const expanded = walkRows(home.el);
    assert.deepEqual(expanded, [...needs, ...priority.slice(0, PREVIEW_ROWS)]);
    assert.equal(stepRow(expanded, needs[PREVIEW_ROWS - 1], 1), needs[PREVIEW_ROWS]);
    assert.equal(stepRow(expanded, priority[0], -1), needs.at(-1));
  });

  it("reveal makes a hidden row walkable and keeps its list expanded after a redraw", () => {
    const home = mounted();
    const slot = home.slots.needs;
    const last = slot.querySelectorAll<HTMLElement>(".row")[PREVIEW_ROWS + 1]!;
    assert.ok(last.hidden);
    assert.ok(!walkRows(home.el).includes(last));
    reveal(last, slot, "needs", ".row");
    assert.ok(!last.hidden);
    assert.ok(walkRows(home.el).includes(last));
    assert.equal(slot.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");

    const redrawn = mounted();
    const rows = [...redrawn.slots.needs.querySelectorAll<HTMLElement>(".row")];
    assert.ok(rows.every((r) => !r.hidden));
    assert.deepEqual(walkRows(redrawn.el).slice(0, rows.length), rows);
    assert.equal(redrawn.slots.needs.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");
  });
});

describe("the sections' fills", () => {
  const mounted = (): Home => {
    const home = homeSkeleton(hooks());
    document.body.replaceChildren(home.el);
    return home;
  };
  const count = (home: Home, id: SectionId) => home.sections[id].count;

  it("lists what waits on him with a hot count, a few rows, and a form only on questions", () => {
    const home = mounted();
    const entries = buildEntries([...questions(7), tracked("PVTI_rev", 200, { labels: ["review"], body: `Blocks: ${TRACKER}/9\nAsk: look\n` })], [], new Map(), true);
    const waiting = fillNeeds(home, buildNeeds({ entries }), needsHooks(), entries);
    assert.equal(waiting, 7);
    assert.equal(text(count(home, "needs")), "7");
    assert.ok(count(home, "needs").classList.contains("hot"));
    const rows = [...home.slots.needs.querySelectorAll<HTMLElement>(".row")];
    assert.equal(rows.length, 7);
    assert.equal(rows.filter((r) => !r.hidden).length, 7);
    assert.equal(home.slots.needs.querySelector<HTMLDetailsElement>(".watching")?.open, false);
    assert.equal(rows.filter((r) => r.querySelector("form.answer")).length, 7, "the review row has no form");
  });

  it("says all caught up when no legacy asks wait on him", () => {
    // jmarrero-forge has no decisions document to point to.
    const home = mounted();
    assert.equal(fillNeeds(home, [], needsHooks()), 0);
    assert.match(text(home.slots.needs), /All caught up: nothing needs you right now\./);
    assert.equal(text(count(home, "needs")), "0");
    assert.ok(!count(home, "needs").classList.contains("hot"));
  });

  it("counts every row by priority, filtered or not, in a section of its own", () => {
    const home = mounted();
    const entries = buildEntries(questions(3), [], new Map(), true);
    fillPriority(home, entries, () => undefined, Date.now(), { scope: "all" }, {});
    assert.equal(text(count(home, "priority")), "3");
    assert.equal(home.slots.priority.querySelectorAll('.row[data-section="priority"]').length, 3);
    assert.ok(home.slots.priority.querySelector(".filters"));
  });

  it("shows the agents' count against the target and the usage's busiest window", () => {
    const home = mounted();
    const active: Active = { board: [], local: null, warnings: [], at: Date.now() };
    fillAgents(home, active, Date.now());
    assert.equal(text(count(home, "agents")), "0/4");
    assert.ok(count(home, "agents").classList.contains("under"));
    fillAgents(home, undefined, Date.now());
    assert.equal(text(count(home, "agents")), "…");

    const usage: UsageData = {
      state: "ok",
      usage: {
        updatedAt: "2026-09-28T15:00:00Z",
        windows: [{ kind: "five_hour", since: "2026-09-28T10:00:00Z", requests: 1, usedPercent: 42, resetsAt: "2026-09-28T20:00:00Z", tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
        workers: [],
      },
    };
    fillUsage(home, usage, null, Date.parse("2026-09-28T15:01:00Z"));
    assert.equal(text(count(home, "usage")), "5-hour 42%");
    assert.ok(home.slots.usage.querySelector(".uw"));
    fillUsage(home, { state: "unreadable" }, null, Date.now());
    assert.equal(text(count(home, "usage")), "private");
  });
});
