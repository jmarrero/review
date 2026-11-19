import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Verdict } from "../src/github/forge.ts";
import {
  afterReview,
  botRepliedSince,
  checkRunWorkflow,
  classifyPr,
  dcoFailing,
  failedRequired,
  forgeWait,
  type PrFacts,
  type PrWait,
  type RawAppCheckRun,
  type RawPrCommit,
  signoffTrailer,
  unsignedCommits,
} from "../src/github/waiting.ts";

const RUN = "https://github.com/bootc-dev/bootc/actions/runs/555";
const run = (name: string, conclusion: string, over: Partial<RawAppCheckRun> = {}): RawAppCheckRun => ({
  name,
  status: "completed",
  conclusion,
  app: { slug: "github-actions" },
  details_url: `${RUN}/job/1`,
  ...over,
});

describe("dcoFailing", () => {
  const cases: [string, RawAppCheckRun[], string[], boolean][] = [
    ["the DCO app wants a sign-off", [run("DCO", "action_required", { app: { slug: "dco-2" } })], [], true],
    ["the DCO app passed", [run("DCO", "success", { app: { slug: "dco" } })], ["DCO"], false],
    ["the DCO app still running", [run("DCO", "", { status: "in_progress", app: { slug: "dco" } })], [], false],
    ["a required check named DCO failed", [run("DCO", "failure")], ["DCO", "ci"], true],
    ["a PR's own workflow named DCO, not required", [run("DCO", "failure")], ["ci"], false],
    ["other failures", [run("ci", "failure")], ["ci"], false],
  ];
  for (const [name, runs, required, want] of cases) it(name, () => assert.equal(dcoFailing(runs, required), want));
});

describe("unsignedCommits", () => {
  const HIM = { name: "Joseph Marrero Corchado", email: "jmarrero@redhat.com" };
  const BOT = { name: "Joseph Marrero Corchado", email: "jmarrero+bot@gmail.com" };
  const commit = (sha: string, message: string, author = BOT, committer = HIM): RawPrCommit => ({ sha: sha.repeat(40), commit: { message, author, committer } });
  const signed = `fix: It\n\nGenerated-by: AI\n${signoffTrailer()}\n`;
  const cases: [string, RawPrCommit, boolean][] = [
    ["signed, him committing", commit("a", signed), false],
    ["signed, him authoring", commit("b", signed, HIM, BOT), false],
    ["signed with trailing space and CRLF", commit("c", `fix\r\n\r\n${signoffTrailer()}  \r\n`), false],
    ["no sign-off", commit("d", "fix: It\n\nGenerated-by: AI\n"), true],
    ["signed, but rebased by the bot", commit("e", signed, BOT, BOT), true],
    ["someone else's sign-off", commit("f", "fix\n\nSigned-off-by: Someone <s@example.com>\n"), true],
  ];
  for (const [name, c, unsigned] of cases) {
    it(name, () => assert.deepEqual(unsignedCommits([c]), unsigned ? [c.sha.slice(0, 12)] : []));
  }
});

describe("checkRunWorkflow", () => {
  const cases: [string, Partial<RawAppCheckRun>, string | undefined][] = [
    ["an Actions job", { details_url: `${RUN}/job/42` }, RUN],
    ["the run itself", { details_url: RUN }, RUN],
    ["the html_url when details_url isn't one", { details_url: "https://ci.example/1", html_url: `${RUN}/job/7` }, RUN],
    ["another CI", { details_url: "https://ci.example/1", html_url: "https://github.com/o/r/runs/1" }, undefined],
    ["a job URL with a query", { details_url: `${RUN}/job/42?pr=1` }, RUN],
  ];
  for (const [name, over, want] of cases) it(name, () => assert.equal(checkRunWorkflow({ name: "x", ...over })?.url, want));
});

describe("failedRequired", () => {
  it("keeps the required checks that failed, DCO aside, with their runs", () => {
    const runs = [
      run("required-checks", "failure"),
      run("test-integration (fedora)", "failure"),
      run("DCO", "action_required", { app: { slug: "dco-2" } }),
      run("docs", "success"),
      run("lint", "cancelled", { details_url: "https://ci.example/9", html_url: "https://ci.example/9" }),
      run("approval", "action_required"),
    ];
    assert.deepEqual(failedRequired(runs, ["DCO", "required-checks", "docs", "lint", "approval"]), [
      { name: "required-checks", run: { url: RUN, owner: "bootc-dev", repo: "bootc", id: "555" } },
      { name: "lint" },
    ]);
  });
});

