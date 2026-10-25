// The review pane for one PR (a forge PR, or another the queue lists): description, commits with their full
// messages, CI, the diff, the bot's review guide, and the review form.
// Commit messages, diffs and the guide are untrusted too, and go in as
// text nodes only.

import { h, kids, link, scrollTo } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { IssueRef } from "./board.ts";
import { BOARD_URL, BOT_LOGIN, FORGE_ORG } from "./config.ts";
import type { Row } from "./diff.ts";
import { FILE_CLASS, type FileHooks, FileView, type PlacedHotspot, type Side } from "./diffview.ts";
import {
  type CiState,
  ciSummary,
  DRAFT_LINE,
  type DraftComment,
  parseBotMeta,
  PR_BASE,
  type ReviewAction,
  VERDICT_LABEL,
  withoutBotMeta,
} from "./forge.ts";
import { type Guide, type GuideState, SEVERITY_LABEL, worst } from "./guide.ts";
import type { Command } from "./keys.ts";
import { type MineHooks, mineSection } from "./mineview.ts";
import { type Commit, type FileDiff, MAX_COMPARE_FILES, type PrDetail } from "./prs.ts";
import type { Entry } from "./queue.ts";
import {
  type DiffLayout,
  load,
  loadGuideOn,
  loadLayout,
  loadSeen,
  save,
  saveGuideOn,
  saveLayout,
  saveSeen,
  ViewedMarks,
  viewedKey,
} from "./store.ts";
import type { RunStatus } from "./backend.ts";
import { type ContextHooks, pill, runView, time } from "./view.ts";
import type { PrReason, PrWait } from "./waiting.ts";

export { FILE_CLASS };
/** Classes the keyboard handler looks for. */
export const REVIEW_FORM_CLASS = "review";
export const APPROVE_ACTION = "approve";
/** Files named in the approval's confirmation at most. */
const UNSEEN_NAMES = 6;
/** Hotspot callouts count as seen when this much of them is on screen. */
const SEEN_THRESHOLD = 0.6;

export interface PrViewHandlers {
  /**
   * Submit a review with his line comments; resolves to its URL.
   * `sent` is called with each commit whose comments went out, as they do.
   */
  review(action: ReviewAction, text: string, draft: boolean, comments: readonly DraftComment[], sent: (commit: string) => void): Promise<string>;
  /** The files changed from `base` to `to` (commits of the PR). */
  loadRange(base: string, to: string): Promise<FileDiff[]>;
  /** A file's lines at a commit. */
  loadLines(path: string, sha: string): Promise<string[]>;
  /** Taking over the PR's text as his (see mine.ts); without it, the pane doesn't offer that. The pane supplies `unseen`. */
  mine?: Omit<MineHooks, "unseen">;
}

/** An open review ask naming this PR: the tracker issue, and the head the bot asked about. */
export interface ReviewAskInfo {
  /** The PR it names; the pane checks it is this one. */
  pr: IssueRef;
  /** The ask's issue in the tracker. */
  issue: IssueRef;
  issueUrl?: string;
  /** The 40-hex head the bot asked him to review. */
  head: string;
  /** Its `Ask:` line. */
  text?: string;
}

export interface PrViewOptions {
  /** A review was already sent from this tab. */
  reviewedHere: boolean;
  /** The review ask for this PR, if there is one. */
  ask?: ReviewAskInfo;
  /**
   * For a PR listed for a rerun: its runs' state, and how to rerun them.
   * The section fills in when `load` answers.
   */
  reruns?: { load(): Promise<RunStatus[]>; hooks: ContextHooks };
}

/** The pane, and the keyboard commands it carries out itself. */
export interface PrPane {
  el: HTMLElement;
  /** Carry out a command; false if it isn't the pane's (or does nothing here). */
  command(cmd: Command): boolean;
  /** Stop observing; call before throwing the pane away. */
  dispose(): void;
}

/** Owners whose bot-authored PRs can be reviewed from here. */
const REVIEWABLE_OWNERS: readonly string[] = [FORGE_ORG, BOT_LOGIN];

