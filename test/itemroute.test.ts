// Exercise deep links through the real entry point, including refreshes and late reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { fields } from "./helpers.ts";

for (const queue of ["loads", "fails", "delayed", "delayed failure"]) it(`opens deep links and keeps read errors visible across chrome refreshes (publication ${queue})`, async () => {
  const id = "PVTI_lADOE9oHIs4BlJLczhENIh0";
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => {
    // Sign-out reloads the page; jsdom implements only hash navigation.
    if (!error.message.startsWith("Not implemented: navigation")) throw error;
  });
  const dom = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), {
    url: `https://review.example/#item/${id}`, pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  const content = {
    __typename: "Issue", id: "I_example786", title: "An in-progress epic", body: "Epic context", url: "https://github.com/jmarrero-forge/tracker/issues/786", state: "OPEN",
    ...(queue.startsWith("delayed") ? {
      body: "Blocks: https://github.com/jmarrero-forge/tracker/issues/1\n\nQ: Epic context?",
      labels: { nodes: [{ name: "question" }] }, assignees: { nodes: [{ login: "jmarrero" }] },
      author: { login: "jmarrero-bot" },
    } : {}),
  };
  const status = "In Progress";
  const board = { id, project: { number: 1, owner: { login: "jmarrero-forge" } }, fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] } };
  let reads = 0;
  let queueFailures = 0;
  let publicationFinished = false;
  let releaseQueue = () => {};
  const queueReady = new Promise<void>((resolve) => { releaseQueue = resolve; });
  let missing = false;
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, HTMLElement: window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const publication = url.pathname === "/repos/jmarrero-forge/bot-ops/issues/1/comments";
      if (publication && queue.startsWith("delayed")) await queueReady;
      if (publication) publicationFinished = true;
      if ((queue === "fails" || queue === "delayed failure") && publication) {
        queueFailures++;
        return new Response(JSON.stringify({ message: "Queue unavailable" }), { status: 503 });
      }
      let body: unknown = [];
      assert.ok(!url.pathname.endsWith("/items"), "deep links do not discover the board");
      if (url.pathname === "/user") body = { login: "viewer" };
      else if (url.pathname.endsWith("/fields")) body = fields();
      else if (url.pathname === "/search/issues") body = { items: [], total_count: 0 };
      else if (url.pathname === "/graphql") {
        const request = JSON.parse(String(init?.body)) as { query: string };
        if (request.query.includes("node(id:$id)")) {
          reads++;
          body = { data: { node: missing ? null : { ...board, content } } };
        } else if (request.query.includes("issue(number:$number)")) {
          reads++;
          body = { data: { repository: { issue: { ...content, projectItems: { nodes: missing ? [] : [board], pageInfo: { hasNextPage: false } } } } } };
        } else body = { data: {} };
      }
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    },
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out: ${window.document.querySelector("#view")?.textContent}`);
  };
  const text = () => window.document.querySelector("#view")?.textContent ?? "";
  const key = (key: string) => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
  try {
    await import(`../src/github/main.ts?queue=${queue}`);
    await until(() => !!window.document.querySelector(".signin"));
    window.document.querySelector<HTMLInputElement>(".signin input[type=password]")!.value = ["ghp", "x".repeat(24)].join("_");
    window.document.querySelector(".signin")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => text().includes(content.title));
    assert.ok(text().includes(status));
    assert.match(text(), /Epic context/);
    assert.doesNotMatch(text(), /left this without an ask/);
    assert.equal(reads, 1);
    assert.equal(window.document.querySelector("#sec-needs"), null, "not the Inbox");
    if (queue === "fails") {
      await until(() => queueFailures > 0);
      assert.match(text(), /Epic context/, "queue failure doesn't replace the readable item");
    }
    if (queue.startsWith("delayed")) {
      const answer = window.document.querySelector<HTMLTextAreaElement>("form.answer textarea");
      assert.ok(answer, "the item offers an answer before the queue finishes");
      answer.value = "Keep this unsent answer";
      releaseQueue();
      await until(() => publicationFinished);
      // Allow the released read and its render callbacks to finish.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(window.document.querySelector("form.answer textarea"), answer, "late reads preserve the form");
      assert.equal(answer.value, "Keep this unsent answer");
    }

    window.location.hash = "#issue/jmarrero-forge/tracker/786";
    await until(() => reads === 2 && text().includes("In Progress"));
    missing = true;
    window.location.hash = "#item/PVTI_missing";
    await until(() => text().includes("Couldn't read this item"));
    key("?"); // renderChrome used to erase the route's notice.
    assert.match(text(), /Couldn't read this item/);
    assert.ok(window.document.querySelector('[role="alert"]'));
    key("r");
    await until(() => reads === 4 && text().includes("Couldn't read this item"));

    window.location.hash = "#issue/jmarrero-forge/tracker/786";
    await until(() => reads === 5 && text().includes(content.title));
    assert.doesNotMatch(text(), /In Progress/, "off-board issue renders alone");
  } finally {
    releaseQueue();
    window.document.querySelector<HTMLButtonElement>("#signout")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
  }
});
