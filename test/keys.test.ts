import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyCommand, parseRoute, type Route } from "../src/github/keys.ts";

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
    ["d", "home", {}, "section:agents"],
    ["n", "home", {}, "section:changes"],
    ["t", "home", {}, "section:priority"],
    ["s", "home", {}, "section:usage"],
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
    ["#ops", { route: "home" }],
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
    ["#composefs", { route: "home", filter: { scope: "composefs" } }],
    ["#org:bootc-dev+P0", { route: "home", filter: { scope: { org: "bootc-dev" }, priority: "P0" } }],
    ["#org:../x", { route: "home" }],
  ];
  for (const [hash, want] of cases) it(JSON.stringify(hash), () => assert.deepEqual(parseRoute(hash), want));
});
