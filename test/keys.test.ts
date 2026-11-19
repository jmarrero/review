import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyCommand, parseRoute, type Route } from "../src/github/keys.ts";
import { GitHub } from "../src/github/api.ts";
import { findRouteItem, loadRouteItem } from "../src/github/itemroute.ts";
import { scriptedFetch } from "./helpers.ts";

describe("keyCommand", () => {
  const press = (key: string, over: Partial<Parameters<typeof keyCommand>[0]> = {}) => ({
    key, ctrlKey: false, metaKey: false, altKey: false, editing: false, ...over,
  });
  const cases: [string, Route, Partial<Parameters<typeof keyCommand>[0]>, string | undefined][] = [
    ["j", "home", {}, "next"],
    ["k", "home", {}, "prev"],
    ["ArrowDown", "home", {}, "next"],
    ["ArrowUp", "home", {}, "prev"],
    ["o", "home", {}, "open"],
    ["Enter", "home", {}, "open"],
    ["a", "home", {}, undefined],
    ["g", "home", {}, undefined],
    // The section keys jump to a section of the page.
    ["q", "home", {}, "section:needs"],
    ["d", "home", {}, undefined],
    ["n", "home", {}, undefined],
    ["t", "home", {}, undefined],
    ["s", "home", {}, "status"],
    ["q", "item", {}, undefined],
    ["t", "item", {}, undefined],
    ["a", "pr", {}, "approve"],
    ["x", "pr", {}, "fold"],
    ["n", "pr", {}, "next-file"],
    ["p", "pr", {}, "prev-file"],
    ["j", "pr", {}, "next-hunk"],
    ["k", "pr", {}, "prev-hunk"],
    ["v", "pr", {}, "viewed"],
    ["c", "pr", {}, "comment"],
    ["c", "item", {}, "compose"],
    ["g", "pr", {}, "guide"],
    ["s", "pr", {}, "layout"],
    ["[", "pr", {}, "prev-commit"],
    ["]", "pr", {}, "next-commit"],
    ["v", "pr", { editing: true }, undefined],
    ["u", "pr", {}, "back"],
    ["u", "home", {}, undefined],
    ["Escape", "item", {}, "back"],
    ["r", "item", {}, "refresh"],
    ["r", "home", {}, "refresh"],
    ["?", "pr", {}, "help"],
    ["?", "home", {}, "help"],
    ["a", "pr", { editing: true }, undefined],
    ["Escape", "pr", { editing: true }, "blur"],
    ["Escape", "home", { editing: true }, "blur"],
    ["j", "home", { editing: true }, undefined],
    ["q", "home", { editing: true }, undefined],
    ["j", "home", { ctrlKey: true }, undefined],
    ["r", "home", { metaKey: true }, undefined],
    ...(["home", "item", "pr"] as const).map((r): [string, Route, object, string] => ["b", r, {}, "capture"]),
    ["b", "home", { editing: true }, undefined],
    ["b", "pr", { ctrlKey: true }, undefined],
    ["b", "item", { metaKey: true }, undefined],
    ["b", "home", { altKey: true }, undefined],
  ];
  for (const [key, route, over, want] of cases) {
    it(`${key} on ${route}${Object.keys(over).length ? ` ${JSON.stringify(over)}` : ""}`, () => assert.equal(keyCommand(press(key, over), route), want));
  }
});

describe("parseRoute", () => {
  const cases: [string, ReturnType<typeof parseRoute>][] = [
    ["", { route: "home" }],
    ["#", { route: "home" }],
    // The old tabs are gone: their hashes are just the page.
    ["#news", { route: "home" }],
    ["#ops", { route: "home", view: "status" }],
    ["#triage", { route: "home" }],
    ["#decisions", { route: "home" }],
    ["#item/PVTI_abc-_1", { route: "item", id: "PVTI_abc-_1" }],
    ["#item/I_kwDOP9abcd", { route: "item", id: "I_kwDOP9abcd" }],
    ["#item/X_abc", { route: "home" }],
    ["#pr/jmarrero-forge/bootc/30", { route: "pr", ref: { owner: "jmarrero-forge", repo: "bootc", number: 30 } }],
    ["#pr/o/r.s_t/1", { route: "pr", ref: { owner: "o", repo: "r.s_t", number: 1 } }],
    ["#pr/o/r/0", { route: "home" }],
    ["#pr/o/../1", { route: "home" }],
    ["#pr/o/./1", { route: "home" }],
    ["#pr/o/r/1/extra", { route: "home" }],
    ["#item/<script>", { route: "home" }],
    ["#inbox", { route: "home", view: "inbox" }],
    ["#status", { route: "home", view: "status" }],
    ["#agents", { route: "home", view: "status" }],
    ["#board", { route: "home", view: "status" }],
    ["#activity", { route: "home", view: "status" }],
    ["#usage", { route: "home", view: "status" }],
    ["#dashboard", { route: "home", view: "status" }],
    ["#maintain", { route: "home", view: "inbox" }],
    ["#chat", { route: "home", view: "inbox" }],
    ["#Inbox", { route: "home" }],
    ["#composefs", { route: "home", view: "inbox" }],
    ["#org:bootc-dev+P0", { route: "home", view: "inbox" }],
    ["#org:../x", { route: "home" }],
  ];
  for (const [hash, want] of cases) it(JSON.stringify(hash), () => assert.deepEqual(parseRoute(hash), want));

  it("accepts issue references with the same validation as PR references", () => {
    for (const [hash, want] of cases.filter(([hash]) => hash.startsWith("#pr/"))) {
      const issue = parseRoute(hash.replace("#pr/", "#issue/"));
      assert.deepEqual(issue, want.route === "pr"
        ? { route: "item", id: `${want.ref.owner}/${want.ref.repo}#${want.ref.number}`.toLowerCase(), ref: want.ref }
        : want);
    }
    for (const suffix of ["o/r/-1", "o/r/01", "o/r/10000000000", "o/r/1?x", "o%2Fx/r/1", "o/%2e%2e/1"]) {
      for (const kind of ["pr", "issue"]) assert.deepEqual(parseRoute(`#${kind}/${suffix}`), { route: "home" });
    }
  });
});

