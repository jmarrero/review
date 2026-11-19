// The inbox's cards (inbox.ts) on the page. Cards are kept by key across
// polls: an unchanged card is left alone, a changed one redrawn, a gone one
// removed. A card holding an unsent form (a pick, a reply, a half-written
// answer) is never redrawn, moved or removed under him: it stays as it is,
// marked as changed, until he sends or clears it, or reloads with r.

import { h, link } from "../dom.ts";
import { ACT_NOW_LIMIT, mergeRefusal, type ActNowCoverage, type ActNowRow } from "./actnow.ts";
import { FORGE_ORG } from "./config.ts";
import { NEEDS_HUMAN_LABEL, NEEDS_HUMAN_SEARCH_URL } from "./needshuman.ts";
import type { Renderer } from "../markdown.ts";
import { chatButton, type ChatItem } from "./chatitem.ts";
import type { DocumentEntry } from "./decisiondocument.ts";
import type { MemberPr } from "./backend.ts";
import type { IssueRef } from "./board.ts";
import { refKey } from "./forge.ts";
import type { Ask, InboxContext } from "./holds.ts";
import { askCard, askHref, askUrl, type Card, CARD_LABEL, githubTarget, members, NEEDS_YOU_MAX_AGE_MS, refusal } from "./inbox.ts";
import { approvalKey, type ApproveItem, type ApproveResult } from "./maintain.ts";
import { approveGroup, KEEP_ATTR, KEEP_BUSY } from "./maintainview.ts";
import type { MergeResult } from "./merge.ts";
import { age, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, SINCE_ATTR } from "./view.ts";

export const CARD_CLASS = "card";
export const CARD_DONE_CLASS = "card-done";
/** On a card kept for its unsent form though what it shows changed or left. */
export const CARD_STALE_CLASS = "card-stale";
/** On a card from a list that can't be read now. */
export const CARD_UNAVAILABLE_CLASS = "card-unavailable";
const SIG_ATTR = "data-sig";
const POLICY_ATTR = "data-policy";
const retired = new WeakSet<Element>();

export const CARD_CHANGED_NOTE = "This changed since it was drawn; send or clear your text, or press r to reload it (unsent text is lost).";
export const CARD_GONE_NOTE = "This has left the inbox; your unsent text is kept until you clear it or press r.";

export interface InboxHooks {
  changed?(): void;
  publishedBody?(a: Ask): Promise<HTMLElement>;
  /** Session receipts, keyed by target and ask, not visual card metadata. */
  writes?: Map<string, HTMLElement>;
  /** An Answer card's body: its target and question read now, with the form that answers it. */
  answerBody?(a: Ask): Promise<HTMLElement>;
  now: number;
  render: Renderer;
  /** Whether the signed-in token may act (the operator's, or not yet named). */
  mayAct: boolean;
  /** Tick option `letter` of document entry `entry` (as the card shows it) and fill its reply. */
  answerEntry(entry: DocumentEntry, letter: string, reply: string): Promise<void>;
  /** The body of a Send card: the draft as its review will look, with Send. */
  draftBody?(card: Card & { kind: "send" }): Promise<HTMLElement>;
  /** A Do card's body: its proposal read again, its live facts and exact mutations, with Run. */
  offerBody?(a: Ask): Promise<HTMLElement>;
  /** Approve at `head`, retaining the write's structured outcome. */
  approve?(a: Ask, head: string): Promise<ApproveResult>;
  /** Merge or enqueue only the confirmed full head, with a fresh policy check. */
  merge?(a: Ask, head: string): Promise<MergeResult>;
  /** Read one of a card's PRs now (readMember). */
  member?(ref: IssueRef): Promise<MemberPr>;
  promote?(a: Ask, ref: IssueRef, head: string, ci: MemberPr["ci"]): Promise<string | undefined>;
  /** Send the digest's picked approvals (approveSelected). */
  approveDigest?(items: readonly ApproveItem[]): Promise<ApproveResult[]>;
  /** A card's chat context, for its Chat button; none for a card about no item. */
  chatItem?(c: Card): ChatItem | undefined;
}

/** Why the write may or may not have happened, and that nothing retries it. */
const failed = (e: unknown): string => `Not sent, or uncertain: ${e instanceof Error ? e.message : String(e)}. Check on GitHub before trying again.`;

/**
 * One confirmed write in place, as the viewer. Nothing retries it. Its
 * receipt, sent or uncertain, is kept under `key` in the session's writes,
 * so a redraw shows it rather than offer the write again, and says at once
 * what it now waits on (`done`). Its card is marked done.
 */
