import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const producer = readFileSync("service/fixtures/state.json", "utf8");
// Time-shift recorded producer clocks together, without inventing observations.
const replay = () => {
  const now = Date.now();
  return JSON.parse(producer.replace(/2026-11-0[67]T[0-9:]+Z/g, (at) => new Date(now + Date.parse(at) - Date.parse("2026-11-07T12:00:00Z")).toISOString()));
};

type Streams = { streams: (EventTarget & { onerror: () => void; closed: boolean })[] };

async function setup(page: Page, markers = '<meta name="service-board" content="enabled">') {
  const github: string[] = [], service: string[] = [], problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("request", (r) => { if (r.url().includes("/api/")) service.push(r.url()); });
  await page.route("https://api.github.com/**", (route) => { github.push(route.request().url()); return route.fulfill({ json: [] }); });
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("</head>", `${markers}</head>`) });
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
  await expect.poll(() => page.evaluate(() => (window as unknown as Streams).streams?.length)).toBe(1);
  return { github, service, problems };
}

async function push(page: Page, state: unknown, id = "1") {
  await page.evaluate(({ state, id }) => {
    (window as unknown as Streams).streams.at(-1)!.dispatchEvent(new MessageEvent("state", { data: typeof state === "string" ? state : JSON.stringify(state), lastEventId: id }));
  }, { state, id });
}

const section = (page: Page, title: string) => page.locator(".service-board section").filter({ has: page.getByRole("heading", { name: title }) });

for (const runs of [false, true]) test(`service board without a token${runs ? " beside service runs" : ""}`, async ({ page }, info) => {
  const { github, service, problems } = await setup(page, `<meta name="service-board" content="enabled">${runs ? '<meta name="service-runs" content="enabled">' : ""}`);
  const board = page.locator(".service-board");
  await expect(section(page, "Bot PRs")).toContainText("Not yet read; coverage is unknown");
  const state = replay();
  await push(page, state);
  await expect(section(page, "Bot PRs")).toContainText("bootc-dev/bootc#1201 — install: Handle a missing ESP");
  await expect(section(page, "Bot PRs")).toContainText("Current · Complete");
  await expect(section(page, "Waiting on you")).toContainText("Current · Incomplete");
  await expect(section(page, "Waiting on you")).toContainText("Source error: GET /search/issues");
  await expect(section(page, "Waiting on you").locator("li")).toHaveCount(2);
  await expect(board.getByRole("button")).toHaveCount(0);
  await expect(page.locator("#writes")).toBeHidden();
  if (runs) await expect(page.locator(".live-agents")).toContainText("Agent: investigate build regression");
  else await expect(page.locator(".live-agents")).toHaveCount(0);
  await page.screenshot({ path: `dist/screenshots/service-board-status-${runs ? "runs-" : ""}${info.project.name}.png`, fullPage: true });

  // The filter narrows the same generation client-side.
  const before = service.length;
  await board.getByLabel("Repository").selectOption("bootc-dev/bootc");
  await expect(section(page, "Bot PRs").locator("li")).toHaveCount(1);
  await expect(section(page, "Waiting on you").locator("li")).toHaveCount(1);
  await expect(section(page, "Service runs")).toContainText("No items reported.");
  await expect(board.getByLabel("Repository")).toBeFocused();
  await expect(board).toContainText("still describe the whole section");
  if (!runs) await page.screenshot({ path: `dist/screenshots/service-board-filtered-${info.project.name}.png`, fullPage: true });

  // A pushed generation replaces the lists and keeps the chosen repository.
  await push(page, { ...state, generation: 2, prs: { ...state.prs, items: [] } }, "2");
  await expect(board).toContainText("Generation 2");
  await expect(section(page, "Bot PRs")).toContainText("No items reported.");
  await expect(board.getByLabel("Repository")).toHaveValue("bootc-dev/bootc");
  expect(service.length).toBe(before);

  // Disconnect: the prior generation is no longer a healthy empty list.
  await page.evaluate(() => (window as unknown as Streams).streams[0]!.onerror());
  await expect(board).toContainText("Incomplete: Service stream unavailable");
  await expect(section(page, "Bot PRs")).toContainText("No items available; coverage is unknown.");
  await expect(section(page, "Waiting on you")).toContainText("may no longer be current");
  // Suspension closes the one stream; return opens a new full-resync subscription.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(await page.evaluate(() => (window as unknown as Streams).streams[0]!.closed)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow")));
  await expect.poll(() => page.evaluate(() => (window as unknown as Streams).streams.length)).toBe(2);
  await push(page, { ...state, generation: 1 }, "1"); // a restart may reset generations
  await expect(section(page, "Bot PRs").locator("li")).toHaveCount(1);
  await expect(board).not.toContainText("Service stream unavailable");
  expect(github).toEqual([]);
  expect(problems).toEqual([]);
});

test("partial, failed, stale and malformed board sections are visibly unknown", async ({ page }, info) => {
  const { github, problems } = await setup(page);
  const state = replay();
  const stale = new Date(Date.now() - 3 * 3600_000).toISOString();
  // A malformed PR section leaves runs and waiting readable.
  await push(page, { ...state, prs: { ...state.prs, items: [{ ...state.prs.items[0], mergeState: "merged" }] }, waiting: { ...state.waiting, readAt: stale } });
  await expect(section(page, "Bot PRs")).toContainText("Service PRs unavailable or malformed; coverage is unknown");
  await expect(section(page, "Waiting on you")).toContainText("Stale · Incomplete");
  await expect(section(page, "Waiting on you").locator("li")).toHaveCount(2);
  await expect(section(page, "Service runs").locator("li")).toHaveCount(3);
  await page.screenshot({ path: `dist/screenshots/service-board-failures-${info.project.name}.png`, fullPage: true });
  for (const bad of [
    { ...state, prs: { ...state.prs, items: [], complete: false } },
    { ...state, prs: { ...state.prs, items: [], error: "rate limited" } },
    { ...state, prs: { ...state.prs, items: [], readAt: null } },
    { ...state, prs: undefined },
  ]) {
    await push(page, bad);
    await expect(section(page, "Bot PRs")).toContainText("coverage is unknown");
    await expect(section(page, "Bot PRs")).not.toContainText("No items reported.");
  }
  await push(page, "{");
  await expect(page.locator(".service-board")).toContainText("Incomplete: Unsupported or malformed service resync");
  await expect(section(page, "Bot PRs")).not.toContainText("No items reported.");
  expect(github).toEqual([]);
  expect(problems).toEqual([]);
});

test("unconfigured static app shows no board and opens no stream", async ({ page }) => {
  const service: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) service.push(r.url()); });
  await page.addInitScript(() => { Object.assign(window, { EventSource: class { constructor() { throw new Error("static subscription"); } } }); });
  await page.goto("#status");
  await expect(page.locator(".service-board")).toHaveCount(0);
  expect(service).toEqual([]);
});
