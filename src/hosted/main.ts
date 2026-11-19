import { h } from "../dom.ts";
import { personalInfra } from "./personal-infra.ts";
import { chatPanel } from "../github/chat.ts";
import { GitHub } from "../github/api.ts";

async function configuredChat() {
  try {
    // POST is read-only discovery: unlike same-origin GET, it carries Origin.
    const response = await fetch("/api/acp", { method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return;
    const sessions: unknown = await response.json();
    if (!Array.isArray(sessions) || !sessions.length || sessions.length > 16
      || sessions.some((s) => !s || typeof s.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)
        || typeof s.label !== "string" || !s.label.trim() || s.label.length > 64)) return;
    const slot = h("div");
    const button = h("button", { type: "button" }, "Configured chat");
    // This mode never reads or writes GitHub, including when signed out.
    const panel = chatPanel(new GitHub(async () => { throw new Error("GitHub unavailable in configured chat"); }), { sessions })!;
    document.querySelector("#view")?.before(button, slot);
    panel.mount(slot);
    button.onclick = () => panel.open();
  } catch { /* Optional bridge is disabled or unavailable. */ }
}

// Access is gated by the service's operator-only network/proxy, not GitHub login.
// Never ship this entry point on Pages. No storage, telemetry or cross-origin reads.
if (window.self === window.top) {
  void configuredChat();
  const mount = h("div", { id: "personal-infra" });
  document.querySelector("#view")?.before(mount);
  async function refresh() {
    if (!document.hidden) {
      try {
        const response = await fetch("/api/v1/state", { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error("State unavailable");
        const state: unknown = await response.json();
        if (!state || typeof state !== "object" || !("schema" in state) || state.schema !== "review-service/v1") throw new Error("Unsupported state");
        const panel = personalInfra(state);
        mount.replaceChildren(...(panel ? [panel] : []));
      } catch {
        // Don't retain old operational facts as if a failed refresh confirmed them.
        if (mount.childElementCount) mount.replaceChildren(h("p", { role: "status" }, "Personal infrastructure unavailable; reload or wait for the next refresh."));
      }
    }
    setTimeout(refresh, 60_000);
  }
  void refresh();
}
