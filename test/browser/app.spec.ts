// Loads the built app in Chromium, signs in, and screenshots each view at
// the project's width (playwright.config.ts) into dist/screenshots/, failing
// on any console error or uncaught exception. Run it, and attach the
// screenshots to the PR, for every UI change:
//
//   npx playwright install chromium   # once
//   npm run test:browser
//
// By default the GitHub API answers from the fixtures (test/e2e/
// fixture-api.ts) and nothing leaves the machine; BROWSER_DATA picks one
// of its FIXTURE_DATA (default `group`). With REVIEW_LIVE_TOKEN set, it
// is a dry run against live data read with that token instead: reads go
// to api.github.com, and any write, which an approval or answer would be,
// is aborted and fails the test. Its screenshots (live-*.png) show what
// the token reads, so they stay off public PRs. Either way it also writes
// [live-]report-<project>.md, the page's status phrases and problem counts
// (test/e2e/live-report.ts), which .github/workflows/live.yml posts for agents.

import { expect, type Page, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { DECISION, FIXTURE_DATA, type FixtureData, FIXTURE_TOKEN, fixtureResponse, isWrite, SESSION_ENDPOINT } from "../e2e/fixture-api.ts";
import { countProblems, DIAGNOSTICS, diagnosticTexts, liveReport, type ViewReport } from "../e2e/live-report.ts";

const API = "https://api.github.com";
const SCREENSHOT_DIR = "dist/screenshots";
const SETTLE_MS = 500;
const LIVE_TOKEN = process.env.REVIEW_LIVE_TOKEN;
const DATA = (process.env.BROWSER_DATA ?? "group") as FixtureData;
if (!FIXTURE_DATA.includes(DATA)) throw new Error(`BROWSER_DATA=${DATA}: not one of ${FIXTURE_DATA.join(", ")}`);

test("configured chat attaches to an existing conversation and ends without retry", async ({ page }) => {
  test.skip(!process.env.BROWSER_HOSTED || !!LIVE_TOKEN, "hosted fixture only");
  problems = await serve(page);
  await page.route("**/api/v1/state", (route) => route.fulfill({ json: { schema: "review-service/v1" } }));
  await page.route("**/api/acp", (route) => route.fulfill({ json: [{ id: "fixture-one", label: "Provider A" }, { id: "fixture-two", label: "Provider B" }] }));
  let requests: string[] = [];
  let end = () => {};
  let clients = 0;
  await page.routeWebSocket("**/api/acp/*", (socket) => {
    expect(socket.url()).toContain("/api/acp/fixture-two");
    if (++clients > 1) { socket.close(); return; }
    end = () => socket.close();
    socket.onMessage((wire) => {
      const m = JSON.parse(String(wire)); requests.push(m.method);
      if (m.id) socket.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: 1 } : { sessionId: "session" } }));
    });
  });
  await page.goto("#inbox");
  await page.getByRole("button", { name: "Configured chat", exact: true }).click();
  expect(requests).toEqual([]);
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("fixture-two");
  const pane = page.getByRole("region", { name: "Session chat" });
  await expect(pane.locator(".chat-state")).toHaveText("connected");
  await expect(pane.getByRole("button", { name: "New session", exact: true })).toHaveCount(0);
  await expect(pane.locator(".chat-status")).toContainText("existing conversation");
  expect(requests.filter((m) => m === "session/new")).toHaveLength(1);
  end();
  await expect(pane.locator(".chat-status")).toContainText("Session ended");
  await expect(pane.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(pane.locator(".chat-status")).toContainText("session server restarted");
  await expect(pane.getByRole("button", { name: "Start fresh", exact: true })).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "Attach", exact: true })).toBeHidden();
  await pane.getByRole("combobox", { name: "Provider", exact: true }).selectOption("");
  await pane.getByRole("combobox", { name: "Provider", exact: true }).selectOption("fixture-two");
  await expect(pane.getByRole("button", { name: "Attach", exact: true })).toBeHidden();
  expect(clients).toBe(1);
  await screenshot(page, "configured-chat-ended");
  expect(problems).toEqual([]);
});

