import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { JSDOM } from "jsdom";
import { AcpClient, TAILNET_STEP, chatPanel, derivedEndpoint, findLiveRuns, stageText, type ChatTiming, type RunStage } from "../src/github/chat.ts";
import { CHAT_CONFIG, chatEndpoint, parseChatConfig, type ChatConfig } from "../src/github/chatconfig.ts";
import { GitHub } from "../src/github/api.ts";
import { MaybeSentError } from "../src/github/backend.ts";
import { chatButton, chatItem, sessionInputs, startChatButton, type ChatAnswer, type ChatItem } from "../src/github/chatitem.ts";
import { parseNeedsYou } from "../src/github/holds.ts";
import { publishedCards } from "../src/github/inbox.ts";
import { rawAsk, rawNeedsYou, realNeedsYouSnapshot, scriptedFetch } from "./helpers.ts";

// The app's page, so the real main.ts hooks can be imported for the chat's Answer.
const win = new JSDOM(readFileSync(new URL("../static/index.html", import.meta.url), "utf8"), { url: "https://review.example/" }).window;
Object.assign(globalThis, { window: win, document: win.document, Node: win.Node, HTMLElement: win.HTMLElement,
  ResizeObserver: class { observe() {} disconnect() {} }, fetch: async () => { throw new Error("network forbidden"); } });
const { inboxHooks } = await import("../src/github/main.ts");
const config = { tailnetDomain: "example.ts.net", sources: [{ repo: "owner/repo", workflow: "session.yml", issue: 1, publisher: "publisher" }] };
// The shipped configuration's shape, with the session wrapper's real status comment.
const live: ChatConfig = { tailnetDomain: "tailf2eb8.ts.net", sources: [{ repo: "jmarrero-forge/tracker", workflow: "session.yml", issue: 728, publisher: "jmarrero-bot" }] };
const RUN = 39062677132;
const ITEM: ChatItem = { ref: "public/project#157", title: "An item title", pool: "openai" };
const endpointComment = (id: number) => ({
  user: { login: "jmarrero-bot" },
   body: `⏳ [session](https://github.com/jmarrero-forge/tracker/actions/runs/${id}) is running. Session: after the task's turn the operator attaches at \`wss://agentic-job-${id}-1.tailf2eb8.ts.net/\`, once the agent job's summary shows it served.\n\n<!-- agentic-job-run: ${id} -->\n\n<!-- agentic-job-status -->`,
 });
// A publisher may name the item itself; the deployed wrapper currently doesn't.
const statusComment = (id: number) => ({ ...endpointComment(id), body: `Context: ${ITEM.ref}. ${endpointComment(id).body}` });
const itemPublication = (id = RUN, ref = ITEM.ref) => ({ user: { login: "jmarrero" }, body: `Context: ${ref}.\n\nSession: https://github.com/jmarrero-forge/tracker/actions/runs/${id}` });
const published = `wss://agentic-job-${RUN}-1.tailf2eb8.ts.net/`;
const ATTACH_TIMEOUT = 300;
const FAST: Partial<ChatTiming> = { pollMs: 1, pollMaxMs: 2, retryMs: 1, retryMaxMs: 2, startLimitMs: 5_000, appearLimitMs: 5_000, waitLimitMs: 5_000, openTimeoutMs: 1_000, attachTimeoutMs: ATTACH_TIMEOUT };

class MockServer extends EventTarget {
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: any[] = [];
  close() { this.onclose?.(); }
  send(text: string) {
    const m = JSON.parse(text); this.sent.push(m);
    if (!m.id) return;
    queueMicrotask(() => this.emit({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: 1 } : m.method === "session/new" ? { sessionId: "session" } : { stopReason: "end_turn" } }));
  }
  emit(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

/**
 * ok: opens and answers ACP like the bridge. fail: never opens. hang: opens
 * and never answers. drop: opens, then the bridge closes it unanswered (as
 * when another client is attached).
 */
type Mode = "ok" | "fail" | "hang" | "drop";

class MockSocket extends MockServer {
  onopen: (() => Promise<void>) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  /** Refuse prompts, as the bridge does while a turn runs. */
  busy = false;
  readonly url: string;
  readonly mode: Mode;
  constructor(url: string, mode: Mode) {
    super();
    this.url = url;
    this.mode = mode;
    queueMicrotask(() => {
      if (mode === "fail") { this.onerror?.(); this.close(); return; }
      void this.onopen?.();
      if (mode === "drop") queueMicrotask(() => this.close());
    });
  }
  override close() { if (this.closed) return; this.closed = true; super.close(); }
  override send(text: string) {
    const m = JSON.parse(text);
    if (this.mode === "hang") { this.sent.push(m); return; }
    if (this.busy && m.method === "session/prompt") { this.sent.push(m); queueMicrotask(() => this.emit({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "a turn is running" } })); return; }
    super.send(text);
  }
}

