// The session chat pane, atop the page: start (or find) a session run of a
// configured workflow, wait for its bridge, and talk to it over ACP.
//
// A session run serves one ACP client over a WebSocket in the tailnet; when
// that client leaves, the run ends. So the pane only connects after the
// operator asks it to here (Start or Attach), never on page load, and it
// never dispatches a run while one is already live: it attaches to it.

import { h } from "../dom.ts";
import { GitHubError, type GitHub } from "./api.ts";
import { CHAT_CONFIG, DEFAULT_REF, chatEndpoint, type ChatConfig, type ChatSource } from "./chatconfig.ts";

export interface ChatPanel {
  mount(slot: HTMLElement): void;
  dispose(): void;
  /** Whether a session is attached: disposing would end its run. */
  attached(): boolean;
  /** Use a new sign-in's client for GitHub reads and dispatches. */
  useGitHub(gh: GitHub): void;
}

export interface ChatOptions {
  /** The repository's configuration (CHAT_CONFIG when absent); undefined disables chat. */
  config?: ChatConfig | undefined;
  socketFactory?: (url: string) => WebSocket;
  timing?: Partial<ChatTiming>;
}

/**
 * none: no live run. starting: a run was dispatched or is queued/running,
 * with no endpoint yet. waiting: the endpoint is known; connecting (with
 * retries, while the bridge and its certificate come up). connected:
 * attached. ended: the attached session closed, or the run finished.
 */
export type ChatState = "none" | "starting" | "waiting" | "connected" | "ended";

/** Run statuses of a run that hasn't finished (`completed` is the only final one). */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/** How many of a workflow's newest runs are looked at for a live one. */
const RUNS_PER_PAGE = 10;
/** Largest publication comment body read. */
const MAX_COMMENT = 65536;

export interface LiveRun {
  source: ChatSource;
  id: number;
  attempt: number;
  status: string;
  title: string;
  /** The run's page on github.com. */
  url: string;
  endpoint?: string;
  /** Where the run is, from its jobs' steps, for the status line. */
  stage: RunStage;
}

/**
 * queued: the run hasn't started (any live status but in_progress). preparing: no job lists the tailnet step
 * yet. joining: the agent job is joining the tailnet. working: it has
 * joined, and `since` is when its current step started: the task's first
 * turn, after which the run serves the session (agentic-job serves it only
 * then, and says so only in the job summary, which has no API). left: the
 * agent job has finished or failed to join.
 */
export interface RunStage {
  phase: "queued" | "preparing" | "joining" | "working" | "left";
  since?: string;
}

export interface ChatTiming {
  /** First wait between polls while a run starts; it grows to pollMaxMs. */
  pollMs: number;
  pollMaxMs: number;
  /** Give up waiting for a run to show an endpoint after this long. */
  startLimitMs: number;
  /** Give up on a dispatch whose run hasn't shown up after this long. */
  appearLimitMs: number;
  /**
   * First wait between connection attempts once the endpoint is known; it
   * doubles to retryMaxMs. The endpoint resolves when the agent job joins
   * the tailnet, but is served only after the task's first turn, which can
   * take many minutes: dialing every few seconds meanwhile only filled the
   * browser's console with refused connections.
   */
  retryMs: number;
  retryMaxMs: number;
  /** Give up connecting after this long: longer than a first turn. */
  waitLimitMs: number;
  /** One connection attempt's limit, until the socket opens. */
  openTimeoutMs: number;
  /**
   * Each of initialize and session/new, once the socket is open. Closing
   * an open socket ends the run, so this is generous.
   */
  attachTimeoutMs: number;
}

export const CHAT_TIMING: ChatTiming = {
  pollMs: 5_000,
  pollMaxMs: 30_000,
  startLimitMs: 20 * 60_000,
  appearLimitMs: 2 * 60_000,
  retryMs: 5_000,
  retryMaxMs: 60_000,
  waitLimitMs: 30 * 60_000,
  openTimeoutMs: 15_000,
  attachTimeoutMs: 120_000,
};

