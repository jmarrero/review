// The browser test (test/browser/app.spec.ts): the app as build.ts builds
// it, served by `node build.ts --serve`, in Playwright's Chromium at a
// desktop and a phone width. Its output, screenshots included, goes under
// dist/, which git ignores and pages.yml rebuilds before publishing.

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:8787/";

export default defineConfig({
  testDir: "test/browser",
  outputDir: "dist/test-results",
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: BASE_URL, browserName: "chromium", serviceWorkers: "block" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
  // Never another checkout's dev server on the same port: its screenshots would pass for this one's.
  webServer: { command: `node build.ts --serve${process.env.BROWSER_HOSTED ? " --hosted" : ""}`, url: BASE_URL, reuseExistingServer: false },
});
