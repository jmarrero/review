import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fixtureFetch, runState } from "../src/cli/statecommand.ts";
import { GitHub } from "../src/github/api.ts";
import { activeAgents, isClaimed } from "../src/github/agents.ts";
import { parseItem, type RawItem } from "../src/github/board.ts";
import { fillAgents, fillFocus, fillState, homeSkeleton } from "../src/github/homeview.ts";
import { agentsBody, agentsSummary } from "../src/github/agentsview.ts";
import { HEARTBEAT_MARKER, parseHeartbeat } from "../src/github/heartbeat.ts";
import { loadActionRuns, parseRunTitleMetrics, runsDue, runTotals, type RunsData, type RunTitleMetrics } from "../src/github/runs.ts";
import { loadPageState, pageState } from "../src/github/state.ts";
import { activeFromOps, loadOps } from "../src/github/ops.ts";
import { installDom, rawBoardItem, scriptedFetch } from "./helpers.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const FIXTURES = resolve("test/fixtures");

describe("source freshness", () => {
  it("lists people, pending until From people is read", () => {
    assert.deepEqual(pageState({}, NOW).sources.people, { state: "pending" });
    const fetched = { state: "ok" as const, checkedAt: NOW, fetchedAt: NOW };
    assert.deepEqual(pageState({ sources: { people: fetched } }, NOW).sources.people, fetched);
  });
});