function samePr(a: IssueRef, b: IssueRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/** The reasons a listed PR asks for his review (a rerun alone doesn't). */
const REVIEW_REASONS: readonly PrReason[] = ["review-requested", "resign", "updated"];

/**
 * Whether the pane offers a review form: for the bot's own PRs in its own
 * space, for any PR an open review ask from the bot names (say, an
 * upstream PR he approves), and for the bot's PRs the queue lists for
 * his review (`wait`, read from GitHub: his review requested, a re-sign,
 * or the bot's response to his change request). Nothing else, so a
 * crafted link can't turn this page into a one-click approval of
 * someone else's PR. A direct operator request also admits a non-bot PR.
 */
export function canReview(d: PrDetail, ask?: ReviewAskInfo, wait?: PrWait): boolean {
  if (d.state !== "open") return false;
  if (ask && samePr(ask.pr, d.ref)) return true;
  if (!d.draft && wait?.reasons.includes("review-requested")) return true;
  // PR authorship stays the user account's, as in promote, takeover and
  // rerun: a role app's PR isn't the bot's here (pushes stay on the user).
  if (d.author !== BOT_LOGIN) return false;
  return REVIEWABLE_OWNERS.includes(d.ref.owner) || (wait?.reasons.some((r) => REVIEW_REASONS.includes(r)) ?? false);
}

/** What the queue lists a PR for, above its review form. */
function waitBanner(d: PrDetail, wait: PrWait): HTMLElement | null {
  const lines: string[] = [];
  if (wait.onBot) lines.push("You requested changes, and the bot hasn't pushed or replied since: this one is the bot's turn.");
  for (const r of wait.reasons) {
    if (r === "review-requested") lines.push("Your review is requested.");
    if (r === "resign") {
      const n = wait.unsigned?.length ?? 0;
      lines.push(
        `DCO fails: ${n} commit${n === 1 ? "" : "s"} (${(wait.unsigned ?? []).join(", ")}) lack${n === 1 ? "s" : ""} your Signed-off-by. Approving head ${short(d.head)} is your sign-off: the bot then adds it with bot-pr signoff.`,
      );
    }
    if (r === "rerun") lines.push(`Required checks failed (${(wait.failed ?? []).join(", ")}); their runs are below, to rerun if it looks like a flake.`);
    if (r === "updated") lines.push("You requested changes, and the bot pushed or replied since.");
  }
  return lines.length ? h("div", { class: "review-ask" }, ...lines.map((l) => h("p", { class: "note" }, l))) : null;
}

/** The runs behind a PR's failed required checks, filled in once read. */
function rerunSection(reruns: NonNullable<PrViewOptions["reruns"]>): HTMLElement {
  const section = h("section", { class: "runs" }, h("h3", {}, "Failed required checks"), h("p", { class: "note" }, "Loading their runs…"));
  reruns
    .load()
    .then((runs) => {
      section.replaceChildren(h("h3", {}, "Failed required checks"), h("ul", {}, ...runs.map((r) => runView(r, { ...reruns.hooks, rerunOnPr: true }))));
    })
    .catch((e: unknown) => {
      section.append(h("p", { class: "warn" }, `Couldn't read the runs: ${e instanceof Error ? e.message : String(e)}`));
    });
  return section;
}

/** The ask's expected head, when the PR's head is no longer it. */
export function movedFrom(d: PrDetail, ask: ReviewAskInfo | undefined): string | undefined {
  return ask && ask.head !== d.head ? ask.head : undefined;
}

function askBanner(d: PrDetail, ask: ReviewAskInfo): HTMLElement {
  const issue = `${ask.issue.owner}/${ask.issue.repo}#${ask.issue.number}`;
  const moved = movedFrom(d, ask);
  return h(
    "div",
    { class: "review-ask" },
    h(
      "p",
      { class: moved ? "warn" : "note" },
      "The bot asks you to review this at ",
      h("code", {}, short(ask.head)),
      " (",
      ask.issueUrl ? link(ask.issueUrl, issue) : issue,
      ask.text ? `: ${ask.text}` : "",
      ").",
      moved
        ? ` The PR has moved since: its head is now ${short(d.head)}. What you see and review here is ${short(d.head)}, not what the bot asked about; you'll be asked to confirm that before anything is sent.`
        : " That is still its head.",
    ),
  );
}

/** What he hasn't seen of a PR, for the approval's confirmation. */
export interface Unseen {
  /** Files whose diff was never shown, nor marked viewed. */
  unopened: string[];
  /** Files GitHub gives no diff for. */
  noDiff: number;
  /** Files or commits beyond what the API lists. */
  truncated: boolean;
  /** Hotspots of a current review guide never on screen, of how many. */
  hotspots?: { unseen: number; total: number };
}

export function unseenNote(u: Unseen): string {
  const names = u.unopened.slice(0, UNSEEN_NAMES).join(", ") + (u.unopened.length > UNSEEN_NAMES ? `, +${u.unopened.length - UNSEEN_NAMES} more` : "");
  const parts = [
    u.unopened.length ? `${u.unopened.length} file${u.unopened.length > 1 ? "s" : ""} never expanded (${names})` : "",
    u.noDiff ? `${u.noDiff} without a diff here` : "",
    u.truncated ? "files or commits beyond what GitHub lists" : "",
    u.hotspots?.unseen ? `${u.hotspots.unseen} of ${u.hotspots.total} review-guide hotspots` : "",
  ].filter(Boolean);
  return parts.length ? ` Not seen here: ${parts.join(", ")}.` : "";
}

const CI_LABEL: Record<CiState, string> = {
  success: "CI passed",
  failure: "CI failed",
  pending: "CI running",
  none: "no CI",
};

const short = (sha: string) => sha.slice(0, 10);

function ciBadge(state: CiState): HTMLElement {
  return h("span", { class: `ci ci-${state}` }, CI_LABEL[state]);
}

function linkRow(d: PrDetail, entry: Entry | undefined): HTMLElement {
  const meta = parseBotMeta(d.body);
  const upstream = meta.upstream ?? d.parent;
  const links = h("div", { class: "links" });
  links.append(link(d.url, `${d.ref.owner}/${d.ref.repo}#${d.ref.number}`));
  links.append(link(`${d.url}/files`, "files on GitHub"));
  if (upstream) {
    const base = meta.base ?? d.baseRef;
    links.append(link(`https://github.com/${upstream}`, `upstream ${upstream}${base ? ` (${base})` : ""}`));
    if (base && d.headRef) {
      links.append(link(`https://github.com/${upstream}/compare/${base}...${d.ref.owner}:${d.ref.repo}:${d.headRef}`, "compare with upstream"));
    }
  }
  if (entry?.item?.url) links.append(link(entry.item.url, "tracking issue"));
  links.append(link(BOARD_URL, "board"));
  return links;
}

interface FormHooks {
  unseen(): Unseen;
  /** Drafts on commits of the PR: what goes out with the review. */
  drafts(): readonly DraftComment[];
  /** Drafts on commits no longer in the PR (after a force push): kept to copy from, never sent. */
  orphans(): readonly DraftComment[];
  drop(c: DraftComment): void;
  sent(commit: string): void;
  /** Show a draft's line. */
  jump(c: DraftComment): void;
}

function reviewForm(d: PrDetail, opts: PrViewOptions, handlers: PrViewHandlers, hooks: FormHooks): { form: HTMLElement; refresh(): void } {
  const text = h("textarea", {
    name: "text",
    rows: "3",
    placeholder: "Optional for an approval, or with line comments; otherwise required",
    "aria-label": "Review text",
  });
  const draft = h("input", { type: "checkbox", id: "review-draft" });
  const status = h("p", { class: "status", role: "status" });
  const drafts = h("div", { class: "drafts" });
  const approve = h("button", { type: "button", class: "primary", "data-action": APPROVE_ACTION }, "Approve (a)");
  const changes = h("button", { type: "button", "data-action": "request-changes" }, "Request changes");
  const comment = h("button", { type: "button", "data-action": "comment" }, "Comment");
  const buttons = [approve, changes, comment];
  const forge = d.ref.owner === FORGE_ORG;
  const ask = opts.ask && samePr(opts.ask.pr, d.ref) ? opts.ask : undefined;
  const moved = movedFrom(d, ask);
  let sent = opts.reviewedHere;
  const enable = () => {
    for (const b of buttons) b.disabled = false;
    // Approving needs the diff shown to be the head's.
    approve.disabled = !d.consistent;
  };
  enable();
  if (!d.consistent) status.textContent = "Approve is off until a reload (r) shows the head's commits.";
  const refresh = () => {
    const list = hooks.drafts();
    drafts.replaceChildren();
    if (list.length === 0) return;
    const ul = h("ul", { class: "draft-list" });
    for (const c of list) {
      const go = h("button", { type: "button", class: "linkish" }, `${c.path}:${c.start_line !== undefined ? `${c.start_line}–` : ""}${c.line}${c.side === "LEFT" ? " (old)" : ""}${c.commit !== d.head ? ` @${c.commit.slice(0, 7)}` : ""}`);
      go.addEventListener("click", () => hooks.jump(c));
      ul.append(h("li", {}, go, h("span", { class: "tag" }, ` ${c.body.replace(/\s+/g, " ").slice(0, 80)}`)));
    }
    drafts.append(h("p", { class: "tag" }, `${list.length} line comment${list.length > 1 ? "s" : ""} will go out with your review:`), ul);
  };
  const orphans = h("details", { class: "orphans" });
  const refreshOrphans = () => {
    const list = hooks.orphans();
    orphans.hidden = list.length === 0;
    const ul = h("ul", { class: "draft-list" });
    for (const c of list) {
      const drop = h("button", { type: "button", class: "small" }, "Discard");
      drop.addEventListener("click", () => hooks.drop(c));
      ul.append(h("li", {}, h("code", {}, `${c.path}:${c.line} @${c.commit.slice(0, 7)}`), " ", drop, h("pre", { class: "msg" }, c.body)));
    }
    orphans.replaceChildren(h("summary", {}, `${list.length} line comment${list.length > 1 ? "s" : ""} written on commits no longer in this PR (not sent; copy what you still need)`), ul);
  };
  const refreshAll = () => {
    refresh();
    refreshOrphans();
  };
  refreshAll();
  const form = h(
    "form",
    { class: REVIEW_FORM_CLASS },
    ask ? askBanner(d, ask) : null,
    orphans,
    drafts,
    text,
    forge
      ? h("label", { class: "check", for: "review-draft" }, draft, ` Ask for a draft upstream PR (adds ${DRAFT_LINE}; unchecked doesn't undo an earlier ${DRAFT_LINE})`)
      : null,
    h("div", { class: "actions" }, ...buttons),
    h(
      "p",
      { class: "target" },
      `Reviews head ${short(d.head)} as you.`,
      forge ? " An approval is what bot-pr promote acts on: it opens the upstream PR from exactly this head, signing off where the project wants DCO." : "",
      " If the head moves before you send, nothing is sent.",
      ask ? ` Approving or requesting changes also comments on ${ask.issue.owner}/${ask.issue.repo}#${ask.issue.number}, so the bot sees it.` : "",
    ),
    status,
  );
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const send = (action: ReviewAction) => {
    const wantDraft = action === "approve" && draft.checked;
    const comments = hooks.drafts();
    const what = action === "approve" ? `Approve${wantDraft ? ` (with ${DRAFT_LINE})` : ""}` : action === "comment" ? "Comment on" : "Request changes on";
    const withComments = comments.length ? ` with ${comments.length} line comment${comments.length > 1 ? "s" : ""}` : "";
    const again = sent ? " You already reviewed it from here." : "";
    const note = action === "approve" ? unseenNote(hooks.unseen()) : "";
    // Never silently review a head other than the one the bot asked about.
    if (moved && !window.confirm(`The bot asked you to review ${short(moved)}, but the PR's head is now ${short(d.head)}. Review ${short(d.head)} instead?`)) return;
    if (!window.confirm(`${what} ${d.ref.owner}/${d.ref.repo}#${d.ref.number} at ${short(d.head)}${withComments}?${note}${again}`)) return;
    for (const b of buttons) b.disabled = true;
    status.textContent = "Sending…";
    handlers
      .review(action, text.value, wantDraft, comments, hooks.sent)
      .then((url) => {
        sent = true;
        text.value = "";
        status.textContent = "Sent: ";
        status.append(link(url, url));
        enable();
        refresh();
      })
      .catch((e: unknown) => {
        status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
        enable();
        refresh();
      });
  };
  for (const b of buttons) b.addEventListener("click", () => send(b.dataset.action as ReviewAction));
  return { form, refresh: refreshAll };
}

function commitsSection(d: PrDetail): HTMLElement {
  const s = h("section", { class: "commits" }, h("h3", {}, `Commits · ${d.commitCount}`));
  const open = d.commits.length <= 5;
  for (const c of d.commits) {
    const [subject = "", ...rest] = c.message.replace(/\r\n?/g, "\n").split("\n");
    const body = rest.join("\n").replace(/^\n+/, "").trimEnd();
    const det = h(
      "details",
      { class: "commit" },
      h("summary", {}, h("code", {}, short(c.sha)), " ", h("span", { class: "subject" }, subject), h("span", { class: "tag" }, ` ${c.author}${c.date ? ` · ${time(c.date)}` : ""}`)),
      body ? h("pre", { class: "msg" }, body) : h("p", { class: "note" }, "(no body)"),
      h("p", { class: "note" }, link(c.url, "commit on GitHub")),
    );
    det.open = open;
    s.append(det);
  }
  if (d.commits.length < d.commitCount) s.append(h("p", { class: "note" }, `Showing the first ${d.commits.length}; see the rest on GitHub.`));
  return s;
}

function checksSection(d: PrDetail): HTMLElement {
  const s = h("section", { class: "checks" }, h("h3", {}, "CI ", ciBadge(ciSummary(d.checks))));
  if (d.checks.length === 0) {
    s.append(h("p", { class: "note" }, "No checks on this head. Forge forks run no CI: the description says how it was tested, and upstream CI runs once promoted."));
    return s;
  }
  const list = h("ul", { class: "checklist" });
  for (const c of d.checks) list.append(h("li", { class: `ci-${c.state}` }, h("span", { class: "dot" }), link(c.url, c.name), h("span", { class: "tag" }, ` ${c.detail}`)));
  s.append(list);
  return s;
}

const subject = (c: Commit) => c.message.split("\n", 1)[0] ?? "";

/** A range of the PR's commits by index, inclusive; undefined is the whole PR. */
export interface CommitRange {
  from: number;
  to: number;
}

/**
 * The diff base and end of a range: the first commit's parent, and the
 * last commit. Undefined when the parent isn't known.
 */
export function rangeEnds(commits: readonly Commit[], r: CommitRange): { base: string; to: string } | undefined {
  const first = commits[r.from];
  const last = commits[r.to];
  if (!first?.parent || !last || r.from > r.to) return undefined;
  return { base: first.parent, to: last.sha };
}

/**
 * The hotspots to show on a file in a view. In the whole PR's diff, all
 * of its. In a range of commits, those a commit in the range introduced,
 * and only when the file there is the head's (same blob), since the
 * guide's lines are the head's.
 */
export function hotspotsFor(guide: Guide, file: FileDiff, view: { commits: readonly string[]; headBlob: string | undefined } | undefined): PlacedHotspot[] {
  const total = guide.hotspots.length;
  return guide.hotspots
    .map((hotspot, index) => ({ index, total, hotspot }))
    .filter(({ hotspot }) => {
      if (hotspot.path !== file.filename) return false;
      if (!view) return true;
      return view.commits.includes(hotspot.commit) && file.sha !== undefined && file.sha === view.headBlob;
    });
}

/** A tree of paths, directories first, with single-child directories joined. */
interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: number[];
}