function writeButton(hooks: InboxHooks, key: string, label: string, question: string, write: () => Promise<string | undefined | ApproveResult>, done: (url: string | undefined) => (string | Node)[], reread = false): HTMLElement {
  const previous = hooks.writes?.get(key);
  if (previous?.querySelector(`[data-sent], [${KEEP_ATTR}="${KEEP_BUSY}"]`)) return presentReceipt(previous);
  const button = h("button", { type: "button", class: "primary" }, label);
  const status = h("p", { class: "status", role: "status" });
  button.addEventListener("click", () => {
    // Another already-drawn card may have attempted this head since we drew.
    // Its session receipt outlives approveHead's bounded five-minute cache.
    const latest = hooks.writes?.get(key);
    if (latest && latest !== el && latest.querySelector("[data-sent]")) {
      el.replaceChildren(presentReceipt(latest.cloneNode(true) as HTMLElement, true));
      return;
    }
    if (button.disabled || !window.confirm(question)) return;
    button.disabled = true;
    status.textContent = "Sending…";
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    void (async () => {
      const result = await write();
      if (result && typeof result !== "string" && !["approved", "already-approved"].includes(result.status)) {
        const e = new Error(result.note ?? result.status);
        if (result.status === "uncertain") e.name = "MaybeSentError";
        throw e;
      }
      const url = typeof result === "object" ? result.url : result;
      status.removeAttribute(KEEP_ATTR);
      status.setAttribute("data-sent", "");
      if (!reread) status.closest(`.${CARD_CLASS}`)?.classList.add(CARD_DONE_CLASS);
      const outcome = done(url);
      status.replaceChildren(...(status.closest("[data-receipt-only]") ? outcome.map((x) => typeof x === "string" ? x : x.textContent ?? "") : outcome));
    })().catch((e: unknown) => {
      // Kept until r, which reads the target again: it may have moved, or the write gone out.
      status.setAttribute(KEEP_ATTR, "");
      status.textContent = e instanceof Error && e.name === "MaybeSentError" ? failed(e) : `Not sent: ${e instanceof Error ? e.message : String(e)}`;
      if (e instanceof Error && e.name === "MaybeSentError") status.setAttribute("data-sent", "");
      else button.disabled = reread;
    }).finally(() => hooks.changed?.());
  });
  const el = h("div", { class: "card-body actions" }, button, status);
  hooks.writes?.set(key, el);
  return el;
}

/** What an approval releases, and what it doesn't. */
export const APPROVED_WAIT = "Waiting on the agent: this releases only the approval wait; checks and merge policy still decide.";

/**
 * Approve in place at the pass's head. The write checks the live head and
 * viewer's approvals, not every card on every poll.
 */
function askApprovalKey(a: Ask): string {
  const [owner = "", repo = ""] = a.action.repository.split("/");
  return approvalKey({ owner, repo, number: a.action.number }, a.action.head!);
}

const approvalBindings = new WeakMap<HTMLElement, string>();

function approveBody(a: Ask, hooks: InboxHooks): HTMLElement {
  const key = askApprovalKey(a);
  const signature = cardSignature(askCard(a));
  const previous = hooks.writes?.get(key);
  // Share identical handlers, but refresh an idle paginated ask when the
  // publication replaces its identity or policy at the same target/head.
  if (previous && approvalBindings.get(previous) === signature) return previous;
  const head = a.action.head!;
  const where = `${a.action.repository}#${a.action.number}`;
  const body = writeButton(hooks, key, `Approve ${head.slice(0, 7)}`,
    `Approve ${where} at ${head.slice(0, 12)} as you, without its diff open here? If the head moved, nothing is sent.`, () => hooks.approve!(a, head),
    (url) => (url ? ["Approved: ", link(url, url), `. ${APPROVED_WAIT}`] : ["Skipped: already approved at HEAD."]));
  // A pending/sent receipt still belongs to its original handler.
  if (body !== previous) approvalBindings.set(body, signature);
  return body;
}

/** Why Act now lists decisions the pass did not certify. */
const ACT_NOW_FALLBACK = "The pass's list is incomplete, so its open operator decisions are listed here too, without shortcuts.";

/**
 * The direct needs-human read, below the published rows: links only. The
 * label is not a question, an answer or a release, so nothing here writes.
 * An empty failed or partial read never says that no decision waits.
 */
function labelledList(c: ActNowCoverage): HTMLElement {
  const el = h("div", { class: "act-now-labelled", "aria-label": "Labelled needs-human issues" },
    h("h3", {}, `Labelled ${NEEDS_HUMAN_LABEL}, not certified`),
    h("p", { class: "note" }, `Open issues labelled ${NEEDS_HUMAN_LABEL} in ${FORGE_ORG}, read directly: read-only, unblocks unknown. The label alone is not a question, an answer or a release of the hold; a decision without the label is not found this way.`));
  const read = c.read;
  if (!read) {
    el.append(h("p", { class: "note" }, `Listing ${NEEDS_HUMAN_LABEL} issues…`));
    return el;
  }
  if (read.error) el.append(h("p", { class: "warn" }, `Couldn't list ${NEEDS_HUMAN_LABEL} issues: ${read.error}. Decisions may still be waiting.`));
  if (read.partial) el.append(h("p", { class: "warn" }, `Partial: ${read.partial}. More may be waiting: `, link(NEEDS_HUMAN_SEARCH_URL, "search on GitHub"), "."));
  if (!read.error && !read.issues.length && !read.partial) el.append(h("p", { class: "note" }, `No open ${NEEDS_HUMAN_LABEL} issue found.`));
  else if (read.issues.length && !c.issues.length) el.append(h("p", { class: "note" }, "Every labelled issue read is listed above or done here."));
  const shown = c.issues.slice(0, ACT_NOW_LIMIT);
  if (shown.length) el.append(h("ul", {}, ...shown.map((i) => h("li", {}, link(i.url, i.item), " ", i.title, " · unblocks unknown"))));
  if (c.issues.length > shown.length) el.append(h("p", { class: "note" }, `${c.issues.length - shown.length} more: `, link(NEEDS_HUMAN_SEARCH_URL, "search on GitHub"), "."));
  return el;
}