/** Answers or passes the app's requests, and collects what went wrong. */
async function serve(page: Page, data: FixtureData = DATA): Promise<string[]> {
  const problems: string[] = [];
  await page.route("**/api/acp", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/state", (route) => route.fulfill({ json: { schema: "review-service/v1" } }));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  // Anything but the app and the API, which the CSP forbids anyway.
  await page.route((url) => url.origin !== API && !url.href.startsWith(test.info().project.use.baseURL!), (route) => {
    problems.push(`unexpected request: ${route.request().url()}`);
    return route.abort();
  });
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ?? undefined;
    if (isWrite(req.method(), path, body)) {
      problems.push(`refused write: ${req.method()} ${path}`);
      return route.abort();
    }
    if (LIVE_TOKEN) return route.continue();
    return route.fulfill({ json: fixtureResponse(data, req.method(), path, body) });
  });
  return problems;
}

// The live report's views and problems, written after the test however it ends.
const views: ViewReport[] = [];
let problems: string[] = [];

test.beforeEach(() => {
  views.length = 0;
  problems = [];
});

test.afterEach(async ({ page }) => {
  const info = test.info();
  // The spec's line from the stack, not the message, which quotes the page.
  const spec = relative(process.cwd(), info.file);
  const line = info.errors.map((e) => e.stack?.split(`${info.file}:`)[1]?.match(/^\d+/)?.[0]).find(Boolean);
  // Where it stopped, when a failure cut the views short; the page may be gone.
  if (info.errors.length) views.push(await pageText(page, "at failure").catch(() => ({ view: "at failure (page unreadable)", texts: [] })));
  const failedAt = info.errors.length ? (line ? `${spec}:${line}` : spec) : null;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const prefix = LIVE_TOKEN ? "live-" : "";
  writeFileSync(`${SCREENSHOT_DIR}/${prefix}report-${info.project.name}.md`, liveReport(info.project.name, views, countProblems(problems, failedAt)));
});

/** The page's diagnostics, for the report. */
async function pageText(page: Page, view: string): Promise<ViewReport> {
  return { view, texts: await page.evaluate(diagnosticTexts, DIAGNOSTICS) };
}

