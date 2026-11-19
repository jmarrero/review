// Puts the live dry run's reports (live-report.ts) on the tracking issue,
// replacing its body: `node test/e2e/post-live-report.ts REPORT.md...`.
// Run by .github/workflows/live.yml with GITHUB_TOKEN (issues: write) and
// LIVE_REPORT_ISSUE, the issue's number.

import { existsSync, readFileSync } from "node:fs";
import { issueBody } from "./live-report.ts";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const issue = env("LIVE_REPORT_ISSUE");
if (!/^\d+$/.test(issue)) throw new Error(`LIVE_REPORT_ISSUE=${issue}: not an issue number`);
const repository = env("GITHUB_REPOSITORY");
const runUrl = `${env("GITHUB_SERVER_URL")}/${repository}/actions/runs/${env("GITHUB_RUN_ID")}`;
const files = process.argv.slice(2);
if (!files.length) throw new Error("usage: post-live-report.ts REPORT.md...");

// A missing report means the test stopped before writing it (no browser, a
// failed build): say so rather than leave the last run's report standing.
const reports = files.map((f) => (existsSync(f) ? readFileSync(f, "utf8") : `## ${f}\n\nNot written: the browser test did not get that far; see the run's log.\n`));
const res = await fetch(`https://api.github.com/repos/${repository}/issues/${issue}`, {
  method: "PATCH",
  headers: { authorization: `Bearer ${env("GITHUB_TOKEN")}`, accept: "application/vnd.github+json", "content-type": "application/json" },
  body: JSON.stringify({ body: issueBody(reports, runUrl, new Date()) }),
});
if (!res.ok) throw new Error(`updating ${repository}#${issue}: HTTP ${res.status} ${await res.text()}`);
