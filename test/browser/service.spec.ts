// Opt-in marker is the hosted build's only switch. Replay without any token.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const decision = JSON.parse(readFileSync("test/fixtures/service-decision.json", "utf8"));

test("service generation renders offline without GitHub decision reads or token", async ({ page }, info) => {
  const problems: string[] = [];
  const github: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  await page.route("https://api.github.com/**", (route) => { github.push(route.request().url()); return route.abort(); });
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("</head>", '<meta name="service-decisions" content="enabled"></head>') });
  });
  await page.addInitScript(() => {
    // The same full-resync handler as native EventSource, driven explicitly so
    // screenshots don't depend on reconnect timing or fixture wall clocks.
    class Stream extends EventTarget {
      onerror: (() => void) | undefined;
      close() {}
      constructor() { super(); (window as unknown as { fixtureStream: Stream }).fixtureStream = this; }
    }
    Object.assign(window, { EventSource: Stream });
  });
  await page.goto("#inbox");
  await expect.poll(() => page.evaluate(() => "fixtureStream" in window)).toBe(true);
  // Keep all producer clocks coherent with this test's real clock.
  const wire = JSON.stringify(decision).replaceAll("2026-11-13T12:00:00Z", new Date().toISOString());
  await page.evaluate((d) => {
    const stream = (window as unknown as { fixtureStream: EventTarget }).fixtureStream;
    stream.dispatchEvent(new MessageEvent("state", { data: JSON.stringify({ schema: "review-service/v1", generation: 7, decision: { items: [JSON.parse(d)], complete: false, readAt: new Date().toISOString(), error: null } }), lastEventId: "7" }));
  }, wire);
  await expect(page.locator('[data-service-generation="7"]')).toContainText("Candidates: unknown");
  await expect(page.locator('[data-service-generation="7"]')).toContainText("hold unknown");
  // The shortlist remains the pass's #2 before #1, not priority/unblock ranking.
  const text = await page.locator("#view").innerText();
  expect(text.indexOf("Choose the next step")).toBeLessThan(text.indexOf("Choose a design"));
  await expect(page.locator("#writes")).toBeHidden();
  await expect(page.locator("#meta")).toContainText("read-only");
  await expect(page.locator("#view")).not.toContainText("checked on GitHub");
  await page.screenshot({ path: `dist/screenshots/service-inbox-${info.project.name}.png`, fullPage: true });
  await page.goto("#status");
  await expect(page.locator("#view")).toContainText("example/work");
  await page.screenshot({ path: `dist/screenshots/service-status-${info.project.name}.png`, fullPage: true });
  await page.evaluate(() => (window as unknown as { fixtureStream: { onerror: () => void } }).fixtureStream.onerror());
  await expect(page.locator("#view")).toContainText("Service stream unavailable");
  expect(github).toEqual([]);
  expect(problems).toEqual([]);
});

test("native SSE reconnect fully replaces a generation after a service restart", async ({ page }) => {
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("connect-src https://api.github.com", "connect-src 'self' https://api.github.com").replace("</head>", '<meta name="service-decisions" content="enabled"></head>') });
  });
  let connects = 0;
  await page.route("**/api/events", (route) => {
    connects++;
    if (connects > 2) return route.fulfill({ status: 204 });
    const at = new Date().toISOString();
    const first = JSON.parse(JSON.stringify(decision).replaceAll("2026-11-13T12:00:00Z", at));
    const d = connects === 1 ? first : { ...first, holds: [], needs_you: null, candidates: 4, work: { schema: "agent-board/dispatchable-work/v1", repositories: {} } };
    const generation = connects === 1 ? 7 : 1;
    return route.fulfill({ contentType: "text/event-stream", body: `retry: 100\nid: ${generation}\nevent: state\ndata: ${JSON.stringify({ schema: "review-service/v1", generation, decision: { items: [d], complete: false, readAt: at, error: null } })}\n\n` });
  });
  await page.goto("#inbox");
  await expect(page.locator('[data-service-generation="1"]')).toContainText("Candidates: 4");
  await expect(page.locator("#view")).not.toContainText("Choose the next step");
  expect(connects).toBeGreaterThanOrEqual(2);
});