async function screenshot(page: Page, view: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  await page.evaluate(() => window.scrollTo(0, 0));
  const prefix = LIVE_TOKEN ? "live-" : "";
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${prefix}${view}-${test.info().project.name}.png`, fullPage: true });
  views.push(await pageText(page, view));
}

test("Needs you and Status render without errors", async ({ page }) => {
  problems = await serve(page);
  await page.goto("#inbox");
  await expect(page).toHaveTitle("Control app");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Control app");
  await page.locator(".signin input[type=password]").fill(LIVE_TOKEN ?? FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await expect(page.locator(".published")).toBeVisible();
  await expect(page.locator(".published")).not.toHaveText(/^Reading/);
  // No service is configured: publications, their ages and live run lists
  // must load using only GitHub (serve refuses every other origin).
  await expect(page.locator("#writes")).toHaveText("Read-only · Enable writes");
  await expect(page.locator("body")).not.toContainText("server unavailable");
  if (!LIVE_TOKEN) {
    const run = page.getByRole("button", { name: "Run a pass now", exact: true });
    await expect(run).toBeDisabled();
    await page.getByRole("button", { name: "Check pass availability", exact: true }).click();
    await expect(run).toBeEnabled();
    await expect(page.locator(".run-pass-control [role=status]")).toContainText("No active pass found");
    // Keyboard cancellation must leave the write untouched (serve refuses writes).
    page.once("dialog", (dialog) => dialog.dismiss());
    await run.focus();
    await page.keyboard.press("Enter");
    await expect(run).toBeEnabled();
    // Live agents from the Actions API: one row per run, each with Cancel, within the page's width.
    const live = page.locator(".live-run");
    await expect(live).toHaveCount(3);
    await expect(live.first()).toContainText("bootc-dev/jmarrero-devspace-sandbox#36");
    await expect(live.getByRole("button", { name: "Cancel" })).toHaveCount(3);
    await expect(page.locator(".live-agents")).not.toContainText("Incomplete:");
    await expect(page.locator(".live-agents")).not.toContainText("39698121265");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator(".live-agents").screenshot({ path: `${SCREENSHOT_DIR}/agents-${test.info().project.name}.png` });
  }
  await screenshot(page, "inbox");
  if (!LIVE_TOKEN && DATA !== "259") {
    const focus = page.getByRole("region", { name: "Focus", exact: true });
    await expect(focus).toBeVisible();
    const card = focus.locator(".focus-card").first();
    const openChild = card.getByRole("link", { name: "Issue 3", exact: true });
    const doneChild = card.getByRole("link", { name: "Issue 4", exact: true });
    await expect(card).not.toHaveAttribute("open");
    await expect(openChild).toBeHidden();
    await focus.screenshot({ path: `${SCREENSHOT_DIR}/focus-${test.info().project.name}.png` });
    await card.locator(":scope > summary").click();
    await expect(openChild).toBeVisible();
    await expect(doneChild).toBeHidden();
    const epicRun = card.locator(".focus-runs li").filter({ has: page.getByRole("link", { name: "o/runner/42", exact: true }) });
    await expect(epicRun.getByRole("link", { name: "o/runner/42", exact: true })).toHaveAttribute("href", "https://github.com/o/runner/actions/runs/42");
    await expect(epicRun.getByRole("link", { name: "o/t#1", exact: true })).toHaveAttribute("href", "https://github.com/o/t/issues/1");
    await focus.screenshot({ path: `${SCREENSHOT_DIR}/focus-expanded-${test.info().project.name}.png` });
    await card.locator(".focus-done > summary").click();
    await expect(doneChild).toBeVisible();
    await card.locator(".focus-done > summary").click();
    await expect(doneChild).toBeHidden();
    await page.reload();
    await expect(page.locator(".published")).not.toHaveText(/^Reading/);
    await expect(focus.locator(".focus-card").first()).toHaveAttribute("open");
    await expect(focus.getByRole("link", { name: "Issue 3", exact: true })).toBeVisible();
    await expect(focus.getByRole("link", { name: "Issue 4", exact: true })).toBeHidden();
    await expect(focus.getByRole("link", { name: "o/runner/41" })).toHaveAttribute("href", "https://github.com/o/runner/actions/runs/41");
    await focus.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const today = page.getByRole("region", { name: "Today", exact: true });
    await expect(today).toBeVisible();
    await expect(today.getByText("3", { exact: true })).toBeVisible();
    await expect(today).toContainText("Incomplete pass history");
    await expect(today).toContainText("By pool: claude 2 · unknown 1");
    await expect(today.locator(".today-cost")).toContainText("$3.00 at list prices");
    await today.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await today.screenshot({ path: `${SCREENSHOT_DIR}/today-${test.info().project.name}.png` });
  }

  await page.goto("#status");
  // Scheduler passes where agent-board publishes holds.passes, else the pass view's Poller passes.
  await expect(page.getByRole("heading", { name: /^(Scheduler|Poller) passes$/ })).toBeVisible();
  if (!LIVE_TOKEN) {
    const board = page.getByRole("region", { name: "Repositories", exact: true });
    await expect(board.getByRole("table")).toHaveCount(DATA === "259" ? 2 : 3);
    await expect(board.getByRole("cell", { name: "3", exact: true })).toBeVisible();
    await expect(board.getByText(/1 items omitted/)).toBeVisible();
    const entry = board.getByRole("link", { name: "Run a pass now" });
    await entry.focus();
    await expect(entry).toBeFocused();
    if (DATA !== "259") {
      const observations = board.getByText("Maintainer observations", { exact: true });
      await expect(observations).toHaveCount(2);
      for (const summary of await observations.all()) await summary.click();
      await expect(board.getByText("Merge-queue depth: 2.", { exact: true })).toBeVisible();
      await expect(board.getByText("Merge-queue depth: unknown (repository undecided this pass).", { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await screenshot(page, "status");

  expect(problems).toEqual([]);
});

test("expired browser token returns to sign-in and forgets it", async ({ page }) => {
  test.skip(!!LIVE_TOKEN, "offline authentication regression");
  problems = await serve(page);
  // A real HTTP 401 logs a browser console error; it is expected here only.
  await page.route(`${API}/user`, (route) => route.fulfill({ status: 401, json: { message: "Bad credentials" } }));
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await expect(page.locator(".signin .warn")).toContainText("expired or was revoked");
  await expect(page.locator("#writes")).toBeHidden();
  expect(await page.evaluate(() => [sessionStorage.getItem("review.token"), localStorage.getItem("review.token")])).toEqual([null, null]);
  expect(problems.filter((p) => !p.includes("401"))).toEqual([]);
});

test("writes require session opt-in and reload returns to read-only", async ({ page }) => {
  test.skip(!!LIVE_TOKEN, "offline write policy regression");
  problems = await serve(page);
  await page.route(`${API}/repos/jmarrero-forge/tracker`, (route) => route.fulfill({ json: { default_branch: "main", permissions: { push: true } } }));
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await expect(page.locator(".published")).toBeVisible();
  await page.getByRole("button", { name: "Check pass availability", exact: true }).click();
  const run = page.getByRole("button", { name: "Run a pass now", exact: true });
  await expect(run).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await run.click();
  await expect(page.locator(".run-pass-control [role=status]")).toContainText("Read-only session");
  // serve would record any attempted dispatch as a refused write.
  expect(problems).toEqual([]);
  await page.getByRole("button", { name: "More", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#writes").click();
  await expect(page.locator("#writes")).toHaveText("Read-only · Enable writes");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#writes").click();
  await expect(page.locator("#writes")).toHaveText("Writes enabled · Make read-only");
  await screenshot(page, "write-policy");
  await page.getByRole("button", { name: "More", exact: true }).click();
  let dispatches = 0;
  await page.route(`${API}/repos/jmarrero-forge/tracker/actions/workflows/poll.yml/dispatches`, (route) => {
    dispatches++;
    return route.fulfill({ status: 422, json: { message: "Workflow refused the dispatch" } });
  });
  await page.getByRole("button", { name: "Check pass availability", exact: true }).click();
  await expect(run).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await run.click();
  await expect(page.locator(".run-pass-control [role=status]")).toContainText("Workflow refused the dispatch");
  expect(dispatches).toBe(1);
  await page.reload();
  await expect(page.locator("#writes")).toHaveText("Read-only · Enable writes");
  expect(problems.filter((p) => !p.includes("422"))).toEqual([]);
});

test("an open item offers the operator a read-only-guarded agent dispatch", async ({ page }) => {
  test.skip(!!LIVE_TOKEN, "offline item fixture");
  problems = await serve(page);
  const issue = { __typename: "Issue", id: "I_5", title: "Fix the flaky poll", body: "The poll times out about once a day.", url: "https://github.com/jmarrero-forge/tracker/issues/5", state: "OPEN", projectItems: { nodes: [], pageInfo: { hasNextPage: false } } };
  await page.route(`${API}/graphql`, (route) => route.request().postData()?.includes("issue(number:$number)")
    ? route.fulfill({ json: { data: { repository: { issue } } } }) : route.fallback());
  await page.goto("#issue/jmarrero-forge/tracker/5");
  await page.locator(".signin input[type=password]").fill(FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  const form = page.locator("form.item-dispatch");
  await expect(form).toBeVisible();
  await form.getByLabel("Brief").fill("Find why the poll times out.");
  page.once("dialog", (dialog) => dialog.accept());
  await form.getByRole("button", { name: "Dispatch" }).click();
  await expect(form.getByRole("status")).toContainText("Read-only session");
  await screenshot(page, "item-dispatch");
  expect(problems).toEqual([]);
});

test("Act now's decisions come first, with labelled needs-human issues read-only", async ({ page }) => {
  test.skip(!!LIVE_TOKEN, "the decisions fixture is synthetic");
  problems = await serve(page, "decisions");
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  const actNow = page.getByRole("region", { name: "Act now", exact: true });
  await expect(actNow).toBeVisible();
  await expect(actNow.locator(".act-now-gap")).toContainText("incomplete: Act now may be missing decisions");
  const first = actNow.locator("ol > li").first();
  await expect(first).toContainText("Which promotion posture? · unblocks 12");
  await expect(first.getByRole("link", { name: DECISION })).toHaveAttribute("href", `https://github.com/${DECISION.replace("#", "/issues/")}`);
  // agent-board#308 is published, so only tracker#1401 is listed from the label.
  const labelled = actNow.locator(".act-now-labelled li");
  await expect(labelled).toHaveCount(1);
  await expect(labelled.getByRole("link", { name: "jmarrero-forge/tracker#1401" })).toHaveAttribute("href", "https://github.com/jmarrero-forge/tracker/issues/1401");
  await expect(labelled).toContainText("unblocks unknown");
  await expect(actNow.locator(".act-now-labelled").locator("button, input, form")).toHaveCount(0);
  const focus = page.getByRole("region", { name: "Focus", exact: true });
  await expect(focus).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  const top = (await actNow.boundingBox())!.y;
  expect(top).toBeLessThan((await focus.boundingBox())!.y);
  expect(top).toBeLessThan(page.viewportSize()!.height / 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const activity = page.getByRole("region", { name: "Published activity", exact: true });
  await expect(activity).toBeVisible();
  await expect(activity).toContainText("Pass failure");
  await expect(activity).toContainText("global fact; not a run receipt");
  expect(await actNow.evaluate((el) => el.parentElement!.nextElementSibling!.querySelector(".published-activity") !== null)).toBe(true);
  expect(await activity.locator(".activity-row").evaluateAll((rows) => rows.every((r) => r.querySelector("a[href^='https://github.com/']")))).toBe(true);
  await activity.screenshot({ path: `${SCREENSHOT_DIR}/activity-${test.info().project.name}.png` });
  await screenshot(page, "decisions");
  await page.screenshot({ path: `${SCREENSHOT_DIR}/decisions-top-${test.info().project.name}.png` });
  expect(problems).toEqual([]);
});

