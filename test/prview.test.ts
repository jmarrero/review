// The review pane shows untrusted PR text (body, commit messages, file
// names, diffs, the bot's review guide): check it lands as text, that
// the diff viewer lays it out right, and that its buttons submit what
// the bot keys on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import type { DraftComment, ReviewAction } from "../src/github/forge.ts";
import type { GuideState } from "../src/github/guide.ts";
import type { PrDetail } from "../src/github/prs.ts";
import { keyCommand } from "../src/github/keys.ts";
import { buildTree, canReview, hotspotsFor, movedFrom, type PrViewHandlers, prView, rangeEnds, type ReviewAskInfo, unseenNote } from "../src/github/prview.ts";
import type { Entry } from "../src/github/queue.ts";
import type { PrWait } from "../src/github/waiting.ts";
import { createRenderer } from "../src/markdown.ts";
import { fields, installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const HEAD = "e".repeat(40);
const C1 = "1".repeat(40);
const BASE = "0".repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 0));

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { owner: "jmarrero-forge", repo: "widget", number: 7 },
    url: "https://github.com/jmarrero-forge/widget/pull/7",
    title: `widget: ${EVIL}`,
    body: `Why ${EVIL}\n\n<!-- bot-meta -->\n- Upstream: \`up/widget\`, base \`main\`\n- Board item: \`PVTI_x\`\n<!-- /bot-meta -->`,
    author: "jmarrero-bot",
    state: "open",
    draft: true,
    head: HEAD,
    headRef: "bot/fix",
    baseRef: "main",
    additions: 2,
    deletions: 1,
    changedFiles: 2,
    commitCount: 2,
    commits: [
      { sha: C1, parent: BASE, url: "javascript:alert(3)", message: `first ${EVIL}`, author: "jmarrero-bot" },
      { sha: HEAD, parent: C1, url: "javascript:alert(3)", message: `subject ${EVIL}\n\nbody line ${EVIL}`, author: "jmarrero-bot" },
    ],
    files: [
      { filename: `src/${EVIL}.rs`, sha: "f".repeat(40), status: "modified", additions: 2, deletions: 1, patch: `@@ -1,2 +1,3 @@\n ctx\n-${EVIL} old\n+${EVIL} new\n+more` },
      { filename: "big.bin", status: "added", additions: 0, deletions: 0 },
    ],
    checks: [],
    verdict: { state: "none" },
    guide: { state: "none" },
    consistent: true,
    updatedAt: "2026-01-01T00:00:00Z",
    warnings: [],
    ...over,
  };
}

function assertNoActiveContent(root: Element): void {
  assert.equal(root.querySelectorAll("script, img, iframe, svg, style, object, embed").length, 0);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
  }
}

function handlers(over: Partial<PrViewHandlers> = {}): PrViewHandlers {
  return {
    review: async () => "https://github.com/r",
    loadRange: async () => [],
    loadLines: async () => [],
    ...over,
  };
}

const opts = { reviewedHere: false };
const pane = (d: PrDetail, h: PrViewHandlers = handlers()) => {
  const p = prView(d, undefined, render, h, opts);
  win.document.body.replaceChildren(p.el);
  return p;
};
const codeRows = (root: Element) =>
  [...root.querySelectorAll("table.diff tr")].map((tr) => [tr.className, [...tr.querySelectorAll("td.code")].map((td) => td.textContent).join(" | ")]);

