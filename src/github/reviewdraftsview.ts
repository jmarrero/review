import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { GitHub } from "./api.ts";
import { asOperator } from "./backend.ts";
import { KEEP_ATTR, KEEP_BUSY } from "./maintainview.ts";
import { dispatchFailed, EVENTS, readPr, refText, sendDraft, startDraft, type DraftIssue, type Excerpt, type ReviewDraftConfig } from "./reviewdrafts.ts";

/** Draft review: create a PR's draft issue and start its drafting run, then `started` (to read the drafts again). */
export function draftReviewForm(gh: GitHub, c: ReviewDraftConfig, started: () => void): HTMLFormElement {
  const input = h("input", { type: "text", placeholder: "OWNER/REPO#N or PR URL", "aria-label": "Pull request to draft a review of" });
  const start = h("button", { type: "submit" }, "Draft review");
  const result = h("p", { role: "status" });
  const form = h("form", { class: "review-draft-start" }, input, start, result);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (start.disabled || !input.value.trim()) return;
    start.disabled = true; result.textContent = "Starting…";
    void startDraft(gh, c, input.value).then((s) => {
      const what = s.retried ? "Retried on the existing draft issue" : "Created the draft issue";
      result.replaceChildren(s.dispatchError ? `${what}, but the drafting run did not start (${s.dispatchError}); Draft review again retries it: `
        : s.retried ? `${what}: ` : "Drafting: ", link(s.issue, s.issue));
      input.value = "";
      started();
    }).catch((e: unknown) => { result.textContent = String(e); }).finally(() => { start.disabled = false; });
  });
  return form;
}

function excerptView(e: Excerpt): HTMLElement {
  return h("pre", { class: "review-draft-hunk" }, ...e.rows.map((r, i) =>
    h("div", { class: `${r.kind}${i === e.at ? " at" : ""}` }, `${String(r.new ?? "").padStart(5)} ${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`)));
}

/** A draft as its review will look, flagged where it can't be sent, with Send; the inbox's Send card shows it too. */
export async function draftCard(gh: GitHub, c: ReviewDraftConfig, render: Renderer, d: DraftIssue, changed?: (sent: boolean) => void): Promise<HTMLElement> {
  const card = h("section", { class: "review-draft" }, h("h3", {}, link(d.issue.html_url, d.issue.title)));
  const flags = h("ul", { class: "review-draft-flags" });
  const flag = (text: string) => flags.append(h("li", {}, text));
  card.append(flags);
  const draft = d.found?.draft;
  if (d.refused) flag(`Not read: ${d.refused}.`);
  else if (!d.found && dispatchFailed(d.issue.body)) flag("The drafting run did not start: Draft review on its PR again retries it.");
  else if (!d.found) flag("No draft yet: the drafting run has not posted one.");
  else if (!draft) flag(`The newest draft can't be read: ${d.found.error}.`);
  if (d.box === "ticked") flag("Send is ticked: waiting on the tracker's workflow.");
  else if (d.box === "missing") flag("The issue body has no send box.");
  let blocked = !draft || d.box !== "unticked";
  if (draft) {
    try {
      const pr = await readPr(gh, draft);
      card.append(h("p", {}, link(pr.url, `${refText(draft.pr)}: ${pr.title}`), ` · ${EVENTS[draft.event]} · `, link(d.found!.url, "draft")));
      if (pr.state !== "open") { flag(`The PR is ${pr.merged ? "merged" : "closed"}.`); blocked = true; }
      if (pr.head !== draft.head) { flag(`The PR head moved to ${pr.head.slice(0, 12)} since the draft (${draft.head.slice(0, 12)}): it needs a redraft.`); blocked = true; }
      card.append(h("div", { class: "review-draft-body md" }, draft.body ? render(draft.body, `${draft.pr.owner}/${draft.pr.repo}`) : h("p", { class: "note" }, "(no review body)")));
      for (const [i, cm] of draft.comments.entries()) {
        const at = pr.excerpts[i];
        // Lines are checked only at the draft's own head; after a move they name another diff.
        if (pr.head === draft.head && !at) { flag(`${cm.path}:${cm.line} is not on the PR's diff.`); blocked = true; }
        card.append(h("div", { class: "review-draft-comment" }, h("p", {}, h("code", {}, `${cm.path}:${cm.line}`)),
          at ? excerptView(at) : null, h("div", { class: "md" }, render(cm.body, `${draft.pr.owner}/${draft.pr.repo}`))));
      }
    } catch (e) { flag(`Can't read the PR: ${String(e)}`); blocked = true; }
  }
  const send = h("button", { type: "button" }, "Send");
  const status = h("p", { role: "status" });
  send.disabled = blocked;
  send.addEventListener("click", () => {
    if (send.disabled || !window.confirm(`Approve sending this review of ${draft ? refText(draft.pr) : "this PR"}?`)) return;
    send.disabled = true; status.textContent = "Ticking the send box…";
    card.dataset.sent = "sending";
    status.setAttribute(KEEP_ATTR, KEEP_BUSY);
    void asOperator(gh, () => sendDraft(gh, c, d)).then(() => { status.textContent = "Ticked: the tracker's workflow sends it."; changed?.(true); })
      .catch((e: unknown) => { status.textContent = `Not sent or uncertain: ${String(e)}. Check GitHub; do not retry here.`; changed?.(false); })
      .finally(() => status.removeAttribute(KEEP_ATTR));
  });
  card.append(send, status);
  return card;
}
