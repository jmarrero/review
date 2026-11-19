// Offline browser entry: exercise the real drawer and repository action with opt-in settings.
import { GitHub } from "../../src/github/api.ts";
import { chatPanel } from "../../src/github/chat.ts";
import { CHAT_CONFIG } from "../../src/github/chatconfig.ts";
import { repositoryChatButton } from "../../src/github/chatitem.ts";

CHAT_CONFIG!.dispatch = { repo: "public/caller", workflow: "dispatch.yml", ref: "main", issue: 536, runner: "devspace" };
const gh = new GitHub(async () => "fixture-token", async (url, init) => {
  let data: unknown;
  if (url.endsWith("/user")) data = { login: "jmarrero" };
  else if (url.endsWith("/repos/public/target") || url.endsWith("/repos/public/caller")) data = { private: false };
  else if (init?.method === "POST" && url.endsWith("/dispatches")) data = { workflow_run_id: 123 };
  else if (url.endsWith("/actions/runs/123")) data = { status: "queued", conclusion: null };
  else throw new Error(`Unexpected fixture request: ${url}`);
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
});
document.body.replaceChildren();
const slot = document.createElement("div");
const button = repositoryChatButton("public/target")!;
document.body.append(button, slot);
const panel = chatPanel(gh)!;
panel.mount(slot);
