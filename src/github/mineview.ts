// The "Make it mine" form on a forge PR's pane (see mine.ts): the title,
// description and commit messages as editable text, prefilled with the
// bot's as they are (Generated-by lines included, which he must remove),
// then a confirmation showing every change as a diff before anything is
// written. Untrusted text goes into form fields and text nodes only.

import { h, link } from "../dom.ts";
import { OPERATOR } from "./config.ts";
import {
  type Change,
  changes,
  DEFAULT_COMMITTER,
  editProblems,
  HUMAN_TEXT_LINE,
  type Identity,
  identityProblem,
  type MineEdit,
  mineRefusal,
  type MineResult,
  splitBody,
  touchesWorkflows,
  WORKFLOWS_DIR,
  workflowScopeProblem,
} from "./mine.ts";
import { lineDiffView } from "./diffview.ts";
import type { PrDetail } from "./prs.ts";
import { load, save } from "./store.ts";

/** Storage key (see store.ts) for the committer identity he last used. */
export const COMMITTER_KEY = "committer";
export const MINE_CLASS = "mine";

export interface MineHooks {
  /** The signed-in login, named on the push button. */
  login: string | undefined;
  /** The token's classic scopes, if GitHub reported them. */
  scopes(): string | undefined;
  /** What he hasn't seen of the PR, as the Approve confirmation says it ("" if nothing). */
  unseen(): string;
  save(edit: MineEdit, committer: Identity, choices: { promote: boolean; ownText: boolean }, progress: (step: string) => void): Promise<MineResult>;
}

const isIdentity = (v: unknown): v is Identity =>
  typeof v === "object" && v !== null && typeof (v as Identity).name === "string" && typeof (v as Identity).email === "string";

/**
 * Notes for the confirmation: what `/promote --human-text` approves when
 * he hasn't approved this head, another login, and what a token needs
 * for workflow changes.
 */
export function confirmNotes(d: PrDetail, login: string | undefined, promote: boolean, unseen: string): string[] {
  const out: string[] = [];
  if (promote && d.verdict.state !== "approved") {
    out.push(`You haven't approved ${d.head.slice(0, 10)}, and ${HUMAN_TEXT_LINE} approves what it becomes: promote opens the upstream PR from it.${unseen}`);
  }
  if (login && login !== OPERATOR) out.push(`You are signed in as ${login}: the push, edits and comment are recorded as ${login}'s, and promote honours only ${OPERATOR}'s.`);
  if (touchesWorkflows(d)) out.push(`This PR changes ${WORKFLOWS_DIR}: moving its branch needs a token with the workflow scope (Workflows: write for a fine-grained one).`);
  return out;
}

function diffBlock(c: Change): HTMLElement {
  const head = h("h4", {}, c.what);
  if (!c.changed) return h("div", { class: "mine-change" }, head, h("p", { class: "note" }, "unchanged"));
  if (c.before === c.after) return h("div", { class: "mine-change" }, head, h("p", { class: "note" }, "only whitespace changes (line endings, or blank lines at the end or before the bot-meta section)"));
  return h("div", { class: "mine-change" }, head, lineDiffView(c.before, c.after));
}