/**
 * The endpoint a run's agent job serves, by its deterministic tailnet name.
 * Used only until the publisher's comment names one.
 */
export function derivedEndpoint(id: number, attempt: number, domain: string): string | undefined {
  return chatEndpoint(`wss://agentic-job-${id}-${attempt}.${domain}/`, domain);
}

/** The endpoint the publisher's newest comment gives for a run, if any. */
function publishedEndpoint(comments: readonly { body: string; user: { login: string } | null }[], source: ChatSource, runUrl: string, domain: string): string | undefined {
  for (const comment of comments.slice(-100).reverse()) {
    if (comment.user?.login !== source.publisher || typeof comment.body !== "string" || comment.body.length > MAX_COMMENT) continue;
    const urls: string[] = comment.body.match(/(?:https|wss):\/\/[^\s<>\x60)\]]+/g) ?? [];
    if (!urls.includes(runUrl)) continue;
    const endpoint = urls.map((u) => chatEndpoint(u, domain)).find(Boolean);
    if (endpoint) return endpoint;
  }
  return undefined;
}

/**
 * The step of the agentic-job agent job after which its tailnet name
 * resolves. A run is in progress, and its endpoint published, a minute or
 * more before then; dialing the name meanwhile only gets NXDOMAIN, which a
 * resolver may keep answering after the node arrives (an iPhone that started
 * a session this way never reached its bridge).
 */
export const TAILNET_STEP = "Join the tailnet";

type RawStep = { name: string; status: string; conclusion: string | null; started_at?: string | null };

/**
 * Where an in-progress run's agent job is: on the tailnet (working) once the
 * step has succeeded and until the job finishes, joining before then, left
 * if it failed or after, and preparing when no job lists the step, as
 * before its job starts or if the step is renamed.
 */
async function runStage(gh: GitHub, base: string, id: number): Promise<RunStage> {
  const res = await gh.get<{ jobs?: { status: string; steps?: RawStep[] }[] }>(`${base}/actions/runs/${id}/jobs?per_page=100`);
  const jobs = (res.data.jobs ?? []).filter((j) => j.steps?.some((s) => s.name === TAILNET_STEP));
  if (!jobs.length) return { phase: "preparing" };
  const stages = jobs.filter((j) => j.status !== "completed").map((j): RunStage => {
    const at = j.steps!.findIndex((s) => s.name === TAILNET_STEP);
    const step = j.steps![at]!;
    if (step.status !== "completed") return { phase: "joining" };
    if (step.conclusion !== "success") return { phase: "left" };
    const since = j.steps!.slice(at + 1).find((s) => s.status === "in_progress")?.started_at;
    return { phase: "working", ...(typeof since === "string" && !Number.isNaN(Date.parse(since)) ? { since } : {}) };
  });
  return stages.find((s) => s.phase === "working") ?? stages.find((s) => s.phase === "joining") ?? { phase: "left" };
}

/** HH:MM, local time. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What a live run is doing, from its jobs' steps, in a sentence. */
export function stageText(run: Pick<LiveRun, "stage" | "status">): string {
  const s = run.stage;
  switch (s.phase) {
    case "queued": return `The run is ${run.status.replace("_", " ")}.`;
    case "preparing": return "The run is preparing its agent job.";
    case "joining": return "The agent job is joining the tailnet.";
    case "left": return "The agent job isn't on the tailnet.";
    // The steps can't tell the first turn from serving afterwards: hedged.
    case "working": return `The agent is probably still on its first turn${s.since ? ` (agent step since ${clock(s.since)})` : ""}: the run serves the session only once that turn ends, so this isn't an error. If it has served, check your tailnet login.`;
  }
}

/**
 * The live runs of each source's workflow, newest first, each with its
 * endpoint once its name resolves: after the agent job joined the tailnet,
 * the one the publisher's comment gives, else the one the job's name
 * implies. When the run's jobs don't say, only a published endpoint counts.
 */
