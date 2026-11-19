import raw from "./chat-config.json" with { type: "json" };

/** A workflow whose runs serve sessions, and where their endpoints are published. */
export interface ChatSource {
  repo: string;
  workflow: string;
  issue: number;
  publisher: string;
  /** The branch Start dispatches the workflow on; the default branch, "main", if unset. */
  ref?: string;
}

export interface ChatConfig {
  tailnetDomain: string;
  sources: ChatSource[];
  /** Opt-in replacement for the legacy direct-tailnet drawer; no ACP connection. */
  dispatch?: SessionDispatchConfig | null;
}

export interface SessionDispatchConfig {
  repo: string;
  workflow: string;
  ref: string;
  /** Public issue in repo used when no target issue/PR was selected. */
  issue: number;
  /** Name in the caller's AGENT_RUNNERS, never labels or a config path. */
  runner: string;
}

export function validChatRepository(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(value) && ![".", ".."].includes(value.split("/")[1]!);
}

export const DEFAULT_REF = "main";

export function parseChatConfig(value: unknown): ChatConfig | undefined {
  const c = value as ChatConfig | null;
  if (c?.dispatch != null) {
    const d = c.dispatch;
    if (!validChatRepository(d.repo) || !/^[\w.-]+\.ya?ml$/.test(d.workflow)
      || typeof d.ref !== "string" || d.ref.length > 256 || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(d.ref)
      || !Number.isSafeInteger(d.issue) || d.issue < 1
      || typeof d.runner !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(d.runner)) throw new Error("Invalid session dispatch configuration");
  }
  if (!c?.tailnetDomain && Array.isArray(c?.sources) && !c.sources.length) return undefined;
  if (!c || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(c.tailnetDomain)
    || !Array.isArray(c.sources) || !c.sources.length || c.sources.length > 8
    || c.sources.some((s) => !s || !/^[\w.-]+\/[\w.-]+$/.test(s.repo)
      || !/^[\w.-]+\.ya?ml$/.test(s.workflow) || !Number.isSafeInteger(s.issue) || s.issue < 1
      || !/^[\w-]+(?:\[bot\])?$/.test(s.publisher)
      || (s.ref !== undefined && (typeof s.ref !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(s.ref))))) throw new Error("Invalid repository chat configuration");
  return c;
}

export const CHAT_CONFIG = parseChatConfig(raw);

export function chatEndpoint(text: string, domain: string): string | undefined {
  try {
    const u = new URL(text);
    // A publication must not redirect prompts outside the configured tailnet.
    if (u.protocol !== "wss:" || u.username || u.password || u.port || u.search || u.hash
      || !u.hostname.endsWith(`.${domain}`) || !/^[a-z0-9-]+$/.test(u.hostname.slice(0, -domain.length - 1))) return undefined;
    return u.href;
  } catch { return undefined; }
}