describe("classifyPr", () => {
  const v = (state: Verdict["state"]): Verdict => ({ state, at: "2026-09-01T00:00:00Z" });
  const base: PrFacts = {
    owner: "bootc-dev",
    requested: false,
    verdict: { state: "none" },
    botReplied: false,
    conflicting: false,
    dcoFailing: false,
    unsigned: [],
    failedRequired: [],
  };
  const red = { failedRequired: [{ name: "required-checks", run: { url: RUN, owner: "bootc-dev", repo: "bootc", id: "555" } }] };
  const dco = { dcoFailing: true, unsigned: ["aaaaaaaaaaaa"] };
  const his = (...reasons: PrWait["reasons"]) => reasons;
  // name, facts, reasons (undefined: not listed), on the bot
  const cases: [string, Partial<PrFacts>, PrWait["reasons"] | undefined, boolean][] = [
    ["nothing for anyone", {}, undefined, false],
    ["review requested", { requested: true }, his("review-requested"), false],
    ["review requested in the bot's own repository", { owner: "jmarrero-bot", requested: true }, his("review-requested"), false],
    ["changes requested, the bot silent", { verdict: v("changes-requested") }, [], true],
    ["changes requested, then the bot replied", { verdict: v("changes-requested"), botReplied: true }, his("updated"), false],
    ["changes requested, then the bot pushed", { verdict: v("changes-requested-older") }, his("updated"), false],
    ["changes requested, then re-requested", { verdict: v("changes-requested"), requested: true }, his("review-requested"), false],
    ["changes requested beats a red CI", { verdict: v("changes-requested"), ...red, ...dco }, [], true],
    ["DCO failing on unsigned commits", dco, his("resign"), false],
    ["DCO failing after a rework he approved before", { ...dco, verdict: v("approved-older") }, his("resign"), false],
    ["DCO failing on a conflicting PR: re-sign still, no rerun", { ...dco, ...red, conflicting: true }, his("resign"), false],
    ["the bot replied, CI red", { verdict: v("changes-requested"), botReplied: true, ...red }, his("rerun", "updated"), false],
    ["DCO failing, but he approved the head (the bot signs off)", { ...dco, verdict: v("approved") }, undefined, false],
    ["DCO failing, every commit signed (someone else's problem)", { dcoFailing: true }, undefined, false],
    ["DCO failing in the bot's own repository", { ...dco, owner: "jmarrero-forge" }, undefined, false],
    ["a failed required check", red, his("rerun"), false],
    ["a failed required check on a conflicting PR (the bot rebases)", { ...red, conflicting: true }, undefined, false],
    ["a failed required check with no Actions run", { failedRequired: [{ name: "ext" }] }, undefined, false],
    ["a failed required check in the bot's own repository", { ...red, owner: "jmarrero-bot" }, undefined, false],
    ["everything at once", { requested: true, ...dco, ...red }, his("review-requested", "resign", "rerun"), false],
  ];
  for (const [name, over, reasons, onBot] of cases) {
    it(name, () => {
      const got = classifyPr({ ...base, ...over });
      if (reasons === undefined) {
        assert.equal(got, undefined);
        return;
      }
      assert.deepEqual([got?.reasons, got?.onBot], [reasons, onBot]);
      if (reasons.includes("resign")) assert.deepEqual(got?.unsigned, ["aaaaaaaaaaaa"]);
      if (reasons.includes("rerun")) assert.deepEqual([got?.failed, got?.runs?.map((r) => r.url)], [["required-checks"], [RUN]]);
    });
  }
});

describe("botRepliedSince", () => {
  const at = "2026-09-01T10:00:00Z";
  const c = (login: string, created_at: string) => ({ user: { login }, created_at });
  const cases: [string, string | undefined, ReturnType<typeof c>[], boolean][] = [
    ["the bot, after", at, [c("jmarrero-bot", "2026-09-01T11:00:00Z")], true],
    ["the bot, before", at, [c("jmarrero-bot", "2026-09-01T09:00:00Z")], false],
    ["someone else, after", at, [c("someone", "2026-09-01T11:00:00Z")], false],
    ["no decision date", undefined, [c("jmarrero-bot", "2026-09-01T11:00:00Z")], false],
  ];
  for (const [name, since, comments, want] of cases) it(name, () => assert.equal(botRepliedSince(since, comments), want));
});

describe("forgeWait", () => {
  const cases: [Verdict["state"], boolean, PrWait | undefined][] = [
    ["changes-requested", false, { reasons: [], onBot: true }],
    ["changes-requested", true, { reasons: ["updated"], onBot: false }],
    ["changes-requested-older", false, undefined],
    ["none", true, undefined],
    ["approved", false, undefined],
  ];
  for (const [state, replied, want] of cases) it(`${state}, replied: ${replied}`, () => assert.deepEqual(forgeWait({ state }, replied), want));
});

describe("afterReview", () => {
  const wait = (reasons: PrWait["reasons"], onBot = false): PrWait => ({ reasons, onBot });
  // [name, before, verdict, reasons after (undefined: no longer listed), onBot after]
  const cases: [string, PrWait, "approved" | "changes-requested", PrWait["reasons"] | undefined, boolean?][] = [
    ["an approval answers a review request", wait(["review-requested"]), "approved", undefined],
    ["an approval is the re-sign's sign-off", wait(["resign", "updated"]), "approved", undefined],
    ["an approval leaves a rerun", wait(["review-requested", "rerun"]), "approved", ["rerun"], false],
    ["a change request makes it the bot's turn", wait(["review-requested"]), "changes-requested", [], true],
    ["a change request leaves a re-sign and a rerun", wait(["resign", "rerun", "updated"]), "changes-requested", ["resign", "rerun"], true],
  ];
  for (const [name, before, verdict, reasons, botTurn] of cases) {
    it(name, () => {
      const got = afterReview(before, verdict);
      assert.deepEqual(got && [got.reasons, got.onBot], reasons && [reasons, botTurn]);
    });
  }
});
