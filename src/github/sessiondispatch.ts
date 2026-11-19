// Dispatch only: never derive an ACP address or connect to the legacy listener.
import { h } from "../dom.ts";
import { GitHub, GitHubError } from "./api.ts";
import { OPERATOR } from "./config.ts";
import { ITEM_CHAT_EVENT, publicItemRef, type ChatItem } from "./chatitem.ts";
import { validChatRepository, type SessionDispatchConfig } from "./chatconfig.ts";
import type { ChatPanel } from "./chat.ts";

const MAX_STATUS_CHECKS = 24;

/**
 * Connects the drawer to a running session's run, resolving to whether it
 * did. The gateway design (agentic-job#3249) plugs in here; until then
 * nothing can attach, and the drawer only says it is waiting.
 */
export type AttachSession = (runId: number) => Promise<boolean>;

export const NO_ATTACH: AttachSession = async () => false;

export function dispatchInputs(config: SessionDispatchConfig, repository: string, item: string): Record<string, string> {
  if (!validChatRepository(repository)) throw new Error("Choose a repository as OWNER/NAME.");
  if (item && !/^[1-9]\d{0,9}$/.test(item)) throw new Error("Issue or PR must be a positive number.");
  return {
    repo: repository, item: item || String(config.issue), kind: "research", session: "true",
    runner: config.runner, "idle-minutes": "10",
    ...(!item && repository.toLowerCase() !== config.repo.toLowerCase() ? { "item-repo": config.repo } : {}),
    task: "The operator opens an interactive session. Wait for the operator's questions. Do not make changes or post a report before the operator asks.",
  };
}

