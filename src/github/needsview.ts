// The rows of the "Needs you" section: one per thing that waits on him,
// each with the single action it asks for. A question is answered right
// in its row, with the same form as the item view; everything else has
// its action as a link to the pane where it is done.

import type { Answer } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { blockedBy, NO_PRIORITY, questionOf } from "./board.ts";
import { OPERATOR } from "./config.ts";
import type { Entry } from "./queue.ts";
import { ACTION_LABEL, ACTION_TITLE, ALL_PRIORITIES, matchesPriority, type Need, needPriority, priorityChips } from "./needs.ts";
import { decisionLabel, shortRef } from "./triage.ts";
import { age, answerForm, askText, excerpt, KIND_LABEL, KIND_TITLE, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, type RowLabel, rowText, SINCE_ATTR, sinceTitle, STATE_LABEL } from "./view.ts";

/** Characters of the ask shown on a row before "The whole question". */
const ASK_EXCERPT = 240;
/** The prefix the bot puts before a question in the board's Why field. */
const WHY_ASK_RE = /^Q:\s*/;
/** Rows of the answer text box in a row: a short note, not the item view's four. */
const NOTE_ROWS = 2;

/** The class of a need's row, and of one answered from this page. */
export const NEED_CLASS = "need";
export const NEED_DONE_CLASS = "need-done";
/** On a row the priority filter hides: not `hidden`, which "View all" owns. */
export const NEED_FILTERED_CLASS = "need-off";
/** The bar over the rows: who answers, and the priority filter. */
export const NEEDS_HEAD_CLASS = "needs-head";
const PRIORITY_ATTR = "data-priority";

export interface NeedsHooks {
  /** The signed-in login: only OPERATOR's answers count, so only he gets the forms. */
  login?: string | undefined;
  now: number;
  render: Renderer;
  /** The label on a row's entry (answered, review requested, ...). */
  labelOf: (e: Entry) => RowLabel | undefined;
  /** Post the answer to a row's question; resolves to the comment's URL. */
  send(need: Need, answer: Answer): Promise<string>;
  /** Why GitHub hasn't said whose token this is, when `login` is not confirmed. */
  loginError?: string | undefined;
  /** Ask GitHub again whose token this is. */
  checkLogin?(): void;
  /** The priority the rows are filtered by (ALL_PRIORITIES unless given). */
  priority?: string | undefined;
  /** He picked a priority to filter by. */
  pickPriority?(priority: string): void;
}

/**
 * What the rows show, so an unchanged list is not redrawn under his hands.
 * It holds a row's ask time, not its age label: the page's ticker moves the
 * label in place, and a label in here would redraw (or, under a draft, claim
 * a change) every minute.
 */
export function needsSignature(needs: readonly Need[], hooks: Pick<NeedsHooks, "login" | "loginError" | "labelOf">, entries: readonly Entry[] = []): string {
  return JSON.stringify([
    [hooks.login, hooks.loginError],
    needs.map((n) => [n.key, n.action, n.title, n.priority, n.why, n.href, n.where, n.done === true, n.parent?.key, n.decision?.item.nodeId, n.decision?.item.body, n.entry?.item?.body, n.entry ? hooks.labelOf(n.entry)?.text : undefined, n.since]),
    entries.flatMap((e) => [e, ...(e.children ?? [])]).map((e) => [e.key, e.title, e.where, e.href, e.verdict?.state, e.wait?.onBot, e.wait?.reasons, rowText(e), hooks.labelOf(e)]),
  ]);
}

/** An answer form's snapshot, without its DOM nodes. */
export interface NeedsForm {
  sent: boolean;
  text: string;
  picked: boolean;
}

export const NEEDS_CHANGED_NOTE = "What waits on you changed; press r to reload it (unsent picks and notes are lost).";