describe("confirmed shared agent execution", () => {
  const fixture = JSON.parse(readFileSync(resolve(FIXTURES, "agent-execution-context.json"), "utf8")) as { board: RawItem[]; heartbeat: unknown };
  const board = fixture.board.map(parseItem);
  const local = parseHeartbeat(`${HEARTBEAT_MARKER}\n\`\`\`json\n${JSON.stringify(fixture.heartbeat)}\n\`\`\``)!;
  const readRuns = () => loadActionRuns(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);

  it("counts and renders Actions-only agents when board and heartbeat are unread", async () => {
    const runs = await readRuns();
    const active = { warnings: ["board unavailable", "heartbeat unavailable"], at: NOW };
    const state = pageState({ active, runs }, NOW);
    assert.equal(state.agents.running, 1);
    assert.deepEqual(state.agents.locations, { remote: 1, local: 0 });
    assert.equal(state.agents.agents[0]?.source, "actions");
    assert.equal(agentsSummary(undefined, NOW, state.agents).count, "1/4");
    assert.equal(agentsSummary(active, NOW, state.agents).count, "1/4");
    const win = installDom();
    try {
      const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
      fillAgents(home, undefined, NOW, state.agents);
      assert.match(home.slots.agents.textContent ?? "", /1\/4 agents · remote 1 · local 0/);
      assert.match(home.slots.agents.textContent ?? "", /heartbeat unread/);
      assert.equal(home.slots.agents.querySelectorAll(".as-agent").length, 1);
      assert.equal(agentsBody(active, NOW, state.agents).querySelectorAll(".as-agent").length, 1);
    } finally {
      win.close();
    }
  });

  it("loads live execution despite inaccessible board and heartbeat APIs", async () => {
    const offline = fixtureFetch(FIXTURES);
    const gh = new GitHub(async () => "fixture", async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/fields") || path.endsWith("/items") || path.includes("/tracker/issues/1/comments")) return Response.json({ message: "inaccessible" }, { status: 403 });
      return offline(url, init);
    });
    const state = await loadPageState(gh, NOW);
    assert.equal(state.sources.board?.state, "unavailable");
    assert.equal(state.sources.heartbeat?.state, "unavailable");
    assert.equal(state.agents.running, 1);
    assert.deepEqual(state.agents.locations, { remote: 1, local: 0 });
  });

  it("merges run identity across Actions, board and remote heartbeat sightings, while retaining distinct local jobs", async () => {
    const runs = await readRuns();
    runs.runs.push({ ...runs.runs[0]!, url: "https://github.com/BOOTC-DEV/JMARRERO-DEVSPACE-SANDBOX/actions/runs/101/attempts/2#jobs" });
    const heartbeat = { ...local, workers: [...local.workers, { ...local.workers[0]! }] };
    const state = pageState({ active: { board, local: heartbeat, warnings: [], at: NOW }, runs }, NOW);
    assert.equal(state.agents.running, 3);
    assert.deepEqual(state.agents.locations, { remote: 1, local: 2 });
    assert.deepEqual(state.agents.lanes, { harness: 0, upstream: 3, unknown: 0 });
    assert.equal(state.agents.opencode, 1);
    assert.equal(state.agents.unknownEngine, 0);
    assert.equal(state.agents.unconfirmed, 2, "completed and missing board Run links never count");
    assert.equal(state.agents.agents.filter((a) => a.source === "actions").length, 1);
    assert.equal(state.agents.agents.find((a) => a.name === "local-same-item")?.location, "local");
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });

  it("does not let board claims rescue stale, stopped, cached or unread heartbeat jobs", async () => {
    const runs = await readRuns();
    for (const heartbeat of [{ ...local, updatedAt: "2026-10-01T12:00:00Z" }, { ...local, loopState: "stopped" }]) {
      const state = pageState({ active: { board, local: heartbeat, warnings: [], at: NOW }, runs }, NOW);
      assert.equal(state.agents.running, 1);
      assert.deepEqual(state.agents.locations, { remote: 1, local: 0 });
    }
    for (const source of ["cached", "unavailable"] as const) {
      const state = pageState({ active: { board, local, warnings: [], at: NOW }, runs, sources: { heartbeat: { state: source } } }, NOW);
      assert.equal(state.agents.running, 1);
      assert.equal(state.agents.heartbeat?.stale, true);
    }
  });

  it("retains shared ops data but unconfirms local agents when every source fails, then recovers", async () => {
    const previous = { board, local, warnings: [], at: NOW, sources: { heartbeat: { state: "ok" as const, fetchedAt: NOW }, status: { state: "ok" as const, fetchedAt: NOW } } };
    assert.equal(pageState({ active: previous }, NOW).agents.locations.local, 2);
    const failing = scriptedFetch(() => ({ status: 500, body: { message: "offline" } }));
    const ops = await loadOps(new GitHub(async () => "fixture", failing.fetchImpl), new Map(), NOW + 1_000);
    assert.equal(ops.board, undefined);
    assert.equal(ops.local, undefined);
    assert.equal(ops.usage, undefined);
    const active = activeFromOps(previous, ops);
    assert.equal(active.board, previous.board);
    assert.equal(active.local, previous.local);
    assert.equal(active.sources?.status?.state, "ok");
    for (const name of ["board", "heartbeat", "usage"]) assert.equal(active.sources?.[name]?.state, "unavailable");
    assert.equal(active.sources?.heartbeat?.fetchedAt, NOW);
    assert.match(active.sources?.heartbeat?.error ?? "", /HTTP 500/);
    assert.equal(previous.sources.heartbeat.state, "ok", "prior freshness is not mutated");
    const failed = pageState({ active }, NOW + 1_000);
    assert.equal(failed.agents.running, 0);
    assert.equal(failed.agents.heartbeat?.stale, true);
    const recovered = activeFromOps(active, { warnings: [], at: NOW + 2_000, local, sources: { heartbeat: { state: "ok", fetchedAt: NOW + 2_000 } } });
    assert.equal(pageState({ active: recovered }, NOW + 2_000).agents.locations.local, 2);
    assert.equal(recovered.sources?.heartbeat?.error, undefined);
  });

  it("excludes failed, cached or expired Actions sightings, then recovers on a live read", async () => {
    const runs = await readRuns();
    const active = { board, local, warnings: [], at: NOW };
    for (const source of ["cached", "unavailable"] as const) {
      const state = pageState({ active, runs, sources: { runs: { state: source } } }, NOW);
      assert.equal(state.agents.running, 2);
      assert.deepEqual(state.agents.locations, { remote: 0, local: 2 });
    }
    assert.equal(pageState({ runs }, NOW + 120_001).agents.running, 0);
    assert.equal(pageState({ runs }, NOW - 1).agents.running, 0, "future-dated reads aren't live evidence");
    assert.equal(pageState({ active, runs }, NOW).agents.running, 3);
    const empty = pageState({ runs: { ...runs, runs: [] } }, NOW);
    assert.equal(agentsSummary(undefined, NOW, empty.agents).count, "0/4");
  });

  it("keeps completed status authoritative over duplicate active rows, and separates repositories", async () => {
    const runs = await readRuns();
    const completed = runs.runs.find((run) => !run.active)!;
    runs.runs.push({ ...completed, active: true });
    assert.equal(pageState({ runs }, NOW).agents.running, 1);
    runs.runs.push({ ...runs.runs[0]!, url: "https://github.com/another/repo/actions/runs/101" });
    assert.equal(pageState({ runs }, NOW).agents.running, 2);
  });
});

