// config.ts holds the app's public settings as constants: there is no
// stored settings object to load or validate, so these check that the
// values agree with each other and that nothing secret is in the file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as config from "../src/github/config.ts";

const source = readFileSync(new URL("../src/github/config.ts", import.meta.url), "utf8");

describe("config: the board", () => {
  it("builds the board URL from its owner and number", () => {
    assert.equal(config.BOARD_URL, `https://github.com/orgs/${config.BOARD_OWNER}/projects/${config.BOARD_NUMBER}`);
    assert.ok(Number.isInteger(config.BOARD_NUMBER) && config.BOARD_NUMBER > 0);
  });

  it("queues Needs human and Draft, and reads In Review only to rank", () => {
    assert.deepEqual(config.QUEUE_STATUSES, [config.NEEDS_HUMAN, config.DRAFT]);
    assert.deepEqual(config.LINKED_STATUSES, [config.IN_REVIEW]);
    for (const s of [config.DONE, config.IN_PROGRESS, config.IN_REVIEW]) assert.ok(!config.QUEUE_STATUSES.includes(s), s);
  });

  it("reads each board field under one name", () => {
    const names = [config.FIELD, config.TRIAGE_FIELD, config.FEED_FIELD].flatMap((f) => Object.values(f));
    assert.equal(new Set(names).size, names.length);
  });

  it("lists each Theme and Verdict once", () => {
    assert.equal(new Set(config.TRIAGE_THEMES).size, config.TRIAGE_THEMES.length);
    assert.deepEqual([...config.VERDICTS], ["keep", "merge", "park", "close"]);
  });

  it("uses distinct ask labels", () => {
    const labels = [config.QUESTION_LABEL, config.REVIEW_LABEL, config.CHORE_LABEL, config.DECISION_LABEL, config.CAPTURE_LABEL];
    assert.equal(new Set(labels).size, labels.length);
  });

  it("trusts only app logins as role apps", () => {
    // None exist yet (config.ts): drop this line when one is added.
    assert.equal(config.ROLE_APPS.length, 0);
    for (const a of config.ROLE_APPS) {
      assert.match(a.login, /^[a-z0-9-]+\[bot\]$/);
      assert.ok(a.role);
    }
  });
});

describe("config: repositories", () => {
  const repo = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
  it("names each as owner/repo", () => {
    for (const r of [config.TRACKER_REPO, config.DEVSPACE_REPO, config.USAGE_REPO, ...config.NEWS_REPOS]) assert.match(r, repo);
    assert.equal(new Set(config.NEWS_REPOS).size, config.NEWS_REPOS.length);
  });

  it("names the agent workflows as files", () => {
    for (const w of [config.DEVSPACE_WORKFLOW, config.AGENT_WORKFLOW]) assert.match(w, /^[\w-]+\.ya?ml$/);
  });

  it("points at real issues", () => {
    for (const n of [config.HEARTBEAT_ISSUE, config.USAGE_ISSUE]) assert.ok(Number.isInteger(n) && n > 0);
  });
});

describe("config: timing and limits", () => {
  it("are positive", () => {
    const numbers = Object.entries(config).filter(([k, v]) => typeof v === "number" && /_(MS|BYTES|CONCURRENCY|SIZE|LIMIT|LINES|FACTOR|HOURS)$/.test(k));
    assert.ok(numbers.length > 10);
    for (const [k, v] of numbers) assert.ok((v as number) > 0, k);
  });

  it("stays within GitHub's page and rate limits", () => {
    assert.ok(config.PAGE_SIZE <= 100 && config.OPS_RUNS_PER_PAGE <= 100);
    assert.ok(config.FETCH_CONCURRENCY >= config.GITHUB_CONCURRENCY, "the client caps verdict fetches anyway");
    assert.ok(config.RATE_LIMIT_WAIT_MS >= 60_000);
    assert.ok(config.RATE_LOW_FRACTION > 0 && config.RATE_LOW_FRACTION < 1);
    assert.ok(config.POLL_BACKOFF_FACTOR > 1);
  });

  it("orders the poll's thresholds", () => {
    assert.ok(config.POLL_SLOW_MS < config.POLL_STALL_MS);
    assert.ok(config.FORGE_MIN_INTERVAL_MS <= config.FORGE_POLL_INTERVAL_MS);
    assert.ok(config.HEARTBEAT_WAKE_GRACE_MS < config.HEARTBEAT_STALE_MS);
    assert.ok(config.OPS_EVENTS_SHOWN <= config.OPS_EVENTS);
  });
});

describe("config: storage and tokens", () => {
  it("keeps every storage key distinct and under the app's prefix", () => {
    const keys = [config.THEME_KEY, config.CAPTURE_DRAFT_KEY, config.TOKEN_KEY];
    assert.equal(new Set(keys).size, keys.length);
    for (const k of keys) assert.match(k, /^review\./);
  });

  it("asks a classic token for a scope per need", () => {
    for (const s of config.CLASSIC_SCOPES) {
      assert.ok(s.any.length > 0 && s.why);
    }
    const all = config.CLASSIC_SCOPES.flatMap((s) => [...s.any]);
    assert.ok(all.includes("read:project") && all.includes("public_repo"));
  });

  // The file is published with the app ("Public names only"): a token
  // here would be a leak. The patterns are built from parts so this test
  // isn't itself a match.
  it("holds no token", () => {
    const prefixes = ["gh" + "p_", "gh" + "o_", "gh" + "s_", "gh" + "u_", "github" + "_pat_"];
    for (const p of prefixes) assert.ok(!source.includes(p), p);
    assert.doesNotMatch(source, /\b[A-Za-z0-9]{40}\b/);
  });
});