export function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", dirs: new Map(), files: [] };
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { name: dir, dirs: new Map(), files: [] };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push(i);
  });
  const squash = (n: TreeNode): TreeNode => {
    for (const [k, child] of n.dirs) n.dirs.set(k, squash(child));
    if (n.name && n.files.length === 0 && n.dirs.size === 1) {
      const only = [...n.dirs.values()][0] as TreeNode;
      return { name: `${n.name}/${only.name}`, dirs: only.dirs, files: only.files };
    }
    return n;
  };
  return squash(root);
}

class Pane implements PrPane {
  readonly el: HTMLElement;
  #d: PrDetail;
  #handlers: PrViewHandlers;
  #canReview: boolean;
  #layout: DiffLayout = loadLayout();
  #range: CommitRange | undefined;
  #files: FileView[] = [];
  #current = -1;
  #focusFile: FileView | undefined;
  #viewed = new ViewedMarks();
  /** `path:blob` of every file version whose diff was shown in any view. */
  #seenBlobs = new Set<string>();
  #lines = new Map<string, Promise<string[]>>();
  #drafts: DraftComment[];
  #guide: GuideState;
  #guideOn = loadGuideOn();
  #seen: Set<number>;
  #guided: number | undefined;
  #lazy: IntersectionObserver | undefined;
  #seenObs: IntersectionObserver | undefined;
  #scrollObs: IntersectionObserver | undefined;
  #byEl = new Map<Element, FileView>();
  #loading = 0;
  // Parts redrawn as things change.
  #list = h("div", { class: "file-list" });
  #tree = h("nav", { class: "tree", "aria-label": "Files" });
  #toolbar = h("div", { class: "toolbar" });
  #bar = h("div", { class: "guided-bar", role: "status" });
  #guidePanel = h("section", { class: "guide" });
  #filesTitle = h("h3", {});
  #form: { form: HTMLElement; refresh(): void } | undefined;