/**
 * Compact published shortlist, with a checked action, a visible refusal or an incomplete list's note on every row.
 * With `coverage`, the list cannot vouch for it: it says why and lists the direct read too, never hidden.
 */
export function fillActNow(slot: HTMLElement, rows: readonly ActNowRow[], hooks: InboxHooks, coverage?: ActNowCoverage): void {
  // Merge has no canonical writer on the Answer card. Its session outcomes
  // remain visible even after completion removes the ask from the shortlist.
  const receipts = [...(hooks.writes ?? [])].flatMap(([key, body]) => key.startsWith('["merge",') && body.querySelector(`[data-sent], [${KEEP_ATTR}]`) ?
    [h("div", { class: "merge-receipt" }, body.dataset.mergeTarget ?? "Merge / enqueue", body.querySelector(".status")!.cloneNode(true))] : []);
  slot.hidden = !coverage && rows.length === 0 && receipts.length === 0;
  slot.replaceChildren(h("h2", {}, "Act now"), ...(coverage ? [h("p", { class: "warn act-now-gap" }, `${coverage.gap}: Act now may be missing decisions.`)] : []),
    ...(rows.some((r) => r.fallback) ? [h("p", { class: "note" }, ACT_NOW_FALLBACK)] : []), h("ol", {}, ...rows.map(({ ask: a, unblocks, fallback }) => {
    const card = askCard(a);
    const row = h("li", {}, link(askUrl(a.action), a.item),
      h("p", {}, a.ask, a.group ? ` · ${a.group.numbers.length} PRs: ${a.group.reason}` : "",
      unblocks ? ` · unblocks ${unblocks}` : " · unblocks unknown", a.carried ? " · carried over; may be resolved" : ""));
    if (fallback) {
      row.append(h("a", { href: askHref(a.action) }, "Inspect"));
    } else if (card.kind === "approve" && !a.group && a.action.head && hooks.mayAct && hooks.approve && hooks.writes && !refusal(a, "review-at-head")) {
      // Forward to the canonical action, even if its card is past the first
      // page. Never create a second writer or move a live receipt off its card.
      const body = approveBody(a, hooks);
      const source = body.querySelector<HTMLButtonElement>("button");
      const button = h("button", { type: "button", class: "small" }, source?.textContent ?? "Approval recorded");
      button.disabled = !source || source.disabled;
      button.addEventListener("click", () => {
        // Show more can draw its canonical card without redrawing this list.
        const current = hooks.writes!.get(askApprovalKey(a))!;
        const control = current.querySelector<HTMLButtonElement>("button");
        control?.click();
        button.disabled = !control || control.disabled;
        if (current.querySelector(`[${KEEP_ATTR}="${KEEP_BUSY}"]`)) button.textContent = "Sending…";
      });
      row.append(button, h("small", { class: "status", role: "status" }, body.querySelector(".status")?.textContent ?? ""));
    } else if (a.action.type === "pull_request" && !a.group && a.action.head && hooks.mayAct && hooks.merge && hooks.writes && !mergeRefusal(a)) {
      const head = a.action.head;
      const key = JSON.stringify(["merge", a.action.repository.toLowerCase(), a.action.number, head]);
      let state: MergeResult["state"] = "enqueued";
      const previous = hooks.writes.get(key);
      const body = previous?.querySelector(`[${KEEP_ATTR}]`) ? previous : writeButton(hooks, key, `Merge / enqueue ${head.slice(0, 7)}`,
        `Merge or enqueue ${a.item} at ${head} as you? GitHub's current rules apply; a changed head sends nothing.`, async () => {
          const result = await hooks.merge!(a, head);
          state = result.state;
          return result.url;
        }, (url) => [state === "merged" ? "Merged: " : "Enqueued, not merged; waiting on GitHub's queue: ", ...(url ? [link(url, url)] : [])], true);
      body.dataset.mergeTarget = `${a.item} at ${head.slice(0, 12)}`;
      row.append(body);
    } else {
      const step = card.kind === "approve" ? "review-at-head" : a.action.type === "pull_request" ? "merge-or-enqueue" : undefined;
      const why = !hooks.mayAct ? "Sign in as the operator to act here." : a.group ? "Grouped PRs require individual inspection; no representative-only write." :
        (step === "merge-or-enqueue" ? mergeRefusal(a) : refusal(a, step)) ?? (step && !a.action.head ? "No published head SHA; inspect the PR before acting." :
          a.action.type === "issue" || a.action.type === "reply_pull_request" ? "A reply requires inspecting the current question and entering an answer." :
          a.action.type === "operator_action" ? "Inspect and confirm the proposal's exact mutations first." :
          a.action.type === "close_pull_request" ? "No checked close action is available here." :
          a.action.type === "review_pull_request" ? "Inspect the diff before submitting a review." : "No matching checked action is configured here.");
      row.append(h("p", { class: "note" }, `Not offered here: ${why}`), h("a", { href: askHref(a.action) }, "Inspect"));
    }
    return row;
  })), ...(coverage ? [labelledList(coverage)] : []), ...(receipts.length ? [h("div", { class: "merge-receipts", "aria-label": "Merge / enqueue receipts" }, ...receipts)] : []));
}