/** Pinned bridge: one client per destination; session/new always returns "session". */
function configuredListener() {
  const sockets: MockSocket[] = [];
  const admitted = new Set<string>();
  const socketFactory = (url: string) => {
    const socket = new MockSocket(url, admitted.has(url) ? "drop" : "ok");
    admitted.add(url); sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  return { sockets, socketFactory };
}

it("the configured listener reuses its session ID and refuses a second client", async () => {
  const { sockets, socketFactory } = configuredListener();
  const client = new AcpClient(socketFactory("wss://review.example/api/acp/one"), () => {}, () => {});
  await client.attach();
  const again = await client.request("session/new", { cwd: "/", mcpServers: [] });
  assert.equal(again.sessionId, client.sessionId);
  client.socket.close();
  socketFactory("wss://review.example/api/acp/one");
  await until("second client refused", () => sockets[1]!.closed);
});

it("configured providers attach only on choice without claiming a fresh conversation or retrying", async () => {
  const { sockets, socketFactory } = configuredListener();
  const gh = new GitHub(async () => { throw new Error("no GitHub access"); });
  const panel = chatPanel(gh, { sessions: [{ id: "one", label: "Provider A" }, { id: "two", label: "Provider B" }],
    socketFactory })!;
  const slot = document.createElement("div"); document.body.append(slot);
  panel.mount(slot); panel.open();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  assert.equal(sockets.length, 0);
  const picker = slot.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  assert.match(picker.textContent!, /Provider A/);
  picker.value = "two"; picker.dispatchEvent(new win.Event("change"));
  await tick();
  assert.equal(sockets[0]!.url, "wss://review.example/api/acp/two");
  const button = (text: string) => [...slot.querySelectorAll("button")].find((b) => b.textContent === text)!;
  assert.equal(button("New session"), undefined);
  assert.equal(sockets[0]!.sent.filter((m) => m.method === "session/new").length, 1);
  assert.match(slot.textContent!, /existing conversation/);
  sockets[0]!.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retain this transcript" } } } });
  sockets[0]!.onerror?.(); await tick();
  assert.match(slot.textContent!, /Session ended.*session server restarted/);
  assert.match(slot.querySelector(".chat-log")!.textContent!, /Retain this transcript/);
  assert.equal(slot.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
  assert.equal(sockets.length, 1, "no replay means no automatic reconnect");
  assert.equal(button("Start fresh"), undefined);
  assert.equal(button("Attach").hidden, true);
  button("Attach").click(); await tick();
  picker.value = ""; picker.dispatchEvent(new win.Event("change"));
  picker.value = "two"; picker.dispatchEvent(new win.Event("change")); await tick();
  assert.equal(sockets.length, 1, "reselecting a consumed listener must not retry it");
  assert.match(slot.querySelector(".chat-log")!.textContent!, /Retain this transcript/);
  const input = slot.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Draft for Provider B";
  picker.value = "one"; picker.dispatchEvent(new win.Event("change")); await tick();
  assert.equal(picker.value, "two");
  assert.equal(input.value, "Draft for Provider B");
  assert.equal(sockets.length, 1);
  assert.match(slot.querySelector(".chat-status")!.textContent!, /Clear or copy the unsent draft/);
  input.value = "";
  picker.value = "one"; picker.dispatchEvent(new win.Event("change")); await tick();
  assert.equal(sockets.length, 2);
  assert.match(slot.querySelector(".chat-log")!.textContent!, /Provider: Provider B.*Retain this transcript.*Session ended.*Provider: Provider A/);
  sockets[1]!.close(); await tick();
  assert.match(slot.textContent!, /Session ended.*session server restarted/);
  assert.equal(button("Attach").hidden, true);
  panel.dispose(); slot.remove();
});

it("a failed configured provider switch retains the ended transcript", async () => {
  const sockets: MockSocket[] = [];
  const panel = chatPanel(new GitHub(async () => { throw new Error("no GitHub access"); }), {
    sessions: [{ id: "one", label: "Provider A" }, { id: "two", label: "Provider B" }],
    socketFactory(url) { const socket = new MockSocket(url, sockets.length ? "fail" : "ok"); sockets.push(socket); return socket as unknown as WebSocket; },
  })!;
  const slot = document.createElement("div"); document.body.append(slot);
  panel.mount(slot); panel.open();
  const picker = slot.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  picker.value = "one"; picker.dispatchEvent(new win.Event("change"));
  await until("attached", () => panel.attached());
  sockets[0]!.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Keep A's text" } } } });
  sockets[0]!.close();
  picker.value = "two"; picker.dispatchEvent(new win.Event("change"));
  await until("failed B", () => sockets[1]!.closed);
  assert.match(slot.querySelector(".chat-log")!.textContent!, /Provider: Provider A.*Keep A's text.*Session ended.*Provider: Provider B.*Session ended/);
  assert.match(slot.querySelector(".chat-status")!.textContent!, /Session ended/);
  panel.dispose(); slot.remove();
});

interface Run { id: number; run_attempt: number; status: string; display_title: string; created_at: string; actor: { login: string } }
const run = (status: string, id = RUN, run_attempt = 1): Run => ({ id, run_attempt, status, display_title: "Operator session (claude)", created_at: new Date().toISOString(), actor: { login: "jmarrero" } });

type Answer = { status: number; body?: unknown };

/**
 * The agent job's tailnet step: done, still running, failed, done but the
 * job has since finished, or not listed (no job started yet, or renamed).
 */
type Joined = "yes" | "no" | "failed" | "left" | "unlisted";
const TURN_STARTED = "2026-10-22T15:16:57Z";
const TURN_CLOCK = new Date(TURN_STARTED).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const jobsBody = (joined: Joined) => ({
  jobs: [
    { name: "profile", status: "completed", steps: [{ name: "Set up job", status: "completed", conclusion: "success" }] },
    ...(joined === "unlisted" ? [] : [{
      name: "run / agent",
      status: joined === "left" ? "completed" : "in_progress",
      steps: [
        { name: TAILNET_STEP, status: joined === "no" ? "in_progress" : "completed", conclusion: joined === "no" ? null : joined === "failed" ? "failure" : "success" },
        // The task's first turn, after which the run serves the session.
        { name: "Run ./.agentic-job-source/run", status: joined === "yes" ? "in_progress" : "queued", conclusion: null, started_at: joined === "yes" ? TURN_STARTED : null },
      ],
    }]),
  ],
});

/**
 * GitHub with a mutable tracker: its session runs, #728's comments, the
 * dispatch answers in turn, and whether the runs' agent jobs joined the tailnet.
 */
function tracker(runs: Run[] = [], comments: { user: { login: string } | null; body: string }[] = [], dispatch: Answer[] = [{ status: 204 }]) {
  const world = { runs, comments, dispatch, onDispatch: () => {}, failRuns: 0, joined: "yes" as Joined, private: false };
  let posts = 0;
  const { fetchImpl, calls } = scriptedFetch((method, url) => {
    if (method === "POST" && url.endsWith("/actions/workflows/session.yml/dispatches")) {
      const answer = world.dispatch[Math.min(posts++, world.dispatch.length - 1)]!;
      if (answer.status < 300) world.onDispatch();
      return answer;
    }
    if (method === "POST" && url.endsWith("/issues/728/comments")) {
      world.comments.push({ user: { login: "jmarrero" }, body: (calls.at(-1)!.body as { body: string }).body });
      return { status: 201, body: {} };
    }
    if (method === "POST" && url.endsWith("/cancel")) return { status: 202 };
    if (method !== "GET") return undefined;
    if (url.endsWith("/repos/public/project")) return { body: { private: world.private } };
    if (url.includes("/actions/workflows/session.yml/runs?") && world.failRuns > 0) { world.failRuns--; return { status: 500, body: { message: "Server Error" } }; }
    if (url.includes("/actions/workflows/session.yml/runs?")) return { body: { workflow_runs: world.runs } };
    if (url.endsWith("/issues/728")) return { body: { comments: world.comments.length } };
    if (url.includes("/issues/728/comments?")) return { body: world.comments };
    const jobs = url.match(/\/actions\/runs\/(\d+)\/jobs\?/);
    // A run that hasn't started has no agent job yet.
    if (jobs) return { body: jobsBody(world.runs.find((r) => r.id === Number(jobs[1]))?.status === "in_progress" ? world.joined : "unlisted") };
    return undefined;
  });
  const gh = new GitHub(async () => "secret-token", fetchImpl);
  return { world, calls, gh, dispatches: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/dispatches")) };
}

function mount(gh: GitHub, modes: Mode[] = [], timing: Partial<ChatTiming> = {}) {
  const sockets: MockSocket[] = [];
  const opened: number[] = [];
  const socketFactory = (url: string) => { const s = new MockSocket(url, modes[sockets.length] ?? "ok"); sockets.push(s); opened.push(performance.now()); return s as unknown as WebSocket; };
  const panel = chatPanel(gh, { config: live, socketFactory, timing: { ...FAST, ...timing } })!;
  const slot = document.createElement("div");
  document.body.append(slot);
  panel.mount(slot);
  assert.equal(slot.hidden, true, "no global chat box");
  panel.open(ITEM);
  const pane = () => slot.querySelector<HTMLElement>(".chat-panel")!;
  const button = (name: RegExp) => [...slot.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
  const status = () => slot.querySelector(".chat-status")?.textContent ?? "";
  return { slot, panel, sockets, opened, pane, button, status, state: () => pane().dataset.state };
}

async function until(what: string, ok: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

it("is off with an empty configuration and confines endpoints to the configured tailnet", () => {
  assert.equal(parseChatConfig({ tailnetDomain: "", sources: [] }), undefined);
  assert.equal(chatPanel(new GitHub(async () => "token"), { config: parseChatConfig({ tailnetDomain: "", sources: [] }) }), undefined);
  // jmarrero's deployment has no session source or tailnet domain yet, so chat is off.
  assert.equal(CHAT_CONFIG, undefined);
  assert.deepEqual(parseChatConfig(config), config);
  for (const url of ["ws://runner.example.ts.net/", "wss://example.ts.net/", "wss://runner.example.ts.net.evil/", "wss://u@runner.example.ts.net/", "wss://runner.example.ts.net:444/", "wss://runner.example.ts.net/?token=x"]) assert.equal(chatEndpoint(url, config.tailnetDomain), undefined);
  assert.equal(chatEndpoint("wss://runner.example.ts.net/acp", config.tailnetDomain), "wss://runner.example.ts.net/acp");
  assert.throws(() => parseChatConfig({ ...config, tailnetDomain: "x; connect-src *" }));
  assert.equal(parseChatConfig({ ...config, sources: [{ ...config.sources[0], ref: "release/1" }] })?.sources[0]?.ref, "release/1");
  assert.throws(() => parseChatConfig({ ...config, sources: [{ ...config.sources[0], ref: "../x y" }] }));
  assert.equal(derivedEndpoint(7, 2, "example.ts.net"), "wss://agentic-job-7-2.example.ts.net/");
});

it("finds live runs and their endpoints from the publisher, or the agent job's name, once it joined the tailnet", async () => {
  const cases: { name: string; runs: Run[]; comments?: { user: { login: string } | null; body: string }[]; joined?: Joined; want: { id: number; endpoint?: string }[] }[] = [
    { name: "no runs", runs: [], want: [] },
    { name: "only completed runs", runs: [run("completed")], want: [] },
    { name: "the wrapper's status comment", runs: [run("in_progress")], comments: [statusComment(RUN)], want: [{ id: RUN, endpoint: published }] },
    { name: "queued, nothing published", runs: [run("queued")], want: [{ id: RUN }] },
    { name: "held as waiting, published, the jobs don't say", runs: [run("waiting")], comments: [statusComment(RUN)], want: [{ id: RUN, endpoint: published }] },
    { name: "starting statuses count as live", runs: ["waiting", "pending", "requested"].map((s, i) => run(s, i + 1)), want: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { name: "in progress, nothing published: derived from the attempt", runs: [run("in_progress", RUN, 2)], want: [{ id: RUN, endpoint: `wss://agentic-job-${RUN}-2.tailf2eb8.ts.net/` }] },
    // Its name doesn't resolve yet: dialing it would only teach resolvers that it doesn't exist.
    { name: "published, still joining the tailnet", runs: [run("in_progress")], comments: [statusComment(RUN)], joined: "no", want: [{ id: RUN }] },
    { name: "published, failed to join the tailnet", runs: [run("in_progress")], comments: [statusComment(RUN)], joined: "failed", want: [{ id: RUN }] },
    // The run lingers (applying, concluding) after its agent job, and bridge, are gone.
    { name: "published, the agent job has finished", runs: [run("in_progress")], comments: [statusComment(RUN)], joined: "left", want: [{ id: RUN }] },
    { name: "published, the jobs don't say", runs: [run("in_progress")], comments: [statusComment(RUN)], joined: "unlisted", want: [{ id: RUN, endpoint: published }] },
    { name: "nothing published, the jobs don't say: no guess", runs: [run("in_progress")], joined: "unlisted", want: [{ id: RUN }] },
    // #728 still carries a supervisor comment from before the publisher became cgwalters-bot.
    { name: "the stale github-actions[bot] comment", runs: [run("in_progress")], comments: [{ user: { login: "github-actions[bot]" }, body: statusComment(RUN).body }], joined: "unlisted", want: [{ id: RUN }] },
    {
      name: "other publishers, other runs and outside endpoints are ignored",
      runs: [run("queued")],
      comments: [
        { user: null, body: statusComment(RUN).body },
        { user: { login: "someone" }, body: statusComment(RUN).body },
        { ...statusComment(RUN), body: statusComment(RUN).body.replaceAll("tailf2eb8.ts.net", "evil.example") },
        statusComment(RUN + 1),
      ],
      want: [{ id: RUN }],
    },
  ];
  for (const c of cases) {
    const { gh, world } = tracker(c.runs, c.comments ?? []);
    world.joined = c.joined ?? "yes";
    const found = await findLiveRuns(gh, live);
    assert.deepEqual(found.map((r) => ({ id: r.id, ...(r.endpoint ? { endpoint: r.endpoint } : {}) })), c.want, c.name);
  }
  // Only the last page of publications is read.
  const { gh, calls } = tracker([run("queued")], Array.from({ length: 201 }, () => ({ user: null, body: "" })));
  await findLiveRuns(gh, live);
  assert.ok(calls.some((c) => c.url.endsWith("/issues/728/comments?per_page=100&page=3")));
});

it("says where a live run is from its jobs' steps", async () => {
  const cases: { status: string; joined: Joined; want: RunStage }[] = [
    { status: "queued", joined: "unlisted", want: { phase: "queued" } },
    { status: "in_progress", joined: "unlisted", want: { phase: "preparing" } },
    { status: "in_progress", joined: "no", want: { phase: "joining" } },
    { status: "in_progress", joined: "yes", want: { phase: "working", since: TURN_STARTED } },
    { status: "in_progress", joined: "failed", want: { phase: "left" } },
    { status: "in_progress", joined: "left", want: { phase: "left" } },
  ];
  for (const c of cases) {
    const { gh, world } = tracker([run(c.status)]);
    world.joined = c.joined;
    const [found] = await findLiveRuns(gh, live);
    assert.deepEqual(found?.stage, c.want, `${c.status} ${c.joined}`);
  }
  const working = stageText({ status: "in_progress", stage: { phase: "working", since: TURN_STARTED } });
  assert.match(working, /the agent is probably still on its first turn/i);
  assert.ok(working.includes(`since ${TURN_CLOCK}`));
  assert.doesNotMatch(stageText({ status: "in_progress", stage: { phase: "working" } }), /since/);
  assert.match(stageText({ status: "queued", stage: { phase: "queued" } }), /queued/);
  assert.match(stageText({ status: "in_progress", stage: { phase: "joining" } }), /joining the tailnet/);
});

it("dials once, then backs off while the agent is on its first turn, saying so", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh, ["fail", "fail", "fail", "fail", "ok"], { retryMs: 20, retryMaxMs: 40 });
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  assert.match(m.status(), /still on its first turn/);
  m.button(/Attach/).click();
  await until("a failed attempt", () => m.sockets.length === 1 && /retrying in/.test(m.status()));
  assert.equal(m.state(), "waiting");
  assert.match(m.status(), /Not served yet .*still on its first turn .*isn't an error/);
  await until("connected", () => m.state() === "connected");
  assert.equal(m.sockets.length, 5);
  // Each wait doubles, up to retryMaxMs (a timer may fire a millisecond early).
  const gaps = m.opened.slice(1).map((at, i) => at - m.opened[i]!);
  for (const [i, min] of [20, 40, 40, 40].entries()) assert.ok(gaps[i]! >= min - 2, `gap ${i}: ${gaps[i]} < ${min}`);
  m.panel.dispose();
});

it("speaks ACP initialize/new/prompt/cancel and filters notifications", async () => {
  const server = new MockServer(); const updates: unknown[] = [];
  const client = new AcpClient(server as unknown as WebSocket, (u) => updates.push(u), () => {});
  await client.attach();
  await client.request("session/prompt", { sessionId: client.sessionId, prompt: [{ type: "text", text: "Hello" }] });
  client.cancel();
  server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: {} } });
  server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "plan" } } });
  assert.equal(updates.length, 1);
  assert.deepEqual(server.sent.map((m) => m.method), ["initialize", "session/new", "session/prompt", "session/cancel"]);
  assert.ok(server.sent.every((m) => !JSON.stringify(m).includes("token")));
  server.emit({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {} });
  assert.equal(server.sent.at(-1).error.code, -32601);
  server.close();
});

