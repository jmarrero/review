import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import shared from "./fixtures/operator-actions.json" with { type: "json" };
import vendor from "../docs/operator-actions.vendor.json" with { type: "json" };
import schema from "../docs/operator-actions.schema.json" with { type: "json" };
import { GitHub } from "../src/github/api.ts";
import { ACTION_CONFIG, actionBlocks, actionConfig, checkRulesetSource, comments, execute, loadOffer, marker, normalizeRuleset, plan, proposals, rulesetDigest, RULESET_SOURCE_LIMIT, validateProposal, type Action, type Comment, type Offered, type Proposal } from "../src/github/actions.ts";
import { KEYWORDS, matchesActionSchema } from "../src/github/actionschema.ts";
import { proposalCard } from "../src/github/actionsview.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const project = "https://github.com/orgs/example/projects/1";
const c = { operator: "operator", planner: "planner", tracker: "example/tracker", repositories: ["example/tasks", "example/tracker"], project, org: "example" };
const stamp = "2026-10-14T12:00:00Z";
const base = { repo: "example/tasks", number: 1 };
const head = "a".repeat(40);
const envelope = { schema: "agent-board/operator-action/v1", title: "Tidy up", why: "Superseded." };

it("allows forge merge proposals in the shipped config, not arbitrary repositories", () => {
  const config = ACTION_CONFIG;
  assert.ok(config);
  const merge = { ...envelope, actions: [{ type: "merge_pull_request", repo: "jmarrero-forge/actions", number: 44, head_sha: head, method: "squash" }] };
  assert.ok(validateProposal(merge, config));
  assert.throws(() => validateProposal({ ...merge, actions: [{ ...merge.actions[0], repo: "jmarrero/unlisted" }] }, config), /not allowed/);
});
const close: Action = { ...base, type: "close_issue", reason: "Superseded" };
const variable = (expected: string | null, selected = true, value = "new\nvalue"): Action => ({ type: "set_org_variable", org: "example", name: "REVIEW_WORKFLOW", value, expected_current: expected,
  ...(selected ? { visibility: "selected" as const, repositories: ["example/tasks", "Example/Tracker"] } : { visibility: "all" as const }) });
const ruleset = (expected: string | null): Action => ({ type: "apply_org_ruleset", org: "example", source: { repo: "example/tasks", path: "rulesets/review.json", sha: head }, ruleset_name: "Required review", expected_current_sha256: expected });
// The fixture's live ruleset (id 42), and its writable body as a reviewed source file holds it.
const live = shared.ruleset_digests[0]!.ruleset as Record<string, any>;
const liveDigest = shared.ruleset_digests[0]!.sha256;
const body = JSON.parse(normalizeRuleset(live));
const { bypass_actors: _, ...created } = body;

function offer(actions: Action[] = [close]): Offered {
  const p = { ...envelope, actions } as Proposal;
  const comment: Comment = { id: "IC_proposal", databaseId: 10, body: `\`\`\`agent-board-action\n${JSON.stringify(p)}\n\`\`\``, updatedAt: stamp, author: { login: c.planner }, editor: null, lastEditedAt: null };
  return { issue: 9, comment, proposal: p };
}

// A small stateful GitHub: writes change what later reads return, so
// sequential actions on one target see each other's effects.
function mock(o = offer()) {
  const all = [o.comment];
  const calls: { method: string; path: string; body: any }[] = [];
  const issues = new Map<string, Record<string, any>>();
  const issue = (path: string): Record<string, any> => {
    if (!issues.has(path)) issues.set(path, { id: 101, url: `https://api.github.com${path}`, node_id: "I_target", title: "<script>target</script>", state: "open", labels: [], parent_issue_url: null });
    return issues.get(path)!;
  };
  const pr: Record<string, any> = { title: "<script>target</script>", state: "open", merged: false, draft: false, head: { sha: head } };
  const field = { value: "P2" as string | null, more: false, project: "PVT_1", item: "item", id: "field", options: [{ id: "option", name: "P1" }] };
  // Org state: one variable, the org's rulesets, the source file's text (or a whole contents response), the compare status.
  const org = { variable: null as { value: string; visibility: string; repositories: string[] } | null, variableStatus: undefined as number | undefined, rulesets: [] as Record<string, any>[], source: JSON.stringify(created), file: undefined as Record<string, unknown> | undefined, status: "behind", moved: {} as Record<string, string> };
  const ids: Record<string, number> = { "example/tasks": 7, "example/tracker": 8 };
  let viewer = c.operator;
  let failPath = "";
  let more = false;
  let closed = false;
  let intercept: (() => void) | undefined;
  const reservationReceipt = { value: { id: 20 } as unknown, visible: true };
  const reasonReceipt = { value: { id: 30, issue_url: "https://api.github.com/repos/example/tasks/issues/1", body: "Superseded" } as unknown };
  const mergeReceipt = { value: { merged: true } as unknown };
  const stateReceipt = { value: undefined as unknown };
  const labelReceipt = { value: undefined as unknown };
  const subIssueReceipt = { value: undefined as unknown };
  const rulesetReceipt = { value: undefined as unknown };
  const projectReceipt = { value: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item" } } } as unknown };
  const approvalReceipt = { value: { id: 31, state: "APPROVED", commit_id: head, pull_request_url: "https://api.github.com/repos/example/tasks/pulls/1" } as unknown };
  const gh = new GitHub(async () => "viewer-secret", async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer viewer-secret");
    const path = url.replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path, body }); intercept?.();
    if (path === failPath) return Response.json({ message: "denied\n/promote" }, { status: 403 });
    if (path === "/user") return Response.json({ login: viewer });
    if (path === "/graphql") {
      if (body.query.includes("comments(first")) return Response.json({ data: { repository: { issue: { state: closed ? "CLOSED" : "OPEN", comments: { nodes: all, pageInfo: { hasNextPage: more } } } } } });
      if (body.query.includes("updateProject")) { field.value = field.options.find((o) => o.id === body.variables.option)!.name; return Response.json({ data: projectReceipt.value }); }
      return Response.json({ data: { node: { projectItems: { nodes: [{ id: field.item, project: { id: field.project, url: project, field: { id: field.id, options: field.options } }, fieldValueByName: field.value === null ? null : { name: field.value } }], pageInfo: { hasNextPage: field.more } } } } });
    }
    const variable = /^\/orgs\/example\/actions\/variables(\/\w+)?(\/repositories\?per_page=100)?$/.exec(path);
    if (variable) {
      if (method === "GET") return org.variable ? Response.json(variable[2] ? { total_count: org.variable.repositories.length, repositories: org.variable.repositories.map((full_name) => ({ full_name })) } : org.variable) : Response.json({ message: "Not Found" }, { status: 404 });
      org.variable = { value: body.value, visibility: body.visibility, repositories: (body.selected_repository_ids ?? []).map((id: number) => Object.keys(ids).find((k) => ids[k] === id)) };
      return new Response(null, { status: org.variableStatus ?? (method === "POST" ? 201 : 204) });
    }
    const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
    if (repo) return Response.json({ id: ids[repo[1]!.toLowerCase()], full_name: org.moved[repo[1]!] ?? repo[1]!.toLowerCase(), default_branch: "main" });
    if (path.includes("/contents/")) return Response.json(org.file ?? { type: "file", encoding: "base64", size: Buffer.byteLength(org.source), content: Buffer.from(org.source).toString("base64") });
    if (path.includes("/compare/")) return Response.json({ status: org.status });
    const rs = /^\/orgs\/example\/rulesets(?:\/(\d+))?(\?.*)?$/.exec(path);
    if (rs) {
      if (method === "GET") return Response.json(rs[1] ? org.rulesets.find((r) => r.id === Number(rs[1])) : org.rulesets.map(({ id, name }) => ({ id, name })));
      if (method === "POST") org.rulesets.push({ ...body, id: 43 });
      // GitHub keeps the fields an update omits.
      else org.rulesets = org.rulesets.map((r) => r.id === Number(rs[1]) ? { ...r, ...body } : r);
      return Response.json(rulesetReceipt.value === undefined ? { ...org.rulesets.find((r) => r.id === Number(rs[1] ?? 43)), source: "example", source_type: "Organization" } : rulesetReceipt.value);
    }
    if (path.includes("?state=open")) return Response.json([{ number: 9 }]);
    if (method === "POST" && path === `/repos/${c.tracker}/issues/9/comments`) {
      if (reservationReceipt.visible) all.push({ id: "IC_receipt", databaseId: 20, body: body.body, updatedAt: stamp, author: { login: c.operator }, editor: null, lastEditedAt: null });
      return Response.json(reservationReceipt.value);
    }
    if (method === "GET" && /\/pulls\/\d+$/.test(path)) return Response.json(pr);
    if (method === "PUT" && path.endsWith("/merge")) { pr.merged = true; return Response.json(mergeReceipt.value); }
    if (method === "POST" && path.endsWith("/reviews")) return Response.json(approvalReceipt.value);
    const m = /^(\/repos\/[^/]+\/[^/]+\/issues\/\d+)(.*)$/.exec(path);
    if (m && !m[1]!.startsWith(`/repos/${c.tracker}/issues/9`)) {
      const i = issue(m[1]!);
      if (method === "POST" && m[2] === "/comments") return Response.json(reasonReceipt.value);
      if (method === "PATCH" && !m[2]) { i.state = body.state; return Response.json(stateReceipt.value === undefined ? i : stateReceipt.value); }
      if (method === "POST" && m[2] === "/labels") i.labels.push({ name: body.labels[0] });
      if (method === "DELETE" && m[2]!.startsWith("/labels/")) i.labels = i.labels.filter((l: { name: string }) => l.name !== decodeURIComponent(m[2]!.slice(8)));
      if (m[2]!.startsWith("/labels") && method !== "GET") return Response.json(labelReceipt.value === undefined ? i.labels : labelReceipt.value);
      if (method === "POST" && m[2] === "/sub_issues") {
        const child = issue(`/repos/example/tasks/issues/1`);
        child.parent_issue_url = `https://api.github.com${m[1]}`;
        return Response.json(subIssueReceipt.value === undefined ? child : subIssueReceipt.value);
      }
      return Response.json(method === "GET" ? i : {});
    }
    return Response.json({});
  });
  return { gh, all, calls, issue, pr, field, org, reservationReceipt, reasonReceipt, mergeReceipt, stateReceipt, labelReceipt, subIssueReceipt, rulesetReceipt, projectReceipt, approvalReceipt, setViewer: (v: string) => { viewer = v; }, fail: (v: string) => { failPath = v; }, more: () => { more = true; }, close: () => { closed = true; }, intercept: (v: () => void) => { intercept = v; } };
}