/** Digest rows belong to their report; other receipts stay live, including pending writes. */
function presentReceipt(el: HTMLElement, only = false): HTMLElement {
  if (el.hasAttribute("data-approval-receipt")) el = el.cloneNode(true) as HTMLElement;
  if (!only) return el;
  el.setAttribute("data-receipt-only", "");
  for (const control of el.querySelectorAll("button, input, textarea, select")) control.remove();
  for (const a of el.querySelectorAll("a")) a.removeAttribute("href");
  return el;
}

/** Receipts for this target only, including a write still going out. */
function memberReceipts(ref: IssueRef, hooks: InboxHooks, except?: string): HTMLElement[] {
  const prefix = JSON.stringify(["approve", refKey(ref).toLowerCase()]).slice(0, -1) + ",";
  return [...(hooks.writes ?? [])].filter(([key, el]) => key !== except && key.startsWith(prefix) && el.querySelector(`[data-sent], [${KEEP_ATTR}]`)).map(([, el]) => presentReceipt(el, true));
}

/** One member read now: its facts, and on a Promote card its own Promote or why there is none. */
async function memberBody(c: Card & { ask: Ask }, ref: IssueRef, hooks: InboxHooks, current: () => boolean): Promise<HTMLElement> {
  let m: MemberPr;
  try { m = await hooks.member!(ref); }
  catch (e) { return current() ? h("div", {}, h("p", { class: "warn" }, String(e)), ...memberReceipts(ref, hooks)) : h("div"); }
  // Receipts are shared live nodes: an obsolete read must not move them off the current card.
  if (!current()) return h("div");
  const where = refKey(m.ref);
  const evidence = !c.unavailable && !c.ask.carried && !c.ask.requestsUnreadable && (c.ask.requests ?? []).every((r) => r.quality === "decision") ? c.ask.reviewBuckets?.[where.toLowerCase()] : undefined;
  const bucket = evidence?.assessed_head === m.head && (evidence.bucket !== "quick" || evidence.ci === "green" && m.ci === "success") ? evidence.bucket : "unknown/deep";
  // One short line: the row's bucket is a label, not a place it moves to.
  const facts = h("div", { "data-bucket": bucket }, h("p", {}, link(m.url, m.title), ` · ${m.state} · ${m.head.slice(0, 7)} · by ${m.author} · `, h("a", { href: `#pr/${where.replace("#", "/")}` }, "Review")),
    h("small", { class: "note review-evidence" }, `${bucket} · CI ${m.ci ?? "unknown"} (published ${evidence?.ci ?? "unknown"}) · ${!evidence ? "No fresh review evidence" : evidence.assessed_head !== m.head ? `assessed at ${evidence.assessed_head.slice(0, 7)}, not this head` : `${evidence.summary}; ${evidence.reason}`}. Informational only.`));
  if (c.kind !== "promote") return h("div", {}, facts, ...memberReceipts(ref, hooks));
  const no = [refusal(c.ask, "promote"), m.problem, m.state !== "open draft" ? `member is ${m.state}, not an open draft` : undefined].filter(Boolean).join("; ");
  const key = approvalKey(m.ref, m.head);
  return h("div", {}, facts, ...memberReceipts(ref, hooks, no || !hooks.mayAct ? undefined : key), no ? h("p", { class: "warn" }, `Promote not offered: ${no}.`) : hooks.mayAct && hooks.promote ?
    writeButton(hooks, key, `Promote ${m.head.slice(0, 7)}`,
      `Approve ${where} at ${m.head} for promotion as you? A changed member must be reread and confirmed again.`,
      () => hooks.promote!(c.ask, ref, m.head, m.ci),
      (url) => [url ? "Approval sent: " : "Already approved: ", ...(url ? [link(url, url)] : []), " Waiting on promoter; promotion is not completed."], true) : null);
}

/** A card's PRs, each read only when he opens it: a group's members, or a Promote card's PR. */
function memberList(c: Card & { ask: Ask }, hooks: InboxHooks, inspected?: string, refresh = false): HTMLElement {
  const [owner = "", repo = ""] = c.ask.action.repository.split("/");
  // One summary line per member, in the pass's order: rows never move, so focus and position stay put.
  return h("div", { class: "card-body members" }, hooks.member ? null : "Inspect each member; no group writes.", ...members(c.ask).map((number) => {
    const d = h("details", { class: "member" }, h("summary", {}, `${c.ask.action.repository}#${number}`, " · ", h("a", { href: askHref({ ...c.ask.action, number }) }, "Inspect")));
    const current = () => d.isConnected && !retired.has(d.closest(`.${CARD_CLASS}`)!);
    d.addEventListener("toggle", () => {
      if (!hooks.member || !current() || !d.open) return;
      d.closest<HTMLElement>("[data-inbox-list]")?.setAttribute("data-selected-member", d.dataset.member!);
      if (d.dataset.restore === "pending") { d.dataset.restore = "ready"; return; }
      if (d.dataset.restore === "ready") {
        delete d.dataset.restore;
        while (d.children.length > 1) d.lastElementChild!.remove();
      }
      if (d.children.length === 1) d.append(bodySlot(memberBody(c, { owner, repo, number }, hooks, current).then((body) => {
        const bucket = body.querySelector<HTMLElement>("[data-bucket]")?.dataset.bucket;
        if (!current()) return body;
        if (bucket) d.dataset.bucket = bucket;
        else delete d.dataset.bucket;
        return body;
      })));
    });
    d.dataset.member = `${owner}/${repo}#${number}`.toLowerCase();
    if (d.dataset.member === inspected) {
      // A poll restores selection only; r explicitly reinspects that identity.
      if (!refresh) {
        d.dataset.restore = "pending";
        d.append(h("p", { class: "note" }, "Review evidence changed. Close and reopen to inspect again."), ...memberReceipts({ owner, repo, number }, hooks));
      }
      d.open = true;
    }
    return d;
  }));
}

