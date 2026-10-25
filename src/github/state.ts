// The serializable page snapshot: no DOM, credentials, Maps or view hooks.
import { activeAgents, type Active } from "./agents.ts";
import { loadAnswered, loadDecisions, loadProjectStatus, loadQueue } from "./backend.ts";
import type { GitHub } from "./api.ts";
import { readSource, type Sources } from "./freshness.ts";
import { buildNeeds } from "./needs.ts";
import { loadActive } from "./ops.ts";
import { buildEntries, type Entry } from "./queue.ts";
import { loadForgePrs, loadOtherPrs, loadWaiting, refreshVerdicts, searchBotPrs } from "./prs.ts";
import { loadActionRuns, runTotals, type RunsData } from "./runs.ts";
import { parseDecision, sortDecisions, type Decision } from "./triage.ts";

export interface StateInput {
  active?: Active | undefined;
  entries?: readonly Entry[];
  decisions?: readonly Decision[] | undefined;
  decisionsAnswered?: Set<string>;
  answeredHere?: Set<string>;
  runs?: RunsData | undefined;
  sources?: Sources;
}

export function pageState(input: StateInput, now = Date.now()) {
  const active = input.active;
  const sources: Sources = Object.fromEntries(["board", "heartbeat", "usage", "status", "queue", "decisions", "forge", "otherPrs", "people", "runs"].map((name) => [name, { state: "pending" }]));
  Object.assign(sources, active?.sources, input.sources);
  if (input.runs && !input.sources?.runs) sources.runs = { state: input.runs.state, checkedAt: input.runs.at, ...(input.runs.state === "ok" ? { fetchedAt: input.runs.at } : { error: input.runs.warnings.join(" ") }) };
  for (const [name, source] of Object.entries(sources)) sources[name] = { ...source };
  if (active?.local && sources.heartbeat) sources.heartbeat = { ...sources.heartbeat, publishedAt: active.local.updatedAt };
  if (active?.usage?.state === "ok" && sources.usage) sources.usage = { ...sources.usage, publishedAt: active.usage.usage.updatedAt };
  if (active?.status && sources.status) sources.status = { ...sources.status, publishedAt: active.status.createdAt };
  if (active?.fromCache) for (const name of Object.keys(active.sources ?? {})) {
    const source = sources[name];
    if (source?.state === "ok") source.state = "cached";
  }
  if (active?.local === null && sources.heartbeat && sources.heartbeat.state !== "unavailable") sources.heartbeat = { ...sources.heartbeat, state: "unavailable", error: "No heartbeat published" };
  if (active?.usage?.state !== undefined && active.usage.state !== "ok" && sources.usage && sources.usage.state !== "unavailable") sources.usage = { ...sources.usage, state: "unavailable", error: active.usage.state === "unreadable" ? "Usage repository inaccessible" : "No usage published" };
  const people = buildNeeds({ entries: input.entries ?? [], decisions: input.decisions, decisionsAnswered: input.decisionsAnswered ?? new Set(), answeredHere: input.answeredHere ?? new Set(), board: active?.board });
  const staleRuns = sources.runs?.state === "unavailable" && input.runs?.state === "ok";
  const totals = input.runs ? runTotals(input.runs, staleRuns ? Math.min(now, input.runs.at) : now) : undefined;
  if (staleRuns && totals) {
    totals.partial = true;
    totals.tokensPartial = true;
    totals.costPartial = true;
    sources.runs = { ...sources.runs!, fetchedAt: input.runs!.at };
  }
  return {
    schema: "review-state/v1", generatedAt: new Date(now).toISOString(),
    status: active?.status ?? null,
    people, decisions: input.decisions ?? [],
    agents: activeAgents(active?.board ?? [], active?.local, now, undefined, { runs: input.runs, sources }),
    focus: active?.board ?? [],
    runs: input.runs && totals ? { ...input.runs, totals } : null,
    usage: active?.usage ?? null,
    sources,
  };
}

export type PageState = ReturnType<typeof pageState>;

/** The CLI uses the same loaders and derivations as the page, tolerating partial access. */
export async function loadPageState(gh: GitHub, now = Date.now()): Promise<PageState> {
  const sources: Sources = {};
  // One search of the bot's PRs serves both lists; each source reports its failure.
  const botPrs = searchBotPrs(gh);
  botPrs.catch(() => {});
  const [active, status, queue, decisions, runs, forge, others] = await Promise.all([
    loadActive(gh, now),
    readSource(sources, "status", () => loadProjectStatus(gh)),
    readSource(sources, "queue", async () => { const q = await loadQueue(gh); return { ...q, answered: await loadAnswered(gh, q.items) }; }),
    readSource(sources, "decisions", async () => { const q = await loadDecisions(gh); return { decisions: sortDecisions(q.items.map(parseDecision)), answered: await loadAnswered(gh, q.items) }; }),
    loadActionRuns(gh, now),
    readSource(sources, "forge", async () => { const prs = await loadForgePrs(gh, await botPrs); return { prs, verdicts: await refreshVerdicts(gh, prs, new Map()) }; }),
    readSource(sources, "otherPrs", async () => loadWaiting(gh, await loadOtherPrs(gh, await botPrs))),
  ]);
  if (status !== undefined) active.status = status;
  sources.runs = { state: runs.state, checkedAt: runs.at, ...(runs.state === "ok" ? { fetchedAt: runs.at } : { error: runs.warnings.join(" ") }) };
  if (others?.errors.length) sources.otherPrs = { ...sources.otherPrs, state: "unavailable", error: others.errors.join(" ") };
  const verdicts = new Map([...forge?.verdicts ?? []].map(([key, value]) => [key, value.verdict]));
  const entries = buildEntries(queue?.items ?? [], forge?.prs ?? [], verdicts, forge !== undefined, queue?.answered ?? new Set(), { others: others?.prs ?? [], linked: queue?.linked ?? [] });
  return pageState({ active, entries, decisions: decisions?.decisions, decisionsAnswered: decisions?.answered ?? new Set(), runs, sources }, now);
}