describe("item deep-link reads outside the needs-you queue", () => {
  const id = "PVTI_lADOE9oHIs4BlJLczhENIh0";
  // Synthetic content for the tracker#786 regression; no live GitHub reads.
  const content = { __typename: "Issue", id: "I_example786", title: "An in-progress epic", body: "Epic context", url: "https://github.com/jmarrero-forge/tracker/issues/786", state: "OPEN", labels: { nodes: [{ name: "epic" }] }, subIssuesSummary: { total: 3, completed: 1, percentCompleted: 33 } };
  const board = { id, project: { number: 1, owner: { login: "jmarrero-forge" } }, fieldValues: { nodes: [
    { name: "In Progress", field: { name: "Status" } },
    { name: "P0", field: { name: "Priority" } },
    { text: "Keep this context", field: { name: "Why" } },
  ] } };
  const issue = { ...content, projectItems: { nodes: [board], pageInfo: { hasNextPage: false } } };
  const refHash = "#issue/JMarrero-Forge/tracker/786";

  async function read(hash: string, data: unknown) {
    const route = parseRoute(hash);
    assert.equal(route.route, "item");
    if (route.route !== "item") throw new Error("expected an item route");
    assert.equal(findRouteItem([], route.id), undefined, "not in the needs-you queue or a previously loaded Board view");
    const { fetchImpl, calls } = scriptedFetch((method, url) => method === "POST" && url.endsWith("/graphql") ? { body: { data } } : undefined);
    const item = await loadRouteItem(new GitHub(async () => "t", fetchImpl), route);
    assert.equal(calls.length, 1, "one on-demand request");
    return { item, calls, route };
  }

  it("reads tracker#786 by PVTI even before Board has been visited", async () => {
    const { item, calls } = await read(`#item/${id}`, { node: { ...board, content } });
    assert.equal(item.nodeId, id);
    assert.equal(item.title, content.title);
    assert.equal(item.status, "In Progress");
    assert.equal(item.priority, "P0");
    assert.equal(item.why, "Keep this context");
    assert.equal(item.body, content.body);
    assert.equal(item.subIssues?.total, 3);
    assert.deepEqual((calls[0]?.body as { variables: unknown }).variables, { id });
  });

  for (const hash of [refHash, "#item/I_example786"]) it(`prefers board context for ${hash}`, async () => {
    const { item, route } = await read(hash, hash === refHash ? { repository: { issue } } : { node: issue });
    assert.equal(item.nodeId, id);
    assert.equal(item.status, "In Progress");
    if (hash === refHash) assert.equal(findRouteItem([item], route.id), item, "case-insensitive reference finds loaded board item");
  });

  for (const hash of [refHash, "#item/I_example786"]) it(`renders standalone content for ${hash} off the board`, async () => {
    const alone = { ...issue, projectItems: { nodes: [], pageInfo: { hasNextPage: false } } };
    const { item } = await read(hash, hash === refHash ? { repository: { issue: alone } } : { node: alone });
    assert.equal(item.nodeId, content.id);
    assert.equal(item.body, content.body);
    assert.equal(item.status, undefined);
    assert.equal(item.ref?.number, 786);
  });

  it("reports missing, inaccessible and indeterminate items instead of returning the Inbox", async () => {
    await assert.rejects(read(`#item/${id}`, { node: null }), /not found or not accessible/);
    await assert.rejects(read(`#item/${id}`, { node: { ...board, content: null } }), /content is not accessible/);
    await assert.rejects(read(refHash, { repository: { issue: null } }), /not found or not accessible/);
    await assert.rejects(read(refHash, { repository: { issue: { ...issue, projectItems: { nodes: [], pageInfo: { hasNextPage: true } } } } }), /first 100 projects/);
  });
});