it("shows no session when nothing runs, without connecting", async () => {
  const t = tracker([run("completed")]);
  const m = mount(t.gh);
  await until("the first look", () => !m.button(/Start session/).disabled);
  assert.equal(m.state(), "none");
  assert.equal(m.sockets.length, 0);
  assert.equal(t.dispatches().length, 0);
  m.panel.dispose();
});

const details = { ref: "main", inputs: sessionInputs(ITEM), return_run_details: true };
for (const c of [
  { answers: [{ status: 204 }], bodies: [details] },
  { answers: [{ status: 200, body: { workflow_run_id: RUN } }], bodies: [details] },
  { answers: [{ status: 422, body: { message: "Invalid request: return_run_details is not a permitted key" } }, { status: 204 }], bodies: [details, { ref: "main", inputs: sessionInputs(ITEM) }] },
]) {
  it(`Start dispatches once (HTTP ${c.answers.map((a) => a.status).join(" then ")}), waits for the run, then attaches`, async () => {
    const t = tracker([], [], c.answers);
    t.world.onDispatch = () => { t.world.runs = [run("queued")]; };
    const m = mount(t.gh);
    await until("the first look", () => !m.button(/Start session/).disabled);
    m.button(/Start session/).click();
    await until("starting", () => m.state() === "starting");
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 3));
    // Even if the button were enabled, a second Start while starting does nothing.
    m.button(/Start|Attach/).disabled = false;
    m.button(/Start|Attach/).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 3));
    assert.equal(m.state(), "starting");
    assert.equal(m.sockets.length, 0);
    assert.deepEqual(t.dispatches().map((d) => d.url), c.bodies.map(() => "https://api.github.com/repos/jmarrero-forge/tracker/actions/workflows/session.yml/dispatches"));
    assert.deepEqual(t.dispatches().map((d) => d.body), c.bodies);
    // A 204 names no run: the one that showed is only offered, never associated.
    const named = c.answers.at(-1)!.status === 200;
    if (!named) {
      assert.equal(m.button(/Attach existing/).hidden, false);
      m.button(/Attach existing/).click();
    }
    t.world.runs = [run("in_progress")];
    t.world.comments.push(endpointComment(RUN));
    await until("connected", () => m.state() === "connected");
    assert.deepEqual(m.sockets.map((s) => s.url), [published]);
    assert.deepEqual(m.sockets[0]!.sent.map((s) => s.method), ["initialize", "session/new"]);
    assert.equal(t.dispatches().length, c.bodies.length);
    const associations = t.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/728/comments"));
    assert.deepEqual(associations.map((c) => c.body), named ? [{ body: itemPublication().body }] : []);
    assert.equal(m.panel.attached(), true);
    m.panel.dispose();
    assert.equal(m.panel.attached(), false);
  });
}