const writes = (m: ReturnType<typeof mock>) => m.calls.filter((v) => v.method !== "GET" && !(v.path === "/graphql" && !v.body.query.includes("mutation")));
const targetWrites = (m: ReturnType<typeof mock>) => writes(m).filter((v) => !v.path.startsWith(`/repos/${c.tracker}/issues/9`) && !v.path.startsWith(`/repos/${c.tracker}/issues/comments`));

async function run(actions: Action[], setup: (m: ReturnType<typeof mock>) => void = () => {}) {
  const o = offer(actions); const m = mock(o); setup(m);
  const shown = await plan(m.gh, c, actions);
  await execute(m.gh, c, o, shown.expected, () => {});
  return { m, shown };
}

it("stops variable batches on unexpected successful acknowledgments without replaying", async () => {
  for (const existing of [false, true]) {
    for (const status of [200, 202, 203, 205, 206, existing ? 201 : 204]) {
      const actions = [variable(existing ? "old" : null), close];
      const o = offer(actions); const m = mock(o);
      if (existing) m.org.variable = { value: "old", visibility: "all", repositories: [] };
      m.org.variableStatus = status;
      const shown = await plan(m.gh, c, actions);
      const progress: string[] = [];
      await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /not confirmed.*check GitHub/);
      assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
      assert.equal(targetWrites(m).length, 1);
      assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
      const count = writes(m).length;
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
      assert.equal(writes(m).length, count);
    }
  }
});

it("continues variable batches after the documented create and update acknowledgments", async () => {
  for (const existing of [false, true]) {
    const { m } = await run([variable(existing ? "old" : null), close], (m) => {
      if (existing) m.org.variable = { value: "old", visibility: "all", repositories: [] };
    });
    assert.equal(targetWrites(m).length, 3);
    assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
    assert.equal(m.calls.filter((v) => v.method === "GET" && v.path === "/orgs/example/actions/variables/REVIEW_WORKFLOW").length, 3);
  }
});

it("vendors agent-board's schema and fixtures unmodified at the pinned commit", () => {
  // Git blob IDs at the pinned commit; `gh api repos/cgwalters-forge/agent-board/contents/SOURCE?ref=COMMIT --jq .sha` prints them.
  assert.match(vendor.commit, /^[0-9a-f]{40}$/);
  for (const f of vendor.files) {
    const bytes = readFileSync(new URL(`../${f.path}`, import.meta.url));
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(blob, f.blob, `${f.path} differs from ${vendor.repository}@${vendor.commit}:${f.source}`);
  }
});

it("uses only the JSON Schema keywords the validator implements", () => {
  const walk = (rule: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(rule)) {
      assert.ok(KEYWORDS.includes(k), `unsupported keyword ${k}`);
      if (k === "properties" || k === "$defs") Object.values(v as Record<string, Record<string, unknown>>).forEach(walk);
      else if (k === "oneOf" || k === "allOf") (v as Record<string, unknown>[]).forEach(walk);
      else if (k === "items") walk(v as Record<string, unknown>);
    }
  };
  walk(schema);
});

it("gives agent-board's verdict on every shared fixture case", async () => {
  const cfg = { operator: shared.config.writers[0]!, planner: shared.config.writers[1]!, tracker: "example/work", repositories: shared.config.repositories, project: shared.valid.actions[4]!.project!, org: shared.config.org };
  // A case category this test does not know would otherwise be skipped silently after a vendor update.
  assert.deepEqual(Object.keys(shared).sort(), ["config", "invalid_actions", "ruleset_digests", "scope_rejections", "valid", "valid_actions"]);
  for (const v of shared.ruleset_digests) assert.equal(await rulesetDigest(v.ruleset), v.sha256, normalizeRuleset(v.ruleset));
  const one = (a: unknown) => ({ ...shared.valid, actions: [a] });
  assert.ok(matchesActionSchema(shared.valid));
  assert.deepEqual(validateProposal(shared.valid, cfg), shared.valid);
  // Review writes only to its one configured project, so each case configures the project it names.
  for (const a of shared.valid_actions) { assert.ok(matchesActionSchema(one(a)), JSON.stringify(a)); validateProposal(one(a), { ...cfg, project: "project" in a ? a.project : "" }); }
  for (const a of shared.invalid_actions) { assert.equal(matchesActionSchema(one(a)), false, JSON.stringify(a)); assert.throws(() => validateProposal(one(a), cfg)); }
  // Repository scope is configuration, not schema.
  for (const a of shared.scope_rejections) { assert.ok(matchesActionSchema(one(a))); assert.throws(() => validateProposal(one(a), cfg), /not allowed/); }
});

