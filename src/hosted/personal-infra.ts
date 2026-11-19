// Private service data never enters the GitHub cache, exports or static bundle.
import { h, link } from "../dom.ts";

const MAX_ITEMS = 6000; // Ten namespaces, three lists of at most 200.
const MAX_TEXT = 4096;
const STALE_MS = 5 * 60_000;
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const text = (v: unknown): string => typeof v === "string" ? v.slice(0, MAX_TEXT) : "unknown";
const count = (v: unknown): string => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : "unknown";

function forgejo(item: RecordValue): HTMLElement {
  const title = `${text(item.repository)}#${count(item.number)} — ${text(item.title)}`;
  return h("li", {}, link(typeof item.url === "string" ? item.url.slice(0, MAX_TEXT) : undefined, title),
    h("p", {}, `${item.pullRequest === true ? "PR" : "Issue"}${item.draft === true ? " · Draft" : ""} · ${text(item.reason)} · Updated ${text(item.updatedAt)}`));
}

function kubernetes(item: RecordValue): HTMLElement {
  let detail: string;
  switch (item.kind) {
    case "Kustomization":
      detail = `Ready: ${item.ready === true ? "yes" : item.ready === false ? "no" : "unknown"} · Revision: ${text(item.appliedRevision)} · ${text(item.message)}`;
      break;
    case "Deployment":
      detail = `Ready ${count(item.readyReplicas)}/${count(item.replicas)} · Updated ${count(item.updatedReplicas)} · ${item.rollingOut === true ? "Rollout in progress" : item.rollingOut === false ? "Rollout complete" : "Rollout unknown"}`;
      break;
    case "Pod":
      detail = `${text(item.problem)} · ${text(item.phase)} · Restarts: ${count(item.restarts)} · ${text(item.reason)}`;
      break;
    default: detail = "Unsupported resource";
  }
  const row = h("li", {}, h("strong", {}, `${text(item.kind)} ${text(item.namespace)}/${text(item.name)}`), h("p", {}, detail));
  if (item.kind === "Deployment" && Array.isArray(item.images)) {
    for (const value of item.images.slice(0, 100)) {
      const image = record(value);
      row.append(h("p", {}, `${text(image.container)}: ${text(image.image)} · Tag: ${text(image.tag)}`));
    }
    if (item.images.length > 100) row.append(h("p", {}, "Additional images omitted"));
  }
  return row;
}

/** Bound DOM growth and render upstream prose only as text, never markup. */
export function personalInfra(state: unknown, now = Date.now()): HTMLElement | null {
  const data = record(state);
  if (data.forgejo === undefined && data.kubernetes === undefined) return null;
  const panel = h("section", { class: "personal-infra", "aria-label": "Personal infrastructure" }, h("h2", {}, "Personal infrastructure"));
  for (const [key, title, render] of [["forgejo", "Forgejo · Needs you", forgejo], ["kubernetes", "Kubernetes", kubernetes]] as const) {
    if (data[key] === undefined) continue;
    const section = record(data[key]);
    const items = Array.isArray(section.items) ? section.items : [];
    const readAt = typeof section.readAt === "string" ? Date.parse(section.readAt) : NaN;
    const current = Number.isFinite(readAt) && readAt <= now && now - readAt <= STALE_MS;
    const complete = section.complete === true && Array.isArray(section.items) && items.length <= MAX_ITEMS;
    const block = h("section", {}, h("h3", {}, title), h("p", {},
      `Read: ${text(section.readAt)} · ${!Number.isFinite(readAt) ? "Unavailable" : readAt > now ? "Future clock" : !current ? "Stale" : "Current"} · ${complete ? "Complete" : "Incomplete"}`));
    if (section.error != null) block.append(h("p", { role: "status" }, `Source error: ${text(section.error)}`));
    if (!items.length) block.append(h("p", {}, complete && current && section.error == null ? "No items reported." : "No items available; coverage is unknown."));
    block.append(h("ul", {}, ...items.slice(0, MAX_ITEMS).map((item) => render(record(item)))));
    if (items.length > MAX_ITEMS) block.append(h("p", {}, "Additional items omitted"));
    panel.append(block);
  }
  return panel;
}
