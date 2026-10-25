import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { GitHub } from "./api.ts";
import { dispatchFailed, EVENTS, loadDraftIssues, readPr, refText, sendDraft, startDraft, type DraftIssue, type Excerpt, type ReviewDraftConfig } from "./reviewdrafts.ts";

/**
 * The open review drafts, each as its review will look, with Send; and
 * Draft review for a PR. Reads only while open: opening it reads the draft
 * issues again, and nothing polls.
 */
export function reviewDraftsPanel(gh: GitHub, c: ReviewDraftConfig, render: Renderer): HTMLDetailsElement {
  const list = h("div");
  const status = h("p", { role: "status" });
  const input = h("input", { type: "text", placeholder: "OWNER/REPO#N or PR URL", "aria-label": "Pull request to draft a review of" });
  const start = h("button", { type: "submit" }, "Draft review");
  const started = h("p", { role: "status" });
  const form = h("form", { class: "review-draft-start" }, input, start, started);
  const panel = h("details", { class: "review-drafts sec" }, h("summary", {}, "Review drafts"),
    h("p", { class: "note" }, `Open ${c.label} issues in ${c.tracker}. Send ticks the issue's send box as you; the tracker's workflow posts the review.`),
    form, status, list);
  let loading = false;
  const load = (): void => {
    if (loading) return;
    loading = true; status.textContent = "Reading drafts…";
    void loadDraftIssues(gh, c).then(async (issues) => {
      list.replaceChildren(...await Promise.all(issues.map((d) => draftCard(gh, c, render, d))));
      status.textContent = issues.length ? "" : "No open review drafts.";
    }).catch((e: unknown) => { status.textContent = String(e); }).finally(() => { loading = false; });
  };
  panel.addEventListener("toggle", () => { if (panel.open) load(); });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (start.disabled || !input.value.trim()) return;
    start.disabled = true; started.textContent = "Starting…";
    void startDraft(gh, c, input.value).then((s) => {
      const what = s.retried ? "Retried on the existing draft issue" : "Created the draft issue";
      started.replaceChildren(s.dispatchError ? `${what}, but the drafting run did not start (${s.dispatchError}); Draft review again retries it: `
        : s.retried ? `${what}: ` : "Drafting: ", link(s.issue, s.issue));
      input.value = "";
      load();
    }).catch((e: unknown) => { started.textContent = String(e); }).finally(() => { start.disabled = false; });
  });
  return panel;
}

function excerptView(e: Excerpt): HTMLElement {
  return h("pre", { class: "review-draft-hunk" }, ...e.rows.map((r, i) =>
    h("div", { class: `${r.kind}${i === e.at ? " at" : ""}` }, `${String(r.new ?? "").padStart(5)} ${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`)));
}

async function draftCard(gh: GitHub, c: ReviewDraftConfig, render: Renderer, d: DraftIssue): Promise<HTMLElement> {
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
    void sendDraft(gh, c, d).then(() => { status.textContent = "Ticked: the tracker's workflow sends it."; })
      .catch((e: unknown) => { status.textContent = String(e); send.disabled = false; });
  });
  card.append(send, status);
  return card;
}
