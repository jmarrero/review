import assert from "node:assert/strict";
import { it } from "node:test";
import type { Sources } from "../src/github/freshness.ts";
import { fillState, homeSkeleton } from "../src/github/homeview.ts";
import { installDom } from "./helpers.ts";

it("shows the footer's per-source line only while a source is not ok", () => {
  installDom();
  const home = homeSkeleton({ toggled: () => {} });
  const now = Date.parse("2026-10-02T12:00:00Z");
  const ok = { state: "ok" as const, checkedAt: now, fetchedAt: now };
  const cases: [string, Sources, boolean][] = [
    ["every source ok or not read yet", { board: ok, heartbeat: ok, people: { state: "pending" } }, true],
    ["one unavailable", { board: ok, heartbeat: { state: "unavailable", error: "offline" } }, false],
    ["one from the cache", { board: { ...ok, state: "cached" } }, false],
  ];
  for (const [name, sources, hidden] of cases) {
    fillState(home, { sources });
    assert.equal(home.slots.freshness.hidden, hidden, name);
  }
});