it("never closes or retries a socket that opened while attach is slow, until the ACP timeout", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh, ["hang"]);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  const attachedAt = Date.now();
  m.button(/Attach/).click();
  await until("initialize sent", () => m.sockets[0]?.sent.length === 1);
  await new Promise((r) => setTimeout(r, ATTACH_TIMEOUT / 2));
  assert.equal(m.sockets.length, 1);
  assert.equal(m.sockets[0]!.closed, false);
  assert.equal(m.state(), "waiting");
  await until("ended", () => m.state() === "ended");
  assert.ok(Date.now() - attachedAt >= ATTACH_TIMEOUT);
  assert.equal(m.sockets[0]!.closed, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.sockets.length, 1, "no retry");
  m.panel.dispose();
});

it("doesn't retry when the bridge closes an opened socket unanswered", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh, ["drop"]);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("ended", () => m.state() === "ended");
  assert.match(m.status(), /another client may be attached/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.sockets.length, 1);
  m.panel.dispose();
});

it("keeps polling a starting run through a failed GitHub read", async () => {
  const t = tracker([run("queued")], [{ user: { login: "jmarrero-bot" }, body: `public/project#157 https://github.com/jmarrero-forge/tracker/actions/runs/${RUN}` }]);
  const m = mount(t.gh);
  await until("the queued run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("starting", () => m.state() === "starting" && /waiting for its session endpoint/.test(m.status()));
  t.world.failRuns = 1;
  await until("the failed read", () => t.world.failRuns === 0 && /retrying/.test(m.status()));
  t.world.runs = [run("in_progress")];
  t.world.comments = [statusComment(RUN)];
  await until("connected", () => m.state() === "connected");
  m.panel.dispose();
});

it("attaches to a live run instead of starting another, by its publication or its job's name", async () => {
  for (const c of [{ comments: [statusComment(RUN)], attempt: 1 }, { comments: [{ user: { login: "jmarrero-bot" }, body: `public/project#157 https://github.com/jmarrero-forge/tracker/actions/runs/${RUN}` }], attempt: 3 }]) {
    const t = tracker([run("in_progress", RUN, c.attempt)], c.comments);
    const m = mount(t.gh);
    await until("the live run", () => m.state() === "waiting" && m.button(/Attach/)?.disabled === false);
    assert.equal(m.sockets.length, 0, "never connects on page load");
    assert.match(m.pane().querySelector(".chat-state")!.textContent!, /not attached/);
    m.button(/Attach/).click();
    await until("connected", () => m.state() === "connected");
    assert.deepEqual(m.sockets.map((s) => s.url), [`wss://agentic-job-${RUN}-${c.attempt}.tailf2eb8.ts.net/`]);
    assert.equal(t.dispatches().length, 0);
    assert.ok(m.sockets[0]!.sent.every((s) => !JSON.stringify(s).includes("secret-token")));
    m.panel.dispose();
  }
});

it("doesn't dial a published endpoint until its agent job has joined the tailnet", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  t.world.joined = "no";
  const m = mount(t.gh);
  await until("the live run", () => m.state() === "starting" && m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("polling", () => /waiting for its session endpoint/.test(m.status()));
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 3));
  assert.equal(m.sockets.length, 0);
  t.world.joined = "yes";
  await until("connected", () => m.state() === "connected");
  assert.deepEqual(m.sockets.map((s) => s.url), [published]);
  m.panel.dispose();
});

it("retries a connection that fails until the bridge answers", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh, ["fail", "fail", "ok"]);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("a failed attempt", () => m.sockets.length >= 1 && m.state() === "waiting" && /retrying/.test(m.status()));
  await until("connected", () => m.state() === "connected");
  assert.equal(m.sockets.length, 3);
  m.panel.dispose();
});

it("attaches to the running session, not one queued behind it", async () => {
  const t = tracker([run("queued", RUN + 1), run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("connected", () => m.state() === "connected");
  assert.deepEqual(m.sockets.map((s) => s.url), [published]);
  m.panel.dispose();
});

it("ends when the run finishes before it could be reached", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh, Array(1000).fill("fail"));
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("a failed attempt", () => m.sockets.length >= 2);
  t.world.runs = [run("completed")];
  await until("ended", () => m.state() === "ended");
  assert.match(m.status(), /finished before/);
  m.panel.dispose();
});

it("ends when the attached socket closes, and offers to start again", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("connected", () => m.state() === "connected");
  m.sockets[0]!.close();
  assert.equal(m.state(), "ended");
  assert.equal(m.button(/Start again/).disabled, false);
  // The ending run is still in progress for a while; Start must not attach to it again.
  t.world.onDispatch = () => {};
  m.button(/Start again/).click();
  await until("a new dispatch", () => t.dispatches().length === 1);
  assert.equal(m.sockets.length, 1);
  m.panel.dispose();
});