describe("explicit run-title metrics", () => {
  const cases = JSON.parse(readFileSync(resolve(FIXTURES, "run-title-metrics.json"), "utf8")) as { title?: string; metrics: RunTitleMetrics }[];
  for (const { title, metrics } of cases) it(title ?? "absent title", () => {
    assert.deepEqual(parseRunTitleMetrics(title), metrics);
  });

  it("keeps malformed and absent titles unknown through the loader and panel", async () => {
    const offline = fixtureFetch(FIXTURES);
    const gh = new GitHub(async () => "fixture", async (url, init) => {
      const response = await offline(url, init);
      if (!url.includes("/workflows/")) return response;
      const body = await response.json();
      for (const run of body.workflow_runs) run.display_title = run.id === 102 ? "[tokens=1,200; cost=$0.25 estimated]" : undefined;
      return Response.json(body);
    });
    const runs = await loadActionRuns(gh, NOW);
    assert.ok(runs.runs.every((run) => run.metrics.tokens === null && run.metrics.cost === null));
    const state = pageState({ runs }, NOW);
    assert.equal(state.runs?.totals.tokens, null);
    assert.equal(state.runs?.totals.cost, null);
    const win = installDom();
    try {
      const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
      fillState(home, state);
      assert.match(home.slots.runs.textContent ?? "", /tokens: unavailable \(0\/2 runs; partial\)/);
      assert.match(home.slots.runs.textContent ?? "", /cost: unavailable \(0\/2 runs; partial\)/);
    } finally {
      win.close();
    }
  });

  it("sums known readings independently, with exact decimal USD sums and created-window coverage", async () => {
    const data = await loadActionRuns(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    const base = data.runs.find((run) => !run.active)!;
    const titles = ["[tokens=100; cost=$0.1]", "[tokens=200; cost=$0.2]", "[tokens=oops; cost=$0]", "Agent with no metrics"];
    data.runs = titles.map((title, i) => ({ ...base, id: i, title, metrics: parseRunTitleMetrics(title), attempt: 1 }));
    data.partial = false;
    // Old and future readings must not leak into sums for runs created in this window.
    for (const createdAt of ["2026-10-01T11:59:59Z", "2026-10-02T12:00:01Z"]) data.runs.push({ ...base, createdAt, metrics: { tokens: 999, cost: 999 } });
    const totals = runTotals(data, NOW);
    assert.equal(totals.count, 4);
    assert.equal(totals.tokens, 300);
    assert.equal(totals.cost, 0.3);
    assert.equal(totals.tokensKnownRuns, 2);
    assert.equal(totals.costKnownRuns, 3);
    assert.equal(totals.tokensPartial, true);
    assert.equal(totals.costPartial, true);
    assert.equal(totals.partial, true);

    data.runs = data.runs.slice(0, 2);
    assert.equal(runTotals(data, NOW).tokensPartial, false);
    assert.equal(runTotals(data, NOW).costPartial, false);
    data.runs[0]!.metrics.cost = null;
    assert.equal(runTotals(data, NOW).tokensPartial, false, "cost coverage does not invalidate known tokens");
    assert.equal(runTotals(data, NOW).costPartial, true);
    assert.equal(runTotals(data, NOW).cost, 0.2);
    data.runs[0]!.metrics.cost = 0.1;
    data.runs[0]!.active = true;
    assert.equal(runTotals(data, NOW).tokensPartial, true, "live readings are provisional");
    data.runs[0]!.active = false;
    data.partial = true;
    assert.equal(runTotals(data, NOW).costPartial, true, "known readings cannot establish complete truncated coverage");
  });

  it("distinguishes unknown, explicit zero and a complete empty window; rejects unsafe sums", async () => {
    const data = await loadActionRuns(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    data.runs = [data.runs.find((run) => !run.active)!];
    data.partial = false;
    data.runs[0]!.metrics = { tokens: null, cost: null };
    assert.equal(runTotals(data, NOW).tokens, null);
    assert.equal(runTotals(data, NOW).cost, null);
    data.runs[0]!.metrics = { tokens: 0, cost: 0 };
    assert.equal(runTotals(data, NOW).tokens, 0);
    assert.equal(runTotals(data, NOW).cost, 0);
    assert.equal(runTotals(data, NOW).tokensPartial, false);
    data.runs[0]!.metrics = { tokens: Number.MAX_SAFE_INTEGER, cost: 5_000_000_000 };
    data.runs.push({ ...data.runs[0]!, metrics: { tokens: 1, cost: 5_000_000_000 } });
    assert.equal(runTotals(data, NOW).tokens, null);
    assert.equal(runTotals(data, NOW).cost, null);
    assert.equal(runTotals(data, NOW).tokensPartial, true);
    assert.equal(runTotals(data, NOW).costPartial, true);
    data.runs = [];
    assert.equal(runTotals(data, NOW).tokens, 0);
    assert.equal(runTotals(data, NOW).costPartial, false);
    data.state = "unavailable";
    assert.equal(runTotals(data, NOW).tokens, null);
    assert.equal(runTotals(data, NOW).costPartial, true);
  });
});

describe("shared dashboard state", () => {
  it("uses API fixtures in the CLI and keeps the snapshot JSON-safe", async () => {
    const state = await loadPageState(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    assert.equal(state.schema, "review-state/v1");
    assert.equal(state.runs?.totals.count, 2);
    assert.equal(state.runs?.totals.coreHours, 16);
    assert.equal(state.runs?.totals.tokens, 1200);
    assert.equal(state.runs?.totals.cost, 0.25);
    assert.equal(state.runs?.totals.tokensKnownRuns, 1);
    assert.equal(state.runs?.totals.costKnownRuns, 1);
    assert.equal(state.runs?.totals.tokensPartial, true);
    assert.equal(state.runs?.totals.costPartial, true);
    assert.equal(state.sources.runs?.state, "ok");
    assert.equal(state.sources.heartbeat?.publishedAt, "2026-09-28T15:05:00Z");
    assert.ok(state.sources.heartbeat!.checkedAt! > Date.parse(state.sources.heartbeat!.publishedAt!));
    assert.ok(state.people.some((n) => n.action === "answer" && n.where.includes("tracker#")), "snapshot includes actual operator questions");
    assert.ok(state.decisions.length > 0);
    assert.ok(state.people.some((n) => n.decision), "decisions are merged into the actual people asks");
    assert.equal(new Set(state.people.map((n) => n.where)).size, state.people.length, "board questions and decisions are not duplicated");
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    let output = "";
    let errors = "";
    assert.equal(await runState(["--json", "--fixture", FIXTURES, "--now", new Date(NOW).toISOString()], {}, (s) => { output += s; }, (s) => { errors += s; }), 0);
    assert.equal(errors, "");
    assert.equal(JSON.parse(output).runs.totals.coreHours, 16);
    assert.equal(JSON.parse(output).runs.totals.tokens, 1200);
    assert.equal(JSON.parse(output).runs.totals.cost, 0.25);
  });

  it("reports token and argument errors without exposing credentials", async () => {
    let errors = "";
    assert.equal(await runState(["--json"], {}, () => {}, (s) => { errors += s; }), 1);
    assert.match(errors, /GH_TOKEN/);
    assert.equal(await runState(["--fixture"], {}, () => {}, () => {}), 1);
  });

  it("keeps failed-source errors and does not mutate shared freshness records", () => {
    const sources = { heartbeat: { state: "unavailable" as const, error: "HTTP 503", fetchedAt: NOW - 60_000 } };
    const active = { warnings: [], at: NOW, local: null, sources, fromCache: true };
    const state = pageState({ active }, NOW);
    assert.equal(state.sources.heartbeat?.error, "HTTP 503");
    state.sources.heartbeat!.error = "changed snapshot";
    assert.equal(sources.heartbeat.error, "HTTP 503");
  });

  it("excludes Lead-only umbrellas, retains Focus and explicit Run evidence", () => {
    const epic = { ...parseItem(rawBoardItem(1, { Status: "In Progress" })), lead: "topic", labels: ["epic"], subIssues: { total: 4, completed: 1, percent_completed: 25 } };
    assert.equal(isClaimed(epic), false);
    assert.equal(activeAgents([epic], null, NOW).running, 0);
    assert.equal(isClaimed({ ...epic, run: "https://github.com/o/r/actions/runs/1" }), true);
    const win = installDom();
    const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
    fillFocus(home, [epic]);
    assert.equal(home.slots.focus.querySelectorAll(".focus-epic").length, 1);
    win.close();
  });

  it("renders runs outside every disclosure and preserves open run details", async () => {
    const win = installDom();
    const state = await loadPageState(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
    fillState(home, state);
    assert.equal(home.slots.runs.closest("details"), null);
    const row = home.slots.runs.querySelector<HTMLDetailsElement>("details");
    assert.ok(row);
    row.open = true;
    fillState(home, state);
    assert.equal(home.slots.runs.querySelector<HTMLDetailsElement>("details")?.open, true);
    assert.match(home.slots.runs.textContent ?? "", /fixture-runner/);
    assert.match(home.slots.runs.textContent ?? "", /tokens: 1,200 known \(1\/2 runs; partial\)/);
    assert.match(home.slots.runs.textContent ?? "", /cost: \$0.25 USD known \(1\/2 runs; partial\)/);
    assert.equal(home.slots.runs.querySelectorAll(".runs-spark span").length, 24);
    assert.match(home.slots.freshness.textContent ?? "", /board: ok/);
    win.close();
  });

  it("updates rolling totals without another fetch and preserves expanded rows", async () => {
    const win = installDom();
    const state = await loadPageState(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
    fillState(home, state);
    home.slots.runs.querySelector<HTMLDetailsElement>("details")!.open = true;
    const later = pageState({ runs: state.runs!, sources: state.sources }, NOW + 24 * 3_600_000);
    fillState(home, later);
    assert.match(home.slots.runs.textContent ?? "", /Last 24 h: 0 runs created/);
    assert.equal(home.slots.runs.querySelector<HTMLDetailsElement>("details")?.open, true);
    win.close();
  });

  it("does not invent runner time after a failed Actions poll", async () => {
    const state = await loadPageState(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    state.runs!.runs[0]!.jobs = [{ labels: ["8c"], status: "in_progress", started_at: "2026-10-02T10:00:00Z" }];
    const failed = pageState({ runs: state.runs!, sources: { runs: { state: "unavailable", checkedAt: NOW + 3_600_000, error: "offline" } } }, NOW + 3_600_000);
    assert.equal(failed.runs?.totals.coreHours, 24);
    assert.equal(failed.runs?.totals.partial, true);
    assert.equal(failed.runs?.totals.tokensPartial, true);
    assert.equal(failed.runs?.totals.costPartial, true);
    assert.equal(failed.sources.runs?.fetchedAt, NOW);
  });
});

describe("Actions reads and metrics", () => {
  it("polls at 60 seconds only on a visible dashboard, with no overlapping read", () => {
    assert.equal(runsDue(NOW, false, NOW + 59_999, true, true), false);
    assert.equal(runsDue(NOW, false, NOW + 60_000, true, true), true);
    assert.equal(runsDue(NOW, false, NOW + 60_000, false, true), false);
    assert.equal(runsDue(NOW, false, NOW + 60_000, true, false), false);
    assert.equal(runsDue(NOW, true, NOW + 60_000, true, true), false);
  });
  it("conditionally revalidates lists and reuses final per-attempt jobs", async () => {
    const offline = fixtureFetch(FIXTURES);
    const calls: { url: string; headers: Headers }[] = [];
    const gh = new GitHub(async () => "fixture", async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (headers.has("if-none-match")) return new Response(null, { status: 304 });
      return offline(url, init);
    });
    await loadActionRuns(gh, NOW);
    await loadActionRuns(gh, NOW);
    assert.ok(calls.some((c) => c.headers.has("if-none-match")));
    assert.equal(calls.filter((c) => c.url.includes("/102/attempts/2/jobs")).length, 1);
    assert.equal(calls.filter((c) => c.url.includes("/101/attempts/2/jobs")).length, 2);
  });

  it("clamps multiple job spans to the 24-hour window without guessing size", () => {
    const data: RunsData = { state: "ok", at: NOW, warnings: [], partial: false, runs: [{ id: 1, title: "old", metrics: { tokens: null, cost: null }, url: "https://github.com/o/r/actions/runs/1", active: true, status: "in_progress", startedAt: "2026-10-01T10:00:00Z", createdAt: "2026-10-01T10:00:00Z", attempt: 1, jobs: [
      { labels: ["2c"], status: "in_progress", started_at: "2026-10-01T10:00:00Z" },
      { labels: ["4c"], status: "completed", started_at: "2026-10-02T10:00:00Z", completed_at: "2026-10-02T11:00:00Z" },
      { labels: ["self-hosted"], status: "in_progress", started_at: "2026-10-02T10:00:00Z" },
    ] }] };
    const totals = runTotals(data, NOW);
    assert.equal(totals.count, 0);
    assert.equal(totals.active, 1);
    assert.equal(totals.coreHours, 52);
    assert.equal(totals.unknownJobs, 1);
    assert.equal(totals.partial, true);
  });

  it("marks inaccessible workflows and missing sources explicitly", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ status: 404 }));
    const data = await loadActionRuns(new GitHub(async () => "fixture", fetchImpl), NOW);
    assert.equal(data.state, "unavailable");
    assert.match(data.warnings.join(" "), /inaccessible/);
    assert.equal(pageState({ runs: data }, NOW).runs?.totals.coreHours, null);
  });

  it("marks truncated run lists as lower bounds", async () => {
    const offline = fixtureFetch(FIXTURES);
    const gh = new GitHub(async () => "fixture", async (url, init) => {
      const response = await offline(url, init);
      const body = await response.json();
      if (url.includes("/workflows/") && !url.includes("&status=")) body.total_count = 300;
      return Response.json(body);
    });
    const data = await loadActionRuns(gh, NOW);
    assert.equal(data.partial, true);
    assert.equal(runTotals(data, NOW).partial, true);
    assert.match(data.warnings.join(" "), /lower bound/);
  });

  it("does not let a stale status query replace a completed newer attempt", async () => {
    const offline = fixtureFetch(FIXTURES);
    const gh = new GitHub(async () => "fixture", async (url, init) => {
      const response = await offline(url, init);
      const body = await response.json();
      if (url.includes("&status=in_progress")) {
        body.workflow_runs = [{ id: 102, html_url: "https://github.com/o/r/actions/runs/102", created_at: "2026-10-02T10:00:00Z", updated_at: "2026-10-02T10:00:00Z", status: "in_progress", run_attempt: 1 }];
        body.total_count = 1;
      }
      return Response.json(body);
    });
    const data = await loadActionRuns(gh, NOW);
    const run = data.runs.find((r) => r.id === 102)!;
    assert.equal(run.attempt, 2);
    assert.equal(run.active, false);
    assert.equal(data.partial, true);
    assert.match(data.warnings.join(" "), /earlier attempts/);
  });
});

describe("responsive DOM render smoke (no layout engine)", () => {
  for (const width of [390, 820, 1280]) it(`renders at ${width}px with runs visible and usable details`, async () => {
    const win = installDom();
    Object.defineProperty(win, "innerWidth", { value: width });
    const home = homeSkeleton({ open: () => false, toggled: () => {}, opsToggled: () => {}, themesToggled: () => {} });
    const state = await loadPageState(new GitHub(async () => "fixture", fixtureFetch(FIXTURES)), NOW);
    win.document.body.append(home.el);
    fillState(home, state);
    const panel = home.slots.runs.querySelector("section");
    assert.ok(panel?.isConnected);
    assert.equal(panel.closest("[hidden], details:not([open])"), null);
    const details = panel.querySelector<HTMLDetailsElement>("details");
    assert.ok(details);
    assert.ok(details.querySelector("summary a[href]"));
    details.open = true;
    assert.match(details.textContent ?? "", /attempt 2/);
    win.close();
  });
});