it("is enabled only for the operator, within the forge and this app, and requires repository-owned writer, target and project configuration", () => {
  assert.equal(ACTION_CONFIG?.operator, "jmarrero");
  assert.ok(ACTION_CONFIG?.repositories.length && ACTION_CONFIG.repositories.every(r => r.startsWith("jmarrero-forge/") || r === "jmarrero/review"));
  assert.deepEqual(actionConfig(c), c);
  assert.equal(ACTION_CONFIG?.org, "jmarrero-forge");
  assert.deepEqual(actionConfig({ ...c, project: "" }), { ...c, project: "" });
  assert.deepEqual(actionConfig({ ...c, org: "" }), { ...c, org: "" });
  assert.equal(actionConfig({ operator: "", planner: "", tracker: "", repositories: [], project: "", org: "" }), undefined);
  for (const value of [{ ...c, org: undefined }, { ...c, org: "example/tasks" }, { ...c, org: "-example" }, { ...c, operator: "" }, { ...c, operator: undefined }, { ...c, planner: undefined }, { ...c, tracker: undefined }, { ...c, repositories: ["../tasks"] }, { ...c, tracker: "https://evil" }, { ...c, project: "PVT_example" }, { ...c, project: `${project}\n` }]) assert.throws(() => actionConfig(value));
});

it("refuses actions outside configured scope and labels or reasons the API would misread", () => {
  for (const a of [
    { ...base, type: "close_issue", reason: "\n/promote" },
    { ...base, type: "remove_label", label: "." }, { ...base, type: "remove_label", label: ".." }, { ...base, type: "add_label", label: "." },
    { ...base, type: "set_project_field", project: "https://github.com/orgs/other/projects/1", field: "Status", value: "Done" },
    { ...base, type: "add_sub_issue", parent_repo: "example/tasks", parent_number: 1 },
    { ...base, type: "move_sub_issue", parent_repo: "example/tasks", parent_number: 2, previous_parent_repo: "outside/tasks", previous_parent_number: 3 },
    { ...base, type: "approve_pull_request", head_sha: head, updatedAt: stamp },
  ]) assert.throws(() => validateProposal({ ...envelope, actions: [a] }, c), JSON.stringify(a));
  for (const p of [null, { ...envelope, actions: [close], extra: true }, { ...envelope, title: "two\nlines", actions: [close] }, { ...envelope, title: "line\n", actions: [close] },
    { ...envelope, actions: [] }, { ...envelope, actions: Array(51).fill(close) }]) assert.throws(() => validateProposal(p, c));
  validateProposal({ ...envelope, actions: Array(50).fill(close) }, c);
  assert.throws(() => validateProposal({ ...envelope, actions: [{ ...base, type: "set_project_field", project, field: "Status", value: "Done" }] }, { ...c, project: "" }), /Project/);
});

it("refuses org actions outside the configured org, and variable values over GitHub's byte limit", () => {
  const p = (a: Action) => ({ ...envelope, actions: [a] });
  assert.throws(() => validateProposal(p(variable(null)), { ...c, org: "" }), /not allowed/);
  assert.throws(() => validateProposal(p(ruleset(null)), { ...c, org: "" }), /not allowed/);
  validateProposal(p({ ...variable(null), org: "Example" } as Action), { ...c, org: "EXAMPLE" });
  // The schema counts characters; GitHub's 48 KB counts UTF-8 bytes.
  for (const [text, ok] of [["x".repeat(49152), true], ["é".repeat(24576), true], ["é".repeat(24577), false], ["😀".repeat(12288), true], ["😀".repeat(12289), false]] as const) {
    for (const a of [variable(null, false, text), variable(text, false)]) {
      if (ok) validateProposal(p(a), c); else assert.throws(() => validateProposal(p(a), c), /49152 UTF-8 bytes/);
    }
  }
});

it("checks a ruleset source file as agent-board does", () => {
  const admin = body.bypass_actors[0];
  const team = { actor_id: 7, actor_type: "Team", bypass_mode: "always" };
  const text = (change: Record<string, unknown>, drop?: string) => JSON.stringify(Object.fromEntries(Object.entries({ ...body, ...change }).filter(([k]) => k !== drop)));
  for (const [source, current, ok] of [
    [text({}), live, true], [text({ enforcement: "evaluate" }), live, true], [text({ target: "push" }), live, true],
    [text({ bypass_actors: [] }), undefined, true], [text({}, "bypass_actors"), undefined, true], [text({ bypass_actors: [] }), live, true],
    [text({}, "conditions"), live, false], [text({}, "bypass_actors"), live, false],
    [text({}), undefined, false], [text({ bypass_actors: [admin, admin] }), live, false], [text({ bypass_actors: [admin, team] }), live, false],
    [text({ bypass_actors: [{ ...admin, bypass_mode: "pull_request" }] }), live, false], [text({ bypass_actors: {} }), live, false],
    [text({ enforcement: "disabled" }), live, false], [text({ target: "repository" }), live, false], [text({ name: "Other" }), live, false], [text({ name: null }), live, false],
    [text({ id: 42 }), live, false], [text({ rules: [{ type: 1 }] }), live, false], [text({ rules: [{ type: "deletion", parameters: { n: 1.5 } }] }), live, false], [text({ conditions: [] }), live, false],
    [text({}, "rules"), live, false], ["[]", live, false], ["{", live, false], [`${" ".repeat(RULESET_SOURCE_LIMIT)}${text({})}`, live, false],
  ] as [string, unknown, boolean][]) {
    if (ok) assert.equal(checkRulesetSource(source, "Required review", current), normalizeRuleset(JSON.parse(source)), source);
    else assert.throws(() => checkRulesetSource(source, "Required review", current), source.slice(0, 200));
  }
  // serde_json cannot hold a lone surrogate, in a value or a key.
  for (const r of [{ ...body, rules: [{ type: "deletion\ud800" }] }, { ...body, conditions: { "\udc00": 1 } }]) assert.throws(() => checkRulesetSource(JSON.stringify(r), "Required review", live), /lone UTF-16 surrogate/);
});

it("creates or updates org variables and rulesets with IDs from live reads", async () => {
  const cases: { action: Action; setup?: (m: ReturnType<typeof mock>) => void; expected: { method: string; path: string; body: unknown } }[] = [
    { action: variable(null), expected: { method: "POST", path: "/orgs/example/actions/variables", body: { name: "REVIEW_WORKFLOW", value: "new\nvalue", visibility: "selected", selected_repository_ids: [7, 8] } } },
    { action: variable("old", false), setup: (m) => { m.org.variable = { value: "old", visibility: "selected", repositories: ["example/tasks"] }; },
      expected: { method: "PATCH", path: "/orgs/example/actions/variables/REVIEW_WORKFLOW", body: { name: "REVIEW_WORKFLOW", value: "new\nvalue", visibility: "all" } } },
    { action: ruleset(null), expected: { method: "POST", path: "/orgs/example/rulesets", body: created } },
    { action: ruleset(liveDigest), setup: (m) => { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify({ ...body, enforcement: "evaluate" }); },
      expected: { method: "PUT", path: "/orgs/example/rulesets/42", body: { ...body, enforcement: "evaluate" } } },
  ];
  for (const { action, setup, expected } of cases) {
    validateProposal({ ...envelope, actions: [action] }, c);
    const { m } = await run([action], setup);
    assert.deepEqual(targetWrites(m), [expected]);
    // The source is pinned and must be on the default branch.
    if (action.type === "apply_org_ruleset") assert.ok(m.calls.some((v) => v.path === `/repos/example/tasks/contents/rulesets/review.json?ref=${head}`) && m.calls.some((v) => v.path === `/repos/example/tasks/compare/main...${head}?per_page=1`));
  }
  // Each org action is planned against live state only, never an earlier action's predicted result.
  for (const actions of [[variable(null), variable("new\nvalue", false, "newer")], [ruleset(null), close, ruleset(null)]]) {
    const m = mock(offer(actions));
    await assert.rejects(plan(m.gh, c, actions), new RegExp(`Action ${actions.length}: one action per organisation variable or ruleset per proposal`));
    assert.deepEqual(writes(m), []);
  }
});

