import assert from "node:assert/strict";
import { it } from "node:test";
import { MAX_ACTIVITY_ROWS, publishedActivity, PUBLICATION_HREF } from "../src/github/activity.ts";
import { activityView } from "../src/github/activityview.ts";
import { parseNeedsYou, type InboxContext, type NeedsYou } from "../src/github/holds.ts";
import type { Published } from "../src/github/inbox.ts";
import { parsePasses, PASSES_MARKER, type Passes } from "../src/github/passes.ts";
import { readPasses } from "../src/github/passesview.ts";
import { homeSkeleton } from "../src/github/homeview.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const AT = "2026-11-05T12:00:00Z";
const NOW = Date.parse(AT);
const fact = { source: "hold", item: "o/r#3", kind: "blocked", reason: "A snapshot, not a new decision", observedAt: AT };
const context = (items: InboxContext["items"] = [fact]): InboxContext => ({ items, sources: { holds: "complete", runs: "partial", steps: "unread" }, omitted: 2, limits: {} });
const published = (c = context()): Published => ({ asks: [], unavailable: false, checkedAt: NOW,
  list: { context: c, validatedAt: AT } as NeedsYou });
const passes = (): Passes => parsePasses(`${PASSES_MARKER}\n\n\`\`\`json\n${JSON.stringify(fixture("passes.json"))}\n\`\`\``) as Passes;

it("links item observations and red/partial passes to typed identities, not prose", () => {
  const data = passes();
  const feed = publishedActivity(published(), { data });
  assert.equal(feed.rows.find((r) => r.source === "context")?.href, "https://github.com/o/r/issues/3");
  for (const p of data.passes.filter((p) => p.result !== "success")) {
    const row = feed.rows.find((r) => r.at === p.finishedAt)!;
    assert.match(row.text, new RegExp(`Pass ${p.result}`));
    assert.ok(row.text.includes("failed") || row.text.includes("cut-short"));
    if (p.run) assert.equal(row.href, `https://github.com/${p.run.repository}/actions/runs/${p.run.id}${p.run.attempt ? `/attempts/${p.run.attempt}` : ""}`);
  }
  assert.equal(published().asks.length, 0);
});

it("global facts and passes without runs explicitly use the publication source; invalid items are counted", () => {
  const p = passes();
  p.passes = [{ ...p.passes[0]!, run: null }];
  const { item: _item, ...global } = fact;
  const feed = publishedActivity(published(context([global, { ...fact, item: "../r#3" }])), { data: p });
  assert.equal(feed.unlinkable, 1);
  assert.equal(feed.rows.length, 2);
  for (const row of feed.rows) {
    assert.equal(row.href, PUBLICATION_HREF);
    assert.match(row.linkText, /not a run receipt/);
  }
});

it("deduplicates stable identities newest first, orders ties deterministically, keeps missing time unknown and bounds rows", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ ...fact, item: `o/r#${i + 1}` }));
  const { observedAt: _at, ...untimed } = fact;
  const unknown = { ...untimed, item: "o/r#99" };
  const all = [...items, { ...fact, item: "O/R#1", observedAt: "2026-11-05T11:00:00Z" }, unknown];
  const a = publishedActivity(published(context(all)), {});
  const b = publishedActivity(published(context(all.toReversed())), {});
  assert.deepEqual(a, b);
  assert.equal(a.rows.length, MAX_ACTIVITY_ROWS);
  assert.equal(a.duplicates, 1);
  assert.equal(a.omitted, 2 + 21 - MAX_ACTIVITY_ROWS);
  const short = publishedActivity(published(context([unknown, fact])), {});
  assert.equal(short.rows[1]!.at, undefined);
});

it("renders literal safe text, useful links on every row, observation/publication clocks and coverage", () => {
  const { observedAt: _at, ...untimed } = fact;
  const c = context([{ ...untimed, reason: '<img src=x onerror=alert(1)> dial https://private.invalid/path' }]);
  const el = activityView(published(c), { data: passes() }, NOW);
  assert.equal(el.querySelector("img"), null);
  assert.ok(el.textContent?.includes("<img"));
  assert.ok(!el.textContent?.includes("private.invalid"));
  assert.match(el.textContent!, /holds complete, runs partial, steps unread/);
  assert.match(el.textContent!, /observed unknown/);
  assert.match(el.textContent!, /publication validated/);
  assert.match(el.textContent!, /records\/details omitted/);
  for (const row of el.querySelectorAll(".activity-row")) {
    const href = row.querySelector("a")?.getAttribute("href");
    assert.match(href!, /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues\/\d+|actions\/runs\/\d+(\/attempts\/\d+)?)$/);
  }
});

it("labels missing, cached, stale and failed retained sources without claiming no activity", () => {
  const empty: Published = { asks: [], unavailable: false };
  const absent = activityView(empty, { absent: true }, NOW);
  assert.match(absent.textContent!, /No observed records/);
  assert.match(absent.textContent!, /does not mean no activity/);
  assert.match(absent.textContent!, /not published/);
  const { checkedAt: _checked, ...cached } = published();
  const p = { ...cached, unavailable: true, error: "Read failed" };
  const data = passes();
  const read = readPasses({ data }, { at: NOW, warnings: [], sources: { holds: { state: "unavailable", error: "HTTP 503" } } });
  assert.equal(read.data, data);
  const el = activityView(p, read, NOW + 86_400_000);
  assert.match(el.textContent!, /last-read \/ cached/);
  assert.match(el.textContent!, /failed\/unavailable read/);
  assert.match(el.textContent!, /stale/);
  assert.ok([...el.querySelectorAll(".activity-row")].every((r) => r.textContent?.includes("last-read")));
});

it("places the feed slot immediately after Act now, ahead of Focus", () => {
  const home = homeSkeleton({ toggled() {} });
  assert.equal(home.slots.actNow.parentElement!.nextElementSibling, home.slots.activity);
  assert.equal(home.slots.activity.nextElementSibling, home.slots.focus);
});

it("does not recast rejected published item identities as global facts", () => {
  const list = parseNeedsYou({ ...fixture<Record<string, unknown>>("needs-you-661.json"), context: {
    sources: { holds: "partial" }, omitted: 0, items: [{ source: "hold", item: "not-an-item", kind: "blocked", reason: "Invalid target" }],
  } });
  assert.equal(typeof list, "object");
  const p = { ...published(), list: list as NeedsYou };
  const feed = publishedActivity(p, {});
  assert.equal(feed.rows.length, 0);
  assert.equal(feed.unlinkable, 1);
  assert.match(activityView(p, {}, NOW).textContent!, /1 unlinkable/);
});

it("qualifies a capped comment read and attributes omissions to each publication and the display cap", () => {
  const data = passes();
  data.omitted = 3;
  data.unreadable = 1;
  const p = published(context(Array.from({ length: 20 }, (_, i) => ({ ...fact, item: `o/r#${i + 1}` }))));
  const el = activityView(p, { data, unavailable: "only the first 100 comments were read" }, NOW, "only the first 100 comments were read");
  assert.match(el.textContent!, /not confirmed/);
  assert.ok(!el.textContent?.includes(" · confirmed read"));
  assert.match(el.textContent!, /2 context facts omitted/);
  assert.match(el.textContent!, /3 passes omitted, 1 unreadable/);
  assert.match(el.textContent!, /13 rows excluded by display cap/);
  assert.match(el.textContent!, /first 100 comments/);
  assert.ok([...el.querySelectorAll(".activity-row")].every((r) => r.textContent?.includes("last-read")));
});
