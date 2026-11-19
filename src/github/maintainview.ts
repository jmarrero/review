import { h } from "../dom.ts";
import { approvalKey, type ApproveItem, type ApproveResult } from "./maintain.ts";
import { refText, type PrRef } from "./reviewdrafts.ts";
import { prRoute } from "./view.ts";

/** A PR as a link into the existing PR pane. */
const prLink = (pr: PrRef): HTMLElement => h("a", { href: prRoute(pr) }, refText(pr));

const APPROVED = " — Done at HEAD";

/**
 * On a card's part that must not be redrawn (inboxview's fillInbox): a
 * report he hasn't read, until r; and, set to KEEP_BUSY, writes still
 * going out, not even on r.
 */
export const KEEP_ATTR = "data-keep";
export const KEEP_BUSY = "busy";

/**
 * The digest's Approve as a group, on its Inbox card: `approve` sends the
 * picked ones (approveSelected), each reported on its own; nothing is
 * retried, and a PR approved is unticked and disabled. The report stays
 * until r: the pass lists the approved PRs until its next digest.
 */
export function approveGroup(items: readonly ApproveItem[], approve: (items: readonly ApproveItem[]) => Promise<ApproveResult[]>, writes = new Map<string, HTMLElement>()): HTMLElement {
  const keys = items.map((it) => approvalKey(it.pr, it.head));
  const blocked = (i: number) => items[i]!.approved || !!writes.get(keys[i]!)?.querySelector("[data-sent]");
  const boxes = items.map((it, i) => h("input", { type: "checkbox", ...(blocked(i) ? { disabled: "" } : { checked: "" }), "aria-label": `Approve ${refText(it.pr)}` }));
  const labels = items.map((it) => h("span", {}, it.approved ? APPROVED : ""));
  const button = h("button", { type: "button", class: "primary" }, "Approve selected");
  // A target may also have an ordinary card on this page: never move its live receipt.
  const receipt = (k: string) => {
    const el = writes.get(k);
    const status = el?.querySelector("[data-sent]");
    return status ? [h("li", { class: el!.className }, status.cloneNode(true))] : [];
  };
  const receipts = (except: readonly ApproveItem[] = []) => keys.flatMap((k, i) => except.includes(items[i]!) ? [] : receipt(k));
  const results = h("ul", { class: "maintain-results", role: "status" }, ...receipts());
  if (results.children.length) results.setAttribute(KEEP_ATTR, "");
  button.disabled = items.every((_, i) => blocked(i));
  button.addEventListener("click", () => {
    for (const [i, box] of boxes.entries()) if (blocked(i)) { box.disabled = true; box.checked = false; }
    const picked = items.filter((_, i) => !boxes[i]!.disabled && boxes[i]!.checked);
    if (!picked.length) { results.replaceChildren(...receipts()); button.disabled = items.every((_, i) => blocked(i)); return; }
    if (button.disabled || !picked.length || !window.confirm(`Approve as you, at the heads the digest assessed: ${picked.map((it) => refText(it.pr)).join(", ")}?`)) return;
    button.disabled = true;
    results.setAttribute(KEEP_ATTR, KEEP_BUSY);
    results.replaceChildren(...receipts(), h("li", {}, "Approving…"));
    void approve(picked).then((rs) => {
      results.setAttribute(KEEP_ATTR, "");
      const rows = rs.map((r) => {
        const i = items.findIndex((it) => it.pr === r.pr);
        const sent = ["approved", "already-approved", "uncertain"].includes(r.status);
        const row = h("li", { class: r.status, "data-approval-receipt": "" }, h("p", { role: "status", ...(sent ? { "data-sent": "" } : {}) }, r.status === "approved" ? `Approved ${refText(r.pr)}.` : `${r.status === "already-approved" || r.status === "skipped" ? "Skipped" : r.status === "uncertain" ? "Failed or uncertain" : "Not sent"}: ${r.note}.`));
        if (i >= 0 && sent) writes.set(keys[i]!, row);
        else if (i >= 0 && blocked(i)) row.append(...receipt(keys[i]!));
        return row;
      });
      results.replaceChildren(...receipts(picked), ...rows);
      for (const r of rs) {
        const i = items.findIndex((it) => it.pr === r.pr);
        if (i < 0 || !blocked(i)) continue;
        boxes[i]!.checked = false;
        boxes[i]!.disabled = true;
        labels[i]!.textContent = r.status === "uncertain" ? " — Uncertain; check GitHub, do not retry" : items[i]!.approved ? APPROVED : "";
      }
    }, (e: unknown) => {
      results.setAttribute(KEEP_ATTR, "");
      results.replaceChildren(h("li", { class: "failed" }, `Not sent: ${e instanceof Error ? e.message : String(e)}`));
    }).finally(() => { button.disabled = items.every((_, i) => blocked(i)); });
  });
  return h("div", { class: "maintain-sec" }, h("ul", {}, ...items.map((it, i) => h("li", {}, h("label", {}, boxes[i]!, " ", prLink(it.pr), ` ${it.reason}`, labels[i]!)))), button, results);
}