export async function findLiveRuns(gh: GitHub, config: ChatConfig, sources: readonly ChatSource[] = config.sources): Promise<LiveRun[]> {
  const live: LiveRun[] = [];
  for (const source of sources) {
    const base = `/repos/${source.repo}`;
    const runs = await gh.get<{ workflow_runs: { id: number; run_attempt?: number; status: string; display_title: string }[] }>(
      `${base}/actions/workflows/${source.workflow}/runs?per_page=${RUNS_PER_PAGE}&exclude_pull_requests=true`);
    const found = runs.data.workflow_runs.slice(0, RUNS_PER_PAGE).filter((r) => Number.isSafeInteger(r.id) && LIVE_STATUSES.has(r.status));
    if (!found.length) continue;
    const issue = await gh.get<{ comments: number }>(`${base}/issues/${source.issue}`);
    const page = Math.max(1, Math.ceil(issue.data.comments / 100));
    const comments = await gh.get<{ body: string; user: { login: string } | null }[]>(`${base}/issues/${source.issue}/comments?per_page=100&page=${page}`);
    for (const run of found) {
      const url = `https://github.com/${source.repo}/actions/runs/${run.id}`;
      const attempt = Number.isSafeInteger(run.run_attempt) && run.run_attempt! > 0 ? run.run_attempt! : 1;
      const listed = await runStage(gh, base, run.id);
      // A run held as waiting or pending may still have its agent job up.
      const stage: RunStage = listed.phase === "preparing" && run.status !== "in_progress" ? { phase: "queued" } : listed;
      const named = publishedEndpoint(comments.data, source, url, config.tailnetDomain);
      const endpoint = stage.phase === "working" ? named ?? derivedEndpoint(run.id, attempt, config.tailnetDomain)
        : stage.phase === "preparing" || stage.phase === "queued" ? named : undefined;
      live.push({ source, id: run.id, attempt, status: run.status, title: String(run.display_title ?? ""), url, stage, ...(endpoint ? { endpoint } : {}) });
    }
  }
  return live;
}

/**
 * Dispatch a source's workflow. GitHub answers 204, or 200 with the new
 * run's id when it chooses to say; the id is returned when given.
 */
export async function dispatchSession(gh: GitHub, source: ChatSource): Promise<number | undefined> {
  const path = `/repos/${source.repo}/actions/workflows/${source.workflow}/dispatches`;
  const ref = source.ref ?? DEFAULT_REF;
  try {
    let res: { workflow_run_id?: unknown } | undefined;
    try {
      res = await gh.send("POST", path, { ref, return_run_details: true });
    } catch (e) {
      // A 422 dispatched nothing; it may be an API without return_run_details, so ask once more without it.
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
      res = await gh.send("POST", path, { ref });
    }
    const id = res?.workflow_run_id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) {
      throw new Error(`Starting a session needs a token with Actions read and write access on ${source.repo}. ${e.message}`);
    }
    throw e;
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One JSON-RPC message per WebSocket text frame; no GitHub credentials. */
export class AcpClient {
  #next = 0;
  #pending = new Map<number, Pending>();
  sessionId = "";
  readonly socket: WebSocket;

  constructor(socket: WebSocket, update: (value: any) => void, closed: () => void) {
    this.socket = socket;
    socket.onmessage = (event) => {
      // Bound unsolicited agent data before parsing/rendering it.
      if (typeof event.data !== "string" || event.data.length > 512 * 1024) { socket.close(); return; }
      try {
        const m = JSON.parse(event.data);
        if (m.jsonrpc !== "2.0") return;
        if (m.method === "session/update" && m.params?.sessionId === this.sessionId) update(m.params.update);
        else if (m.id !== undefined && m.method) socket.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Unsupported client method" } }));
        else {
          const p = this.#pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer); this.#pending.delete(m.id);
          if (m.error) p.reject(new Error(String(m.error.message ?? "ACP request failed")));
          else p.resolve(m.result);
        }
      } catch { socket.close(); }
    };
    socket.onclose = () => {
      for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error("Session disconnected")); }
      this.#pending.clear(); closed();
    };
  }

  request(method: string, params: unknown, timeout = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("ACP response timed out")); this.socket.close(); }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch (e) { clearTimeout(timer); this.#pending.delete(id); reject(e); }
    });
  }

  async attach(timeout = 60_000): Promise<void> {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, timeout);
    if (init?.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
    const session = await this.request("session/new", { cwd: "/", mcpServers: [] }, timeout);
    if (typeof session?.sessionId !== "string" || !session.sessionId) throw new Error("Missing ACP session id");
    this.sessionId = session.sessionId;
  }

  cancel(): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } }));
  }
}