const STEP: Record<string, string> = { promote: "promote", "merge-or-enqueue": "merge or enqueue", reply: "reply", close: "close", "review-at-head": "approve at the head", "check-proposal": "run the proposal" };

/** The steps a card's own path takes, through its own checks, whatever the pass supplies. */
const OWN: Partial<Record<Card["kind"], string>> = { promote: "promote", answer: "reply" };

/** The steps the pass says are not supported from its request, each with its reason, less the card's own. */
function notOffered(c: Card & { ask: Ask }): HTMLElement | null {
  const off = (c.ask.requests ?? []).flatMap((r) => r.actions).filter((x) => !x.supported && OWN[c.kind] !== x.kind).filter((x, i, all) => all.findIndex((y) => y.kind === x.kind) === i);
  if (!off.length) return null;
  return h("details", { class: "not-offered" }, h("summary", {}, `Not offered here: ${off.map((x) => STEP[x.kind] ?? x.kind).join(", ")}`),
    h("ul", {}, ...off.map((x) => h("li", {}, `${STEP[x.kind] ?? x.kind}: ${x.reason}`))));
}

/** In place of a write the pass or the forge rules out: why, and where to look. */
const refused = (why: string, a: Ask): HTMLElement => h("div", { class: "card-body" }, h("p", { class: "warn" }, `Not offered here: ${why}`), githubTarget(a) ? h("a", { class: "action", href: askHref(a.action) }, "Inspect") : null);

/** Cards drawn at first, about a phone's screen; "Show more" draws as many again. */
export const INBOX_PAGE = 5;
const MORE_CLASS = "inbox-more";
const LIMIT_ATTR = "data-limit";

/** What a card shows, so an unchanged card is not redrawn. Its age is left out: the ticker moves it in place. */
export function cardSignature(c: Card): string {
  const base = [c.kind, c.key, c.title, c.where, c.url, c.since, c.answered === true, c.note, c.priority, c.unavailable === true];
  return JSON.stringify([...base, ...("ask" in c ? [c.ask.action, c.ask.group, c.ask.requests, c.ask.requestsUnreadable, c.ask.reviewBuckets, c.ask.approvalEvidence, c.ask.detailMissing, c.ask.carried] :
    c.kind === "digest" ? [c.items] : c.kind === "send" ? [c.draft.issue.body, c.draft.box, c.draft.found?.raw, c.draft.refused] : [c.entry.text, c.mark])]);
}

/**
 * Whether a card holds something he typed or picked and hasn't sent, or
 * he is in one of its fields: redrawing or moving it would take the focus
 * (and a phone's keyboard) away.
 */
export function holdsDraft(card: Element): boolean {
  const active = card.ownerDocument.activeElement;
  if (active && card.contains(active) && active.matches("input, textarea, select")) return true;
  if (card.querySelector(`[${KEEP_ATTR}]`)) return true;
  return [...card.querySelectorAll("form:not([data-sent])")].some((form) =>
    [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input[type=text]")].some((t) => t.value.trim() !== "") ||
    form.querySelector("input[type=radio]:checked") !== null);
}

/** A document entry's options and reply, sent through `answerEntry`. */
function entryForm(c: Card & { kind: "document" }, hooks: InboxHooks): HTMLElement {
  const form = h("form", { class: "answer entry-answer", "data-id": c.entry.id });
  for (const o of c.entry.options) form.append(h("label", { class: "opt" }, h("input", { type: "radio", name: `entry-${c.entry.id}`, value: o.letter }), `${o.letter}) ${o.text}`));
  const reply = h("input", { type: "text", "aria-label": `Reply for ${c.entry.id}`, maxlength: "4096", placeholder: "Reply (optional)" });
  const button = h("button", { type: "submit", class: "primary" }, "Send");
  const status = h("p", { class: "status", role: "status" });
  form.append(reply, h("div", { class: "actions" }, button), status);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const picked = form.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value;
    if (button.disabled) return;
    if (!picked) {
      status.textContent = "Pick an option.";
      return;
    }
    button.disabled = true;
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    status.textContent = "Sending…";
    hooks.answerEntry(c.entry, picked, reply.value).then(() => {
      form.dataset.sent = "true";
      status.textContent = "Answered.";
      for (const input of form.querySelectorAll("input")) input.disabled = true;
    }, (e: unknown) => {
      status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
      button.disabled = false;
    }).finally(() => status.removeAttribute(KEEP_ATTR));
  });
  return form;
}

