import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

test("published documentation is readable and navigable beside the app", async ({ page }, info) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
  await page.route((url) => url.origin !== new URL(info.project.use.baseURL!).origin, (route) => route.abort());
  await page.goto("docs/");
  await expect(page.getByRole("heading", { name: "Control app", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mkdirSync("dist/screenshots", { recursive: true });
  await page.screenshot({ path: `dist/screenshots/docs-${info.project.name}.png` });
  await page.getByRole("link", { name: "design.md", exact: true }).first().click();
  await expect(page).toHaveURL(/\/docs\/design.html$/);
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/index.html$/);
  await expect(page.getByRole("link", { name: "Open app", exact: true })).toHaveAttribute("href", "../");
  expect(problems).toEqual([]);
});
