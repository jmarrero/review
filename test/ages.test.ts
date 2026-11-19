import assert from "node:assert/strict";
import { it } from "node:test";
import { ageLabel, ago, agoLabel, tickAges, time } from "../src/github/view.ts";
import { installDom } from "./helpers.ts";

installDom();
const since = "2026-01-15T11:00:00Z";
const now = Date.parse("2026-01-15T11:30:00Z");

it("ticks shared labels in place and retains the absolute time in title", () => {
  const label = ageLabel(since, now);
  assert.equal(label.textContent, "30m");
  assert.equal(label.title, time(since));
  assert.match(label.title, /2026/);
  const root = document.createElement("div");
  root.append(label, ageLabel(undefined, now), ageLabel("bad date", now));
  tickAges(root, now + 3600_000);
  assert.equal(root.firstChild, label);
  assert.equal(label.textContent, "1h");
  assert.equal(label.title, time(since));
  assert.equal(root.lastChild?.textContent, "age unknown");
});

it("phrases sub-minute ages in prose as just now, never now ago", () => {
  assert.equal(ago(since, Date.parse(since) + 30_000), "just now");
  assert.equal(ago(since, now), "30m ago");
  assert.equal(ago("bad date", now), "");
  const label = agoLabel(since, Date.parse(since) + 30_000);
  assert.equal(label.textContent, "just now");
  const root = document.createElement("div");
  root.append(label);
  tickAges(root, now);
  assert.equal(label.textContent, "30m ago");
  assert.equal(agoLabel(undefined, now).textContent, "at an unknown time");
});