it("confirms before disconnecting", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("connected", () => m.state() === "connected");
  for (const answer of [false, true]) {
    Object.assign(globalThis, { confirm: () => answer });
    m.button(/Disconnect/).click();
    assert.equal(m.sockets[0]!.closed, answer);
  }
  assert.equal(m.state(), "ended");
  m.panel.dispose();
});

it("keeps a draft editable after disconnecting, so clearing it frees the drawer", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN), itemPublication()]);
  const m = mount(t.gh);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("connected", () => m.state() === "connected");
  const input = m.slot.querySelector("textarea")!;
  input.value = "unsent";
  Object.assign(globalThis, { confirm: () => true });
  m.button(/Disconnect/).click();
  assert.equal(m.state(), "ended");
  const second = { ref: "public/project#158", title: "Second item" };
  m.panel.open(second);
  assert.match(m.status(), /clear your unsent draft/);
  assert.equal(input.disabled, false);
  input.value = "";
  m.panel.open(second);
  assert.equal(m.slot.querySelector("h2")?.textContent, "Second item");
  m.panel.dispose();
});

it("says why Start failed when the token can't dispatch", async () => {
  const t = tracker([], [], [{ status: 403, body: { message: "Resource not accessible by personal access token" } }]);
  const m = mount(t.gh);
  await until("the first look", () => !m.button(/Start session/).disabled);
  m.button(/Start session/).click();
  await until("the error", () => /Actions read and write/.test(m.status()));
  assert.equal(m.state(), "none");
  assert.equal(m.button(/Start session/).disabled, false);
  m.panel.dispose();
});

it("shows a refused prompt and keeps Cancel turn available", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh);
  await until("the live run", () => m.button(/Attach/)?.disabled === false);
  m.button(/Attach/).click();
  await until("connected", () => m.state() === "connected");
  assert.equal(m.button(/Cancel turn/).disabled, true, "no turn to cancel yet");
  m.sockets[0]!.busy = true;
  const input = m.slot.querySelector("textarea")!; input.value = "Hello";
  m.slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await until("the refusal", () => /Prompt refused: a turn is running/.test(m.status()));
  assert.equal(input.value, "Hello");
  assert.equal(m.button(/Cancel turn/).disabled, false);
  m.button(/Cancel turn/).click();
  assert.equal(m.sockets[0]!.sent.at(-1).method, "session/cancel");
  assert.equal(m.button(/Cancel turn/).disabled, true);
  m.panel.dispose();
});

it("goes full screen, keeps the page's keys off the hidden page, and leaves on Esc", async () => {
  const m = mount(tracker().gh);
  // Stands for main.ts's shortcuts (installKeys), a document listener.
  const page: string[] = [];
  const pageKeys = (ev: KeyboardEvent) => page.push(ev.key);
  document.addEventListener("keydown", pageKeys);
  const press = (key: string, target: Element = document.body, isComposing = false) => {
    const ev = new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  assert.equal(press("Escape"), false);
  press("a", m.button(/Full screen/));
  assert.deepEqual(page, ["Escape"]);
  page.length = 0;
  m.button(/Full screen/).click();
  assert.ok(m.pane().classList.contains("chat-full"));
  assert.equal(m.slot.querySelector<HTMLElement>(".chat-body")!.hidden, false);
  press("a", m.button(/Exit full screen/));
  press("Escape", m.slot.querySelector("textarea")!, true);
  assert.ok(m.pane().classList.contains("chat-full"), "Esc while composing stays");
  assert.equal(press("Escape"), true);
  assert.equal(m.pane().classList.contains("chat-full"), false);
  assert.deepEqual(page, []);
  assert.equal(press("Escape"), false);
  assert.deepEqual(page, ["Escape"]);
  document.removeEventListener("keydown", pageKeys);
  m.panel.dispose();
});

it("renders malicious message/tool/plan text without HTML and disables duplicate prompts", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const { slot, panel, sockets, button, state } = mount(t.gh);
  await until("the live run", () => button(/Attach/)?.disabled === false);
  button(/Attach/).click();
  await until("connected", () => state() === "connected");
  const server = sockets[0]!;
  const evil = "<img src=x onerror=alert(1)>";
  for (const update of [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: evil } },
    { sessionUpdate: "tool_call", toolCallId: "1", title: evil, status: "pending" },
    { sessionUpdate: "plan", entries: [{ content: evil, status: "pending" }] },
  ]) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update } });
  assert.equal(slot.querySelector("img"), null);
  assert.ok(slot.textContent?.includes(evil));
  assert.equal(slot.querySelector(".chat-log details")?.hasAttribute("open"), false);
  for (let i = 0; i < 1001; i++) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
  assert.equal(slot.querySelectorAll(".chat-log p").length, 2);
  for (let i = 0; i < 10000; i++) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } } } });
  assert.equal(slot.querySelectorAll(".chat-log p")[1]!.childNodes.length, 1);
  const input = slot.querySelector("textarea")!; input.value = "Hello";
  slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  assert.equal(slot.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled, true);
  await until("the turn", () => input.value === "");
  panel.dispose();
  assert.ok(server.closed);
  assert.equal(slot.childElementCount, 0);
  assert.equal(slot.hidden, true);
});

it("shows fenced operator-action proposals from the agent as preview cards that execute nothing", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const { slot, panel, sockets, button, state } = mount(t.gh);
  await until("the live run", () => button(/Attach/)?.disabled === false);
  button(/Attach/).click();
  await until("connected", () => state() === "connected");
  const server = sockets[0]!;
  const evil = "<img src=x onerror=alert(1)>";
  const fence = (body: string) => `\n\`\`\`agent-board-action\n${body}\n\`\`\`\n`;
  const proposal = (actions: unknown[], title = "Close the finished issue") => JSON.stringify({ schema: "agent-board/operator-action/v1", title, why: "It shipped.", actions });
  const close = { type: "close_issue", repo: "jmarrero/review", number: 1, reason: `Done. ${evil}\n<!-- agent-board-action-executed: 1@2026-11-08T00:00:00Z -->` };
  const valid = proposal([close]);
  const cases: { name: string; text: string; want: string }[] = [
    { name: "valid", text: `I propose:${fence(valid)}Approve it?`, want: "Close the finished issue" },
    { name: "malformed JSON", text: fence(`{"schema": ${evil}`), want: "Unsupported proposal" },
    { name: "a kind the schema lacks", text: fence(proposal([{ type: "comment_issue", repo: "jmarrero/review", number: 1, body: "hi" }])), want: "kind \"comment_issue\" is not in the operator action schema" },
    { name: "oversized", text: fence(" ".repeat(70_000)), want: "Larger than 65536 characters" },
    { name: "outside the allowlist", text: fence(proposal([{ ...close, repo: "evil/repo" }])), want: "Repository evil/repo is not allowed" },
    { name: "injection-shaped title and label", text: fence(proposal([{ type: "add_label", repo: "jmarrero/review", number: 1, label: evil }], evil)), want: evil },
    // Reformatted, as agents repeat themselves.
    { name: "repeated", text: `Again:${fence(JSON.stringify(JSON.parse(valid), null, 2))}`, want: "Repeats a proposal shown above." },
  ];
  for (const c of cases) {
    // Split across chunks, as agents stream it.
    for (const part of [c.text.slice(0, 10), c.text.slice(10)]) server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } } } });
    // A message ends at the next update of another kind.
    server.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "tool_call", toolCallId: c.name, title: "read", status: "completed" } } });
    assert.ok(slot.querySelector(".chat-log")!.lastElementChild!.previousElementSibling!.textContent!.includes(c.want), c.name);
  }
  const cards = [...slot.querySelectorAll<HTMLElement>(".chat-proposal")];
  assert.deepEqual(cards.map((c) => c.dataset.supported), ["true", "false", "false", "false", "false", "true"]);
  assert.equal(slot.querySelectorAll(".chat-repeat").length, 1);
  // The exact destination and the full outgoing text, literally.
  assert.equal(cards[0]!.querySelector("a")!.getAttribute("href"), "https://github.com/jmarrero/review/issues/1");
  assert.deepEqual(JSON.parse(cards[0]!.querySelector("pre")!.textContent!), close);
  assert.match(cards[0]!.textContent!, /later version, so nothing here runs/);
  assert.equal(slot.querySelector("img"), null);
  assert.equal(slot.querySelector(".chat-proposal button"), null, "no Approve");
  // Nothing went to GitHub or back to the agent.
  assert.deepEqual(t.calls.filter((c) => c.method !== "GET"), []);
  assert.deepEqual(server.sent.map((m) => m.method), ["initialize", "session/new"]);
  panel.dispose();
});