it("requires ruleset receipts to confirm identity and the submitted writable fields", async () => {
  for (const update of [false, true]) {
    const setup = (m: ReturnType<typeof mock>) => {
      if (update) { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify(body); }
    };
    const action = ruleset(update ? liveDigest : null);
    const good = { ...(update ? body : created), id: update ? 42 : 43, source: "EXAMPLE", source_type: "Organization", created_at: stamp };
    for (const receipt of [null, {}, [], { ...good, id: 0 }, { ...good, id: 1.5 }, { ...good, id: "42" }, { ...good, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...good, source: "other" }, { ...good, source_type: "Repository" }, { ...good, name: "other" }, { ...good, enforcement: "disabled" },
      { ...good, target: "tag" }, { ...good, rules: [] }, { ...good, conditions: null }, ...(update ? [{ ...good, id: 43 }, { ...good, bypass_actors: [] }] : [])]) {
      const o = offer([action, close]); const m = mock(o); setup(m); m.rulesetReceipt.value = receipt;
      const shown = await plan(m.gh, c, o.proposal.actions);
      const progress: string[] = [];
      await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Ruleset update not confirmed/);
      assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
      assert.equal(targetWrites(m).length, 1);
      assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
      assert.equal(targetWrites(m).length, 1);
    }
    // Server metadata and defaults for omitted fields do not change the submitted body.
    await run([action, close], (m) => { setup(m); m.rulesetReceipt.value = { bypass_actors: [], ...good }; });
  }
});

it("refuses stale org state, naming the live ruleset digest", async () => {
  const changed = await rulesetDigest({ ...live, enforcement: "evaluate" });
  const cases: [Action, (m: ReturnType<typeof mock>) => void, RegExp][] = [
    [variable("older"), (m) => { m.org.variable = { value: "old", visibility: "all", repositories: [] }; }, /expected "older", found \{"value":"old"/],
    [variable(null), (m) => { m.org.variable = { value: "old", visibility: "all", repositories: [] }; }, /expected unset/],
    [variable("old"), () => {}, /expected "old", found null/],
    [ruleset(liveDigest), (m) => { m.org.rulesets = [{ ...structuredClone(live), enforcement: "evaluate" }]; m.org.source = JSON.stringify(body); }, new RegExp(`found "${changed}"`)],
    [ruleset(null), (m) => { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify(body); }, new RegExp(`expected no ruleset of that name, found "${liveDigest}"`)],
    [ruleset(liveDigest), () => {}, /found null/],
  ];
  for (const [action, setup, error] of cases) {
    const m = mock(offer([action])); setup(m);
    await assert.rejects(plan(m.gh, c, [action]), error);
    assert.deepEqual(writes(m), []);
  }
});

it("refuses unreviewed, invalid or ambiguous rulesets and tokens without admin:org", async () => {
  const update = (m: ReturnType<typeof mock>, source: unknown = body) => { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify(source); };
  const cases: [Action, (m: ReturnType<typeof mock>) => void, RegExp][] = [
    [ruleset(null), (m) => { m.org.status = "ahead"; }, /not on its default branch main/],
    [ruleset(null), (m) => { m.org.status = "diverged"; }, /not on its default branch/],
    [ruleset(null), (m) => { m.org.file = { type: "dir" }; }, /not a file/],
    [ruleset(null), (m) => { m.org.file = { type: "file", encoding: "base64", size: RULESET_SOURCE_LIMIT + 1, content: "e30=" }; }, /not a file/],
    [ruleset(null), (m) => { m.org.file = { type: "file", encoding: "base64", size: 3, content: "!!!" }; }, /base64/],
    [ruleset(null), (m) => { m.org.source = "{"; }, /not JSON/],
    [ruleset(liveDigest), (m) => update(m, { ...body, name: "Other" }), /name does not match/],
    [ruleset(liveDigest), (m) => update(m, { ...body, enforcement: "disabled" }), /enforcement/],
    [ruleset(liveDigest), (m) => update(m, { ...body, bypass_actors: [...body.bypass_actors, { actor_id: 7, actor_type: "Team", bypass_mode: "always" }] }), /adds bypass actor/],
    [ruleset(null), (m) => { m.org.source = JSON.stringify(body); }, /adds bypass actor/],
    [ruleset(liveDigest), (m) => { update(m); m.org.rulesets.push({ ...structuredClone(live), id: 43 }); }, /2 rulesets named/],
    [ruleset(null), (m) => { m.org.rulesets = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, name: `other ${i}` })); }, /more than 1000 rulesets/],
    [variable(null), (m) => { m.org.moved["example/tasks"] = "elsewhere/tasks"; }, /is now elsewhere\/tasks/],
    [ruleset(null), (m) => { m.org.moved["example/tasks"] = "elsewhere/tasks"; }, /is now elsewhere\/tasks/],
    [ruleset(liveDigest), (m) => update(m, created), /every field the live ruleset has \(GitHub keeps omitted fields\): bypass_actors/],
    [variable(null), (m) => { m.gh.scopes = "repo, read:org"; }, /needs admin:org/],
    [ruleset(null), (m) => { m.gh.scopes = "repo"; }, /needs admin:org/],
  ];
  for (const [action, setup, error] of cases) {
    const m = mock(offer([action])); setup(m);
    await assert.rejects(plan(m.gh, c, [action]), error);
    assert.deepEqual(writes(m), []);
  }
  const m = mock(); m.gh.scopes = "repo, admin:org";
  await plan(m.gh, c, [variable(null)]);
});

it("refuses to execute an org action whose visibility or ruleset changed after it was shown", async () => {
  for (const [action, setup, change] of [
    [variable("old"), (m) => { m.org.variable = { value: "old", visibility: "all", repositories: [] }; }, (m) => { m.org.variable!.visibility = "private"; }],
    [ruleset(liveDigest), (m) => { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify(body); }, (m) => { m.org.rulesets[0]!.enforcement = "evaluate"; }],
  ] as [Action, (m: ReturnType<typeof mock>) => void, (m: ReturnType<typeof mock>) => void][]) {
    const o = offer([action]); const m = mock(o); setup(m);
    const shown = await plan(m.gh, c, [action]);
    change(m);
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /Stale/);
    assert.deepEqual(writes(m), []);
  }
});

