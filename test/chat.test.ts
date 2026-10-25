import assert from "node:assert/strict";
import { it } from "node:test";
import { AcpClient, TAILNET_STEP, chatPanel, derivedEndpoint, findLiveRuns, stageText, type ChatTiming, type RunStage } from "../src/github/chat.ts";
import { CHAT_CONFIG, chatEndpoint, parseChatConfig, type ChatConfig } from "../src/github/chatconfig.ts";
import { GitHub } from "../src/github/api.ts";
import { installDom, scriptedFetch } from "./helpers.ts";

const win = installDom();
const config = { tailnetDomain: "example.ts.net", sources: [{ repo: "owner/repo", workflow: "session.yml", issue: 1, publisher: "publisher" }] };
// The shipped configuration's shape, with the session wrapper's real status comment.
const live: ChatConfig = { tailnetDomain: "tailf2eb8.ts.net", sources: [{ repo: "cgwalters-forge/tracker", workflow: "session.yml", issue: 728, publisher: "github-actions[bot]" }] };
const RUN = 39062677132;
const statusComment = (id: number) => ({
  user: { login: "github-actions[bot]" },
  body: `⏳ [session](https://github.com/cgwalters-forge/tracker/actions/runs/${id}) is running. Session: after the task's turn the operator attaches at \`wss://agentic-job-${id}-1.tailf2eb8.ts.net/\`, once the agent job's summary shows it served.\n\n<!-- agentic-job-run: ${id} -->\n\n<!-- agentic-job-status -->`,
});
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

interface Run { id: number; run_attempt: number; status: string; display_title: string }
const run = (status: string, id = RUN, run_attempt = 1): Run => ({ id, run_attempt, status, display_title: "Operator session (claude)" });

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
  const world = { runs, comments, dispatch, onDispatch: () => {}, failRuns: 0, joined: "yes" as Joined };
  let posts = 0;
  const { fetchImpl, calls } = scriptedFetch((method, url) => {
    if (method === "POST" && url.endsWith("/actions/workflows/session.yml/dispatches")) {
      const answer = world.dispatch[Math.min(posts++, world.dispatch.length - 1)]!;
      if (answer.status < 300) world.onDispatch();
      return answer;
    }
    if (method !== "GET") return undefined;
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
  return { world, calls, gh, dispatches: () => calls.filter((c) => c.method === "POST") };
}

function mount(gh: GitHub, modes: Mode[] = [], timing: Partial<ChatTiming> = {}) {
  const sockets: MockSocket[] = [];
  const opened: number[] = [];
  const socketFactory = (url: string) => { const s = new MockSocket(url, modes[sockets.length] ?? "ok"); sockets.push(s); opened.push(performance.now()); return s as unknown as WebSocket; };
  const panel = chatPanel(gh, { config: live, socketFactory, timing: { ...FAST, ...timing } })!;
  const slot = document.createElement("div");
  document.body.append(slot);
  panel.mount(slot);
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
  // jmarrero-forge/tracker has no session workflow yet, so chat is off.
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

const details = { ref: "main", return_run_details: true };
for (const c of [
  { answers: [{ status: 204 }], bodies: [details] },
  { answers: [{ status: 200, body: { workflow_run_id: RUN } }], bodies: [details] },
  { answers: [{ status: 422, body: { message: "Invalid request: return_run_details is not a permitted key" } }, { status: 204 }], bodies: [details, { ref: "main" }] },
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
    assert.deepEqual(t.dispatches().map((d) => d.url), c.bodies.map(() => "https://api.github.com/repos/cgwalters-forge/tracker/actions/workflows/session.yml/dispatches"));
    assert.deepEqual(t.dispatches().map((d) => d.body), c.bodies);
    t.world.runs = [run("in_progress")];
    t.world.comments = [statusComment(RUN)];
    await until("connected", () => m.state() === "connected");
    assert.deepEqual(m.sockets.map((s) => s.url), [published]);
    assert.deepEqual(m.sockets[0]!.sent.map((s) => s.method), ["initialize", "session/new"]);
    assert.equal(t.dispatches().length, c.bodies.length);
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
  const t = tracker([run("queued")]);
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
  for (const c of [{ comments: [statusComment(RUN)], attempt: 1 }, { comments: [], attempt: 3 }]) {
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
  assert.deepEqual(page, ["Escape", "a"]);
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
