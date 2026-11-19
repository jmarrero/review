// The service's runs, bot PRs and waiting items, read-only. These thin sections
// lack check runs, DCO, verdicts and write authority: no controls here, and
// they don't replace the token-backed PR queue or Needs you.
import { h, link } from "../dom.ts";
import { onlyRepository, sectionClock, sectionTrusted, type ServicePr, type ServiceRun, type ServiceSection, type ServiceState, type ServiceWaiting } from "./service.ts";

const ALL = "";

/** A healthy empty list needs a complete, current, error-free read on a live stream. */
function block<T extends { repository: string }>(title: string, s: ServiceSection<T> | undefined, sectionError: string | undefined, streamError: string | undefined, repository: string | undefined, now: number, row: (item: T) => HTMLElement): HTMLElement {
  if (!s) return h("section", {}, h("h3", {}, title), h("p", { class: "warn", role: "status" }, `${[streamError, sectionError].filter(Boolean).join("; ") || "Not yet read"}; coverage is unknown.`));
  const items = (repository ? onlyRepository(s, repository) : s).items;
  const el = h("section", {}, h("h3", {}, `${title} `, h("span", { class: "count" }, String(items.length))),
    h("p", { class: "note" }, `Read: ${s.readAt ?? "never"} · ${sectionClock(s.readAt, now)} · ${s.complete ? "Complete" : "Incomplete"}`));
  if (s.error !== null) el.append(h("p", { class: "warn", role: "status" }, `Source error: ${s.error}`));
  if (streamError) el.append(h("p", { class: "warn" }, "From the last generation received before the stream failed; may no longer be current."));
  if (items.length) el.append(h("ul", {}, ...items.map(row)));
  else el.append(h("p", {}, sectionTrusted(s, now) && !streamError ? "No items reported." : "No items available; coverage is unknown."));
  return el;
}

const runRow = (r: ServiceRun) => h("li", {}, link(r.url, `${r.repository} · ${r.workflow}`), h("p", {}, `${r.title} · ${r.status} · Started ${r.startedAt ?? `unknown (created ${r.createdAt})`}`));

const prRow = (p: ServicePr) => h("li", {}, link(p.url, `${p.repository}#${p.number} — ${p.title}`),
  h("p", {}, `${p.draft ? "Draft" : "Ready"} · Merge state: ${p.mergeState ?? "unknown"} · Updated ${p.updatedAt}`));

const waitingRow = (w: ServiceWaiting) => h("li", {}, link(w.url, `${w.repository}#${w.number} — ${w.title}`),
  h("p", {}, `${w.pullRequest ? "PR" : "Issue"} · ${w.reasons.join(", ")} · Updated ${w.updatedAt}`));

/** Repositories named by any listed item, case-insensitively, keeping the first spelling. */
export function serviceRepositories(state: ServiceState | undefined): string[] {
  const seen = new Map<string, string>();
  for (const item of [...state?.runs?.items ?? [], ...state?.prs?.items ?? [], ...state?.waiting?.items ?? []]) {
    if (!seen.has(item.repository.toLowerCase())) seen.set(item.repository.toLowerCase(), item.repository);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Filtering is client-side over the one full-state generation, never another request. */
export function serviceBoardView(state: ServiceState | undefined, now: number, streamError: string | undefined, repository: string | undefined, choose: (repository: string | undefined) => void): HTMLElement {
  const names = serviceRepositories(state);
  // Keep a chosen repository selectable after its items leave the state.
  if (repository && !names.some((n) => n.toLowerCase() === repository.toLowerCase())) names.push(repository);
  const select = h("select", { "aria-label": "Repository" }, h("option", { value: ALL }, "All repositories"),
    ...names.map((n) => h("option", { value: n }, n)));
  select.value = repository ?? ALL;
  select.onchange = () => choose(select.value === ALL ? undefined : select.value);
  const el = h("section", { class: "service-board", "aria-label": "Service board", "data-service-generation": state ? String(state.generation) : "unknown" },
    h("h2", {}, "Service board"),
    h("p", { class: "note" }, `Generation ${state?.generation ?? "unknown"} · read-only; not the PR queue or Needs you.`));
  if (streamError) el.append(h("p", { class: "warn", role: "status" }, `Incomplete: ${streamError}`));
  el.append(h("label", {}, "Repository ", select));
  if (repository) el.append(h("p", { class: "note" }, `Showing ${repository} only. Each section's read time, completeness and error still describe the whole section, so this repository's items may be missing when it is incomplete.`));
  el.append(
    block("Service runs", state?.runs, state?.runsError, streamError, repository, now, runRow),
    block("Bot PRs", state?.prs, state?.prsError, streamError, repository, now, prRow),
    block("Waiting on you", state?.waiting, state?.waitingError, streamError, repository, now, waitingRow));
  return el;
}