it("shows an org action's exact request, the variable's whole value and a normalised ruleset diff", async () => {
  const card = async (action: Action, setup: (m: ReturnType<typeof mock>) => void = () => {}) => {
    const o = offer([action]); const m = mock(o); setup(m);
    const el = await proposalCard(m.gh, c, o, () => false, () => {});
    assert.ok(!el.textContent?.includes("Refused"), el.textContent ?? "");
    return el;
  };
  const value = `${"x".repeat(5000)}\nend`;
  const v = await card(variable(null, true, value));
  assert.ok(v.textContent?.includes("Now: unset")); assert.ok(v.textContent?.includes("New, visibility selected: example/tasks, Example/Tracker:"));
  assert.ok([...v.querySelectorAll("pre")].some((p) => p.textContent === value));
  assert.ok([...v.querySelectorAll("pre")].some((p) => p.textContent!.startsWith("POST /orgs/example/actions/variables\n") && p.textContent!.includes('"selected_repository_ids": [\n    7,\n    8\n  ]')));
  assert.ok([...v.querySelectorAll("a")].some((a) => a.getAttribute("href") === "https://github.com/example"));
  const r = await card(ruleset(liveDigest), (m) => { m.org.rulesets = [structuredClone(live)]; m.org.source = JSON.stringify({ ...body, enforcement: "evaluate" }); });
  const lines = (kind: string) => [...r.querySelectorAll(`.line-diff .d-${kind}`)].map((s) => s.textContent);
  assert.deepEqual([lines("del"), lines("add")], [['-   "enforcement": "active",'], ['+   "enforcement": "evaluate",']]);
  assert.ok(lines("same").includes('    "name": "Required review",'));
  assert.ok(r.textContent?.includes("PUT /orgs/example/rulesets/42"));
  assert.ok([...r.querySelectorAll("a")].some((a) => a.getAttribute("href") === `https://github.com/example/tasks/blob/${head}/rulesets/review.json`));
  const fresh = await card(ruleset(null));
  assert.deepEqual([...fresh.querySelectorAll(".line-diff .d-del")].map((s) => s.textContent), ["- (none)"]);
});

it("accepts only named writers with trusted last editors and exactly one unquoted block", () => {
  const o = offer();
  assert.equal(proposals([o.comment], 9, c).length, 1);
  for (const comment of [{ ...o.comment, author: null }, { ...o.comment, author: { login: "visitor" } }, { ...o.comment, lastEditedAt: stamp, editor: null }, { ...o.comment, lastEditedAt: stamp, editor: { login: "visitor" } }, { ...o.comment, body: o.comment.body.split("\n").map((s) => `> ${s}`).join("\n") }]) assert.deepEqual(proposals([comment], 9, c), []);
  assert.equal(proposals([{ ...o.comment, lastEditedAt: stamp, editor: { login: c.operator } }], 9, c).length, 1);
  assert.throws(() => proposals([{ ...o.comment, body: `${o.comment.body}\n${o.comment.body}` }], 9, c));
  const receipt = { ...o.comment, databaseId: 20, body: `${marker(o)}\nDone`, author: { login: c.operator } };
  assert.deepEqual(proposals([o.comment, receipt], 9, c), []);
  assert.equal(proposals([o.comment, { ...receipt, author: { login: "visitor" } }], 9, c).length, 1);
  assert.equal(proposals([o.comment, { ...receipt, lastEditedAt: stamp, editor: null }], 9, c).length, 1);
});

it("finds fences as the comment regular expression does, in linear time", () => {
  const regex = (text: string) => [...text.matchAll(/^```agent-board-action\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)].map((m) => m[1]!);
  const open = "```agent-board-action\n";
  for (const text of ["", `${open}{}\n\`\`\``, `x\n${open}a\n\`\`\` \r\nb\n${open}\n\`\`\`\n${open}c`, `${open}\`\`\`\n\`\`\``, `a${open}b\n\`\`\``, `${open}a\r\`\`\`\r\n${open}b \`\`\``, `${open}${open}a\n\`\`\`x\n\`\`\``]) {
    assert.deepEqual(actionBlocks(text), regex(text), JSON.stringify(text));
  }
  // Unclosed openers in untrusted agent text: the regular expression takes seconds here.
  const start = performance.now();
  assert.deepEqual(actionBlocks(open.repeat(50_000)), []);
  assert.ok(performance.now() - start < 1_000);
});

it("reads the proposal a published ask names again, and refuses truncated or closed proposal issues", async () => {
  const m = mock();
  const ask = { repository: c.tracker, number: 9, comment: 10 };
  assert.equal((await loadOffer(m.gh, c, ask)).comment.id, "IC_proposal");
  assert.ok(m.calls.every((v) => !v.path.includes("labels=")), "no label index is read");
  await assert.rejects(loadOffer(m.gh, c, { ...ask, repository: "example/tasks" }), /from example\/tracker only/);
  await assert.rejects(loadOffer(m.gh, c, { ...ask, comment: 11 }), /no longer pending/);
  m.all.push({ ...offer().comment, id: "IC_receipt", databaseId: 20, body: `${marker(offer())}\nDone`, author: { login: c.operator } });
  await assert.rejects(loadOffer(m.gh, c, ask), /no longer pending/, "an executed proposal");
  m.more(); await assert.rejects(comments(m.gh, c, 9), /100 comments/);
  const closed = mock(); closed.close(); await assert.rejects(comments(closed.gh, c, 9), /closed/);
});

it("executes every action type as its exact typed mutation", async () => {
  const parent = "https://api.github.com/repos/example/tasks/issues/3";
  const cases: { action: Action; setup?: (m: ReturnType<typeof mock>) => void; expected: { method: string; path: string; body?: unknown } }[] = [
    { action: close, expected: { method: "PATCH", path: "/repos/example/tasks/issues/1", body: { state: "closed" } } },
    { action: { ...base, type: "reopen_issue" }, setup: (m) => { m.issue("/repos/example/tasks/issues/1").state = "closed"; }, expected: { method: "PATCH", path: "/repos/example/tasks/issues/1", body: { state: "open" } } },
    { action: { ...base, type: "add_label", label: "needs review" }, expected: { method: "POST", path: "/repos/example/tasks/issues/1/labels", body: { labels: ["needs review"] } } },
    { action: { ...base, type: "remove_label", label: "a/b" }, setup: (m) => { m.issue("/repos/example/tasks/issues/1").labels = [{ name: "a/b" }]; }, expected: { method: "DELETE", path: "/repos/example/tasks/issues/1/labels/a%2Fb" } },
    { action: { ...base, type: "approve_pull_request", head_sha: head }, expected: { method: "POST", path: "/repos/example/tasks/pulls/1/reviews", body: { event: "APPROVE", commit_id: head } } },
    { action: { ...base, type: "merge_pull_request", head_sha: head, method: "squash" }, expected: { method: "PUT", path: "/repos/example/tasks/pulls/1/merge", body: { sha: head, merge_method: "squash" } } },
    { action: { ...base, type: "add_sub_issue", parent_repo: "example/tasks", parent_number: 2 }, expected: { method: "POST", path: "/repos/example/tasks/issues/2/sub_issues", body: { sub_issue_id: 101, replace_parent: false } } },
    { action: { ...base, type: "move_sub_issue", parent_repo: "example/tasks", parent_number: 2, previous_parent_repo: "example/tasks", previous_parent_number: 3 }, setup: (m) => { m.issue("/repos/example/tasks/issues/1").parent_issue_url = parent; }, expected: { method: "POST", path: "/repos/example/tasks/issues/2/sub_issues", body: { sub_issue_id: 101, replace_parent: true } } },
    { action: { ...base, type: "set_project_field", project, field: "Priority", value: "P1" }, expected: { method: "POST", path: "/graphql" } },
  ];
  for (const { action, setup, expected } of cases) {
    validateProposal({ ...envelope, actions: [action] }, c);
    const { m, shown } = await run([action], setup);
    assert.match(shown.states[0]!, /target/);
    const done = targetWrites(m);
    const call = done.at(-1)!;
    assert.equal(call.method, expected.method); assert.equal(call.path, expected.path);
    // Fetch normalizes dot segments, so check the path that would actually be requested.
    assert.equal(new URL(new Request(`https://api.github.com${call.path}`).url).pathname, expected.path);
    if (expected.body) assert.deepEqual(call.body, expected.body);
    if (action.type === "set_project_field") assert.deepEqual(call.body.variables, { project: "PVT_1", item: "item", field: "field", option: "option" });
  }
});

it("stops unconfirmed project updates and never replays them", async () => {
  for (const payload of [null, {}, [], true, { projectV2Item: null }, { projectV2Item: {} },
    ...[null, 1, "", "other-item"].map((id) => ({ projectV2Item: { id } }))]) {
    const o = offer([{ ...base, type: "set_project_field", project, field: "Priority", value: "P1" }, close]);
    const m = mock(o); m.projectReceipt.value = { updateProjectV2ItemFieldValue: payload };
    const shown = await plan(m.gh, c, o.proposal.actions);
    const progress: string[] = [];
    await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Project update not confirmed/);
    assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
    assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]), [["POST", "/graphql"]]);
    assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
    const count = writes(m).length;
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
    assert.equal(writes(m).length, count);
  }
});