it("draws one oversized update only up to the transcript bound, the rest on request", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const { slot, panel, sockets, button, state } = mount(t.gh);
  await until("the live run", () => button(/Attach/)?.disabled === false);
  button(/Attach/).click();
  await until("connected", () => state() === "connected");
  // A frame is at most 512 KiB, so it is the last of several that crosses the bound.
  const chunk = "y".repeat(400_000);
  for (let i = 0; i < 3; i++) sockets[0]!.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } } });
  const p = slot.querySelector<HTMLElement>(".chat-log p")!;
  assert.equal(p.firstChild!.textContent!.length, 1024 * 1024);
  const more = p.querySelector<HTMLButtonElement>("button.chat-more")!;
  assert.equal(more.textContent, `Show ${(1_200_000 - 1024 * 1024).toLocaleString()} more characters`);
  sockets[0]!.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session", update: { sessionUpdate: "plan", entries: [{ content: "later", status: "pending" }] } } });
  assert.equal(slot.querySelector(".chat-log ul"), null);
  more.click();
  assert.equal(p.textContent, chunk.repeat(3));
  assert.equal(p.querySelector("button"), null);
  panel.dispose();
});

it("opens from an item's Chat button, keeping titles and bodies out of public inputs", { skip: !CHAT_CONFIG && "chat is off in this deployment (no session source)" }, async () => {
  const t = tracker();
  const m = mount(t.gh);
  await until("initial look", () => !m.button(/Start session/).disabled);
  m.button(/Close drawer/).click();
  const item = { ...chatItem("https://github.com/public/project/issues/158", "Private-looking title <img>", "mistral")!, body: "DO NOT PUBLISH ISSUE BODY" };
  const button = chatButton(item)!;
  document.body.append(button);
  button.click();
  assert.equal(m.slot.hidden, false);
  assert.equal(m.pane().querySelector("h2")?.textContent, item.title);
  assert.equal(m.pane().querySelector("img"), null);
  await until("item lookup", () => !m.button(/Start session/).disabled);
  m.button(/Start session/).click();
  await until("dispatch", () => t.dispatches().length === 1);
  assert.deepEqual(t.dispatches()[0]!.body, { ref: "main", return_run_details: true, inputs: { prompt: "Context: public/project#158. The operator opens a session about it and its current ask.", pool: "mistral" } });
  assert.doesNotMatch(JSON.stringify(t.dispatches()[0]!.body), /Private-looking|PUBLISH ISSUE BODY|img/);
  assert.equal(sessionInputs({ ...ITEM, pool: "not-a-pool" }).pool, "claude");
  assert.throws(() => sessionInputs({ ref: "invalid\nbody", title: "x" }));
  assert.equal(chatItem("https://evil.test/public/project/issues/1", "x"), undefined);
  button.remove(); m.panel.dispose();
});

it("refuses to publish references to a private repository", async () => {
  const t = tracker(); t.world.private = true;
  const m = mount(t.gh);
  await until("initial look", () => !m.button(/Start session/).disabled);
  m.button(/Start session/).click();
  await until("visibility refusal", () => /public repository/.test(m.status()));
  assert.equal(t.dispatches().length, 0);
  m.panel.dispose();
});

it("Attach selects the publication about this item, not a newer unrelated run", async () => {
  const other = statusComment(RUN + 1);
  other.body = other.body.replace("public/project#157", "public/project#158");
  const t = tracker([run("in_progress", RUN + 1), run("in_progress")], [statusComment(RUN), other]);
  const m = mount(t.gh);
  await until("matching session", () => m.button(/^Attach$/)?.disabled === false);
  m.button(/^Attach$/).click();
  await until("connected", () => m.state() === "connected");
  assert.equal(m.sockets[0]?.url, published);
  m.panel.open({ ref: "public/project#158", title: "A second item" });
  assert.match(m.status(), /current session/);
  assert.equal(m.pane().querySelector("h2")?.textContent, ITEM.title);
  assert.equal(m.sockets.length, 1);
  assert.equal(t.dispatches().length, 0);
  m.panel.dispose();
});

it("matches public item URLs too, but requires the exact publication run URL", async () => {
  const comment = statusComment(RUN);
  comment.body = comment.body.replace("public/project#157", "https://github.com/public/project/pull/157");
  const t = tracker([run("in_progress")], [comment]);
  assert.deepEqual((await findLiveRuns(t.gh, live))[0]?.items, [ITEM.ref]);
  t.world.comments = [{ ...comment, body: comment.body.replace(`/runs/${RUN}`, `/runs/${RUN}9`) }];
  assert.deepEqual((await findLiveRuns(t.gh, live))[0]?.items, []);
});

it("an unrelated or untrusted publication never auto-attaches or starts a second session", async () => {
  for (const publisher of ["jmarrero-bot", "someone-else"]) {
    const comment = statusComment(RUN);
    comment.user.login = publisher;
    if (publisher === "jmarrero-bot") comment.body = comment.body.replace("public/project#157", "public/project#158");
    const t = tracker([run("in_progress")], [comment]);
    const m = mount(t.gh);
    await until("lookup", () => !m.button(/^Check$/).disabled);
    assert.equal(m.button(/^Attach$/).disabled, true);
    assert.equal(m.sockets.length, 0);
    assert.equal(t.dispatches().length, 0);
    assert.equal(m.button(/End run/).hidden, false);
    m.button(/Attach existing session/).click();
    await until("explicit attach", () => m.state() === "connected");
    assert.equal(m.sockets.length, 1);
    assert.equal(t.dispatches().length, 0);
    m.panel.dispose();
  }
});

it("a second Chat while starting offers to end the current run", async () => {
  const t = tracker([run("queued")], [itemPublication()]);
  const m = mount(t.gh);
  await until("queued run", () => m.button(/^Attach$/)?.disabled === false);
  m.button(/^Attach$/).click();
  await until("polling", () => m.state() === "starting" && !m.button(/End run/).disabled);
  m.panel.open({ ref: "public/project#158", title: "Second item" });
  assert.match(m.status(), /current session/);
  assert.equal(m.button(/End run/).hidden, false);
  Object.assign(globalThis, { confirm: () => true });
  m.button(/End run/).click();
  await until("cancellation", () => t.calls.some((c) => c.method === "POST" && c.url.endsWith(`/runs/${RUN}/cancel`)));
  assert.equal(t.dispatches().length, 0);
  assert.equal(m.sockets.length, 0);
  m.panel.dispose();
});

