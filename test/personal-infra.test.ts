import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { personalInfra } from "../src/hosted/personal-infra.ts";

const dom = new JSDOM();
globalThis.document = dom.window.document;
const fixture = (name: string) => JSON.parse(readFileSync(`service/fixtures/${name}-state.json`, "utf8"));
const now = Date.parse("2026-11-10T12:01:00Z");

test("absent sources produce no panel; each configured source stands alone", () => {
  assert.equal(personalInfra({}), null);
  for (const key of ["forgejo", "kubernetes"]) {
    const panel = personalInfra({ [key]: fixture(key) }, now)!;
    assert.equal(panel.querySelectorAll("h3").length, 1);
    assert.match(panel.textContent!, /Current · Complete/);
  }
});

test("recorded Forgejo and Kubernetes states render separately with their facts", () => {
  const panel = personalInfra({ forgejo: fixture("forgejo"), kubernetes: fixture("kubernetes") }, now)!;
  for (const fact of ["Forgejo · Needs you", "Bump the ingress controller", "Draft", "Kubernetes", "Ready 3/3 · Updated 1", "Rollout in progress", "v1.4.0", "crash-looping", "restarting", "pending", "Ready: unknown", "main@sha1:4f2a9c1e0b7d"]) {
    assert.ok(panel.textContent!.includes(fact), fact);
  }
  assert.equal(panel.querySelectorAll("a").length, 4);
});

test("empty, failed, stale, future and incomplete observations stay distinct", () => {
  const section = { items: [], complete: true, readAt: "2026-11-10T12:00:00Z", error: null };
  assert.match(personalInfra({ forgejo: section }, now)!.textContent!, /No items reported/);
  for (const [patch, expected] of [
    [{ complete: false }, "Incomplete"],
    [{ error: "Read refused" }, "Source error: Read refused"],
    [{ readAt: null }, "Unavailable"],
    [{ readAt: "2026-11-10T11:00:00Z" }, "Stale"],
    [{ readAt: "2026-11-10T13:00:00Z" }, "Future clock"],
  ] as const) {
    const content = personalInfra({ forgejo: { ...section, ...patch } }, now)!.textContent!;
    assert.ok(content.includes(expected));
    assert.match(content, /coverage is unknown/);
  }
});

test("upstream markup and unsafe links are inert, and inventories are bounded", () => {
  const item = { title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)" };
  const panel = personalInfra({ forgejo: { items: Array(6001).fill(item) } }, now)!;
  assert.equal(panel.querySelectorAll("li").length, 6000);
  assert.equal(panel.querySelectorAll("a, img, script").length, 0);
  assert.match(panel.textContent!, /Additional items omitted/);
});
