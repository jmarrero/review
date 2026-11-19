import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "../src/dom.ts";
import { fillState, homeSkeleton } from "../src/github/homeview.ts";
import { publishedNote } from "../src/github/inbox.ts";
import { type Passes, PASSES_MARKER, parsePasses } from "../src/github/passes.ts";
import { passesView } from "../src/github/passesview.ts";
import { todayView, type Today } from "../src/github/today.ts";
import { ROW_CLASS } from "../src/github/view.ts";
import { countProblems, DIAGNOSTICS, diagnosticTexts, issueBody, liveReport, statusLines } from "./e2e/live-report.ts";
import { fixture, installDom } from "./helpers.ts";

installDom();
const HOUR = 3_600_000;

describe("live report", () => {
  // The report goes on a public issue: row text read with the token must not.
  it("keeps only the app's status phrases, never the text around them", () => {
    const texts = [
      "Pass view not published (off or older producer)",
      "Detail not published: inspect the source before acting",
      "  Detail not published:\n inspect the source before acting ",
      "unknown/deep · CI unknown (published unknown) · Secret summary; private reason. Informational only.",
      "private/repo#12: Today unavailable is a stale title",
      "Incomplete (proposals partial, 51 past the pass's cap, 2 unreadable here): more may wait on you.",
      " — stale: the pass may have stopped, or failed to publish",
      "",
    ];
    assert.deepEqual(statusLines(texts), [
      "Pass view not published",
      "Detail not published (×2)",
      "Today unavailable",
      "Incomplete",
      "51 past the pass's cap",
      "2 unreadable here",
      "— stale: the pass may have stopped, or failed to publish",
    ]);
  });

  it("drops a number too long to be one of the app's counts", () => {
    assert.deepEqual(statusLines([
      "Confidential customer identifier: 424242424242 unreadable here", "(12345 past the pass's cap)", "Couldn't read: #4242 unreadable here",
    ]), []);
  });

  it("reads only the app's notes outside rows, whose text is private", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p class="note published">Incomplete (2 unreadable here)</p>
      <article class="${ROW_CLASS} card"><span class="title">Confidential: 4242 unreadable here</span>
        <p class="card-note warn">Today unavailable</p><details class="card-note"><p class="note">7 past the pass's cap</p></details></article>
      <p>Pass view not published</p>`;
    assert.equal(DIAGNOSTICS.rows, `.${ROW_CLASS}`);
    assert.deepEqual(diagnosticTexts(DIAGNOSTICS, root), ["Incomplete (2 unreadable here)"]);
  });

  // The producers' own wording, so a rewording that the phrases miss fails here.
  const today = fixture<Today>("today.json");
  const passes = fixture<Record<string, unknown>>("passes.json");
  const observed = Date.parse("2026-11-07T12:00:00Z");
  const home = homeSkeleton({ toggled() {} });
  fillState(home, { sources: { holds: { state: "unavailable", error: "HTTP 502" }, status: { state: "cached", fetchedAt: observed } } });
  // As main.ts shows publishedNote's text.
  const inbox = h("div", {}, h("p", { class: "note published warn" }, publishedNote({ asks: [], unavailable: false, error: "Couldn't read the pass's snapshot: HTTP 502" }, observed).text));
  for (const [label, el, line] of [
    ["an unavailable source", home.el, "holds: unavailable"],
    ["a cached source", home.el, "status: cached"],
    ["an unreadable needs-you list", inbox, "Couldn't read the pass's snapshot"],
    ["unavailable Today", todayView(today, observed, "HTTP 502"), "Today publication unavailable"],
    ["previous-day Today", todayView(today, observed + 13 * HOUR), "previous UTC day, not today's activity"],
    ["stale Today", todayView(today, observed + 25 * HOUR), "stale (over a day old)"],
    ["unavailable passes", passesView({ unavailable: "couldn't confirm it (HTTP 502)" }, observed), "Pass publication unavailable"],
    ["stale passes", passesView({ data: parsePasses(`${PASSES_MARKER}\n\n\`\`\`json\n${JSON.stringify(passes)}\n\`\`\``) as Passes }, observed + 30 * 24 * HOUR), "— stale: the pass may have stopped, or failed to publish"],
  ] as const) {
    it(`reports ${label}`, () => assert.ok(statusLines(diagnosticTexts(DIAGNOSTICS, el)).includes(line), el.textContent!));
  }

  it("counts problems instead of quoting them", () => {
    const p = countProblems(["console: GET private/repo failed", "console: x", "refused write: POST /repos/private/repo/pulls/1/reviews", "uncaught: boom"], "test/browser/app.spec.ts:90");
    assert.deepEqual(p, { console: 2, uncaught: 1, refusedWrites: 1, unexpectedRequests: 0, failedAt: "test/browser/app.spec.ts:90" });
    assert.equal(liveReport("desktop", [
      { view: "inbox", texts: ["Today not published (off, older producer or omitted); activity is unknown."] },
      { view: "status", texts: ["Poller passes"] },
    ], p), `## desktop

### inbox

- Today not published

### status

None of the known unpublished, unavailable or stale notes.

### Problems

- Failed at test/browser/app.spec.ts:90
- Console errors: 2; uncaught exceptions: 1; refused writes: 1; unexpected requests: 0
`);
  });

  it("heads the issue body with the run", () => {
    const body = issueBody(["## desktop\n"], "https://github.com/o/r/actions/runs/1", new Date("2026-11-07T12:00:00Z"));
    assert.match(body, /^Live dry run of the browser test, 2026-11-07T12:00:00.000Z: https:\/\/github.com\/o\/r\/actions\/runs\/1\n/);
    assert.match(body, /## desktop\n$/);
  });
});