it("continues after a project update confirms the exact item", async () => {
  const { m } = await run([{ ...base, type: "set_project_field", project, field: "Priority", value: "P1" }, close]);
  assert.equal(m.field.value, "P1");
  assert.equal(m.issue("/repos/example/tasks/issues/1").state, "closed");
  assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
});

it("stops unconfirmed label changes without continuing or replaying the proposal", async () => {
  for (const type of ["add_label", "remove_label"] as const) {
    for (const receipt of [null, {}, true, "done", [null], [{}], [{ name: null }], [{ name: 1 }], [{ name: "" }],
      [{ name: "other" }, {}], type === "add_label" ? [] : [{ name: "DoNe" }],
      type === "add_label" ? [{ name: "other" }] : [{ name: "other" }, { name: "done" }]]) {
      const o = offer([{ ...base, type, label: "done" }, close]);
      const m = mock(o); m.labelReceipt.value = receipt;
      if (type === "remove_label") m.issue("/repos/example/tasks/issues/1").labels = [{ name: "done" }];
      const shown = await plan(m.gh, c, o.proposal.actions);
      const progress: string[] = [];
      await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Label change not confirmed/);
      assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
      assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]),
        [[type === "add_label" ? "POST" : "DELETE", `/repos/example/tasks/issues/1/labels${type === "add_label" ? "" : "/done"}`]]);
      assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
      const count = writes(m).length;
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
      assert.equal(writes(m).length, count);
    }
  }
});

it("continues after label receipts confirm membership case-insensitively", async () => {
  for (const type of ["add_label", "remove_label"] as const) {
    for (const other of [[], [{ name: "other" }]]) {
      const { m } = await run([{ ...base, type, label: "done" }, close], (m) => {
        if (type === "remove_label") m.issue("/repos/example/tasks/issues/1").labels = [{ name: "done" }];
        m.labelReceipt.value = type === "add_label" ? [...other, { name: "DoNe" }] : other;
      });
      assert.equal(targetWrites(m).length, 3);
      assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
    }
  }
});

it("stops proposal approvals without a matching approved review receipt and never replays them", async () => {
  const valid = { id: 31, state: "APPROVED", commit_id: head, pull_request_url: "https://api.github.com/repos/example/tasks/pulls/1" };
  for (const receipt of [null, {}, [], true, { ...valid, id: 0 }, { ...valid, id: "31" },
    { ...valid, id: 1.5 }, { ...valid, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, state: "PENDING" }, { ...valid, state: "COMMENTED" }, { ...valid, state: null },
    { ...valid, commit_id: "b".repeat(40) }, { ...valid, commit_id: null },
    { ...valid, pull_request_url: "https://api.github.com/repos/example/tasks/pulls/2" }, { ...valid, pull_request_url: null }]) {
    const o = offer([{ ...base, type: "approve_pull_request", head_sha: head }, { ...base, type: "add_label", label: "done" }]);
    const m = mock(o); m.approvalReceipt.value = receipt;
    const shown = await plan(m.gh, c, o.proposal.actions);
    const progress: string[] = [];
    await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Approval not confirmed/);
    assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
    assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]), [["POST", "/repos/example/tasks/pulls/1/reviews"]]);
    assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
    const count = writes(m).length;
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
    assert.equal(writes(m).length, count);
  }
});

it("continues the proposal after a confirmed approval", async () => {
  const { m } = await run([{ ...base, type: "approve_pull_request", head_sha: head }, { ...base, type: "add_label", label: "done" }]);
  assert.equal(targetWrites(m).length, 2);
  assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
});

it("stops proposal merges without an affirmative boolean receipt and never replays them", async () => {
  for (const receipt of [{ merged: "false" }, { merged: "true" }, { merged: 1 }, { merged: {} }, null, {}, [], true, { merged: false }]) {
    const o = offer([{ ...base, type: "merge_pull_request", head_sha: head, method: "squash" }, { ...base, type: "add_label", label: "done" }]);
    const m = mock(o); m.mergeReceipt.value = receipt;
    const shown = await plan(m.gh, c, o.proposal.actions);
    const progress: string[] = [];
    await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Merge not confirmed/);
    assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
    assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]), [["PUT", "/repos/example/tasks/pulls/1/merge"]]);
    assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
    const count = writes(m).length;
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
    assert.equal(writes(m).length, count);
  }
});

it("continues the proposal after a confirmed merge", async () => {
  const { m } = await run([{ ...base, type: "merge_pull_request", head_sha: head, method: "squash" }, { ...base, type: "add_label", label: "done" }]);
  assert.deepEqual(targetWrites(m).map(v => v.method), ["PUT", "POST"]);
  assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
});

it("does not close or continue a proposal without a confirmed reason comment", async () => {
  const valid = { id: 30, issue_url: "https://api.github.com/repos/example/tasks/issues/1", body: "Superseded" };
  for (const receipt of [null, {}, [], { ...valid, id: 0 }, { ...valid, id: "30" },
    { ...valid, id: 1.5 }, { ...valid, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, issue_url: "https://api.github.com/repos/example/tasks/issues/2" },
    { ...valid, issue_url: null }, { ...valid, body: "Different reason" }]) {
    const o = offer([close, { ...base, type: "add_label", label: "done" }]);
    const m = mock(o); m.reasonReceipt.value = receipt;
    const shown = await plan(m.gh, c, o.proposal.actions);
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /did not confirm the reason comment/);
    assert.equal(m.issue("/repos/example/tasks/issues/1").state, "open");
    assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]), [["POST", "/repos/example/tasks/issues/1/comments"]]);
    assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
    const count = writes(m).length;
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
    assert.equal(writes(m).length, count, "reservation prevents reposting the reason");
  }
});

