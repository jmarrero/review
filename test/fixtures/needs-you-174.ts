// Synthetic producer contract: operator-path approval survives a cap of 12
// other rows. No live publication or operatorPaths policy is inferred by the app.
//
// `grouped` is the #251 screen: 174 decisions, ranked by the producer with the
// operator-path approval last; 60 listed (the rest past the cap), the others
// sharing one row per three decisions, detail published for that approval and
// one group only, and an approval placeholder among them.
export type Variant = "full" | "capped" | "grouped";

const GROUP = 3;
const LISTED = 58;

export function needsYou174(variant: Variant = "full") {
  const at = "2026-10-30T12:00:00Z";
  const epic = "jmarrero-forge/tracker#976";
  const inactive = "jmarrero-forge/tracker#900";
  const grouped = variant === "grouped";
  const items = Array.from({ length: 174 }, (_, i) => {
    const approve = i === 173 || (grouped && i === LISTED);
    const number = i === 173 ? 1367 : 2000 + i;
    const item = `jmarrero-forge/tracker#${number}`;
    const head = approve ? "a".repeat(40) : null;
    const action = { type: approve ? "approve_pull_request" : "issue", repository: "jmarrero-forge/tracker", number, ...(head ? { head } : {}) };
    const detailKey = grouped && !approve ? `jmarrero-forge/tracker#${2000 + i - (i % GROUP)}` : item;
    return { key: item, item, detail_key: detailKey, source: approve ? "reviews" : "items", kind: approve ? "review-approve" : "needs-human", priority: approve ? "P2" : "P1",
      waiting_since: at, ask: i === 173 ? "Approve the operator-path PR to release 21 stale holds" : `Choose the next step for item ${number}`,
      recommendation: null, target: `https://github.com/jmarrero-forge/tracker/${approve ? "pull" : "issues"}/${number}`, head,
      action, source_ref: { ...action, type: approve ? "pull_request" : "hold" }, epic: approve ? inactive : epic, topEpic: approve ? inactive : epic };
  });
  const listed = variant === "capped" ? [...items.slice(0, 12), items[173]!] : grouped ? [...items.slice(0, LISTED + 1), items[173]!] : items;
  // Grouped: only the approval and the first group's detail fit.
  const details = grouped ? [items[0]!, items[173]!] : listed;
  return { schema: "agent-board/needs-you/v2", complete: variant === "full", validated_at: at, changed_at: at,
    sources: { epics: "complete", items: "complete", reviews: "complete" }, summaries: "complete", omitted: 174 - listed.length,
    count: 174, counts: { decisions: 174, groups: grouped ? 58 : 0, members: 174 }, details_omitted: listed.length - listed.filter((a) => details.some((d) => d.key === a.detail_key)).length,
    items: details, identities: listed.map((a) => ({ item: a.item, detail_key: a.detail_key, kind: a.kind, source: a.source, waiting_since: at, priority: a.priority, epic: a.epic, topEpic: a.topEpic })),
    epics: { [epic]: { active: true, activeWhy: ["focus"], complete: true }, [inactive]: { active: false, activeWhy: [], complete: true } } };
}