/** The card's in-place action or body, read on drawing where it needs to be; else a link to where it is done. */
function action(c: Card, hooks: InboxHooks, inspected?: string, refresh = false): HTMLElement | null {
  // Its title already says the detail is missing; there is nothing to refuse.
  if (c.answered || ("ask" in c && c.ask.detailMissing)) return null;
  const no = "ask" in c ? refusal(c.ask, c.kind === "approve" ? "review-at-head" : c.kind === "do" ? "check-proposal" : undefined) : undefined;
  if (no && "ask" in c) {
    const body = refused(no, c.ask);
    if (c.kind === "promote") for (const number of members(c.ask)) {
      const [owner = "", repo = ""] = c.ask.action.repository.split("/");
      for (const receipt of memberReceipts({ owner, repo, number }, hooks)) {
        body.append(h("div", {}, `Prior write on ${owner}/${repo}#${number}:`, receipt));
      }
    }
    return body;
  }
  if ("ask" in c && (c.ask.group || c.kind === "promote")) return memberList(c, hooks, inspected, refresh);
  if ("ask" in c && (c.ask.source === "decisions" || c.ask.source === "drafts") && hooks.publishedBody) return bodySlot(hooks.publishedBody(c.ask));
  switch (c.kind) {
    case "answer": if (hooks.answerBody && hooks.mayAct) return bodySlot(hooks.answerBody(c.ask)); break;
    case "approve": if (hooks.approve && hooks.mayAct) return approveBody(c.ask, hooks); break;
    case "do": if (hooks.offerBody) return bodySlot(hooks.offerBody(c.ask)); break;
    case "document": return hooks.mayAct && c.entry.options.length ? entryForm(c, hooks) : null;
    case "send": return hooks.draftBody ? bodySlot(hooks.draftBody(c)) : null;
    case "digest": return hooks.approveDigest && hooks.mayAct ? approveGroup(c.items, hooks.approveDigest, hooks.writes) : null;
  }
  return h("a", { class: "action", href: askHref(c.ask.action) }, "Inspect");
}

/** Published facts only: never new human asks or write controls. */
export function publishedContext(context: InboxContext | undefined): HTMLDetailsElement {
  const fold = h("details", { class: "published-context" }, h("summary", {}, "Published context"));
  if (!context) {
    fold.append(h("p", { class: "note" }, "Context not published."));
    return fold;
  }
  fold.append(h("p", { class: "note" }, `Observed ${context.observedAt ?? "unknown"} · WIP ${context.wip?.inFlight ?? "unknown"}/${context.wip?.limit ?? "unknown"} · ${context.omitted} facts omitted.`,
    ` Sources: ${Object.entries(context.sources).map(([name, state]) => `${name} ${state}`).join(", ") || "not published"}. Unread sources are unknown, not empty.`),
    h("ul", {}, ...context.items.map((f) => h("li", {}, `${f.source} · ${f.item ?? "all new runs"} · ${f.kind}: ${f.reason} · observed ${f.observedAt ?? "unknown"}${f.since ? ` · since ${f.since}` : ""}`))),
    ...Object.entries(context.limits).map(([name, fields]) => h("p", { class: "note" }, `${name}: ${Object.entries(fields).map(([key, value]) => `${key} ${value}`).join(" · ")}`)));
  return fold;
}

/** A slot filled with `body` when it arrives. */
function bodySlot(body: Promise<HTMLElement>): HTMLElement {
  const slot = h("div", { class: "card-body" }, h("p", { class: "note" }, "Reading…"));
  body.then((b) => slot.replaceChildren(b), (e: unknown) => slot.replaceChildren(h("p", { class: "warn" }, String(e))));
  return slot;
}

