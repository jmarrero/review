// Item text stays in the browser: public workflow inputs contain only a reference and its public links.
import { h } from "../dom.ts";
import { CHAT_CONFIG } from "./chatconfig.ts";

/** A card's ask read now, and its answer through the cards' guarded answer-and-release path. */
export interface ChatAnswer {
  target: string;
  /** The target and its ask as read, shown in the drawer. */
  ask: string;
  /** Whether answering also removes the needs-human hold. */
  release: boolean;
  /** Post `text` as the operator's answer; the comment's URL. */
  send(text: string): Promise<string>;
}

export interface ChatItem {
  ref: string;
  title: string;
  pool?: string;
  /** What the card asks, as it shows it. */
  ask?: string;
  links?: string[];
  /** Answer cards only: read the ask now, to answer it from the chat. */
  answer?: () => Promise<ChatAnswer>;
}

export const ITEM_CHAT_EVENT = "review-item-chat";

/** Links passed to a session, at most. */
const MAX_LINKS = 4;

export function publicItemRef(value: string): string | undefined {
  return /^[A-Za-z0-9-]+\/(?!\.+#)[A-Za-z0-9_.-]+#[1-9]\d{0,9}$/.test(value) ? value.toLowerCase() : undefined;
}

export function chatItem(url: string | undefined, title: string, pool?: string): ChatItem | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d{0,9})(?:[?#].*)?$/.exec(url ?? "");
  const ref = m && publicItemRef(`${m[1]}#${m[2]}`);
  return ref ? { ref, title, ...(pool ? { pool } : {}) } : undefined;
}

/** The item's links on its own repository, whose visibility the dispatch checks. */
export function itemLinks(item: ChatItem): string[] {
  const repo = item.ref.split("#")[0];
  return [...new Set((item.links ?? []).filter((u) => chatItem(u, "")?.ref.split("#")[0] === repo))].slice(0, MAX_LINKS);
}

/** Without an item, a session about nothing in particular. */
export function sessionInputs(item: ChatItem | undefined): { prompt: string; pool: string } {
  const pool = ["claude", "openai", "mistral"].includes(item?.pool ?? "") ? item!.pool! : "claude";
  if (!item) return { prompt: "The operator opens a session.", pool };
  const ref = publicItemRef(item.ref);
  if (!ref) throw new Error("Chat needs an issue or PR reference.");
  const links = itemLinks(item);
  return { prompt: `Context: ${ref}${links.length ? ` (${links.join(" ")})` : ""}. The operator opens a session about it and its current ask.`, pool };
}

/** A bubbling request lets every renderer use the page's single session owner; no item starts a plain chat. */
function requestButton(label: string, text: string, item: ChatItem | undefined, cls: string): HTMLButtonElement {
  const button = h("button", { type: "button", class: `small ${cls}`, "aria-label": label }, text);
  button.onclick = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const Event = button.ownerDocument.defaultView!.CustomEvent;
    button.dispatchEvent(new Event(ITEM_CHAT_EVENT, { bubbles: true, detail: item }));
  };
  return button;
}

export function chatButton(item: ChatItem | undefined): HTMLButtonElement | null {
  return CHAT_CONFIG && item ? requestButton(`Chat about ${item.title}`, "Chat", item, "item-chat") : null;
}

export function startChatButton(): HTMLButtonElement | null {
  return CHAT_CONFIG ? requestButton("Start a chat", "Start a chat", undefined, "start-chat") : null;
}

export function repositoryChatButton(repository: string): HTMLButtonElement | null {
  return CHAT_CONFIG?.dispatch ? requestButton(`Chat about ${repository}`, "Chat", { ref: repository, title: repository }, "repository-chat") : null;
}

export function dispatchChatButton(url: string | undefined, title: string): HTMLButtonElement | null {
  return CHAT_CONFIG?.dispatch ? chatButton(chatItem(url, title)) : null;
}