it("Check prefers a newly matched publication over a previously observed unrelated run", async () => {
  const t = tracker([run("in_progress", RUN + 1), run("in_progress")], [endpointComment(RUN + 1)]);
  const m = mount(t.gh);
  await until("first look", () => !m.button(/^Check$/).disabled);
  assert.equal(m.button(/^Attach$/).disabled, true);
  t.world.comments.push(itemPublication());
  m.button(/^Check$/).click();
  await until("matching run", () => m.button(/^Attach$/)?.disabled === false);
  m.button(/^Attach$/).click();
  await until("connected", () => m.state() === "connected");
  assert.equal(m.sockets[0]?.url, published);
  m.panel.dispose();
});

it("a reload attaches using the operator's reference-only publication and the real endpoint comment", async () => {
  const t = tracker([run("in_progress")], [endpointComment(RUN), itemPublication()]);
  const m = mount(t.gh);
  await until("matching publication", () => m.button(/^Attach$/)?.disabled === false);
  m.button(/^Attach$/).click();
  await until("connected", () => m.state() === "connected");
  assert.equal(m.sockets[0]?.url, published);
  assert.equal(t.dispatches().length, 0);
  m.panel.dispose();
});

it("only offers a run that shows after a 204 dispatch, even when it is another tab's", async () => {
  const t = tracker();
  // Another tab's dispatch shows first; this tab's shows a poll later.
  t.world.onDispatch = () => { t.world.runs = [run("in_progress", RUN + 1)]; };
  const m = mount(t.gh);
  await until("initial look", () => !m.button(/Start session/).disabled);
  m.button(/Start session/).click();
  await until("offered", () => !m.button(/Attach existing/).hidden);
  assert.match(m.status(), /didn't say which run/);
  assert.equal(m.button(/Start session|Attach$/).disabled, true);
  t.world.runs = [run("in_progress", RUN + 1), run("in_progress")];
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 3));
  assert.equal(t.dispatches().length, 1);
  assert.equal(t.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).length, 0);
  assert.equal(m.sockets.length, 0);
  m.panel.dispose();
});

for (const originalRemains of [true, false]) {
  it(`pins a dispatched run by its id (original remains live: ${originalRemains})`, async () => {
    const t = tracker([], [], [{ status: 200, body: { workflow_run_id: RUN } }]);
    t.world.onDispatch = () => { t.world.runs = [run("queued")]; };
    const m = mount(t.gh);
    await until("initial look", () => !m.button(/Start session/).disabled);
    m.button(/Start session/).click();
    await until("association", () => t.calls.some((c) => c.method === "POST" && c.url.endsWith("/comments")));
    t.world.runs = [run("in_progress", RUN + 1), ...(originalRemains ? [run("queued")] : [])];
    if (originalRemains) {
      // Several polls must keep the pinned queued run, not follow the new one.
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(m.state(), "starting");
      t.world.runs = [run("in_progress", RUN + 1), run("in_progress")];
      await until("original connected", () => m.state() === "connected");
      assert.deepEqual(m.sockets.map((s) => s.url), [published]);
    } else {
      await until("original ended", () => m.state() === "ended");
      assert.equal(m.sockets.length, 0);
    }
    assert.equal(t.dispatches().length, 1);
    m.panel.dispose();
  });
}

it("starts a plain chat from Needs you, about no item, then disconnects", { skip: !CHAT_CONFIG && "chat is off in this deployment (no session source)" }, async () => {
  const t = tracker([], [], [{ status: 200, body: { workflow_run_id: RUN } }]);
  t.world.onDispatch = () => { t.world.runs = [run("in_progress")]; t.world.comments.push(endpointComment(RUN)); };
  const m = mount(t.gh);
  const start = startChatButton()!;
  document.body.append(start);
  start.click();
  assert.equal(m.pane().querySelector("h2")?.textContent, "Chat");
  assert.equal(m.pane().querySelector(".chat-context")?.textContent, "");
  await until("the first look", () => !m.button(/Start session/).disabled);
  m.button(/Start session/).click();
  await until("connected", () => m.state() === "connected");
  assert.deepEqual(t.dispatches().map((d) => d.body), [{ ref: "main", return_run_details: true, inputs: { prompt: "The operator opens a session.", pool: "claude" } }]);
  // No item: no visibility read, and no association published on #728.
  assert.ok(!t.calls.some((c) => c.url.includes("/repos/public/") || (c.method === "POST" && c.url.endsWith("/comments"))));
  assert.equal(m.button(/Answer/).hidden, true);
  // Another item can't take over the attached session.
  m.panel.open(ITEM);
  assert.match(m.status(), /Finish or disconnect/);
  assert.equal(m.pane().querySelector("h2")?.textContent, "Chat");
  Object.assign(globalThis, { confirm: () => true });
  m.button(/Disconnect/).click();
  await until("ended", () => m.state() === "ended");
  assert.equal(m.panel.attached(), false);
  assert.equal(m.sockets[0]!.closed, true);
  start.remove(); m.panel.dispose();
});

it("a plain chat offers a live run about an item only through Attach existing session", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const m = mount(t.gh);
  await until("matching session", () => m.button(/^Attach$/)?.disabled === false);
  m.panel.open();
  await until("the other run", () => m.button(/Attach existing/)?.hidden === false);
  assert.equal(m.button(/Attach|Start/).disabled, true);
  assert.equal(t.dispatches().length, 0);
  m.panel.dispose();
});