const STATE_TEXT: Record<ChatState, string> = {
  none: "no session",
  starting: "starting",
  waiting: "connecting",
  connected: "connected",
  ended: "ended",
};

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function chatPanel(gh: GitHub, options: ChatOptions = {}): ChatPanel | undefined {
  const config = "config" in options ? options.config : CHAT_CONFIG;
  if (!config) return undefined;
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const t = { ...CHAT_TIMING, ...options.timing };
  let cleanup = () => {};
  let isAttached = () => false;
  let disposed = false;
  return { dispose() { disposed = true; cleanup(); }, attached: () => !disposed && isAttached(), useGitHub(next) { gh = next; }, mount(slot) {
    if (disposed) return;
    const doc = slot.ownerDocument;
    const pane = h("section", { class: "chat-panel", "aria-label": "Session chat" });
    const badge = h("span", { class: "chat-state" });
    const sourceSelect = h("select", { "aria-label": "Session workflow" }, ...config.sources.map((s, i) => h("option", { value: String(i) }, `${s.repo} ${s.workflow}`)));
    sourceSelect.hidden = config.sources.length < 2;
    const start = h("button", { type: "button", class: "small primary" }, "Start session");
    const check = h("button", { type: "button", class: "small" }, "Check");
    const full = h("button", { type: "button", class: "small", "aria-pressed": "false" }, "Full screen");
    const disconnect = h("button", { type: "button", class: "small" }, "Disconnect");
    const status = h("p", { class: "status chat-status", role: "status" });
    const runLink = h("a", { class: "chat-run", target: "_blank", rel: "noopener" });
    const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" });
    const input = h("textarea", { "aria-label": "Prompt", maxlength: "65536", rows: "3" });
    const send = h("button", { type: "submit", class: "primary" }, "Send");
    const cancel = h("button", { type: "button" }, "Cancel turn");
    const form = h("form", { class: "chat-form" }, input, h("div", { class: "chat-bar" }, send, cancel));
    const body = h("div", { class: "chat-body" }, log, form);

    let state: ChatState = "none";
    /** The operator asked this tab to attach (Start or Attach); only then does it connect. */
    let armed = false;
    let run: LiveRun | undefined;
    /** Set while the run we wait for is one we dispatched: when, and its id once known. */
    let dispatched: { at: number; id?: number } | undefined;
    /** Runs whose session this tab ended or saw end: never attach to them again. */
    const finished = new Set<number>();
    let client: AcpClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = 0;
    let delay = t.pollMs;
    let retryDelay = t.retryMs;
    let busy = false;
    /** A prompt was refused because a turn is running: Cancel turn stays offered. */
    let refused = false;
    let working = false;
    /** Bumped whenever a flow is abandoned, so its pending awaits stop there. */
    let generation = 0;
    let chars = 0;
    const tools = new Map<string, HTMLElement>();
    let current: HTMLElement | undefined;
    let currentKind = "";

    const source = () => config.sources[Number(sourceSelect.value)] ?? config.sources[0]!;
    const schedule = (fn: () => void, ms: number) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
    const say = (text: string) => { status.textContent = text; };

    const controls = () => {
      pane.dataset.state = state;
      badge.dataset.state = state;
      badge.textContent = state === "none" || armed || state === "connected" || state === "ended" ? STATE_TEXT[state] : `${STATE_TEXT[state]} · not attached`;
      const attachable = !armed && !client && run !== undefined && (state === "starting" || state === "waiting");
      start.textContent = attachable ? "Attach" : state === "ended" ? "Start again" : "Start session";
      start.disabled = working || armed || !!client;
      check.disabled = working || armed || !!client;
      sourceSelect.disabled = armed || !!client;
      disconnect.hidden = state !== "connected";
      send.disabled = state !== "connected" || busy;
      cancel.disabled = state !== "connected" || !(busy || refused);
      input.disabled = state !== "connected";
      if (run) { runLink.href = run.url; runLink.textContent = `Run ${run.id}${run.title ? `: ${run.title}` : ""}`; runLink.hidden = false; }
      else runLink.hidden = true;
      body.hidden = state === "none" && !log.childElementCount && !pane.classList.contains("chat-full");
    };
    const go = (next: ChatState, text?: string) => { state = next; if (text !== undefined) say(text); controls(); };

    const render = (u: any) => {
      if (!u || chars >= 1024 * 1024 || log.childElementCount >= 1000) { say("Transcript display limit reached"); return; }
      const text = (v: unknown) => typeof v === "string" ? v.slice(0, 65536) : "";
      let node: HTMLElement | undefined;
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk") {
        if (u.content?.type === "text") {
          const chunk = text(u.content.text).slice(0, 1024 * 1024 - chars);
          if (!chunk) return;
          if (!current || currentKind !== u.sessionUpdate) {
            current = h("p", { class: u.sessionUpdate === "user_message_chunk" ? "chat-user" : "chat-agent" }); currentKind = u.sessionUpdate; log.append(current);
          }
          const leaf = current.firstChild;
          if (leaf) leaf.nodeValue = (leaf.nodeValue ?? "") + chunk;
          else current.append(doc.createTextNode(chunk));
          chars += chunk.length;
        }
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const id = text(u.toolCallId);
        node = tools.get(id);
        if (!node) { node = h("details"); tools.set(id, node); }
        node.replaceChildren(h("summary", {}, `${text(u.title) || "Tool"} · ${text(u.status)}`), h("pre", {}, text(JSON.stringify(u.content ?? u.rawOutput ?? ""))));
      } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
        node = h("ul", {}, ...u.entries.slice(0, 100).map((e: any) => h("li", {}, `${text(e.status)}: ${text(e.content)}`)));
      }
      if (u.sessionUpdate !== "agent_message_chunk" && u.sessionUpdate !== "user_message_chunk") current = undefined;
      if (node) { chars += node.textContent?.length ?? 0; if (!node.parentNode) log.append(node); }
    };

    /**
     * The live run to show or attach to: the one already followed or
     * dispatched here, else the oldest one in progress (a newer one is
     * queued behind it), else the newest.
     */
    const detect = async (): Promise<LiveRun | undefined> => {
      const runs = (await findLiveRuns(gh, config, [source()])).filter((r) => !finished.has(r.id));
      const want = run?.id ?? dispatched?.id;
      return runs.find((r) => r.id === want) ?? runs.findLast((r) => r.status === "in_progress") ?? runs[0];
    };

    /** Show what is live without attaching: on mount and on Check. */
    const look = async () => {
      const gen = ++generation;
      working = true; controls();
      try {
        const found = await detect();
        if (gen !== generation || disposed) return;
        run = found;
        if (!found) go(state === "ended" ? "ended" : "none", state === "ended" ? status.textContent ?? "" : "No session is running. Start one to talk to it.");
        else go(found.endpoint ? "waiting" : "starting", `A session run is ${found.status.replace("_", " ")}. ${found.stage.phase === "queued" ? "" : `${stageText(found)} `}Attach to talk to it; while attached, leaving or disconnecting ends it.`);
      } catch (e) { if (gen === generation) say(message(e)); }
      finally { if (gen === generation) { working = false; controls(); } }
    };

    const endRun = (text: string) => {
      if (run) finished.add(run.id);
      armed = false; dispatched = undefined; clearTimeout(timer);
      go("ended", text);
    };

    /** starting: poll for the run and its endpoint, backing off, for at most startLimitMs. */
    const poll = async (gen: number) => {
      if (gen !== generation || disposed) return;
      let found: LiveRun | undefined;
      let read = true;
      // A failed read says nothing about the run: poll again.
      try { found = await detect(); }
      catch (e) { read = false; if (gen !== generation || disposed) return; say(`${message(e)} (retrying)`); }
      if (gen !== generation || disposed) return;
      if (read && run && found?.id !== run.id) {
        endRun("The run finished before its session could be reached.");
        return;
      }
      if (found) {
        run = found;
        if (found.endpoint) { wait(gen); return; }
        say(`${stageText(found)} Not connecting yet: waiting for its session endpoint…`);
      }
      if (Date.now() > deadline || (!run && dispatched && Date.now() > dispatched.at + t.appearLimitMs)) {
        armed = false; dispatched = undefined;
        go(run ? "starting" : "none", run ? "Gave up waiting for the session endpoint; Attach to wait again." : "No session run appeared; check the workflow's runs, then Start again.");
        return;
      }
      controls();
      schedule(() => void poll(gen), delay);
      delay = Math.min(t.pollMaxMs, Math.round(delay * 1.5));
    };

    const startPolling = (gen: number, text: string) => {
      deadline = Date.now() + t.startLimitMs; delay = t.pollMs;
      go("starting", text);
      schedule(() => void poll(gen), delay);
    };

    /** waiting: connect, retrying after retryMs, doubling to retryMaxMs, for at most waitLimitMs. */
    const wait = (gen: number) => {
      deadline = Date.now() + t.waitLimitMs; retryDelay = t.retryMs;
      go("waiting", "Connecting to the session…");
      connect(gen);
    };

    const retry = (gen: number, why: string) => {
      if (gen !== generation || disposed) return;
      if (Date.now() > deadline) {
        armed = false;
        go("waiting", `Couldn't attach: ${why}. Check your tailnet login, then Attach to try again.`);
        return;
      }
      const ms = retryDelay;
      retryDelay = Math.min(t.retryMaxMs, retryDelay * 2);
      say(`Not served yet (${why}); retrying in ${Math.ceil(ms / 1000)} s. ${run ? stageText(run) : ""}`.trim());
      schedule(async () => {
        if (gen !== generation || disposed) return;
        try {
          const found = await detect();
          if (gen !== generation || disposed) return;
          if (!found || found.id !== run?.id) { endRun("The run finished before its session could be reached."); return; }
          run = found;
          if (!found.endpoint) { startPolling(gen, "Waiting for the session endpoint…"); return; }
        } catch { /* GitHub being unreachable doesn't stop the attempt. */ }
        if (gen === generation && !disposed) connect(gen);
      }, ms);
    };

    const connect = (gen: number) => {
      const endpoint = run?.endpoint;
      if (!endpoint || client || disposed) return;
      log.replaceChildren(); chars = 0; tools.clear(); current = undefined; refused = false;
      let opened = false;
      let attached = false;
      let why = "connection failed";
      let socket: WebSocket;
      try { socket = socketFactory(endpoint); }
      catch (e) { retry(gen, message(e)); return; }
      const opening = setTimeout(() => { why = "timed out"; socket.close(); }, t.openTimeoutMs);
      const self = new AcpClient(socket, render, () => {
        clearTimeout(opening);
        if (client === self) client = undefined;
        busy = false;
        if (disposed) return;
        if (attached) endRun("Disconnected. The session run ends when its client leaves; Start again for a new one.");
        // Once the socket was open, the bridge saw this client: a run whose client
        // leaves ends, and a bridge already serving another client closes unanswered.
        // Either way connecting again can't help.
        else if (opened) endRun(`The session closed while attaching (${why}): another client may be attached, or the run has ended.`);
        else { controls(); retry(gen, why); }
      });
      client = self;
      socket.onopen = async () => {
        opened = true;
        clearTimeout(opening);
        if (disposed || gen !== generation) { socket.close(); return; }
        why = "closed by the bridge";
        try {
          await self.attach(t.attachTimeoutMs);
          // Closed meanwhile (its handler has run): a late answer attaches nothing.
          if (client !== self) return;
          if (disposed || gen !== generation) { socket.close(); return; }
          attached = true; dispatched = undefined;
          go("connected", "Attached. Leaving this page or disconnecting ends the session run.");
          input.focus();
        } catch (e) { why = message(e); socket.close(); }
      };
      socket.onerror = () => { why = "connection refused or not allowed"; };
      controls();
    };

    start.onclick = async () => {
      if (armed || client || disposed) return;
      const gen = ++generation;
      armed = true; working = true;
      log.replaceChildren(); chars = 0; tools.clear(); current = undefined;
      go(state, "Looking for a live session run…");
      try {
        const found = await detect();
        if (gen !== generation || disposed) return;
        run = found;
        if (found?.endpoint) wait(gen);
        else if (found) startPolling(gen, `${stageText(found)} Not connecting yet: waiting for its session endpoint…`);
        else {
          const src = source();
          const id = await dispatchSession(gh, src);
          if (gen !== generation || disposed) return;
          dispatched = { at: Date.now(), ...(id !== undefined ? { id } : {}) };
          startPolling(gen, `Dispatched ${src.workflow} on ${src.repo}; waiting for the run to start…`);
        }
      } catch (e) {
        if (gen !== generation || disposed) return;
        armed = false;
        say(message(e));
      } finally {
        if (gen === generation) { working = false; controls(); }
      }
    };
    check.onclick = () => void look();
    disconnect.onclick = () => { if (client && confirm("Disconnect and end this session run?")) client.socket.close(); };
    cancel.onclick = () => { try { client?.cancel(); refused = false; say("Cancel sent"); } catch (e) { say(message(e)); } controls(); };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const c = client;
      if (disposed || state !== "connected" || !c?.sessionId || busy || !input.value.trim()) return;
      current = undefined;
      busy = true; controls();
      const prompt = input.value;
      say("Turn running…");
      try {
        await c.request("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text: prompt }] }, 6 * 3600_000);
        if (input.value === prompt) input.value = "";
        refused = false;
        say("Turn finished");
      } catch (e) {
        if (client === c) { refused = true; say(`Prompt refused: ${message(e)}. A turn may still be running; Cancel turn stops it.`); }
      }
      busy = false; controls();
    };

    // Full screen: an overlay over the page; Esc leaves it. While it is
    // full screen, no key reaches the page's own shortcuts (which would act
    // on the hidden page); typing and buttons keep their default actions.
    // The pane has no key handlers of its own. Otherwise keys are left alone.
    const onKey = (ev: KeyboardEvent) => {
      if (!pane.classList.contains("chat-full")) return;
      ev.stopPropagation();
      if (ev.key !== "Escape" || ev.isComposing) return;
      ev.preventDefault();
      setFull(false);
    };
    const setFull = (on: boolean) => {
      pane.classList.toggle("chat-full", on);
      full.setAttribute("aria-pressed", String(on));
      full.textContent = on ? "Exit full screen" : "Full screen";
      if (on) doc.addEventListener("keydown", onKey, true);
      else doc.removeEventListener("keydown", onKey, true);
      controls();
    };
    full.onclick = () => setFull(!pane.classList.contains("chat-full"));
    // Closing or reloading the tab disconnects, which ends the run: ask first.
    const win = doc.defaultView;
    const onUnload = (ev: BeforeUnloadEvent) => { if (client) { ev.preventDefault(); ev.returnValue = ""; } };
    win?.addEventListener("beforeunload", onUnload);

    isAttached = () => state === "connected" && client !== undefined;
    cleanup = () => {
      generation++;
      clearTimeout(timer);
      doc.removeEventListener("keydown", onKey, true);
      win?.removeEventListener("beforeunload", onUnload);
      client?.socket.close(); client = undefined;
      slot.replaceChildren(); slot.hidden = true;
    };

    pane.append(
      h("div", { class: "chat-head" }, h("h2", {}, "Session chat"), badge),
      h("div", { class: "chat-bar" }, sourceSelect, start, check, full, disconnect),
      h("p", { class: "note" }, "Uses your tailnet login, never your GitHub token. One client per session: leaving or disconnecting ends the run."),
      status, runLink, body,
    );
    slot.replaceChildren(pane); controls();
    void look();
  } };
}