  constructor(d: PrDetail, entry: Entry | undefined, render: Renderer, handlers: PrViewHandlers, opts: PrViewOptions) {
    this.#d = d;
    this.#handlers = handlers;
    this.#canReview = canReview(d, opts.ask, entry?.wait);
    this.#guide = d.guide;
    this.#seen = loadSeen(this.#guideKey());
    this.#drafts = load(this.#draftsKey(), [], (v): v is DraftComment[] => Array.isArray(v) && v.every(isDraft));
    if (typeof IntersectionObserver !== "undefined") {
      this.#lazy = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && this.#byEl.get(e.target)?.near()), { rootMargin: "1500px 0px" });
      this.#seenObs = new IntersectionObserver(
        (es) => es.forEach((e) => e.isIntersecting && this.#sawHotspot(Number((e.target as HTMLElement).dataset.hs))),
        { threshold: SEEN_THRESHOLD },
      );
      // The file whose header is near the top is the current one, for n/p and v.
      this.#scrollObs = new IntersectionObserver(
        (es) => {
          for (const e of es) {
            if (!e.isIntersecting) continue;
            const i = this.#files.findIndex((f) => f.el === e.target);
            if (i >= 0) this.#select(i, false);
          }
        },
        { rootMargin: "-80px 0px -75% 0px" },
      );
    }
    const verdict = d.verdict.state === "none" ? undefined : VERDICT_LABEL[d.verdict.state];
    let form: HTMLElement;
    if (this.#canReview) {
      this.#form = reviewForm(d, opts, handlers, {
        unseen: () => this.unseen(),
        drafts: () => this.#drafts.filter((c) => this.#inPr(c)),
        orphans: () => this.#drafts.filter((c) => !this.#inPr(c)),
        drop: (c) => this.#setDrafts(this.#drafts.filter((x) => x !== c), c.path),
        sent: (commit) => this.#setDrafts(this.#drafts.filter((c) => c.commit !== commit)),
        jump: (c) => void this.#jumpToDraft(c),
      });
      form = this.#form.form;
    } else if (d.state !== "open") form = h("p", { class: "warn" }, `This PR is ${d.state}; there is nothing to review.`);
    else form = h("p", { class: "note" }, `Reviews from here are only for ${BOT_LOGIN}'s PRs in ${REVIEWABLE_OWNERS.join(" and ")}, and its PRs the queue lists for your review; use GitHub for this one.`);
    const files = h(
      "section",
      { class: "files" },
      h("div", { class: "files-h" }, this.#filesTitle),
      this.#toolbar,
      this.#bar,
      h("div", { class: "files-layout" }, this.#tree, this.#list),
    );
    this.el = h(
      "main",
      { class: "item pr" },
      h("a", { href: "#", class: "back" }, "← Back (u)"),
      h(
        "div",
        { class: "hdr" },
        pill(entry?.priority),
        h("span", { class: "tag" }, [entry?.item?.org, d.draft ? "draft PR" : "PR", d.state === "open" ? "" : d.state, d.isPrivate ? "private" : ""].filter(Boolean).join(" · ")),
        ciBadge(ciSummary(d.checks)),
        verdict ? h("span", { class: `state v-${d.verdict.state}` }, d.verdict.url ? link(d.verdict.url, verdict) : verdict) : null,
      ),
      h("h2", {}, d.title),
      linkRow(d, entry),
      ...d.warnings.map((w) => h("p", { class: "warn" }, w)),
      entry?.item?.why ? h("section", {}, h("h3", {}, "Why (board)"), h("div", { class: "md" }, render(entry.item.why))) : null,
      entry?.wait ? waitBanner(d, entry.wait) : null,
      opts.reruns ? rerunSection(opts.reruns) : null,
      form,
      handlers.mine && d.state === "open" && d.author === BOT_LOGIN && d.ref.owner === FORGE_ORG
        ? mineSection(d, { ...handlers.mine, unseen: () => unseenNote(this.unseen()) })
        : null,
      h("section", {}, h("h3", {}, "Description"), h("div", { class: "md" }, render(withoutBotMeta(d.body) || "(empty)"))),
      checksSection(d),
      commitsSection(d),
      this.#guide.state === "none" ? null : this.#guidePanel,
      files,
    );
    this.#showFiles(d.files);
    this.#drawGuide();
  }

  #guideKey(): string {
    const g = this.#guide;
    return `${this.#d.ref.owner}/${this.#d.ref.repo}#${this.#d.ref.number}@${g.state === "current" || g.state === "stale" ? g.guide.head : "none"}`;
  }

  #inPr(c: DraftComment): boolean {
    return this.#d.commits.some((k) => k.sha === c.commit);
  }

  /** The current view's base, as drafts record it. */
  #viewBase(): string {
    const r = this.#range;
    return r ? (rangeEnds(this.#d.commits, r)?.base ?? PR_BASE) : PR_BASE;
  }

  #draftsKey(): string {
    return `drafts.${this.#d.ref.owner}/${this.#d.ref.repo}#${this.#d.ref.number}`;
  }

  /** Replace his drafts; only the files whose drafts changed are redrawn (all, without a path). */
  #setDrafts(list: DraftComment[], path?: string): void {
    this.#drafts = list;
    save(this.#draftsKey(), list.length ? list : undefined);
    this.#form?.refresh();
    for (const f of this.#files) if (path === undefined || f.file.filename === path) f.render();
  }

  /** The current guide, if it is shown: current, and not turned off. */
  #activeGuide(): Guide | undefined {
    return this.#guideOn && this.#guide.state === "current" ? this.#guide.guide : undefined;
  }

  /** The view's end commit: the head, or the last commit of the range. */
  #viewEnd(): string {
    const r = this.#range;
    return r ? (this.#d.commits[r.to]?.sha ?? this.#d.head) : this.#d.head;
  }

  #headBlob(path: string): string | undefined {
    return this.#d.files.find((f) => f.filename === path)?.sha;
  }

  /** Hooks shared by the files of the current view; loadLines and drafts are per file. */
  #hooks(): Omit<FileHooks, "loadLines" | "drafts"> {
    const fromBase = !this.#range || this.#range.from === 0;
    const end = this.#viewEnd();
    return {
      layout: () => this.#layout,
      commit: end,
      base: this.#viewBase(),
      commentable: (row: Row, side: Side) => this.#canReview && !row.expanded && (fromBase || (row.kind === "add" && side === "RIGHT")),
      saveDraft: (c, old) => this.#setDrafts([...this.#drafts.filter((x) => x !== old), c], c.path),
      deleteDraft: (c) => this.#setDrafts(this.#drafts.filter((x) => x !== c), c.path),
      sawHotspot: (i) => this.#sawHotspot(i),
      focused: (file, item, side) => {
        if (this.#focusFile && this.#focusFile !== file) this.#focusFile.setFocus(undefined);
        this.#focusFile = file;
        file.setFocus(item, side);
        const i = this.#files.indexOf(file);
        if (i >= 0) this.#select(i, false);
      },
      setViewed: (file, on) => this.#setViewed(file, on),
    };
  }

  #loadLines(path: string, sha: string): Promise<string[]> {
    const key = `${sha}:${path}`;
    let p = this.#lines.get(key);
    if (!p) {
      p = this.#handlers.loadLines(path, sha);
      p.catch(() => this.#lines.delete(key));
      this.#lines.set(key, p);
    }
    return p;
  }

  #showFiles(files: readonly FileDiff[]): void {
    for (const f of this.#files) this.#lazy?.unobserve(f.el);
    this.#scrollObs?.disconnect();
    this.#seenObs?.disconnect();
    this.#byEl.clear();
    this.#focusFile = undefined;
    const r = this.#range;
    const guide = this.#activeGuide();
    const end = this.#viewEnd();
    const inRange = r ? this.#d.commits.slice(r.from, r.to + 1).map((c) => c.sha) : undefined;
    const viewBase = this.#viewBase();
    const base = this.#hooks();
    const repo = `${this.#d.ref.owner}/${this.#d.ref.repo}`;
    this.#files = files.map((file) => {
      const hooks: FileHooks = {
        ...base,
        loadLines: () => this.#loadLines(file.filename, end),
        drafts: () => this.#drafts.filter((c) => c.path === file.filename && c.commit === end && (c.base ?? PR_BASE) === viewBase),
      };
      const fv = new FileView({
        file,
        hotspots: guide ? hotspotsFor(guide, file, inRange ? { commits: inRange, headBlob: this.#headBlob(file.filename) } : undefined) : [],
        skim: guide?.skim.filter((s) => s.path === file.filename) ?? [],
        viewed: file.sha !== undefined && this.#viewed.has(viewedKey(repo, file.filename, file.sha)),
        hooks,
        ...(this.#lazy ? { lazy: this.#lazy } : {}),
        ...(this.#seenObs ? { seen: this.#seenObs } : {}),
      });
      this.#byEl.set(fv.el, fv);
      this.#scrollObs?.observe(fv.el);
      fv.el.addEventListener("toggle", () => this.#noteSeen());
      return fv;
    });
    this.#list.replaceChildren(...this.#files.map((f) => f.el));
    const d = this.#d;
    if (!r && d.files.length < d.changedFiles) this.#list.append(h("p", { class: "note" }, `Showing ${d.files.length} of ${d.changedFiles} files; see the rest on GitHub.`));
    if (r && files.length >= MAX_COMPARE_FILES) this.#list.append(h("p", { class: "note" }, `GitHub lists at most ${MAX_COMPARE_FILES} files for a range of commits; there may be more.`));
    this.#current = -1;
    this.#noteSeen();
    this.#drawTitle();
    this.#drawTree();
    this.#drawToolbar();
    this.#drawBar();
  }

  /** Remember which file versions were shown, for the approval's note. */
  #noteSeen(): void {
    for (const f of this.#files) if (f.seen() && f.file.sha) this.#seenBlobs.add(`${f.file.filename}:${f.file.sha}`);
  }

  #drawTitle(): void {
    const files = this.#files;
    const add = files.reduce((n, f) => n + f.file.additions, 0);
    const del = files.reduce((n, f) => n + f.file.deletions, 0);
    const viewed = files.filter((f) => f.viewed).length;
    const r = this.#range;
    const what = r ? (r.from === r.to ? `commit ${r.from + 1} of ${this.#d.commits.length}` : `commits ${r.from + 1}–${r.to + 1} of ${this.#d.commits.length}`) : "all commits";
    this.#filesTitle.replaceChildren(
      `Files · ${files.length} · `,
      h("span", { class: "plus" }, `+${add}`),
      " ",
      h("span", { class: "minus" }, `−${del}`),
      h("span", { class: "tag" }, ` · ${what} · ${viewed}/${files.length} viewed`),
    );
  }

  #drawTree(): void {
    const tree = buildTree(this.#files.map((f) => f.file.filename));
    const ul = (n: TreeNode): HTMLElement => {
      const list = h("ul", {});
      for (const dir of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        list.append(h("li", { class: "dir" }, h("span", { class: "dname" }, `${dir.name}/`), ul(dir)));
      }
      for (const i of n.files) {
        const f = this.#files[i] as FileView;
        const name = f.file.filename.split("/").at(-1) ?? f.file.filename;
        const b = h(
          "button",
          { type: "button", class: `tfile s-${f.file.status}${f.viewed ? " viewed" : ""}${i === this.#current ? " sel" : ""}`, title: f.file.filename, "data-i": String(i) },
          h("span", { class: "tname" }, name),
          f.hotspots.length ? h("span", { class: `hs-dot sev-${worst(f.hotspots.map((p) => p.hotspot))}`, title: `${f.hotspots.length} hotspot(s)` }) : null,
          h("span", { class: "tcounts" }, h("span", { class: "plus" }, `+${f.file.additions}`), " ", h("span", { class: "minus" }, `−${f.file.deletions}`)),
        );
        b.addEventListener("click", () => this.#goFile(i, true));
        list.append(h("li", {}, b));
      }
      return list;
    };
    this.#tree.replaceChildren(ul(tree));
  }

  #drawToolbar(): void {
    const d = this.#d;
    const r = this.#range;
    const from = h("select", { "aria-label": "Show commits from" });
    from.append(h("option", { value: "all" }, `All commits (${d.commits.length})`));
    d.commits.forEach((c, i) => from.append(h("option", { value: String(i) }, `${i + 1}. ${c.sha.slice(0, 7)} ${subject(c)}`)));
    from.value = r ? String(r.from) : "all";
    const to = h("select", { "aria-label": "through" });
    if (r) d.commits.forEach((c, i) => i >= r.from && to.append(h("option", { value: String(i) }, `${i === r.from ? "only this" : `through ${i + 1}. ${c.sha.slice(0, 7)} ${subject(c)}`}`)));
    to.value = r ? String(r.to) : "";
    to.disabled = !r;
    from.addEventListener("change", () => {
      const v = from.value === "all" ? undefined : Number(from.value);
      void this.#setRange(v === undefined ? undefined : { from: v, to: v });
    });
    to.addEventListener("change", () => r && void this.#setRange({ from: r.from, to: Number(to.value) }));
    const layoutBtn = (l: DiffLayout, label: string) => {
      const b = h("button", { type: "button", class: `small${this.#layout === l ? " on" : ""}`, "aria-pressed": String(this.#layout === l) }, label);
      b.addEventListener("click", () => this.#setLayout(l));
      return b;
    };
    const expand = h("button", { type: "button", class: "small" }, "Expand all");
    const collapse = h("button", { type: "button", class: "small" }, "Collapse all");
    expand.addEventListener("click", () => this.#files.forEach((f) => (f.el.open = true)));
    collapse.addEventListener("click", () => this.#files.forEach((f) => (f.el.open = false)));
    const loading = this.#loading ? h("span", { class: "tag" }, "Loading…") : null;
    const noParent = d.commits.length > 0 && !d.commits[0]?.parent;
    this.#toolbar.replaceChildren(...kids(
      h("span", { class: "group" }, from, to, loading),
      h("span", { class: "group seg" }, layoutBtn("unified", "Unified"), layoutBtn("split", "Split")),
      h("span", { class: "group" }, expand, collapse),
      noParent ? h("span", { class: "tag" }, "Commit views need the commits' parents, which GitHub didn't list.") : null,
    ));
  }

  #drawBar(): void {
    const g = this.#activeGuide();
    const i = this.#guided;
    this.#bar.parentElement?.classList.toggle("guided", g !== undefined && i !== undefined);
    if (!g || i === undefined) {
      this.#bar.hidden = true;
      this.#bar.replaceChildren();
      return;
    }
    const hs = g.hotspots[i];
    this.#bar.hidden = false;
    const prev = h("button", { type: "button", class: "small" }, "← p");
    const next = h("button", { type: "button", class: "small" }, "n →");
    const leave = h("button", { type: "button", class: "small" }, "Leave (Esc)");
    prev.addEventListener("click", () => void this.#goHotspot(i - 1));
    next.addEventListener("click", () => void this.#goHotspot(i + 1));
    leave.addEventListener("click", () => this.#leaveGuided());
    this.#bar.replaceChildren(...kids(
      h("strong", {}, "Guided review"),
      h("span", { class: "tag" }, ` hotspot ${i + 1} of ${g.hotspots.length} · ${this.#seen.size}/${g.hotspots.length} seen · `),
      hs ? h("span", { class: `chip sev-${hs.severity}` }, SEVERITY_LABEL[hs.severity]) : null,
      hs ? h("span", { class: "tag" }, ` ${hs.path}:${hs.start}–${hs.end}`) : null,
      h("span", { class: "group" }, prev, next, leave),
    ));
  }

  #drawGuide(): void {
    const g = this.#guide;
    const p = this.#guidePanel;
    if (g.state === "none") return;
    const head = h("div", { class: "guide-h" }, h("h3", {}, "Review guide"));
    if (g.state === "invalid") {
      p.replaceChildren(head, h("p", { class: "warn" }, `${BOT_LOGIN}'s latest review guide couldn't be read: ${g.error}. `, link(g.url, "the review")));
      return;
    }
    const guide = g.guide;
    const stale = g.state === "stale";
    const on = h("input", { type: "checkbox", id: "guide-on" });
    on.checked = this.#guideOn;
    on.addEventListener("change", () => this.#setGuideOn(on.checked));
    const start = h("button", { type: "button", class: "small primary" }, "Guided review (g)");
    start.disabled = stale || !this.#guideOn || guide.hotspots.length === 0;
    start.addEventListener("click", () => this.#startGuided());
    head.append(...kids(
      h("span", { class: `state ${stale ? "v-approved-older" : ""}` }, stale ? "stale" : "current"),
      stale ? null : h("label", { class: "check", for: "guide-on" }, on, " Show in the diff"),
      stale ? null : start,
    ));
    const seen = guide.hotspots.filter((_, i) => this.#seen.has(i)).length;
    const note = h(
      "p",
      { class: "note" },
      `Advice from ${BOT_LOGIN}'s reviewer, written for ${short(guide.head)}${g.at ? ` (${time(g.at)})` : ""}: where it thinks this PR needs a close read. It doesn't replace reading the diff. `,
      link(g.url, "the review"),
    );
    const children: HTMLElement[] = [head, note];
    if (stale) children.push(h("p", { class: "warn" }, `The head moved to ${short(this.#d.head)} since, so its lines may be off: tints and guided review stay off until the bot posts a guide for this head.`));
    if (!this.#guideOn && !stale) {
      p.replaceChildren(...children);
      return;
    }
    children.push(h("p", { class: "summary-text" }, guide.summary));
    if (guide.hotspots.length) {
      children.push(h("p", { class: "tag progress" }, `${seen}/${guide.hotspots.length} hotspots seen`));
      const ol = h("ol", { class: "hotspots" });
      guide.hotspots.forEach((hs, i) => {
        const b = h(
          "button",
          { type: "button", class: `hotspot${this.#seen.has(i) ? " seen" : ""}${this.#guided === i ? " on" : ""}`, "data-hs": String(i) },
          h("span", { class: `chip sev-${hs.severity}` }, SEVERITY_LABEL[hs.severity]),
          h("span", { class: "tag" }, ` ${hs.category} · `),
          h("code", {}, `${hs.path}:${hs.start}–${hs.end}`),
          this.#seen.has(i) ? h("span", { class: "tag" }, " · seen") : null,
          h("span", { class: "reason" }, hs.reason),
        );
        b.disabled = stale;
        b.addEventListener("click", () => {
          this.#guided = i;
          void this.#goHotspot(i);
        });
        ol.append(h("li", {}, b));
      });
      children.push(ol);
    } else {
      children.push(h("p", { class: "note" }, "No hotspots: the reviewer found nothing that needs a closer read than the rest."));
    }
    if (guide.skim.length) {
      const ul = h("ul", { class: "skim" });
      for (const s of guide.skim) ul.append(h("li", {}, h("code", {}, s.start !== undefined ? `${s.path}:${s.start}–${s.end}` : s.path), h("span", { class: "tag" }, ` ${s.reason}`)));
      children.push(h("details", { class: "skim" }, h("summary", {}, `Safe to skim · ${guide.skim.length}`), ul));
    }
    p.replaceChildren(...children);
  }

  #sawHotspot(i: number): void {
    const g = this.#activeGuide();
    if (!g || !Number.isInteger(i) || i < 0 || i >= g.hotspots.length || this.#seen.has(i)) return;
    this.#seen.add(i);
    saveSeen(this.#guideKey(), this.#seen);
    this.#drawGuide();
    this.#drawBar();
  }

  #setGuideOn(on: boolean): void {
    this.#guideOn = on;
    saveGuideOn(on);
    if (!on) this.#guided = undefined;
    this.#drawGuide();
    this.#showFiles(this.#files.map((f) => f.file));
  }

  #setLayout(l: DiffLayout): void {
    if (l === this.#layout) return;
    this.#layout = l;
    saveLayout(l);
    for (const f of this.#files) f.render();
    this.#drawToolbar();
  }

  async #setRange(r: CommitRange | undefined): Promise<boolean> {
    const d = this.#d;
    if (!r) {
      if (this.#range === undefined) return true;
      this.#range = undefined;
      this.#showFiles(d.files);
      return true;
    }
    const ends = rangeEnds(d.commits, r);
    if (!ends) return false;
    this.#loading++;
    this.#drawToolbar();
    try {
      const files = await this.#handlers.loadRange(ends.base, ends.to);
      this.#range = r;
      this.#guided = undefined;
      this.#showFiles(files);
      return true;
    } catch (e) {
      this.#toolbar.append(h("span", { class: "warn" }, `Couldn't load the commits: ${e instanceof Error ? e.message : String(e)}`));
      return false;
    } finally {
      this.#loading--;
      this.#drawToolbar();
    }
  }

  #select(i: number, scroll: boolean): void {
    if (i < 0 || i >= this.#files.length) return;
    this.#current = i;
    this.#files.forEach((f, k) => f.el.classList.toggle("sel", k === i));
    for (const b of this.#tree.querySelectorAll<HTMLElement>("button.tfile")) b.classList.toggle("sel", b.dataset.i === String(i));
    const f = this.#files[i] as FileView;
    if (scroll) {
      scrollTo(f.el, "start");
      f.el.querySelector("summary")?.focus({ preventScroll: true });
    }
  }

  #goFile(i: number, open: boolean): void {
    const f = this.#files[i];
    if (!f) return;
    if (open) f.el.open = true;
    this.#select(i, true);
  }

  #setViewed(f: FileView, on: boolean): void {
    const sha = f.file.sha;
    if (sha) this.#viewed.set(viewedKey(`${this.#d.ref.owner}/${this.#d.ref.repo}`, f.file.filename, sha), on);
    f.setViewedBox(on);
    f.el.open = !on;
    if (on && f.file.sha) this.#seenBlobs.add(`${f.file.filename}:${f.file.sha}`);
    this.#drawTitle();
    this.#drawTree();
  }

  /** Move the focused line to the next or previous hunk, across files. */
  #moveHunk(step: 1 | -1): void {
    const files = this.#files;
    if (!files.length) return;
    let fi = this.#focusFile ? files.indexOf(this.#focusFile) : Math.max(0, this.#current);
    let cur = this.#focusFile ? (this.#focusFile.focus?.item ?? -1) : step > 0 ? -1 : Number.MAX_SAFE_INTEGER;
    for (let guard = 0; guard <= files.length; guard++) {
      const f = files[fi];
      if (!f) return;
      if (f.el.open) {
        f.build();
        const starts = f.hunkStarts();
        const target = step > 0 ? starts.find((s) => s > cur) : [...starts].reverse().find((s) => s < cur);
        if (target !== undefined) {
          if (this.#focusFile && this.#focusFile !== f) this.#focusFile.setFocus(undefined);
          this.#focusFile = f;
          const el = f.setFocus(target);
          this.#select(fi, false);
          if (el) scrollTo(el, "center");
          return;
        }
      }
      fi += step;
      cur = step > 0 ? -1 : Number.MAX_SAFE_INTEGER;
      if (fi < 0 || fi >= files.length) return;
    }
  }

  #startGuided(): void {
    const g = this.#activeGuide();
    if (!g || g.hotspots.length === 0) return;
    // From the top: "seen" only means it was on screen, not that it was read.
    void this.#goHotspot(0);
  }

  #leaveGuided(): void {
    this.#guided = undefined;
    for (const el of this.#list.querySelectorAll(".callout.on")) el.classList.remove("on");
    this.#drawBar();
    this.#drawGuide();
  }

  async #goHotspot(i: number): Promise<void> {
    const g = this.#activeGuide();
    if (!g) return;
    const n = g.hotspots.length;
    if (i < 0 || i >= n) return;
    const hs = g.hotspots[i] as Guide["hotspots"][number];
    this.#guided = i;
    // The guide's lines are the head's: walk it in the whole PR's diff.
    if (this.#range) await this.#setRange(undefined);
    const fi = this.#files.findIndex((f) => f.file.filename === hs.path);
    const f = this.#files[fi];
    if (!f) {
      this.#drawBar();
      this.#bar.append(h("span", { class: "warn" }, ` ${hs.path} isn't among the files shown.`));
      return;
    }
    const row = await f.reveal([hs.start, hs.end]);
    if (this.#guided !== i) return;
    for (const el of this.#list.querySelectorAll(".callout.on")) el.classList.remove("on");
    const callout = f.calloutEl(i);
    callout?.classList.add("on");
    this.#select(fi, false);
    // The callout sits right above the lines: bring both to the top.
    scrollTo(callout ?? row ?? f.el, callout ? "start" : "center");
    if (row) {
      const item = Number(row.dataset.i);
      if (this.#focusFile && this.#focusFile !== f) this.#focusFile.setFocus(undefined);
      this.#focusFile = f;
      f.setFocus(item);
    }
    this.#seen.add(i);
    saveSeen(this.#guideKey(), this.#seen);
    this.#noteSeen();
    this.#drawBar();
    this.#drawGuide();
  }

  async #jumpToDraft(c: DraftComment): Promise<void> {
    if (c.commit !== this.#viewEnd()) {
      const idx = this.#d.commits.findIndex((k) => k.sha === c.commit);
      if (c.commit === this.#d.head) await this.#setRange(undefined);
      else if (idx >= 0) await this.#setRange({ from: idx, to: idx });
    }
    const f = this.#files.find((x) => x.file.filename === c.path);
    if (!f) return;
    f.el.open = true;
    f.build();
    const item = f.items.findIndex((it) => it.t === "row" && (c.side === "LEFT" ? it.row.old : it.row.new) === c.line && (c.side === "LEFT" || it.row.kind !== "del"));
    scrollTo(f.rowEl(item) ?? f.el, "center");
  }

  unseen(): Unseen {
    this.#noteSeen();
    const d = this.#d;
    const repo = `${d.ref.owner}/${d.ref.repo}`;
    const withDiff = d.files.filter((f) => f.patch !== undefined && f.patch !== "");
    const unopened = withDiff
      .filter((f) => !f.sha || (!this.#seenBlobs.has(`${f.filename}:${f.sha}`) && !this.#viewed.has(viewedKey(repo, f.filename, f.sha))))
      .map((f) => f.filename);
    const out: Unseen = {
      unopened,
      noDiff: d.files.length - withDiff.length,
      truncated: d.files.length < d.changedFiles || d.commits.length < d.commitCount,
    };
    const g = this.#guide;
    if (g.state === "current" && g.guide.hotspots.length) {
      const total = g.guide.hotspots.length;
      out.hotspots = { unseen: total - g.guide.hotspots.filter((_, i) => this.#seen.has(i)).length, total };
    }
    return out;
  }

  command(cmd: Command): boolean {
    const guided = this.#guided !== undefined && this.#activeGuide() !== undefined;
    switch (cmd) {
      case "next-file":
      case "prev-file": {
        const step = cmd === "next-file" ? 1 : -1;
        if (guided) void this.#goHotspot((this.#guided as number) + step);
        else this.#goFile(Math.max(0, Math.min(this.#files.length - 1, this.#current + step)), false);
        return true;
      }
      case "next-hunk":
      case "prev-hunk":
        this.#moveHunk(cmd === "next-hunk" ? 1 : -1);
        return true;
      case "fold": {
        const f = this.#files[Math.max(0, this.#current)];
        if (f) f.el.open = !f.el.open;
        return true;
      }
      case "viewed": {
        const i = Math.max(0, this.#current);
        const f = this.#files[i];
        if (!f) return true;
        const on = !f.viewed;
        this.#setViewed(f, on);
        if (on && i + 1 < this.#files.length) this.#goFile(i + 1, false);
        else this.#select(i, true);
        return true;
      }
      case "comment": {
        const f = this.#focusFile;
        const at = f?.focus;
        return f !== undefined && at !== undefined && f.openComposer(at.item, at.side);
      }
      case "layout":
        this.#setLayout(this.#layout === "unified" ? "split" : "unified");
        return true;
      case "guide":
        if (guided) this.#leaveGuided();
        else this.#startGuided();
        return true;
      case "prev-commit":
      case "next-commit": {
        const n = this.#d.commits.length;
        const r = this.#range;
        let next: number | undefined;
        if (!r) next = cmd === "next-commit" ? 0 : n - 1;
        else next = (cmd === "next-commit" ? r.to : r.from) + (cmd === "next-commit" ? 1 : -1);
        void this.#setRange(next === undefined || next < 0 || next >= n ? undefined : { from: next, to: next });
        return true;
      }
      case "back":
        if (!guided) return false;
        this.#leaveGuided();
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    this.#lazy?.disconnect();
    this.#seenObs?.disconnect();
    this.#scrollObs?.disconnect();
  }
}

function isDraft(v: unknown): v is DraftComment {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.path === "string" &&
    typeof c.line === "number" &&
    (c.side === "LEFT" || c.side === "RIGHT") &&
    typeof c.body === "string" &&
    typeof c.commit === "string" &&
    (c.base === undefined || typeof c.base === "string") &&
    (c.start_line === undefined || typeof c.start_line === "number") &&
    (c.start_side === undefined || c.start_side === "LEFT" || c.start_side === "RIGHT")
  );
}

export function prView(d: PrDetail, entry: Entry | undefined, render: Renderer, handlers: PrViewHandlers, opts: PrViewOptions): PrPane {
  return new Pane(d, entry, render, handlers, opts);
}