export function cardEl(c: Card, hooks: InboxHooks, inspected?: string, refresh = false): HTMLElement {
  // An answer keeps its own receipts (answerBody), and an Open card writes nothing; the rest by what they write.
  const key = JSON.stringify(c.kind === "digest" ? [c.kind, c.items.map((a) => [a.pr, a.head])] : c.kind === "send" ? [c.kind, c.key, c.draft.issue.body, c.draft.found?.raw] : c.kind === "document" ? [c.kind, c.key, cardSignature(c)] : [c.kind, c.key, c.ask.action, members(c.ask), policySignature(c)]);
  const previous = hooks.writes?.get(key);
  if (c.kind !== "answer" && c.kind !== "promote" && c.kind !== "open" && previous?.querySelector("[data-sent], [data-keep]")) return refreshEvidence(previous, c, hooks.now);
  const head = h("div", { class: "card-head" },
    h("span", { class: `kind c-${c.kind}` }, CARD_LABEL[c.kind]),
    c.priority ? pill(c.priority) : null,
    "ask" in c && c.ask.kind === "review-withheld" ? pill("Review withheld") : null,
    h("span", { class: "title", title: c.title }, c.url && !("ask" in c && c.ask.group) ? link(c.url, c.title) : c.title),
    h("span", { class: "age", ...(c.since ? { [SINCE_ATTR]: c.since, title: c.since } : {}) }, age(c.since, hooks.now)));
  const ask = "ask" in c ? c.ask : undefined;
  const el = h("article", {
    class: `${ROW_CLASS} ${CARD_CLASS} c-${c.kind}${c.answered ? ` ${CARD_DONE_CLASS}` : ""}${c.unavailable ? ` ${CARD_UNAVAILABLE_CLASS}` : ""}`,
    tabindex: "-1",
    [ROW_KEY_ATTR]: c.key,
    [ROW_SECTION_ATTR]: "inbox",
    [ROW_HREF_ATTR]: ask && githubTarget(ask) ? askHref(ask.action) : "#",
    [SIG_ATTR]: cardSignature(c),
    [POLICY_ATTR]: policySignature(c),
  }, head, h("p", { class: "card-where" }, c.where),
  c.unavailable ? h("p", { class: "card-note warn" }, "Unavailable: from the last list read; the pass's list can't be read now.") : null);
  refreshEvidence(el, c, hooks.now);
  if (ask?.requests?.some((r) => r.quality !== "decision")) el.append(h("small", { class: "note" }, [...new Set(ask.requests.map((r) => r.quality).filter((q) => q !== "decision"))].join(" · ")));
  // The note and the published request context share one collapsed fold, so a card stays a few lines.
  const descriptions = ask?.requests?.filter((r) => r.detail) ?? [];
  if (c.note || descriptions.length) el.append(h("details", { class: "card-note" }, h("summary", {}, "Context"), c.note ? h("p", {}, c.note) : null,
    ...descriptions.map((r) => h("dl", { class: "request-context" }, ...Object.entries(r.detail!).flatMap(([key, value]) => [h("dt", {}, key), h("dd", {}, value)])))));
  if (c.kind === "document" && c.entry.text.trim()) el.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole entry"), h("div", { class: "md" }, hooks.render(c.entry.text, c.entry.about?.repo))));
  // Cold load and polls read the publication alone. Target reads are lazy;
  // action-time preflight remains independent of these inspection reads.
  if (((c.kind === "answer" && hooks.mayAct) || c.kind === "send" || c.kind === "do" || (ask && ["decisions", "drafts"].includes(ask.source))) && !(ask && refusal(ask))) {
    const fold = h("details", { class: "card-full" }, h("summary", {}, "Details and action"));
    fold.addEventListener("toggle", () => {
      if (!fold.open || fold.children.length > 1 || retired.has(el)) return;
      const act = action(c, hooks, inspected, refresh);
      if (act) fold.append(act);
    });
    if (ask && (ask.group || c.kind === "promote") && members(ask).some((n) => `${ask.action.repository}#${n}`.toLowerCase() === inspected)) {
      const act = action(c, hooks, inspected, refresh);
      if (act) fold.append(act);
      fold.open = true;
    }
    el.append(fold);
  } else {
    const act = action(c, hooks, inspected, refresh);
    if (act) el.append(act);
  }
  const off = ask && !c.answered ? notOffered({ ...c, ask }) : null;
  if (off) el.append(off);
  // After the card's own action: chatting never stands in for it.
  const chat = chatButton(!ask || githubTarget(ask) ? hooks.chatItem?.(c) : undefined);
  if (chat) el.append(h("div", { class: "actions" }, chat));
  if (c.kind !== "answer" && c.kind !== "promote" && c.kind !== "open") hooks.writes?.set(key, el);
  return el;
}

/** Refresh only facts beside retained writes; never lend a new head's evidence to an old button. */
function refreshEvidence(el: HTMLElement, c?: Card, now = Date.now()): HTMLElement {
  const a = c?.kind === "approve" ? c.ask : undefined;
  const row = el.querySelector<HTMLElement>(":scope > .approval-evidence") ?? (a ? el.appendChild(h("div", { class: "approval-evidence", "data-action": JSON.stringify(a.action) })) : null);
  if (!row) return el;
  const age = now - Date.parse(a?.approvalEvidence?.observed_at ?? "");
  const e = a && age >= 0 && age <= NEEDS_YOU_MAX_AGE_MS && !c?.unavailable && !a.carried && githubTarget(a) && a.requests?.every((r) => r.quality === "decision") !== false && row.dataset.action === JSON.stringify(a.action) && a.approvalEvidence?.assessed_head === a.action.head ? a.approvalEvidence : undefined;
  row.replaceChildren(h("span", {}, e ? `${typeof e.diff === "object" ? `Diff +${e.diff.additions}/−${e.diff.deletions}` : "Diff unknown"} · CI ${e.ci.complete ? e.ci.state : "unknown (partial)"} · Review ${e.review ? `${e.review.verdict} at ${e.review.at}` : "unknown"} · head ${e.assessed_head} · observed ${e.observed_at} (published, not live)` : "Diff, CI and review unknown: no matching published evidence"),
    ...(a && githubTarget(a) && !retired.has(el) ? [h("a", { href: askHref(a.action) }, "Review the diff")] : []));
  return el;
}

/** A retained draft or receipt must not retain authority a newer list removed. */
function policySignature(c: Card): string {
  return JSON.stringify("ask" in c ? [c.ask.requests, c.ask.requestsUnreadable, c.ask.detailMissing] : c.kind === "digest" ? c.items.map((a) => [a.pr, a.head]) : null);
}

