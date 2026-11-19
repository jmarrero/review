import { h } from "../dom.ts";
import { serviceProblem, type ServiceDecision } from "./service.ts";

/** A preview is not a pass receipt. Do not manufacture history/readiness from it. */
export function serviceDecisionView(d: ServiceDecision | undefined, now: number, error?: string): HTMLElement {
  const problem = error ?? (d ? serviceProblem(d, now) : "Service decision not yet available");
  return h("section", { class: "active-pass", "data-service-generation": d ? String(d.generation) : "unknown" },
    h("h2", {}, "Service decision preview"),
    h("p", { class: "note", role: "status" }, `Generation ${d?.generation ?? "unknown"} · ${problem ?? (d?.complete ? "complete" : "partial / incomplete")} · observed ${d?.holds.at ?? "unknown"}. Preview only; not an execution receipt.`),
    d ? h("div", {},
      h("p", {}, `Candidates: ${d.candidates ?? "unknown"} · WIP: ${d.holds.wip?.inFlight ?? "unknown"} / ${d.holds.wip?.limit ?? "unknown"} · ${d.holdsOmitted} holds omitted · ${d.poolsOmitted} pools omitted. Pass history and run observations are not supplied by this decision contract.`),
      h("ul", {}, ...d.pools.map((p) => h("li", {}, `${p.name}: ${p.evidence} · used ${p.used_percent ?? "unknown"}% / allowed ${p.allowed_percent ?? "unknown"}% · hold ${p.hold === null ? "unknown" : p.hold ? "yes" : "no"} · ${p.reason ?? "reason unknown"} · observed ${p.observed_at ?? "unknown"} · resets ${p.resets_at ?? "unknown"}`))),
      h("details", {}, h("summary", {}, `Pass holds (${d.holds.holds.length} listed)`), h("ul", {}, ...d.holds.holds.map((hold) => h("li", {}, hold.item ?? "Global", ` · ${hold.kind}: ${hold.reason}`))))) : null);
}