it("stops unconfirmed issue state writes and never replays them", async () => {
  for (const action of [close, { ...base, type: "reopen_issue" } as Action]) {
    const state = action.type === "close_issue" ? "closed" : "open";
    const before = state === "closed" ? "open" : "closed";
    const path = "/repos/example/tasks/issues/1";
    const valid = { id: 101, url: `https://api.github.com${path}`, state };
    for (const receipt of [null, {}, [], true, { ...valid, state: before }, { ...valid, state: null },
      ...[null, "101", 0, 1.5, 102].map((id) => ({ ...valid, id })),
      ...[null, 42, "https://api.github.com/repos/example/tasks/issues/2", "https://api.github.com/repos/other/tasks/issues/1"].map((url) => ({ ...valid, url })),
      { ...valid, pull_request: {} }]) {
      const o = offer([action, { ...base, type: "add_label", label: "done" }]);
      const m = mock(o); m.issue(path).state = before; m.stateReceipt.value = receipt;
      const shown = await plan(m.gh, c, o.proposal.actions);
      const progress: string[] = [];
      await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Issue state update not confirmed/);
      assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
      assert.deepEqual(targetWrites(m).map(({ method, path }) => [method, path]), [
        ...(action.type === "close_issue" ? [["POST", `${path}/comments`]] : []), ["PATCH", path],
      ]);
      assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
      const count = writes(m).length;
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
      assert.equal(writes(m).length, count);
    }
  }
});

it("stops unconfirmed sub-issue writes and never replays them", async () => {
  const path = "/repos/example/tasks/issues/1";
  const parent = "https://api.github.com/repos/example/tracker/issues/2";
  const valid = { id: 101, url: `https://api.github.com${path}`, parent_issue_url: parent };
  for (const type of ["add_sub_issue", "move_sub_issue"] as const) {
    const action: Action = { ...base, type, parent_repo: "example/tracker", parent_number: 2,
      ...(type === "move_sub_issue" ? { previous_parent_repo: "example/tasks", previous_parent_number: 3 } : {}) } as Action;
    for (const receipt of [null, {}, [], true,
      ...[null, "101", 0, 1.5, 102].map((id) => ({ ...valid, id })),
      ...[null, 42, "https://api.github.com/repos/example/tasks/issues/2"].map((url) => ({ ...valid, url })),
      ...[undefined, null, 42, "https://api.github.com/repos/example/tasks/issues/2", "https://api.github.com/repos/example/tasks/issues/3"].map((parent_issue_url) => ({ ...valid, parent_issue_url })),
      { ...valid, pull_request: {} }]) {
      const o = offer([action, { ...base, type: "add_label", label: "done" }]);
      const m = mock(o); m.subIssueReceipt.value = receipt;
      if (type === "move_sub_issue") m.issue(path).parent_issue_url = "https://api.github.com/repos/example/tasks/issues/3";
      const shown = await plan(m.gh, c, o.proposal.actions);
      const progress: string[] = [];
      await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Sub-issue update not confirmed/);
      assert.deepEqual(progress, ["Failed or uncertain; stopped"]);
      assert.equal(targetWrites(m).length, 1);
      assert.deepEqual(targetWrites(m)[0], { method: "POST", path: "/repos/example/tracker/issues/2/sub_issues", body: { sub_issue_id: 101, replace_parent: type === "move_sub_issue" } });
      assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
      const count = writes(m).length;
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /execution record/);
      assert.equal(writes(m).length, count);
    }
  }
});

it("continues after confirmed cross-repository sub-issue acknowledgments", async () => {
  const { m } = await run([
    { ...base, type: "add_sub_issue", parent_repo: "example/tracker", parent_number: 2 },
    { ...base, type: "move_sub_issue", parent_repo: "example/tasks", parent_number: 3, previous_parent_repo: "example/tracker", previous_parent_number: 2 },
  ]);
  assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done/);
});

it("continues after confirmed close and reopen acknowledgments", async () => {
  const { m } = await run([close, { ...base, type: "reopen_issue" }, { ...base, type: "add_label", label: "done" }]);
  assert.equal(m.issue("/repos/example/tasks/issues/1").state, "open");
  assert.match(writes(m).at(-1)!.body.body, /1\. done\n2\. done\n3\. done/);
});

it("refuses replaced project targets before reservation and again before mutation", async () => {
  const action: Action = { ...base, type: "set_project_field", project, field: "Priority", value: "P1" };
  for (const change of [
    (m: ReturnType<typeof mock>) => { m.field.project = "replacement"; },
    (m: ReturnType<typeof mock>) => { m.field.item = "replacement"; },
    (m: ReturnType<typeof mock>) => { m.field.id = "replacement"; },
    (m: ReturnType<typeof mock>) => { m.field.options[0]!.id = "replacement"; },
  ]) for (const afterReservation of [false, true]) {
    const o = offer([action, close]); const m = mock(o);
    const shown = await plan(m.gh, c, o.proposal.actions);
    assert.equal(shown.states[0], '<script>target</script> · now "P2" → "P1"');
    if (afterReservation) m.intercept(() => {
      if (m.calls.at(-1)?.path === `/repos/${c.tracker}/issues/9/comments`) change(m);
    });
    else change(m);
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /Stale/);
    assert.deepEqual(targetWrites(m), []);
    if (afterReservation) assert.match(writes(m).at(-1)!.body.body, /1\. failed or uncertain/);
    else assert.deepEqual(writes(m), []);
  }
});

it("keeps sequential project changes and option reordering usable", async () => {
  const actions: Action[] = ["P1", "P2"].map((value) => ({ ...base, type: "set_project_field", project, field: "Priority", value }));
  const o = offer(actions); const m = mock(o);
  m.field.options.push({ id: "option2", name: "P2" });
  const shown = await plan(m.gh, c, actions);
  assert.equal(shown.states[1], '<script>target</script> · now "P1" after the earlier actions → "P2"');
  m.field.options.reverse();
  await execute(m.gh, c, o, shown.expected, () => {});
  assert.deepEqual(targetWrites(m).map((v) => v.body.variables.option), ["option", "option2"]);
  assert.equal(m.field.value, "P2");
});

it("plans actions on one target in order, each against the state the earlier ones leave", async () => {
  const actions: Action[] = [
    { ...base, type: "add_label", label: "ready" }, { ...base, type: "remove_label", label: "ready" },
    { ...base, type: "add_sub_issue", parent_repo: "example/tasks", parent_number: 3 },
    { ...base, type: "move_sub_issue", parent_repo: "example/tasks", parent_number: 4, previous_parent_repo: "example/tasks", previous_parent_number: 3 },
  ];
  const { m, shown } = await run(actions);
  assert.deepEqual(shown.expected, [false, true, null, "example/tasks#3"]);
  assert.equal(targetWrites(m).length, 4);
  // A repeated mutation is stale against the first one's effect.
  await assert.rejects(plan(mock().gh, c, [close, close]), /Action 2: Stale/);
});