/** All preflight reads are fresh; callback marks the point a write may go out. */
export async function startRepositorySession(gh: GitHub, config: SessionDispatchConfig, repository: string, item: string, attempting: () => void): Promise<number | undefined> {
  const inputs = dispatchInputs(config, repository, item);
  const viewer = await gh.send<{ login: string }>("GET", "/user");
  if (viewer.login !== OPERATOR) throw new Error(`Only ${OPERATOR} can start a session here.`);
  for (const repo of new Set([repository, config.repo])) {
    const visibility = await gh.send<{ private: boolean }>("GET", `/repos/${repo}`);
    if (visibility.private !== false) throw new Error("Session workflow inputs require public repository references.");
  }
  attempting();
  const result = await gh.send<{ workflow_run_id?: unknown } | undefined>("POST", `/repos/${config.repo}/actions/workflows/${config.workflow}/dispatches`, {
    ref: config.ref, inputs, return_run_details: true,
  });
  const id = result?.workflow_run_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function sessionDispatchPanel(gh: GitHub, config: SessionDispatchConfig, pollMs = 5_000, attach: AttachSession = NO_ATTACH): ChatPanel {
  let open = (_item?: ChatItem) => {};
  let cleanup = () => {};
  let disposed = false;
  return {
    open(item) { open(item); }, attached: () => false, useGitHub(next) { gh = next; },
    dispose() { disposed = true; cleanup(); },
    mount(slot) {
      if (disposed) return;
      const repo = h("input", { "aria-label": "Chat repository", placeholder: "OWNER/NAME", maxlength: "140", required: "" });
      const item = h("input", { "aria-label": "Issue or PR (optional)", inputmode: "numeric", maxlength: "10" });
      const start = h("button", { type: "submit", class: "primary" }, "Start session");
      const close = h("button", { type: "button" }, "Close drawer");
      const status = h("p", { role: "status", class: "chat-status" });
      const history = `https://github.com/${config.repo}/actions/workflows/${config.workflow}`;
      const receipt = h("a", { href: history, target: "_blank", rel: "noopener" }, "View session workflow runs");
      const form = h("form", { class: "chat-dispatch-form" }, h("label", {}, "Repository ", repo), h("label", {}, "Issue or PR (optional) ", item), start);
      const pane = h("section", { class: "chat-panel", "aria-label": "Start repository chat" },
        h("div", { class: "chat-head" }, h("h2", {}, "Chat"), close), form,
        h("p", { class: "note" }, `Starts ${config.repo} / ${config.workflow} on ${config.runner} with your GitHub token. Without an issue or PR, uses ${config.repo}#${config.issue} as the workflow's required context. Public repositories only. Chat connection is not available in this slice.`), status, receipt);
      let locked = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let runId: number | undefined;
      let polls = 0;
      const poll = async () => {
        if (disposed || runId === undefined) return;
        try {
          const run = await gh.send<{ status: string; conclusion: string | null }>("GET", `/repos/${config.repo}/actions/runs/${runId}`);
          if (disposed) return;
          const running = run.status === "in_progress";
          const attached = running && await attach(runId);
          if (disposed) return;
          status.textContent = `Run ${runId}: ${run.status}${run.conclusion ? ` · ${run.conclusion}` : ""}. ${attached ? "Attached." : running ? "Waiting for attach." : "Chat connection is not available yet."}`;
          if (run.status === "completed" || attached) return;
        } catch {
          if (disposed) return;
          status.textContent = "Run status unavailable; inspect the linked run. No dispatch retry was sent.";
        }
        if (++polls < MAX_STATUS_CHECKS) timer = setTimeout(() => void poll(), pollMs);
        else status.append(" Automatic status checks stopped; follow the run on GitHub.");
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (locked || disposed) return;
        const repository = repo.value.trim();
        const number = item.value.trim();
        try { dispatchInputs(config, repository, number); }
        catch (e) { status.textContent = String(e); return; }
        if (!slot.ownerDocument.defaultView!.confirm(`Start a session for ${repository}${number ? `#${number}` : ""} on ${config.runner}?`)) return;
        locked = true; start.disabled = repo.disabled = item.disabled = true;
        status.textContent = "Requesting session…";
        let attempted = false;
        try {
          runId = await startRepositorySession(gh, config, repository, number, () => {
            if (disposed) throw new Error("The chat drawer was disposed before dispatch.");
            attempted = true;
          });
          if (disposed) return;
          status.textContent = runId ? `Run ${runId} is starting…` : "Session dispatch accepted; GitHub returned no run ID. Check workflow runs; no run has been guessed.";
          if (runId) {
            receipt.href = `https://github.com/${config.repo}/actions/runs/${runId}`;
            receipt.textContent = `View session run ${runId}`;
            timer = setTimeout(() => void poll(), pollMs);
          }
        } catch (e) {
          if (disposed) return;
          // Explicit rejection permits correction. Lost responses never permit a blind second dispatch.
          const rejected = e instanceof GitHubError && [400, 401, 403, 404, 422].includes(e.status);
          locked = attempted && !rejected;
          status.textContent = `${locked ? "Dispatch outcome uncertain; inspect workflow runs before starting another session." : "Session not dispatched."} ${e instanceof Error ? e.message : String(e)} Actions read/write access is required on the workflow repository.`;
        } finally {
          if (!disposed) start.disabled = repo.disabled = item.disabled = locked;
        }
      };
      close.onclick = () => { slot.hidden = true; };
      open = (about) => {
        if (disposed) return;
        slot.hidden = false;
        if (!locked) {
          const ref = about && publicItemRef(about.ref);
          repo.value = ref ? ref.split("#")[0]! : about && validChatRepository(about.ref) ? about.ref : "";
          item.value = ref ? ref.split("#")[1]! : "";
        }
        repo.focus();
      };
      const onItem = (event: Event) => open((event as CustomEvent<ChatItem | undefined>).detail);
      slot.ownerDocument.addEventListener(ITEM_CHAT_EVENT, onItem);
      cleanup = () => { clearTimeout(timer); slot.ownerDocument.removeEventListener(ITEM_CHAT_EVENT, onItem); slot.replaceChildren(); slot.hidden = true; };
      slot.replaceChildren(pane); slot.hidden = true;
    },
  };
}