/** Keep typed text and receipts, but retire their old handlers until an explicit reload. */
function retireActions(el: HTMLElement): void {
  retired.add(el);
  for (const button of el.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type=submit]")) button.disabled = true;
  for (const a of el.querySelectorAll("a")) a.removeAttribute("href");
  el.setAttribute(ROW_HREF_ATTR, "#");
  for (const type of ["click", "submit"]) el.addEventListener(type, (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
}

function staleNote(el: Element, text: string): void {
  el.classList.add(CARD_STALE_CLASS);
  const note = el.querySelector(":scope > .card-stale-note") ?? el.querySelector(":scope > .card-head")!.insertAdjacentElement("afterend", h("p", { class: "card-stale-note warn", role: "status" }))!;
  note.textContent = text;
}

/** The "Show more" button after `list`, for the cards of `total` not drawn yet; none when there are none. */
function moreButton(list: HTMLElement, drawn: number, total: number, more: () => void): void {
  const next = list.nextElementSibling;
  const old = next?.classList.contains(MORE_CLASS) ? next : null;
  if (drawn >= total) {
    old?.remove();
    return;
  }
  // Counted as the section's heading counts: every card in the list.
  const button = h("button", { type: "button", class: `small ${MORE_CLASS}` }, `Show ${Math.min(total - drawn, INBOX_PAGE)} more · ${drawn} of ${total} shown`);
  button.addEventListener("click", more);
  if (old) old.replaceWith(button);
  else list.after(button);
}

/**
 * Show `cards` in `list`, in order, keeping each card that didn't change
 * (or, unless `force`, holds an unsent form) as the node it is. A kept
 * draft is never moved either, since moving a node takes the focus out of
 * it: the other cards are placed around it. Only the first INBOX_PAGE cards
 * (more after "Show more") are drawn, so the ones further down read
 * nothing; a drawn card holding a draft stays however far it moved.
 * Returns the matching published card count, excluding departed drafts.
 */
export function fillInbox(list: HTMLElement, cards: readonly Card[], hooks: InboxHooks, force = false, selected?: ReadonlySet<string>): number {
  list.setAttribute("data-inbox-list", "");
  const inspected = list.dataset.selectedMember;
  const shown = new Map([...list.querySelectorAll<HTMLElement>(`:scope > .${CARD_CLASS}`)].map((el) => [el.getAttribute(ROW_KEY_ATTR)!, el]));
  // Not even r redraws writes still going out: a fresh card would offer them again.
  const keep = (el: HTMLElement): boolean => (!force && holdsDraft(el)) || el.querySelector(`[${KEEP_ATTR}="${KEEP_BUSY}"]`) !== null;
  const limit = Number(list.getAttribute(LIMIT_ATTR)) || INBOX_PAGE;
  const matching = cards.filter((c) => !selected || selected.has(c.key));
  const page = new Set(matching.slice(0, limit).map((c) => c.key));
  const drawn = cards.filter((c) => {
    if (page.has(c.key)) return true;
    const el = shown.get(c.key);
    return el !== undefined && keep(el);
  });
  const more = () => {
    list.setAttribute(LIMIT_ATTR, String(limit + INBOX_PAGE));
    fillInbox(list, cards, hooks, false, selected);
  };
  const wanted = drawn.map((c) => {
    const el = shown.get(c.key);
    shown.delete(c.key);
    // r clears a write's kept report too, reading the card's state again.
    const report = force && el?.querySelector(`[${KEEP_ATTR}=""]`);
    if (el) refreshEvidence(el, c, hooks.now);
    if (el && el.getAttribute(SIG_ATTR) === cardSignature(c) && !el.classList.contains(CARD_STALE_CLASS) && !report && !(force && "ask" in c && (c.kind === "promote" || c.ask.group || ["decisions", "drafts"].includes(c.ask.source)))) return el;
    // A newly published group revokes the representative's old single-item form.
    if (el && keep(el) && !("ask" in c && (c.ask.group || c.kind === "promote"))) {
      if (el.getAttribute(POLICY_ATTR) !== policySignature(c)) retireActions(el);
      staleNote(el, CARD_CHANGED_NOTE);
      return el;
    }
    if (el) retired.add(el);
    const fresh = cardEl(c, hooks, inspected, force);
    if ("ask" in c && c.ask.group && c.kind !== "promote") {
      const prior = el?.querySelector<HTMLElement>(":scope > .prior-write");
      if (prior) fresh.append(prior);
      else if (el?.querySelector("[data-sent], [data-keep]")) {
        // Its outcome stays visible; its controls go, so a failed write offers no retry.
        fresh.append(presentReceipt(h("div", { class: "prior-write" }, "Prior write:", ...el.children), true));
      }
    }
    el?.replaceWith(fresh);
    return fresh;
  });
  let gone = 0;
  for (const el of shown.values()) {
    if (keep(el)) {
      // A filtered-out digest has no replacement key to compare policies
      // with. Keep its report/text, never its obsolete approval handlers.
      retireActions(el);
      refreshEvidence(el);
      staleNote(el, CARD_GONE_NOTE);
      // A poll must not hide an already-visible draft when its key leaves
      // the publication. Show everything also recovers drafts hidden earlier.
      if (!selected) el.hidden = false;
      if (!el.hidden) gone++;
    } else el.remove();
  }
  wanted.forEach((el, i) => { el.hidden = !!selected && !selected.has(drawn[i]!.key); });
  moreButton(list, drawn.filter((c) => !selected || selected.has(c.key)).length + gone, matching.length + gone, more);
  let cursor: HTMLElement | undefined;
  for (const el of wanted) {
    if (!(keep(el) && el.isConnected)) {
      const at = cursor ? cursor.nextElementSibling : list.firstElementChild;
      if (at !== el) {
        if (cursor) cursor.after(el);
        else list.prepend(el);
      }
    }
    cursor = el;
  }
  return matching.length;
}