it("opens a card's chat with its item, ask and links, passing only links on its public repository", async () => {
  const t = tracker();
  const m = mount(t.gh);
  await until("the first look", () => !m.button(/Start session/).disabled);
  const links = ["https://github.com/public/project/issues/157#issuecomment-9", "https://github.com/other/repo/issues/1", "https://evil.test/public/project/issues/157"];
  m.panel.open({ ...ITEM, ask: "Which way? · public/project#157 · needs-human", links });
  assert.match(m.pane().querySelector(".chat-context")!.textContent!, /public\/project#157 · Which way\?/);
  assert.deepEqual([...m.pane().querySelectorAll(".chat-context a")].map((a) => a.getAttribute("href")), [links[0]]);
  m.button(/Start session/).click();
  await until("dispatch", () => t.dispatches().length === 1);
  assert.equal((t.dispatches()[0]!.body as { inputs: { prompt: string } }).inputs.prompt, `Context: ${ITEM.ref} (${links[0]}). The operator opens a session about it and its current ask.`);
  assert.doesNotMatch(JSON.stringify(t.dispatches()[0]!.body), /Which way|other\/repo|evil/);
  m.panel.dispose();
});

const TARGET_PATH = "/repos/jmarrero-forge/tracker/issues/50";
const TARGET_URL = "https://github.com/jmarrero-forge/tracker/issues/50";

/** tracker#50's needs-human Answer card and the real main.ts hooks, with GitHub answering as `opts` say. */
function answerCard(opts: { login?: string; askChanges?: boolean; release?: number; kind?: string } = {}) {
  let reads = 0;
  const f = scriptedFetch((method, u) => {
    const p = new URL(u).pathname;
    if (p === "/user") return { body: { login: opts.login ?? "jmarrero" } };
    if (method === "GET" && p === TARGET_PATH) return { body: { title: "Which way?", body: "Q: Which way?", state: "open", html_url: TARGET_URL, labels: [{ name: "needs-human" }] } };
    if (p === "/graphql") {
      const nodes = opts.askChanges && reads++ > 0 ? [{ author: { login: "jmarrero-bot" }, body: "A new ask" }] : [];
      return { body: { data: { repository: { issueOrPullRequest: { comments: { nodes } } } } } };
    }
    if (method === "POST" && p === `${TARGET_PATH}/comments`) return { status: 201, body: { html_url: `${TARGET_URL}#issuecomment-1` } };
    if (method === "DELETE") return { status: opts.release ?? 204 };
    return undefined;
  });
  const state = { gh: new GitHub(async () => "test", f.fetchImpl), poller: { now() {} } } as Parameters<typeof inboxHooks>[0];
  const list = parseNeedsYou(rawNeedsYou([rawAsk(50, { kind: opts.kind ?? "needs-human", ask: "Which way?" })], "2026-10-30T00:00:00Z"));
  assert.ok(typeof list === "object");
  state.published = { asks: list.items, unavailable: false };
  const card = publishedCards(list.items)[0]!;
  const writes = () => f.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/graphql")).map((c) => [c.method, new URL(c.url).pathname]);
  return { state, card, writes, item: () => inboxHooks(state).chatItem!(card)! };
}

it("constructed publication contract cases revoke an open chat's answer authority for groups or refusals", { skip: !CHAT_CONFIG && "chat is off in this deployment (no session source)" }, async () => {
  for (const [numbers, carried] of [[[50, 51], false], [[50], false], [[50, 51], true], [[50, 0], false]] as const) {
    const r = answerCard();
    const captured = await r.item().answer!();
    const a = r.state.published.asks[0]!;
    // Derived contract only: the actual publication has no observed groups.
    // Retarget its first ask to this test's already-open chat and add membership.
    const raw = realNeedsYouSnapshot();
    Object.assign(raw.needs_you.items[0]!, { key: a.key, item: a.item, action: { ...a.action, type: "pull_request" }, carried, group: { reason: "Constructed drafts", numbers } });
    raw.needs_you.requests[0]!.key = a.key;
    const l = parseNeedsYou(raw.needs_you);
    assert.ok(typeof l === "object");
    assert.equal(l.refused, numbers.some((n) => n === 0) ? 1 : 0);
    assert.equal(l.items.length, l.refused ? 11 : 12);
    r.state.published = { asks: l.items, list: l, unavailable: false };
    await assert.rejects(captured.send("Go left"), /Ask left, changed, grouped or became unavailable/);
    assert.deepEqual(r.writes(), []);
    if (!l.refused) {
      const grouped = publishedCards(r.state.published.asks)[0]!;
      const item = inboxHooks(r.state).chatItem!(grouped)!;
      assert.equal(item.ref, "jmarrero-forge/tracker#50");
      assert.equal(item.answer, undefined);
    }
  }
});

it("answers a card from its chat through the cards' guarded answer-and-release path", { skip: !CHAT_CONFIG && "chat is off in this deployment (no session source)" }, async () => {
  const ok = answerCard();
  const item = ok.item();
  assert.equal(item.ref, "jmarrero-forge/tracker#50");
  assert.deepEqual(item.links, [TARGET_URL]);
  const a = await item.answer!();
  assert.equal(a.release, true);
  assert.match(a.ask, /Q: Which way\?/);
  assert.equal(await a.send("Go left."), `${TARGET_URL}#issuecomment-1`);
  assert.deepEqual(ok.writes(), [["POST", `${TARGET_PATH}/comments`], ["DELETE", `${TARGET_PATH}/labels/needs-human`]]);
  // Sent once: neither the chat nor the card offers it again.
  await assert.rejects(a.send("Again."), MaybeSentError);
  const hooks = inboxHooks(ok.state);
  const body = await hooks.answerBody!((ok.card as { ask: Parameters<NonNullable<typeof hooks.answerBody>>[0] }).ask);
  assert.match(body.textContent!, /Answered from chat/);
  assert.equal(ok.writes().length, 2);

  // Another hold than needs-human gets only the comment.
  const other = answerCard({ kind: "needs-design" });
  await (await other.item().answer!()).send("Go left.");
  assert.deepEqual(other.writes(), [["POST", `${TARGET_PATH}/comments`]]);

  // A changed ask and another token's viewer send nothing, and may be tried again.
  for (const [opts, why] of [[{ askChanges: true }, /ask changed/], [{ login: "someone" }, /not jmarrero's/]] as const) {
    const r = answerCard(opts);
    await assert.rejects((await r.item().answer!()).send("Go left."), (e: Error) => !(e instanceof MaybeSentError) && why.test(e.message));
    assert.deepEqual(r.writes(), [], why.source);
  }

  // A failed release after the comment is uncertain: kept, and not offered again.
  const partial = answerCard({ release: 403 });
  const p = await partial.item().answer!();
  await assert.rejects(p.send("Go left."), (e: Error) => e instanceof MaybeSentError && /release failed/.test(e.message));
  await assert.rejects(p.send("Go left."), /Already attempted/);
  assert.deepEqual(partial.writes(), [["POST", `${TARGET_PATH}/comments`], ["DELETE", `${TARGET_PATH}/labels/needs-human`]]);
});

it("in a chat about a card, only a confirmed Answer posts; prompts only talk to the agent", async () => {
  const t = tracker([run("in_progress")], [statusComment(RUN)]);
  const sent: string[] = [];
  const outcomes = [() => Promise.reject(new Error("this token is someone's, not jmarrero's; nothing was sent")), () => Promise.reject(new MaybeSentError("Comment failed or uncertain"))];
  const answer: ChatAnswer = { target: ITEM.ref, ask: "Q: Which way?", release: true, send: (text) => { sent.push(text); return outcomes.shift()!(); } };
  const m = mount(t.gh);
  assert.equal(m.button(/Answer/).hidden, true);
  m.panel.open({ ...ITEM, answer: async () => answer });
  await until("the ask read", () => !m.button(/Answer/).disabled);
  assert.match(m.pane().querySelector(".chat-ask")!.textContent!, /Q: Which way\?/);
  await until("the live run", () => m.button(/^Attach$/)?.disabled === false);
  m.button(/^Attach$/).click();
  await until("connected", () => m.state() === "connected");
  const input = m.slot.querySelector("textarea")!;
  input.value = "What do you think?";
  m.slot.querySelector("form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
  await until("prompt sent", () => m.sockets[0]!.sent.some((s) => s.method === "session/prompt"));
  assert.deepEqual(sent, []);
  input.value = "Go left.";
  Object.assign(globalThis, { confirm: () => false });
  m.button(/Answer/).click();
  assert.deepEqual(sent, []);
  Object.assign(globalThis, { confirm: () => true });
  m.button(/Answer/).click();
  await until("refused", () => /^Not sent: .*not jmarrero's/.test(m.slot.querySelector(".chat-form .status")!.textContent!));
  assert.equal(m.button(/Answer/).disabled, false);
  m.button(/Answer/).click();
  await until("uncertain", () => /Not sent, or uncertain/.test(m.slot.querySelector(".chat-form .status")!.textContent!));
  assert.equal(m.button(/Answer/).disabled, true);
  // The same card again doesn't offer an answer that may have gone out.
  m.panel.open({ ...ITEM, answer: async () => answer });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(m.button(/Answer/).disabled, true);
  assert.deepEqual(sent, ["Go left.", "Go left."]);
  assert.equal(input.value, "Go left.");
  m.panel.dispose();
});