/** The agent's reply in the chat test: one proposal the app can show, one of a kind the schema lacks. */
const PROPOSALS = [
  "I can't write, but here is what I'd do:",
  "```agent-board-action",
  JSON.stringify({ schema: "agent-board/operator-action/v1", title: "Close the finished chat issue", why: "Its pull request merged and nothing is left to do.", actions: [
    { type: "close_issue", repo: "jmarrero/review", number: 275, reason: "Done in the merged pull request; closing." },
    { type: "add_label", repo: "jmarrero/review", number: 275, label: "shipped" },
  ] }, null, 2),
  "```",
  "And a follow-up comment:",
  "```agent-board-action",
  JSON.stringify({ schema: "agent-board/operator-action/v1", title: "Thank the reviewer", why: "Courtesy.", actions: [{ type: "comment_issue", repo: "jmarrero/review", number: 275, body: "Thanks!" }] }),
  "```",
].join("\n");

test("Chat shows an agent's proposals as preview cards", async ({ page }) => {
  test.skip(!!LIVE_TOKEN, "the session socket is answered here, from fixtures only");
  // Chat is off in jmarrero's deployment: no session source yet.
  test.skip(!JSON.parse(readFileSync("src/github/chat-config.json", "utf8")).sources.length, "chat is off in this deployment (no session source)");
  problems = await serve(page);
  // The session bridge: ACP over the socket, answering a prompt with the proposals.
  await page.routeWebSocket(SESSION_ENDPOINT, (ws) => ws.onMessage((text) => {
    const m = JSON.parse(String(text));
    const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    if (m.method === "initialize") reply({ protocolVersion: 1 });
    else if (m.method === "session/new") reply({ sessionId: "session" });
    else if (m.method === "session/prompt") {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: PROPOSALS } } } }));
      reply({ stopReason: "end_turn" });
    }
  }));
  await page.goto("#inbox");
  await page.locator(".signin input[type=password]").fill(FIXTURE_TOKEN);
  await page.locator(".signin button[type=submit]").click();
  await page.getByRole("button", { name: "Start a chat", exact: true }).first().click();
  const chat = page.getByRole("region", { name: "Session chat" });
  await chat.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(chat.locator(".chat-state")).toHaveText("connected");
  await chat.getByRole("textbox", { name: "Prompt" }).fill("Anything to close?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  const cards = chat.locator(".chat-proposal");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Close the finished chat issue");
  await expect(cards.nth(1)).toContainText("is not in the operator action schema");
  await expect(chat.locator(".chat-proposal button")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await chat.getByRole("button", { name: "Full screen" }).click();
  // The log scrolls on its own: show the cards, not the message above them.
  await cards.first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-${test.info().project.name}.png` });
  expect(problems).toEqual([]);
});