it("refuses stale states, labels, heads, parents, fields and PR/issue confusion before mutation", async () => {
  const cases: { action: Action; setup: (m: ReturnType<typeof mock>) => void }[] = [
    { action: close, setup: (m) => { m.issue("/repos/example/tasks/issues/1").state = "closed"; } },
    { action: close, setup: (m) => { m.issue("/repos/example/tasks/issues/1").pull_request = {}; } },
    { action: { ...base, type: "add_label", label: "x" }, setup: (m) => { m.issue("/repos/example/tasks/issues/1").labels = [{ name: "X" }]; } },
    { action: { ...base, type: "remove_label", label: "x" }, setup: () => {} },
    { action: { ...base, type: "approve_pull_request", head_sha: head }, setup: (m) => { m.pr.head = { sha: "b".repeat(40) }; } },
    { action: { ...base, type: "merge_pull_request", head_sha: head, method: "merge" }, setup: (m) => { m.pr.draft = true; } },
    { action: { ...base, type: "merge_pull_request", head_sha: head, method: "merge" }, setup: (m) => { m.pr.merged = true; } },
    { action: { ...base, type: "add_sub_issue", parent_repo: "example/tasks", parent_number: 2 }, setup: (m) => { m.issue("/repos/example/tasks/issues/1").parent_issue_url = "https://api.github.com/repos/example/tasks/issues/3"; } },
    { action: { ...base, type: "move_sub_issue", parent_repo: "example/tasks", parent_number: 2, previous_parent_repo: "example/tasks", previous_parent_number: 3 }, setup: () => {} },
    { action: { ...base, type: "add_sub_issue", parent_repo: "example/tasks", parent_number: 2 }, setup: (m) => { m.issue("/repos/example/tasks/issues/2").pull_request = {}; } },
    { action: { ...base, type: "set_project_field", project, field: "Priority", value: "P0" }, setup: () => {} },
    { action: { ...base, type: "set_project_field", project, field: "Priority", value: "P1" }, setup: (m) => { m.field.more = true; } },
  ];
  for (const { action, setup } of cases) {
    const m = mock(offer([action])); setup(m);
    await assert.rejects(plan(m.gh, c, [action]), JSON.stringify(action));
    assert.deepEqual(writes(m), []);
  }
});

it("refuses to execute when a target changed after it was shown, before reserving", async () => {
  for (const [action, change] of [
    [close, (m: ReturnType<typeof mock>) => { m.issue("/repos/example/tasks/issues/1").state = "closed"; }],
    [{ ...base, type: "set_project_field", project, field: "Priority", value: "P1" }, (m: ReturnType<typeof mock>) => { m.field.value = null; }],
    [{ ...base, type: "approve_pull_request", head_sha: head }, (m: ReturnType<typeof mock>) => { m.pr.draft = true; }],
  ] as [Action, (m: ReturnType<typeof mock>) => void][]) {
    const o = offer([action]); const m = mock(o);
    const shown = await plan(m.gh, c, [action]);
    change(m);
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /Stale/);
    assert.deepEqual(writes(m), []);
  }
  // A field changed to another valid value still passes the plan, but not the comparison with what was shown.
  const o = offer([{ ...base, type: "set_project_field", project, field: "Priority", value: "P1" }]); const m = mock(o);
  const shown = await plan(m.gh, c, o.proposal.actions); m.field.value = "P3";
  await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /since the proposal was shown/);
  assert.deepEqual(writes(m), []);
});

it("refuses malformed reservation IDs before any action or receipt update", async () => {
  for (const visible of [false, true]) for (const value of [{}, null, [], true, { id: null }, { id: "20" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }]) {
    const o = offer(); const m = mock(o);
    m.reservationReceipt.value = value; m.reservationReceipt.visible = visible;
    const shown = await plan(m.gh, c, o.proposal.actions);
    const progress: string[] = [];
    await assert.rejects(execute(m.gh, c, o, shown.expected, (_, result) => progress.push(result)), /Reservation not confirmed/);
    assert.deepEqual(progress, []);
    assert.deepEqual(writes(m).map(({ method, path }) => ({ method, path })), [{ method: "POST", path: `/repos/${c.tracker}/issues/9/comments` }]);
    if (visible) {
      await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /already has an execution record/);
      assert.equal(writes(m).length, 1, "a persisted reservation still blocks replay");
    }
  }
});

it("reserves before execution, rechecks targets, records results and refuses replay", async () => {
  const o = offer(); const m = mock(o); const progress: string[] = [];
  const shown = await plan(m.gh, c, o.proposal.actions);
  await execute(m.gh, c, o, shown.expected, (_, v) => progress.push(v));
  assert.deepEqual(progress, ["Done"]);
  const w = writes(m);
  assert.equal(w[0]!.path, "/repos/example/tracker/issues/9/comments");
  assert.equal(w[0]!.body.body.split("\n")[0], marker(o));
  // Shown, execution preflight, and just before the write.
  assert.equal(m.calls.filter((v) => v.method === "GET" && v.path === "/repos/example/tasks/issues/1").length, 3);
  assert.match(w.at(-1)!.body.body, /1\. done/);
  const before = w.length;
  await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}), /already/);
  assert.equal(writes(m).length, before);
});

it("stops at first failure, retains the executed marker and never posts API text as intent", async () => {
  const actions: Action[] = [{ ...base, type: "add_label", label: "x" }, { ...base, number: 2, type: "add_label", label: "y" }];
  const o = offer(actions); const m = mock(o); m.fail("/repos/example/tasks/issues/1/labels");
  await assert.rejects(execute(m.gh, c, o, (await plan(m.gh, c, actions)).expected, () => {}));
  assert.ok(!m.calls.some((v) => v.method === "POST" && v.path === "/repos/example/tasks/issues/2/labels"));
  const receipt = m.calls.at(-1)!;
  assert.equal(receipt.method, "PATCH"); assert.ok(receipt.body.body.startsWith(marker(o)));
  assert.match(receipt.body.body, /1\. failed or uncertain/); assert.ok(!receipt.body.body.includes("/promote"));
});

it("refuses another viewer, changed proposal and forged UI object", async () => {
  const o = offer(); const shown = [ "open" ];
  const m = mock(o); m.setViewer("visitor"); await assert.rejects(execute(m.gh, c, o, shown, () => {}), /own token/);
  const changed = mock(o); changed.all[0] = { ...o.comment, updatedAt: "2026-10-14T13:00:00Z" }; await assert.rejects(execute(changed.gh, c, o, shown, () => {}), /changed/);
  const forged = { ...o, proposal: { ...o.proposal, why: "forged" } }; await assert.rejects(execute(mock(o).gh, c, forged, shown, () => {}), /match/);
  for (const v of [m, changed]) assert.deepEqual(writes(v), []);
});

it("does not mutate after a competing earlier receipt or a target change after reservation", async () => {
  for (const competing of [true, false]) {
    const o = offer(); const m = mock(o);
    const shown = await plan(m.gh, c, o.proposal.actions);
    m.intercept(() => {
      if (m.calls.at(-1)?.path === "/repos/example/tracker/issues/9/comments") {
        if (competing) m.all.push({ ...o.comment, id: "IC_other", databaseId: 19, author: { login: c.operator }, body: marker(o) });
        else m.issue("/repos/example/tasks/issues/1").state = "closed";
      }
    });
    await assert.rejects(execute(m.gh, c, o, shown.expected, () => {}));
    assert.deepEqual(targetWrites(m), []);
  }
});

it("renders plain text and disables stale proposals", async () => {
  for (const stale of [true, false]) {
    const o = offer(); o.proposal.title = "<img src=x onerror=evil()>"; o.comment.body = `\`\`\`agent-board-action\n${JSON.stringify(o.proposal)}\n\`\`\``;
    const m = mock(o); if (stale) m.issue("/repos/example/tasks/issues/1").state = "closed";
    const panel = await proposalCard(m.gh, c, o, () => false, () => {}); document.body.replaceChildren(panel);
    assert.ok(panel.textContent?.includes(o.proposal.title)); assert.equal(panel.querySelector("img"), null);
    assert.equal(panel.querySelector<HTMLButtonElement>("button")!.disabled, stale);
    assert.equal(panel.textContent?.includes("Refused: Error: Action 1: Stale"), stale);
    assert.ok(panel.querySelector("pre")?.textContent?.includes("close_issue"));
    assert.equal(win.document.querySelector("script"), null);
  }
});