describe("prView", () => {
  it("shows untrusted text as text, and drops the bot-meta section", () => {
    const { el } = pane(detail());
    assert.equal(el.querySelector("button.item-chat"), null);
    assertNoActiveContent(el);
    const text = el.textContent ?? "";
    assert.ok(text.includes(`widget: ${EVIL}`));
    assert.ok(text.includes(`body line ${EVIL}`));
    assert.ok(text.includes(`src/${EVIL}.rs`));
    assert.ok(!text.includes("Board item"));
    assert.deepEqual(codeRows(el), [
      ["ctx", " ctx"],
      ["del", `-${EVIL} old`],
      ["add", `+${EVIL} new`],
      ["add", "+more"],
      ["gap", ""],
    ]);
    // Word-level: only the changed word is marked in the paired lines.
    assert.deepEqual([...el.querySelectorAll("tr.del .wd, tr.add .wd")].map((s) => s.textContent), ["old", "new"]);
    assert.match(text, /No diff to show/);
    const links = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    assert.ok(links.includes("https://github.com/up/widget"));
    assert.ok(links.includes("https://github.com/up/widget/compare/main...jmarrero-forge:widget:bot/fix"));
  });

  it("colors code by language", () => {
    const d = detail({ files: [{ filename: "src/lib.rs", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n fn main() {}\n+let x = \"s\";" }] });
    const { el } = pane(d);
    const kinds = [...el.querySelectorAll("td.code span[class*=hljs]")].map((s) => [s.className, s.textContent]);
    assert.ok(kinds.some(([c, t]) => c?.includes("hljs-keyword") && t === "fn"), JSON.stringify(kinds));
    assert.ok(kinds.some(([c, t]) => c?.includes("hljs-string") && t === '"s"'));
  });

  it("lays the same rows out side by side, and remembers nothing it can't store", () => {
    const p = pane(detail());
    assert.equal(p.command("layout"), true);
    assert.deepEqual(codeRows(p.el), [
      ["split", " ctx |  ctx"],
      ["split", `-${EVIL} old | +${EVIL} new`],
      ["split", " | +more"],
      ["gap", ""],
    ]);
    p.command("layout");
    assert.equal(p.el.querySelectorAll("table.diff.unified").length, 1);
  });

  it("expands context from the file at the head", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const asked: [string, string][] = [];
    const d = detail({ files: [{ filename: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -60,3 +60,3 @@\n line 60\n-x\n+line 61\n line 62" }] });
    const { el } = pane(d, handlers({ loadLines: async (path, sha) => (asked.push([path, sha]), lines) }));
    const buttons = () => [...el.querySelectorAll<HTMLButtonElement>("tr.gap button.expand")];
    assert.deepEqual(buttons().map((b) => b.textContent), ["↑ 20", "Show all 59", "↓ Show the rest"]);
    buttons()[0]?.click();
    await tick();
    assert.deepEqual(asked, [["a.txt", HEAD]]);
    const rows = [...el.querySelectorAll("tr.expanded td.code")].map((td) => td.textContent);
    assert.equal(rows.length, 20);
    assert.equal(rows[0], " line 40");
    assert.deepEqual(buttons().map((b) => b.textContent), ["↕ Show 39 lines", "↕ Show 38 lines"]);
  });

  it("collapses generated files and keeps big ones closed until opened", () => {
    const patch = `@@ -1,0 +1,1200 @@\n${Array.from({ length: 1200 }, (_, i) => `+line ${i}`).join("\n")}`;
    const d = detail({
      files: [
        { filename: "Cargo.lock", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "big.rs", status: "added", additions: 1200, deletions: 0, patch },
      ],
    });
    const { el } = pane(d);
    const [lock, big] = [...el.querySelectorAll<HTMLDetailsElement>("details.file")];
    assert.equal(lock?.open, false);
    assert.match(lock?.textContent ?? "", /generated/);
    assert.equal(big?.open, false);
    assert.equal(big?.querySelectorAll("tr").length, 0);
    (big as HTMLDetailsElement).open = true;
    big?.dispatchEvent(new win.Event("toggle"));
    assert.equal(big?.querySelectorAll("tr").length, 1200);
  });

  it("builds a file tree and steps through files and hunks with the keys", () => {
    const d = detail({
      files: [
        { filename: "src/a/x.rs", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b\n@@ -10 +11,2 @@\n c\n+d" },
        { filename: "src/b.rs", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+z" },
      ],
    });
    const p = pane(d);
    assert.deepEqual([...p.el.querySelectorAll("nav.tree .dname, nav.tree .tname")].map((e) => e.textContent), ["src/", "a/", "x.rs", "b.rs"]);
    const focused = () => p.el.querySelector("tr.focus td.code")?.textContent;
    p.command("next-hunk");
    assert.equal(focused(), " a");
    p.command("next-hunk");
    assert.equal(focused(), " c");
    p.command("next-hunk");
    assert.equal(focused(), "+z");
    p.command("prev-hunk");
    assert.equal(focused(), " c");
    p.command("next-file");
    assert.ok(p.el.querySelectorAll("details.file")[1]?.classList.contains("sel"));
  });

  it("n/p navigate files at the boundaries and ignore keys typed into a composer", () => {
    const p = pane(detail());
    const press = (key: string, editing = false) => {
      const cmd = keyCommand({ key, editing, ctrlKey: false, metaKey: false, altKey: false }, "pr");
      if (cmd && cmd !== "blur") assert.equal(p.command(cmd), true);
    };
    const selected = () => p.el.querySelector("details.file.sel")?.getAttribute("data-path");
    try {
      press("p");
      assert.equal(selected(), `src/${EVIL}.rs`);
      press("n");
      assert.equal(selected(), "big.bin");
      press("n");
      assert.equal(selected(), "big.bin");
      press("p");
      assert.equal(selected(), `src/${EVIL}.rs`);
      press("j");
      press("c");
      assert.ok(p.el.querySelector("tr.composer textarea"));
      press("n", true);
      assert.equal(selected(), `src/${EVIL}.rs`);
    } finally {
      p.dispose();
    }
  });

  it("marks files viewed, folding them, and counts them", () => {
    const p = pane(detail());
    const file = p.el.querySelector<HTMLDetailsElement>("details.file");
    assert.equal(file?.open, true);
    p.command("viewed");
    assert.equal(file?.open, false);
    assert.equal(p.el.querySelector<HTMLInputElement>("input.viewed")?.checked, true);
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /1\/2 viewed/);
  });

  it("submits the button's action after confirming, with /draft only for approval", async () => {
    const got: [ReviewAction, string, boolean][] = [];
    const confirms: string[] = [];
    win.confirm = (m?: string) => {
      confirms.push(m ?? "");
      return confirms.length !== 2;
    };
    const { el } = pane(detail(), handlers({
      review: async (action, text, draft) => {
        got.push([action, text, draft]);
        return "https://github.com/r/1";
      },
    }));
    const text = el.querySelector("form.review textarea") as HTMLTextAreaElement;
    const draft = el.querySelector("#review-draft") as HTMLInputElement;
    const click = (action: string) => (el.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement).click();

    text.value = "LGTM";
    draft.checked = true;
    click("approve");
    await tick();
    click("comment"); // refused at the confirm
    await tick();
    text.value = "nit";
    click("request-changes");
    await tick();
    assert.deepEqual(got, [["approve", "LGTM", true], ["request-changes", "nit", false]]);
    assert.match(confirms[0] ?? "", /^Approve \(with \/draft\) jmarrero-forge\/widget#7 at eeeeeeeeee\? Not seen here: 1 without a diff here\.$/);
    assert.match(confirms[2] ?? "", /You already reviewed it from here/);
    assert.match(el.querySelector("form.review .status")?.textContent ?? "", /^Sent: /);
  });

  it("adds line comments to the review and sends them with it", async () => {
    win.confirm = () => true;
    let sentWith: readonly DraftComment[] = [];
    const p = pane(detail(), handlers({
      review: async (_a, _t, _d, comments, sent) => {
        sentWith = comments;
        sent(HEAD);
        return "https://github.com/r/2";
      },
    }));
    // Click the new-side line number of "+more" (line 3).
    const row = [...p.el.querySelectorAll("tr.add")].find((tr) => tr.textContent?.includes("more"));
    row?.querySelectorAll<HTMLElement>("td.ln")[1]?.click();
    const box = p.el.querySelector<HTMLTextAreaElement>("tr.composer textarea");
    assert.ok(box);
    (box as HTMLTextAreaElement).value = `Why ${EVIL}?`;
    p.el.querySelector<HTMLButtonElement>("tr.composer button.primary")?.click();
    assert.match(p.el.querySelector("tr.draft")?.textContent ?? "", /Pending comment on line 3/);
    assert.match(p.el.querySelector("form.review .drafts")?.textContent ?? "", /1 line comment will go out/);
    assertNoActiveContent(p.el);
    (p.el.querySelector('button[data-action="comment"]') as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(sentWith.map((c) => [c.path, c.line, c.side, c.commit, c.body]), [[`src/${EVIL}.rs`, 3, "RIGHT", HEAD, `Why ${EVIL}?`]]);
    assert.equal(p.el.querySelectorAll("tr.draft").length, 0);
  });

  it("keeps drafts from commits no longer in the PR, without sending them", async () => {
    win.confirm = () => true;
    const gone = "9".repeat(40);
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    storage.setItem("review.drafts.jmarrero-forge/widget#7", JSON.stringify([
      { path: "a.rs", line: 1, side: "RIGHT", body: `old thought ${EVIL}`, commit: gone },
      { path: `src/${EVIL}.rs`, line: 3, side: "RIGHT", body: "kept", commit: HEAD },
    ]));
    let sentWith: readonly DraftComment[] = [];
    const p = pane(detail(), handlers({ review: async (_a, _t, _d, comments, sent) => ((sentWith = comments), sent(HEAD), "https://github.com/r/3") }));
    assert.match(p.el.querySelector("details.orphans summary")?.textContent ?? "", /1 line comment written on commits no longer in this PR/);
    assert.ok(p.el.querySelector("details.orphans pre")?.textContent?.includes(`old thought ${EVIL}`));
    assertNoActiveContent(p.el);
    (p.el.querySelector('button[data-action="comment"]') as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(sentWith.map((c) => c.body), ["kept"]);
    p.el.querySelector<HTMLButtonElement>("details.orphans button")?.click();
    assert.equal(p.el.querySelector<HTMLElement>("details.orphans")?.hidden, true);
    assert.deepEqual(JSON.parse(mem.get("review.drafts.jmarrero-forge/widget#7") ?? "null"), null, "all sent or discarded");
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("flags bidirectional control characters in code", () => {
    const d = detail({ files: [{ filename: "a.rs", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+/* \u202e } \u2066 */" }] });
    assert.equal(pane(d).el.querySelectorAll("td.code .bidi").length, 1);
  });

  it("puts c on the focused line", () => {
    const p = pane(detail());
    assert.equal(p.command("comment"), false);
    p.command("next-hunk");
    assert.equal(p.command("comment"), true);
    assert.ok(p.el.querySelector("tr.composer textarea"));
  });

  it("shows one commit at a time, and allows only its added lines a comment", async () => {
    const asked: [string, string][] = [];
    const p = pane(detail(), handlers({
      loadRange: async (base, to) => {
        asked.push([base, to]);
        return [{ filename: "one.rs", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c" }];
      },
    }));
    p.command("next-commit");
    await tick();
    assert.deepEqual(asked, [[BASE, C1]]);
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /commit 1 of 2/);
    assert.equal(p.el.querySelectorAll("td.ln.can-comment").length, 4, "from the base, every hunk line, either side of context");
    p.command("next-commit");
    await tick();
    assert.deepEqual(asked.at(-1), [C1, HEAD]);
    const commentable = [...p.el.querySelectorAll("td.ln.can-comment")].map((td) => td.closest("tr")?.className);
    assert.deepEqual(commentable, ["add"]);
    p.command("next-commit");
    await tick();
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /all commits/);
  });

  it("names unexpanded files and truncation in the approval's confirmation", () => {
    const confirms: string[] = [];
    win.confirm = (m?: string) => (confirms.push(m ?? ""), false);
    const patch = `@@ -1,0 +1,1200 @@\n${Array.from({ length: 1200 }, (_, i) => `+l${i}`).join("\n")}`;
    const d = detail({ changedFiles: 4, files: [{ filename: "big.rs", sha: "9".repeat(40), status: "added", additions: 1200, deletions: 0, patch }, ...detail().files] });
    const { el } = pane(d);
    (el.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    assert.match(confirms[0] ?? "", /Not seen here: 1 file never expanded \(big\.rs\), 1 without a diff here, files or commits beyond what GitHub lists\.$/);
  });

  it("won't approve a diff that may not be the head's", () => {
    const { el } = pane(detail({ consistent: false }));
    assert.equal((el.querySelector('button[data-action="approve"]') as HTMLButtonElement).disabled, true);
    assert.equal((el.querySelector('button[data-action="comment"]') as HTMLButtonElement).disabled, false);
    assert.match(el.querySelector("form.review .status")?.textContent ?? "", /Approve is off until a reload/);
  });

  it("offers a review form only for the bot's PRs in its own space", () => {
    const cases: [Partial<PrDetail>, boolean][] = [
      [{}, true],
      [{ ref: { owner: "jmarrero-bot", repo: "sandbox", number: 1 } }, true],
      [{ ref: { owner: "bootc-dev", repo: "bootc", number: 1 } }, false],
      [{ author: "someone" }, false],
    ];
    for (const [over, want] of cases) {
      const { el } = pane(detail(over));
      assert.equal(el.querySelector("form.review") !== null, want, JSON.stringify(over));
      assert.equal(el.querySelectorAll("td.ln.can-comment").length > 0, want, "line comments only with a form");
      assert.equal(canReview(detail(over)), want);
    }
  });

  describe("a PR the queue lists outside the bot's space", () => {
    const up = (over: Partial<PrDetail> = {}) =>
      detail({ ref: { owner: "bootc-dev", repo: "bootc", number: 2501 }, url: "https://github.com/bootc-dev/bootc/pull/2501", body: "fix", draft: false, ...over });
    const listed = (wait: PrWait): Entry => ({ key: "pr:bootc-dev/bootc#2501", kind: "pr", title: "t", where: "", href: "#", wait });

    it("gets a review form only for what the queue asks of him", () => {
      const cases: [string, PrDetail, PrWait | undefined, boolean][] = [
        ["not listed", up(), undefined, false],
        ["review requested", up(), { reasons: ["review-requested"], onBot: false }, true],
        ["approve to re-sign", up(), { reasons: ["resign"], onBot: false, unsigned: ["abc"] }, true],
        ["the bot responded", up(), { reasons: ["updated"], onBot: false }, true],
        ["a rerun only", up(), { reasons: ["rerun"], onBot: false }, false],
        ["waiting on the bot", up(), { reasons: [], onBot: true }, false],
        ["someone else's PR, requested", up({ author: "someone" }), { reasons: ["review-requested"], onBot: false }, true],
        ["someone else's PR, no request", up({ author: "someone" }), undefined, false],
        ["closed", up({ state: "closed" }), { reasons: ["review-requested"], onBot: false }, false],
      ];
      for (const [name, d, wait, want] of cases) {
        assert.equal(canReview(d, undefined, wait), want, name);
        const p = prView(d, wait ? listed(wait) : undefined, render, handlers(), opts);
        assert.equal(p.el.querySelector("form.review") !== null, want, name);
        p.dispose();
      }
    });

    it("says what it is listed for", () => {
      const p = prView(up(), listed({ reasons: ["review-requested", "resign"], onBot: false, unsigned: ["aaaaaaaaaaaa"] }), render, handlers(), opts);
      const text = p.el.querySelector(".review-ask")?.textContent ?? "";
      assert.match(text, /Your review is requested/);
      assert.match(text, /DCO fails: 1 commit \(aaaaaaaaaaaa\) lacks your Signed-off-by\. Approving head e{10} is your sign-off/);
      p.dispose();
    });

    it("lists the failed required checks' runs, each with a Rerun button that comments nowhere", async () => {
      const RUN = "https://github.com/bootc-dev/bootc/actions/runs/900";
      const run = { url: RUN, owner: "bootc-dev", repo: "bootc", id: "900" };
      const reran: string[] = [];
      const reruns = {
        load: async () => [{ run, name: "CI", status: "completed", conclusion: "failure", headSha: HEAD, failed: [{ name: "required-checks" }] }],
        hooks: { rerun: async (url: string) => (reran.push(url), url) },
      };
      const p = prView(up(), listed({ reasons: ["rerun"], onBot: false, failed: ["required-checks"], runs: [run] }), render, handlers(), { ...opts, reruns });
      win.document.body.replaceChildren(p.el);
      await tick();
      const button = p.el.querySelector<HTMLButtonElement>(".runs li.run button");
      assert.ok(button && !button.disabled);
      let asked = "";
      win.confirm = (m?: string) => ((asked = m ?? ""), true);
      button.click();
      await tick();
      assert.deepEqual(reran, [RUN]);
      assert.doesNotMatch(asked, /comments on the chore/);
      assert.match(p.el.querySelector(".runs .status")?.textContent ?? "", /^Rerun started: /);
      p.dispose();
    });
  });

  describe("a PR a review ask names", () => {
    const UP = { owner: "bootc-dev", repo: "bootc", number: 2500 };
    const ASKED = "a".repeat(40);
    const upstream = (over: Partial<PrDetail> = {}) => detail({ ref: UP, url: "https://github.com/bootc-dev/bootc/pull/2500", author: "jmarrero-bot", body: "fix", draft: false, head: ASKED, ...over });
    const ask: ReviewAskInfo = { pr: UP, issue: { owner: "jmarrero-forge", repo: "tracker", number: 24 }, issueUrl: "https://github.com/jmarrero-forge/tracker/issues/24", head: ASKED, text: "Re-approve" };
    const askPane = (d: PrDetail, a: ReviewAskInfo | undefined, h: PrViewHandlers = handlers()) => {
      const p = prView(d, undefined, render, h, a ? { reviewedHere: false, ask: a } : opts);
      win.document.body.replaceChildren(p.el);
      return p;
    };

    it("gets a review form only with an ask for that very PR", () => {
      const cases: [string, PrDetail, ReviewAskInfo | undefined, boolean][] = [
        ["no ask", upstream(), undefined, false],
        ["the ask", upstream(), ask, true],
        ["someone else's PR, asked", upstream({ author: "someone" }), ask, true],
        ["an ask for another PR", upstream(), { ...ask, pr: { ...UP, number: 2501 } }, false],
        ["an ask for another repository", upstream(), { ...ask, pr: { ...UP, repo: "other" } }, false],
        ["asked, in any case", upstream(), { ...ask, pr: { ...UP, owner: "Bootc-Dev" } }, true],
        ["asked, but merged", upstream({ state: "merged" }), ask, false],
      ];
      for (const [name, d, a, want] of cases) {
        assert.equal(canReview(d, a), want, name);
        assert.equal(askPane(d, a).el.querySelector("form.review") !== null, want, name);
      }
    });

    it("shows the head asked about, and says when it is still the head", () => {
      const { el } = askPane(upstream(), ask);
      const banner = el.querySelector(".review-ask p");
      assert.equal(banner?.className, "note");
      assert.match(banner?.textContent ?? "", /The bot asks you to review this at aaaaaaaaaa \(jmarrero-forge\/tracker#24: Re-approve\)\. That is still its head\./);
      assert.match(el.querySelector("form.review .target")?.textContent ?? "", /also comments on jmarrero-forge\/tracker#24/);
      assert.equal(movedFrom(upstream(), ask), undefined);
    });

    it("warns when the head moved, and asks before reviewing the new one", async () => {
      const moved = upstream({ head: HEAD });
      assert.equal(movedFrom(moved, ask), ASKED);
      const sent: ReviewAction[] = [];
      const confirms: string[] = [];
      let answers: boolean[] = [];
      Object.assign(win, { confirm: (m: string) => (confirms.push(m), answers.shift() ?? false) });
      const { el } = askPane(moved, ask, handlers({ review: async (a) => (sent.push(a), "https://github.com/r") }));
      const banner = el.querySelector(".review-ask p");
      assert.equal(banner?.className, "warn");
      assert.match(banner?.textContent ?? "", /has moved since: its head is now eeeeeeeeee\. What you see and review here is eeeeeeeeee, not what the bot asked about/);
      const approve = el.querySelector('button[data-action="approve"]') as HTMLButtonElement;
      // Declining the moved-head question sends nothing, and asks nothing more.
      answers = [false];
      approve.click();
      await tick();
      assert.deepEqual(sent, []);
      assert.equal(confirms.length, 1);
      assert.match(confirms[0] ?? "", /The bot asked you to review aaaaaaaaaa, but the PR's head is now eeeeeeeeee\. Review eeeeeeeeee instead\?/);
      // Accepting it still leaves the usual confirmation.
      answers = [true, false];
      approve.click();
      await tick();
      assert.deepEqual(sent, []);
      answers = [true, true];
      approve.click();
      await tick();
      assert.deepEqual(sent, ["approve"]);
    });

    it("asks nothing extra when the head is the one asked about", async () => {
      const sent: ReviewAction[] = [];
      const confirms: string[] = [];
      Object.assign(win, { confirm: (m: string) => (confirms.push(m), true) });
      const { el } = askPane(upstream(), ask, handlers({ review: async (a) => (sent.push(a), "https://github.com/r") }));
      (el.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
      await tick();
      assert.deepEqual(sent, ["approve"]);
      assert.equal(confirms.length, 1);
    });
  });

  it("offers no review form on a closed PR", () => {
    const { el } = pane(detail({ state: "merged" }));
    assert.equal(el.querySelector("form.review"), null);
    assert.match(el.textContent ?? "", /This PR is merged/);
  });
});

describe("the review guide", () => {
  const PATH = "src/lib.rs";
  const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`);
  const files = [
    { filename: PATH, sha: "5".repeat(40), status: "modified", additions: 1, deletions: 1, patch: "@@ -10,3 +10,3 @@\n l10\n-old\n+l11\n l12" },
    { filename: "Cargo.lock", sha: "6".repeat(40), status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
  ];
  const guideState = (over: Partial<GuideState> = {}): GuideState =>
    ({
      state: "current",
      url: "https://github.com/jmarrero-forge/widget/pull/7#pullrequestreview-1",
      guide: {
        repo: "jmarrero-forge/widget",
        pr: 7,
        head: HEAD,
        summary: `Summary ${EVIL}`,
        hotspots: [
          { path: PATH, commit: HEAD, start: 11, end: 11, severity: "risky", category: "logic", reason: `Reason ${EVIL}` },
          { path: PATH, commit: C1, start: 40, end: 42, severity: "note", category: "test-gap", reason: "Outside the hunks." },
        ],
        skim: [{ path: "Cargo.lock", reason: "generated" }],
      },
      ...over,
    }) as GuideState;
  const withGuide = (g: GuideState = guideState()) => detail({ files, guide: g });

  it("shows the guide as text, tints the hotspot's lines and puts its reason under them", () => {
    const { el } = pane(withGuide(), handlers({ loadLines: async () => lines }));
    assertNoActiveContent(el);
    const panel = el.querySelector("section.guide");
    assert.ok(panel?.textContent?.includes(`Summary ${EVIL}`));
    assert.match(panel?.textContent ?? "", /0\/2 hotspots seen/);
    assert.equal(panel?.querySelector("details.skim")?.hasAttribute("open"), false);
    const tinted = [...el.querySelectorAll("tr.hs")].map((tr) => [tr.className, tr.querySelector("td.code")?.textContent]);
    assert.deepEqual(tinted, [["del hs sev-risky", "-old"], ["add hs sev-risky", "+l11"]]);
    const callout = el.querySelector('tr.callout[data-hs="0"]');
    assert.equal(callout?.nextElementSibling?.querySelector("td.code")?.textContent, "-old", "the reason comes before the lines");
    assert.ok(callout?.textContent?.includes(`Reason ${EVIL}`));
    assert.match(el.querySelector('details.file[data-path="Cargo.lock"] summary')?.textContent ?? "", /skim/);
  });

  it("walks the hotspots in order, expanding context, and counts what was seen", async () => {
    const confirms: string[] = [];
    win.confirm = (m?: string) => (confirms.push(m ?? ""), false);
    const p = pane(withGuide(), handlers({ loadLines: async () => lines }));
    p.command("guide");
    await tick();
    assert.ok(p.el.querySelector('tr.callout.on[data-hs="0"]'));
    assert.match(p.el.querySelector(".guided-bar")?.textContent ?? "", /hotspot 1 of 2/);
    p.command("next-file"); // n walks hotspots while guided
    await tick();
    await tick();
    assert.ok(p.el.querySelector('tr.callout.on[data-hs="1"]'));
    assert.deepEqual([...p.el.querySelectorAll("tr.hs.sev-note td.code")].map((td) => td.textContent), [" l40", " l41", " l42"]);
    assert.match(p.el.querySelector("section.guide")?.textContent ?? "", /2\/2 hotspots seen/);
    assert.equal(p.command("back"), true, "Esc leaves guided review first");
    assert.equal(p.el.querySelector(".guided-bar")?.hasAttribute("hidden"), true);
    assert.equal(p.command("back"), false);
    (p.el.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    assert.doesNotMatch(confirms[0] ?? "", /hotspots/);
  });

  it("names unseen hotspots when approving", () => {
    const confirms: string[] = [];
    win.confirm = (m?: string) => (confirms.push(m ?? ""), false);
    const { el } = pane(withGuide());
    (el.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    assert.match(confirms[0] ?? "", /2 of 2 review-guide hotspots/);
  });

  it("can be turned off", () => {
    const { el } = pane(withGuide());
    const on = el.querySelector<HTMLInputElement>("#guide-on") as HTMLInputElement;
    on.checked = false;
    on.dispatchEvent(new win.Event("change"));
    assert.equal(el.querySelectorAll("tr.hs, tr.callout").length, 0);
    assert.equal(el.querySelector("ol.hotspots"), null);
    on.checked = true;
    on.dispatchEvent(new win.Event("change"));
    assert.ok(el.querySelectorAll("tr.hs").length > 0);
  });

  it("says stale when the head moved, without tints or a walk", () => {
    const p = pane(withGuide(guideState({ state: "stale" } as Partial<GuideState>)));
    assert.match(p.el.querySelector("section.guide")?.textContent ?? "", /stale.*head moved/s);
    assert.equal(p.el.querySelectorAll("tr.hs, tr.callout").length, 0);
    p.command("guide");
    assert.equal(p.el.querySelector(".guided-bar")?.hasAttribute("hidden"), true);
  });

  it("says why an invalid guide isn't shown", () => {
    const { el } = pane(withGuide({ state: "invalid", error: `bad ${EVIL}` }));
    assert.match(el.querySelector("section.guide")?.textContent ?? "", /couldn't be read: bad </);
    assertNoActiveContent(el);
  });
});

describe("pane helpers", () => {
  it("rangeEnds diffs a range from its first commit's parent", () => {
    const commits = detail().commits;
    assert.deepEqual(rangeEnds(commits, { from: 1, to: 1 }), { base: C1, to: HEAD });
    assert.deepEqual(rangeEnds(commits, { from: 0, to: 1 }), { base: BASE, to: HEAD });
    assert.equal(rangeEnds([{ ...commits[0], parent: undefined } as never], { from: 0, to: 0 }), undefined);
  });

  it("hotspotsFor keeps a range's own hotspots on files at the head's version", () => {
    const g = { repo: "o/r", pr: 1, head: HEAD, summary: "s", skim: [], hotspots: [
      { path: "a", commit: C1, start: 1, end: 1, severity: "note", category: "api", reason: "r" },
      { path: "a", commit: HEAD, start: 2, end: 2, severity: "note", category: "api", reason: "r" },
    ] } as never;
    const file = { filename: "a", sha: "7".repeat(40), status: "modified", additions: 1, deletions: 0 };
    const idx = (v: Parameters<typeof hotspotsFor>[2]) => hotspotsFor(g, file, v).map((p) => p.index);
    assert.deepEqual(idx(undefined), [0, 1]);
    assert.deepEqual(idx({ commits: [C1], headBlob: "7".repeat(40) }), [0]);
    assert.deepEqual(idx({ commits: [C1], headBlob: "8".repeat(40) }), []);
  });

  it("buildTree joins single-child directories", () => {
    const t = buildTree(["a/b/c/x.rs", "a/b/c/y.rs", "a/z.rs", "top.md"]);
    assert.deepEqual([...t.dirs.keys()], ["a"]);
    assert.deepEqual([...(t.dirs.get("a")?.dirs.values() ?? [])].map((d) => d.name), ["b/c"]);
    assert.deepEqual(t.files, [3]);
  });

  it("unseenNote lists a few names", () => {
    const names = Array.from({ length: 8 }, (_, i) => `f${i}`);
    assert.equal(unseenNote({ unopened: names, noDiff: 0, truncated: false }), " Not seen here: 8 files never expanded (f0, f1, f2, f3, f4, f5, +2 more).");
    assert.equal(unseenNote({ unopened: [], noDiff: 0, truncated: false }), "");
  });
});

// Exercise the real entry point with a PR ready before the publication, not just prView.
for (const fails of [false, true]) it(`preserves unsent PR reviews when the publication ${fails ? "fails" : "loads"} late`, async () => {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), {
    url: "https://review.example/#pr/jmarrero-forge/widget/7", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  let releaseQueue = () => {};
  const queueReady = new Promise<void>((resolve) => { releaseQueue = resolve; });
  let queueFinished = false;
  const requests: string[] = [];
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string) => {
      const path = new URL(input).pathname;
      requests.push(path);
      if (path === "/repos/jmarrero-forge/bot-ops/issues/1/comments") {
        await queueReady;
        queueFinished = true;
        if (fails) return Response.json({ message: "Queue unavailable" }, { status: 503 });
      }
      let body: unknown = [];
      if (path === "/user") body = { login: "jmarrero" };
      else if (path.endsWith("/fields")) body = fields();
      else if (path === "/search/issues") body = { items: [], total_count: 0 };
      else if (path === "/graphql") body = { data: {} };
      else if (path === "/repos/jmarrero-forge/widget/pulls/7") body = {
        number: 7, html_url: "https://github.com/jmarrero-forge/widget/pull/7", title: "widget: Fix it", body: "Body", draft: true, state: "open",
        user: { login: "jmarrero-bot" }, head: { sha: HEAD, ref: "bot/fix" }, base: { ref: "main" }, additions: 1, deletions: 1, changed_files: 1, commits: 1,
      };
      else if (path.endsWith("/pulls/7/commits")) body = [{ sha: HEAD, commit: { message: "Fix it" }, parents: [{ sha: BASE }], author: { login: "jmarrero-bot" } }];
      else if (path.endsWith("/pulls/7/files")) body = [{ filename: "a.rs", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }];
      else if (path.endsWith("/check-runs")) body = { check_runs: [] };
      else if (path.endsWith("/status")) body = { statuses: [] };
      else if (path === "/repos/jmarrero-forge/widget") body = {};
      return Response.json(body);
    },
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${window.document.querySelector("#view")?.textContent}`);
  };
  try {
    await import(`../src/github/main.ts?early-pr=${fails}`);
    await until(() => !!window.document.querySelector(".signin"));
    window.document.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
    window.document.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => !!window.document.querySelector("form.review textarea"));
    assert.equal(queueFinished, false);
    const review = window.document.querySelector<HTMLTextAreaElement>("form.review textarea")!;
    review.value = "Keep this unsent review";
    window.document.querySelectorAll<HTMLElement>("tr.add td.ln")[1]!.click();
    const inline = window.document.querySelector<HTMLTextAreaElement>("tr.composer textarea")!;
    assert.ok(inline);
    inline.value = "Keep this unsent inline comment";
    releaseQueue();
    await until(() => queueFinished);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(window.document.querySelector("form.review textarea"), review);
    assert.equal(review.value, "Keep this unsent review");
    assert.equal(window.document.querySelector("tr.composer textarea"), inline);
    assert.equal(inline.value, "Keep this unsent inline comment");
    assert.ok(!requests.some((path) => path.includes("/actions/") || path.endsWith("/events")), "no removed workflow or activity polling");
    assert.ok(!requests.some((path) => path.endsWith("/items") || path === "/search/issues"), "no background board or search discovery");
  } finally {
    releaseQueue();
    window.document.querySelector<HTMLButtonElement>("#signout")?.click();
    await tick();
    dom.window.close();
  }
});