/** Decide whether to redraw, keeping half-written answers and unrelated notices. */
export function needsRedraw(input: {
  signature: string;
  previousSignature: string | undefined;
  forms: readonly NeedsForm[];
  note: string | undefined;
  force: boolean;
}): { action: "skip" | "defer" | "redraw"; note: string | undefined } {
  if (!input.force && input.signature === input.previousSignature) return { action: "skip", note: input.note };
  const draft = input.forms.some((f) => !f.sent && (f.text.trim() !== "" || f.picked));
  if (!input.force && draft) return { action: "defer", note: NEEDS_CHANGED_NOTE };
  return { action: "redraw", note: input.note === NEEDS_CHANGED_NOTE ? undefined : input.note };
}

/** The element id of a need's row. */
export const needId = (n: Need): string => `need-${n.key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;

function unblocks(urls: readonly string[]): HTMLElement {
  return h("details", { class: "unblocks" }, h("summary", {}, `Unblocks ${urls.length}`), h("ul", {}, ...urls.map((u) => h("li", {}, link(u, shortRef(u))))));
}

/** Whether rows offer the answer form: to OPERATOR, and to a token GitHub hasn't named yet (it may be his). */
const mayAnswer = (hooks: Pick<NeedsHooks, "login">): boolean => hooks.login === undefined || hooks.login === OPERATOR;

/**
 * Who answers, said once over the rows instead of in each: nothing for
 * OPERATOR; for a token GitHub hasn't named, that answers go out as its
 * owner, with the reason and a way to ask again.
 */
function whoNote(needs: readonly Need[], hooks: NeedsHooks): HTMLElement | null {
  if (hooks.login === OPERATOR || !needs.some((n) => n.inPlace && !n.done)) return null;
  if (hooks.login !== undefined) return h("p", { class: "note who" }, `Only ${OPERATOR} answers; you are signed in as ${hooks.login}.`);
  const note = h("p", { class: "note who" }, `GitHub hasn't confirmed whose token this is${hooks.loginError ? ` (${hooks.loginError})` : ""}. An answer is posted as the token's owner, and the bot acts only on answers from ${OPERATOR}. `);
  if (hooks.checkLogin) {
    const again = h("button", { type: "button", class: "small" }, "Check again");
    again.addEventListener("click", () => hooks.checkLogin?.());
    note.append(again);
  }
  return note;
}

const chipLabel = (priority: string): string => (priority === ALL_PRIORITIES ? "All" : priority === NO_PRIORITY ? "None" : priority);

/** A row's place in the list as built, so rows moved in and out of Watching keep their order. */
export const NEED_ORDER_ATTR = "data-order";
/** The fold under the rows: rows past the limit, then the entries only being watched. */
export const WATCHING_CLASS = "watching";
export const WATCHING_ITEM_CLASS = "watching-item";

/**
 * Show only the rows at `priority` under `root`, and mark its chip. Done
 * on the rows as drawn, so that picking a filter never takes a half
 * written answer away.
 *
 * The filter comes before the limit: the first `limit` rows at `priority`
 * go in the list and only the rest of them in the Watching fold, so a chip
 * never counts rows the list doesn't show. Rows are moved, not redrawn
 * (a moved node keeps what is typed in it). Rows the filter hides stay in
 * the list, out of sight.
 */
export function applyPriority(root: HTMLElement, priority: string, limit = Infinity): void {
  const rows = [...root.querySelectorAll<HTMLElement>(`.${NEED_CLASS}`)].map((row, i) => ({ row, i, order: Number(row.getAttribute(NEED_ORDER_ATTR) ?? i) })).sort((a, b) => a.order - b.order || a.i - b.i).map((r) => r.row);
  const watching = root.querySelector<HTMLDetailsElement>(`:scope > details.${WATCHING_CLASS}`);
  const main: HTMLElement[] = [];
  const overflow: HTMLElement[] = [];
  let shown = 0;
  for (const row of rows) {
    const on = priority === ALL_PRIORITIES || row.getAttribute(PRIORITY_ATTR) === priority;
    row.classList.toggle(NEED_FILTERED_CLASS, !on);
    if (on) shown++;
    (on && shown > limit && watching ? overflow : main).push(row);
  }
  const head = root.querySelector(`:scope > .${NEEDS_HEAD_CLASS}`);
  if (head) head.after(...main);
  else root.prepend(...main);
  if (watching) {
    const summary = watching.querySelector(":scope > summary");
    summary?.after(...overflow);
    const count = overflow.length + watching.querySelectorAll(`.${WATCHING_ITEM_CLASS}`).length;
    if (summary) summary.textContent = `Watching (${count})`;
    watching.hidden = count === 0;
  }
  for (const chip of root.querySelectorAll<HTMLElement>(`.${NEEDS_HEAD_CLASS} button[${PRIORITY_ATTR}]`)) {
    const on = chip.getAttribute(PRIORITY_ATTR) === priority;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
  const none = root.querySelector<HTMLElement>(".needs-none");
  if (none) {
    none.hidden = shown > 0 || priority === ALL_PRIORITIES;
    none.textContent = none.hidden ? "" : `Nothing waits on you at ${chipLabel(priority)}.`;
  }
}

/**
 * The bar over the rows: who answers, and a chip per priority with how
 * many rows wait at it. `root` is what the chips filter (the rows' slot),
 * showing at most `limit` rows before Watching (applyPriority).
 */
export function needsHead(needs: readonly Need[], hooks: NeedsHooks, root: HTMLElement, limit = Infinity): HTMLElement {
  const selected = hooks.priority ?? ALL_PRIORITIES;
  const chips = h("div", { class: "needs-filter", role: "group", "aria-label": "Filter by priority" });
  for (const c of priorityChips(needs, selected)) {
    const label = chipLabel(c.priority);
    const chip = h(
      "button",
      { type: "button", class: "small", [PRIORITY_ATTR]: c.priority, "aria-pressed": "false", "aria-label": `${c.priority === ALL_PRIORITIES ? "All priorities" : c.priority === NO_PRIORITY ? NO_PRIORITY : `Priority ${label}`}: ${c.count} waiting` },
      label,
      " ",
      h("span", { class: "count" }, String(c.count)),
    );
    chip.addEventListener("click", () => {
      applyPriority(root, c.priority, limit);
      hooks.pickPriority?.(c.priority);
    });
    chips.append(chip);
  }
  return h("div", { class: NEEDS_HEAD_CLASS }, whoNote(needs, hooks), needs.length ? chips : null, h("p", { class: "note needs-none", hidden: "" }));
}

/** The form for a question that is answered in its row, or why there is none. */
function answerPart(n: Need, hooks: NeedsHooks): Node | null {
  const item = n.decision?.item ?? n.entry?.item;
  if (!item?.ref) return h("p", { class: "warn" }, "This question has no issue to answer on.");
  // Said once, over the rows (whoNote).
  if (!mayAnswer(hooks)) return null;
  const question = n.decision?.question ?? questionOf(item);
  return answerForm(item.ref, question, false, (a) => hooks.send(n, a), `n${item.ref.number}-`, NOTE_ROWS);
}

/**
 * A row's headline and the smaller line under it. A question leads with
 * what it asks (its `Q:` line, else the Why the bot wrote as "Q: ..."),
 * with the issue's title under it; anything else leads with its title.
 */
function headline(n: Need, asked: string | undefined, fallback: string | undefined): { lead: string; under?: string } {
  const why = n.why?.trim();
  if (n.action === "answer") {
    const lead = asked ?? (why && WHY_ASK_RE.test(why) ? why.replace(WHY_ASK_RE, "") : undefined);
    if (lead && lead !== n.title) return { lead: excerpt(lead, ASK_EXCERPT), under: n.title };
  }
  const under = why || fallback;
  return under && under !== n.title ? { lead: n.title, under: excerpt(under, ASK_EXCERPT) } : { lead: n.title };
}

export function needRow(n: Need, hooks: NeedsHooks): HTMLElement {
  const e = n.entry;
  const item = n.decision?.item ?? e?.item;
  const label = e ? hooks.labelOf(e) : undefined;
  const question = n.action === "answer" ? (n.decision?.question ?? (item ? questionOf(item) : undefined)) : undefined;
  const { lead, under } = headline(n, question?.ask, e ? rowText(e) : item ? askText(item) : undefined);
  const since = n.since;
  const form = n.inPlace && !n.done ? answerPart(n, hooks) : null;
  // One small line: priority, where it is (a link to GitHub, where it can also be answered), and how long it has waited.
  // A PR row is about the PR: its board item only tracks it, so the PR is
  // the location and the item, when it is a separate issue, a second link.
  const pr = e?.pr;
  const tracks = pr && item?.url && item.url.toLowerCase() !== pr.url.toLowerCase() ? item.url : undefined;
  const whereUrl = pr ? pr.url : item?.url;
  const where = pr ? n.where : item?.url ? shortRef(item.url) : n.where;
  const sub = h(
    "span",
    { class: "sub" },
    pill(n.priority),
    // The form is the action; without one, the action is a link to where it is done.
    form?.nodeName === "FORM" ? null : h("a", { class: `action a-${n.action}`, href: n.href, title: ACTION_TITLE[n.action] }, ACTION_LABEL[n.action]),
    n.decision ? h("span", { class: "dec-id", title: "a decision" }, decisionLabel(n.decision)) : null,
    h(
      "span",
      { class: "tag" },
      link(whereUrl, where),
      tracks ? " · tracks " : null,
      tracks ? link(tracks, shortRef(tracks)) : null,
      // The board's Org, unless it is the PR's owner, already in its reference.
      [pr && item?.org?.toLowerCase() === pr.ref.owner.toLowerCase() ? undefined : item?.org, n.parent ? `for ${excerpt(n.parent.title, 48)}` : undefined].filter(Boolean).map((t) => ` · ${t}`).join(""),
      " · ",
      h("span", { class: "age", title: since ? sinceTitle(e, since, "asked") : "ask date not available", ...(since ? { [SINCE_ATTR]: since } : {}) }, age(since, hooks.now) || "age unknown"),
    ),
    n.done ? h("span", { class: "state answered" }, STATE_LABEL.answered) : label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
  );
  const main = h("div", { class: "main" }, h("span", { class: "title" }, h("a", { href: n.href }, lead)));
  if (under) main.append(h("span", { class: "why", title: under }, under));
  main.append(sub);
  const blocked = item ? blockedBy(item) ?? item.parent : undefined;
  if (question && blocked) main.append(h("p", { class: "note blocks" }, "Blocks: ", link(`https://github.com/${blocked.owner}/${blocked.repo}/issues/${blocked.number}`, n.parent?.title ?? shortRef(`https://github.com/${blocked.owner}/${blocked.repo}/issues/${blocked.number}`))));
  if (question?.recommendation) main.append(h("p", { class: "note" }, `Recommended: ${question.recommendation}`));
  if (question?.optionsProblem) {
    main.append(h("p", { class: "warn" }, `Not every option can be offered: ${question.optionsProblem}. Read the question below, and answer in your own words if one is missing.`));
  }
  if (form) main.append(form);
  if (n.decision?.unblocks.length) main.append(unblocks(n.decision.unblocks));
  if (question && item?.body.trim()) main.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole question"), h("div", { class: "md" }, hooks.render(item.body))));
  const kind = e?.kind ?? "question";
  const row = h(
    "article",
    {
      class: `${ROW_CLASS} ${NEED_CLASS} k-${kind}${n.done ? ` ${NEED_DONE_CLASS}` : ""}${matchesPriority(n, hooks.priority ?? ALL_PRIORITIES) ? "" : ` ${NEED_FILTERED_CLASS}`}`,
      id: needId(n),
      // Focusable, so moving on after an answer can land on it.
      tabindex: "-1",
      [ROW_KEY_ATTR]: n.key,
      [ROW_HREF_ATTR]: n.href,
      [ROW_SECTION_ATTR]: "needs",
      [PRIORITY_ATTR]: needPriority(n),
    },
    h("span", { class: `kind k-${kind}`, title: KIND_TITLE[kind] }, KIND_LABEL[kind]),
    main,
  );
  return row;
}
