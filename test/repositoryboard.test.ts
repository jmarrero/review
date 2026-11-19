import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHolds, loadPassPublications, HOLDS_MARKER } from "../src/github/holds.ts";
import { parseDispatchableWork } from "../src/github/repositoryboard.ts";
import { repositoriesView } from "../src/github/repositories.ts";
import { BOT_LOGIN } from "../src/github/config.ts";
import type { GitHub } from "../src/github/api.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const work = () => fixture<Record<string, any>>("dispatchable-work.json");
const snapshot = (): Record<string, any> => ({ ...fixture<Record<string, any>>("pass-view.json"), dispatchable_work: work() });
const body = (raw: unknown) => `${HOLDS_MARKER}\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
const now = Date.parse("2026-11-05T12:00:00Z");
const render = (raw = snapshot(), at = now) => {
  const holds = parseHolds(body(raw))!;
  return repositoriesView([], at, undefined, { work: holds.dispatchableWork, at: holds.at, pass: holds.passView });
};

describe("per-repository Status board", () => {
  it("uses the existing publication read and matches counts without summing overlapping plan kinds", async () => {
    let reads = 0;
    const gh = { get: async () => { reads++; return { data: [{ user: { login: BOT_LOGIN }, body: body(snapshot()) }] }; } } as unknown as GitHub;
    const { holds } = await loadPassPublications(gh);
    const el = repositoriesView([], now, undefined, { work: holds?.dispatchableWork, at: holds?.at, pass: holds?.passView });
    assert.equal(reads, 1);
    assert.equal(el.querySelectorAll("table").length, 2);
    const rows = [...el.querySelectorAll("table")].find((t) => t.caption?.textContent?.includes("example/work"))!.querySelectorAll("tbody tr");
    assert.deepEqual([...rows].map((r) => [r.querySelector("th")!.textContent, r.querySelector("td")!.textContent]), [["Ready", "3"], ["In flight", "2 listed"], ["In review", "1 listed"], ["Blocked", "2"]]);
    for (const text of ["1 items omitted", "issue plans incomplete", "taken this pass", "carried", "needs operator", "5m at observation", "accepted-plan: 2"]) assert.ok(el.textContent!.includes(text), text);
    assert.ok(el.querySelector("a[href='https://github.com/example/runner/actions/runs/42']"));
    assert.ok(el.querySelector("a[href='https://github.com/example/work/pull/15']"));
    assert.ok(el.querySelector("a[href$='/actions/workflows/poll.yml']"));
    assert.equal(el.querySelector("button"), null);
  });

  it("includes run-only repositories and joins repository names case-insensitively", () => {
    const raw = snapshot();
    raw.pass_view.in_flight[0].item = "EXAMPLE/WORK#11";
    raw.pass_view.in_flight.push({ state: "waiting-review", repository: "other/project", number: 1 });
    const el = render(raw);
    assert.equal(el.querySelectorAll("table").length, 3);
    assert.match(el.textContent!, /other\/project/);
    const table = [...el.querySelectorAll("table")].find((t) => t.caption?.textContent?.includes("other/project"))!;
    assert.deepEqual([...table.querySelectorAll(".repository-count")].map((c) => c.textContent), ["Unknown", "0 listed", "1 listed", "Unknown"]);
  });

  it("labels missing, malformed, omitted, incomplete, stale, future and unavailable publications", () => {
    const raw = snapshot();
    raw.pass_view.complete = false;
    raw.pass_view.omitted = 7;
    assert.match(render(raw).textContent!, /incomplete; unread work is unknown · 7 records omitted/);
    raw.pass_view.in_flight = [];
    assert.deepEqual([...render(raw).querySelectorAll("tbody tr:nth-child(2) .repository-count, tbody tr:nth-child(3) .repository-count")].map((c) => c.textContent), ["0 listed", "0 listed", "0 listed", "0 listed"]);
    raw.pass_view = snapshot().pass_view;
    assert.match(render(raw, now + 3_600_001).textContent!, /stale/);
    assert.match(render(raw, now - 60_001).textContent!, /clock is in the future/);
    assert.match(repositoriesView([], now, "offline", { unavailable: "offline" }).textContent!, /last read, not current/);
    assert.match(repositoriesView([], now).textContent!, /ready and blocked are unknown/);
    delete raw.dispatchable_work;
    assert.match(render(raw).textContent!, /Dispatchable work not published/);
    raw.dispatchable_work = { bad: true };
    const el = render(raw);
    assert.match(el.textContent!, /Dispatchable work unavailable/);
    assert.match(el.textContent!, /5m at observation/);
  });

  it("keeps unknown kinds and hostile prose as text, never addresses or authority", () => {
    const raw = snapshot();
    raw.dispatchable_work.repositories["example/work"].items[0].reason = '<img src=x onerror="alert(1)"> https://untrusted.invalid';
    raw.dispatchable_work.repositories["example/work"].counts.future = 1;
    const el = render(raw);
    assert.match(el.textContent!, /<img/);
    assert.match(el.textContent!, /Unknown decision kinds/);
    assert.equal(el.querySelector("img, script, [onerror], a[href*='untrusted']"), null);
  });

  it("accepts the producer's reasonless accepted plans and counts reasons in characters", () => {
    const raw = snapshot();
    const items = raw.dispatchable_work.repositories["example/work"].items;
    assert.equal(items.find((i: any) => i.kind === "accepted-plan").reason, undefined);
    items[0].reason = "\u{1F600}".repeat(500);
    const line = [...render(raw).querySelectorAll("li")].find((li) => li.textContent!.includes("#9"))!;
    assert.match(line.textContent!, /accepted-plan \(implement\)$/);
    items[0].reason += "\u{1F600}";
    assert.equal(typeof parseDispatchableWork(raw.dispatchable_work), "string");
  });

  it("rejects malformed or oversized extensions without losing the holds or pass view", () => {
    const mutations = [
      (r: any) => { r.repositories["bad/../repo"] = r.repositories["example/work"]; },
      (r: any) => { r.repositories["EXAMPLE/WORK"] = r.repositories["example/work"]; },
      (r: any) => { r.repositories["example/work"].reviews_complete = null; },
      (r: any) => { r.repositories["example/work"].omitted = 0; },
      (r: any) => { r.repositories["example/work"].counts.held = -1; },
      (r: any) => { r.repositories["example/work"].counts.held = 6; },
      (r: any) => { r.repositories["example/work"].items[0].item = "elsewhere/work#8"; },
      (r: any) => { r.repositories["example/work"].items[0].reason = "x".repeat(501); },
      (r: any) => { r.repositories["example/work"].items[0].taken = "yes"; },
      (r: any) => { r.repositories["example/work"].items = Array(201).fill(r.repositories["example/work"].items[0]); },
    ];
    for (const mutate of mutations) {
      const raw = snapshot();
      mutate(raw.dispatchable_work);
      assert.equal(typeof parseDispatchableWork(raw.dispatchable_work), "string");
      const holds = parseHolds(body(raw))!;
      assert.equal(typeof holds.dispatchableWork, "string");
      assert.equal(typeof holds.passView, "object");
      assert.deepEqual(holds.holds, []);
    }
  });
});
