import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

// Chat is off in jmarrero's deployment: no session source yet.
const chatOff = !JSON.parse(readFileSync("src/github/chat-config.json", "utf8")).sources.length;

test("repository Chat confirms a dispatch and shows its returned starting run", async ({ page }) => {
  test.skip(chatOff, "chat is off in this deployment (no session source)");
  await page.route("**/api/acp", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/state", (route) => route.fulfill({ json: { schema: "review-service/v1" } }));
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  const bundle = await build({ entryPoints: ["test/e2e/session-dispatch.ts"], bundle: true, format: "esm", write: false });
  await page.route("**/app.js", (route) => route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0]!.text }));
  await page.route("https://api.github.com/**", (route) => { problems.push("Unexpected network request"); return route.abort(); });
  await page.goto("/");
  await page.getByRole("button", { name: "Chat about public/target" }).click();
  await expect(page.getByRole("textbox", { name: "Chat repository" })).toHaveValue("public/target");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Run 123 is starting…");
  await expect(page.getByRole("link", { name: "View session run 123" })).toHaveAttribute("href", "https://github.com/public/caller/actions/runs/123");
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  await page.screenshot({ path: `dist/screenshots/chat-dispatch-${test.info().project.name}.png`, fullPage: true });
  expect(problems).toEqual([]);
});