/** The form, or a note saying why this PR can't be taken over here. */
export function mineSection(d: PrDetail, hooks: MineHooks): HTMLElement {
  const det = h("details", { class: MINE_CLASS }, h("summary", {}, "Make it mine: rewrite the title, description and commit messages as yours"));
  const refusal = mineRefusal(d) ?? workflowScopeProblem(d, hooks.scopes());
  if (refusal) {
    det.append(h("p", { class: "note" }, `Not available: ${refusal}.`));
    return det;
  }
  const approved = d.verdict.state === "approved";
  det.append(
    h(
      "p",
      { class: "note" },
      "For upstreams whose policy is human-text, the text must be yours. The fields start as the bot's; nothing saves while one still has a Generated-by line. Saving uses your token: it rewrites every commit of ",
      h("code", {}, d.headRef ?? ""),
      " with your message and you as committer (same code, parents and author), moves the branch only if it is still at ",
      h("code", {}, d.head.slice(0, 10)),
      ", then sets the title and description. The bot-meta section is kept as is. Code edits aren't supported here.",
    ),
  );
  const title = h("input", { type: "text", class: "mine-title", "aria-label": "PR title" });
  title.value = d.title;
  const body = h("textarea", { class: "mine-body", rows: "10", "aria-label": "PR description" });
  body.value = splitBody(d.body).text;
  const messages = new Map<string, HTMLTextAreaElement>();
  const commitFields = d.commits.map((c) => {
    const ta = h("textarea", { class: "mine-msg", rows: String(Math.min(16, Math.max(4, c.message.split("\n").length + 1))), "aria-label": `Message of ${c.sha.slice(0, 10)}` });
    ta.value = c.message;
    messages.set(c.sha, ta);
    return h("label", { class: "mine-field" }, h("span", {}, "Commit ", h("code", {}, c.sha.slice(0, 10))), ta);
  });
  const name = h("input", { type: "text", class: "mine-name", "aria-label": "Committer name", autocomplete: "name" });
  const email = h("input", { type: "email", class: "mine-email", "aria-label": "Committer email", autocomplete: "email" });
  const stored = load(COMMITTER_KEY, undefined as Identity | undefined, (v): v is Identity | undefined => v === undefined || isIdentity(v));
  name.value = (stored ?? DEFAULT_COMMITTER).name;
  email.value = (stored ?? DEFAULT_COMMITTER).email;
  const promote = h("input", { type: "checkbox", id: "mine-promote" });
  // Checked by default only over his approval of this head.
  promote.checked = approved;
  const mine = h("input", { type: "checkbox", id: "mine-own" });
  const status = h("p", { class: "status", role: "status" });
  const reviewBtn = h("button", { type: "button", class: "primary" }, "Review changes…");
  const editing = h(
    "div",
    { class: "mine-edit" },
    h("label", { class: "mine-field" }, h("span", {}, "Title"), title),
    h("label", { class: "mine-field" }, h("span", {}, "Description"), body),
    ...commitFields,
    h("div", { class: "mine-who" }, h("label", {}, "Committer name ", name), h("label", {}, "email ", email)),
    h("label", { class: "check", for: "mine-own" }, mine, " This text is mine: I wrote or rewrote the title, description and every commit message"),
    h(
      "label",
      { class: "check", for: "mine-promote" },
      promote,
      ` Then comment ${HUMAN_TEXT_LINE}, so bot-pr promote opens the upstream PR with your text`,
      approved ? " (you approved this head)" : " (you haven't approved this head: that comment approves it)",
    ),
    h("div", { class: "actions" }, reviewBtn),
  );
  const confirm = h("div", { class: "mine-confirm", hidden: "" });
  det.append(editing, confirm, status);

  const current = (): MineEdit => ({
    title: title.value,
    body: body.value,
    messages: new Map([...messages].map(([sha, ta]) => [sha, ta.value])),
  });
  const committer = (): Identity => ({ name: name.value.trim(), email: email.value.trim() });
  const back = () => {
    confirm.hidden = true;
    confirm.replaceChildren();
    editing.hidden = false;
  };

  reviewBtn.addEventListener("click", () => {
    const edit = current();
    const problems = editProblems(d, edit, promote.checked);
    const idProblem = identityProblem(committer());
    if (idProblem) problems.push(idProblem);
    if (!mine.checked) problems.push("tick \"This text is mine\"");
    if (problems.length) {
      status.textContent = `Fix first: ${problems.join("; ")}.`;
      return;
    }
    status.textContent = "";
    const who = committer();
    const withPromote = promote.checked;
    const push = h("button", { type: "button", class: "primary" }, `Push as ${hooks.login ?? "you"}`);
    const cancel = h("button", { type: "button" }, "Back to editing");
    const notes = confirmNotes(d, hooks.login, withPromote, withPromote && !approved ? hooks.unseen() : "");
    confirm.replaceChildren(
      h("h3", {}, "Confirm"),
      h(
        "p",
        {},
        `Rewrites ${d.commits.length} commit${d.commits.length > 1 ? "s" : ""} with committer ${who.name} <${who.email}> and moves ${d.headRef ?? "the branch"} from ${d.head.slice(0, 10)}; the code stays the same.`,
        withPromote ? ` Then comments ${HUMAN_TEXT_LINE}.` : "",
      ),
      ...notes.map((n) => h("p", { class: "warn" }, n)),
      ...changes(d, edit).map(diffBlock),
      h("div", { class: "actions" }, push, cancel),
    );
    editing.hidden = true;
    confirm.hidden = false;
    cancel.addEventListener("click", back);
    push.addEventListener("click", () => {
      push.disabled = true;
      cancel.disabled = true;
      save(COMMITTER_KEY, who);
      hooks
        .save(edit, who, { promote: withPromote, ownText: mine.checked }, (s) => {
          status.textContent = `${s}…`;
        })
        .then((r) => {
          status.replaceChildren(`Saved: ${d.headRef ?? "the branch"} is now ${r.head.slice(0, 10)}.`);
          if (r.commentUrl) status.append(" ", link(r.commentUrl, `${HUMAN_TEXT_LINE} posted`), ".");
          status.append(" Reload (r) to see it.");
          confirm.replaceChildren();
        })
        .catch((e: unknown) => {
          status.textContent = `Stopped: ${e instanceof Error ? e.message : String(e)}`;
          push.disabled = false;
          cancel.disabled = false;
        });
    });
  });
  return det;
}
