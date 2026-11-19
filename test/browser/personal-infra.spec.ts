import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";

const fixture = (name: string) => JSON.parse(readFileSync(`service/fixtures/${name}-state.json`, "utf8"));

test("personal infrastructure is hosted-only and configured-only", async ({ page }) => {
  await page.route("**/api/acp", (route) => route.fulfill({ json: [] }));
  await page.clock.install();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  let reads = 0;
  let state: object = { schema: "review-service/v1" };
  await page.route("**/api/v1/state", (route) => {
    reads++;
    return route.fulfill({ json: state });
  });
  await page.goto("/");
  await expect(page.locator(".signin")).toBeVisible();
  await expect(page.getByRole("button", { name: "Configured chat", exact: true })).toHaveCount(0);
  if (!process.env.BROWSER_HOSTED) {
    await expect(page.locator('script[src="personal-infra.js"]')).toHaveCount(0);
    expect(reads).toBe(0);
    return;
  }
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByRole("region", { name: "Personal infrastructure" })).toHaveCount(0);
  state = { schema: "review-service/v1", forgejo: fixture("forgejo"), kubernetes: fixture("kubernetes") };
  await page.reload();
  const panel = page.getByRole("region", { name: "Personal infrastructure" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Rollout in progress");
  await expect(panel).toContainText("Forgejo · Needs you");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  mkdirSync("dist/screenshots", { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `dist/screenshots/personal-infra-${test.info().project.name}.png`, fullPage: true });
  // A malformed successful response is still a read failure, not confirmed absence.
  state = {};
  await page.clock.runFor(60_001);
  await expect(page.locator("#personal-infra")).toContainText("Personal infrastructure unavailable");
  await expect(panel).toHaveCount(0);
  state = { schema: "review-service/v1" };
  await page.clock.runFor(60_001);
  await expect(page.locator("#personal-infra")).toBeEmpty();
  expect(errors).toEqual([]);
});
