import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { FIXTURE_TOKEN, fixtureResponse } from "../e2e/fixture-api.ts";

const producer = readFileSync("service/fixtures/state.json", "utf8");
// Time-shift recorded producer clocks together, without inventing observations.
const replay = () => {
  const now = Date.now();
  return JSON.parse(producer.replace(/2026-11-07T[0-9:]+Z/g, (at) => new Date(now + Date.parse(at) - Date.parse("2026-11-07T12:00:00Z")).toISOString()));
};

async function setup(page: Page, decisions = false, viewer = false) {
  const github: string[] = [], problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  await page.route("https://api.github.com/**", (route) => {
    const req = route.request();
    github.push(req.url());
    return route.fulfill({ json: viewer ? fixtureResponse("group", req.method(), new URL(req.url()).pathname, req.postData() ?? undefined) : [] });
  });
  if (viewer) await page.addInitScript((token) => sessionStorage.setItem("review.token", token), FIXTURE_TOKEN);
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="service-runs" content="enabled">${decisions ? '<meta name="service-decisions" content="enabled">' : ""}</head>`) });
  });
  await page.addInitScript(() => {
    class Stream extends EventTarget {
      onerror: (() => void) | undefined;
      onopen: (() => void) | undefined;
      closed = false;
      close() { this.closed = true; }
      constructor() { super(); const w = window as unknown as { streams: Stream[] }; (w.streams ??= []).push(this); }
    }
    Object.assign(window, { EventSource: Stream });
  });
  await page.goto("#status");
  await expect.poll(() => page.evaluate(() => (window as unknown as { streams: unknown[] }).streams?.length)).toBe(1);
  return { github, problems };
}

async function push(page: Page, state: unknown, id = "1") {
  await page.evaluate(({ state, id }) => {
    const streams = (window as unknown as { streams: EventTarget[] }).streams;
    streams.at(-1)!.dispatchEvent(new MessageEvent("state", { data: typeof state === "string" ? state : JSON.stringify(state), lastEventId: id }));
  }, { state, id });
}

for (const decisions of [false, true]) test(`service runs without token or decision (decision opt-in ${decisions})`, async ({ page }, info) => {
  const { github, problems } = await setup(page, decisions);
  await expect(page.locator(".live-agents")).toContainText("Service runs unavailable");
  const state = replay();
  await push(page, state);
  const live = page.locator(".live-agents");
  await expect(live).toBeVisible();
  await expect(live).toContainText("Agent: investigate build regression");
  await expect(live.locator(".live-run")).toHaveCount(1); // poll.yml and agent-job.yml are not the agent workflow allowlist
  await expect(live).not.toContainText("Incomplete:");
  await expect(live.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.locator("#writes")).toBeHidden();
  if (decisions) await expect(page.locator("#view")).toContainText("Service decision unavailable");
  await page.screenshot({ path: `dist/screenshots/service-runs-status-${decisions ? "combined-" : ""}${info.project.name}.png`, fullPage: true });
  // Full-state pushes replace, never merge, the displayed run list.
  await push(page, { ...state, generation: 2, runs: { ...state.runs, items: [] } }, "2");
  await expect(live).toContainText("No agent runs in flight.");
  await page.evaluate(() => (window as unknown as { streams: { onerror: () => void }[] }).streams[0]!.onerror());
  await expect(live).toContainText("Service stream unavailable");
  await expect(live).not.toContainText("No agent runs in flight.");
  await push(page, state); // lower generation is allowed after reconnect/restart
  await expect(live.locator(".live-run")).toHaveCount(1);
  // Both consumers share one stream, including after page suspension.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(await page.evaluate(() => (window as unknown as { streams: { closed: boolean }[] }).streams[0]!.closed)).toBe(true);
  await expect(live).toContainText("Service stream unavailable");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
  await expect.poll(() => page.evaluate(() => (window as unknown as { streams: unknown[] }).streams.length)).toBe(2);
  await expect(live).toContainText("Service stream unavailable");
  await push(page, { ...state, generation: 3 }, "3");
  await expect(live).toContainText("generation 3");
  expect(github).toEqual([]);
  expect(problems).toEqual([]);
});

test("partial, failed, absent, stale and malformed runs are visibly unknown", async ({ page }) => {
  const { github, problems } = await setup(page);
  const state = replay();
  const cases = [
    { ...state, runs: undefined },
    { ...state, runs: { items: [], complete: false, readAt: null, error: null } },
    ...[{ complete: false }, { error: "read failed" }, { readAt: "2020-01-01T00:00:00Z" }].map((change) => ({ ...state, runs: { ...state.runs, items: [], ...change } })),
    { ...state, runs: { ...state.runs, items: [null] } },
    "{",
  ];
  for (const bad of cases) {
    await push(page, bad);
    await expect(page.locator(".live-agents")).toContainText("Incomplete:");
    await expect(page.locator(".live-agents")).not.toContainText("No agent runs in flight.");
  }
  expect(github).toEqual([]);
  expect(problems).toEqual([]);
});

test("unconfigured static app does not subscribe or bypass sign-in", async ({ page }) => {
  const service: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) service.push(r.url()); });
  await page.addInitScript(() => { Object.assign(window, { EventSource: class { constructor() { throw new Error("static subscription"); } } }); });
  await page.goto("#status");
  await expect(page.locator(".live-agents")).toHaveCount(0);
  expect(service).toEqual([]);
});

test("runs-only with a viewer retains static decisions but does not duplicate live polling", async ({ page }) => {
  const { github, problems } = await setup(page, false, true);
  await push(page, replay());
  await expect(page.locator(".live-agents")).toBeVisible();
  await page.goto("#inbox");
  await expect(page.locator(".published")).toBeVisible();
  await expect(page.locator("#writes")).not.toHaveAttribute("hidden");
  expect(github.some((url) => /\/issues\/\d+\/comments/.test(url))).toBe(true);
  expect(github.filter((url) => /\/actions\/workflows\/(dispatch|agent)\.yml\/runs/.test(url))).toEqual([]);
  expect(problems).toEqual([]);
});

test("native full resync replaces both fixture-backed sections through one reconnecting stream", async ({ page }) => {
  const decisionProducer = readFileSync("test/fixtures/service-decision-producer.json", "utf8");
  const github: string[] = [];
  await page.route("https://api.github.com/**", (route) => { github.push(route.request().url()); return route.fulfill({ json: [] }); });
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("connect-src https://api.github.com", "connect-src 'self' https://api.github.com").replace("</head>", '<meta name="service-runs" content="enabled"><meta name="service-decisions" content="enabled"></head>') });
  });
  let connects = 0;
  await page.route("**/api/events", (route) => {
    connects++;
    if (connects > 2) return route.fulfill({ status: 204 });
    const state = replay();
    const d = JSON.parse(decisionProducer.replaceAll("2026-11-09T12:00:00Z", new Date().toISOString()));
    const generation = connects === 1 ? 7 : 1;
    return route.fulfill({ contentType: "text/event-stream", body: `retry: 100\nid: ${generation}\nevent: state\ndata: ${JSON.stringify({ ...state, generation, decision: d.decision, ...(connects === 2 ? { runs: undefined } : {}) })}\n\n` });
  });
  await page.goto("#status");
  await expect(page.locator(".live-agents")).toContainText("generation 1");
  await expect(page.locator(".live-agents")).toContainText("Service runs unavailable");
  await expect(page.locator(".live-agents .live-run")).toHaveCount(0);
  await page.goto("#inbox");
  await expect(page.locator('[data-service-generation="1"]')).toContainText("test has no current window; new runs wait");
  await expect(page.locator('[data-service-generation="7"]')).toHaveCount(0);
  expect(connects).toBeGreaterThanOrEqual(2);
  expect(github).toEqual([]);
});
