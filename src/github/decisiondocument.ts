import config from "./decisions-config.json" with { type: "json" };
import { GitHub } from "./api.ts";

// `resolve: true` reads the live state of each open entry's About item (see
// readMarks); off unless set, so the document costs one read per refresh.
// `inbox: true` shows the Inbox view as one card per thing to do (inbox.ts)
// instead of the Decisions rows and the opt-in panels; the document's
// entries show only as its cards.
export const DECISIONS_CONFIG = config as { document: DocumentTarget | null; legacyQuestions: boolean; inbox?: boolean };

export interface DocumentTarget { repo: string; number: number; resolve?: boolean }

function proseLines(text: string): { text: string; start: number }[] {
  const lines: { text: string; start: number }[] = [];
  let fence = "";
  let start = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (!fence) lines.push({ text: line.replace(/\r?\n$/, ""), start });
    start += line.length;
  }
  return lines;
}

export interface DocumentEntry {
  id: string;
  title: string;
  start: number;
  end: number;
  text: string;
  done: boolean;
  options: { letter: string; text: string; checked: boolean }[];
  /** The issue or PR the entry is about, from its first `About:` line, and when it was asked. */
  about?: About;
}

export interface About {
  repo: string;
  number: number;
  asked?: string;
}

// `About: owner/repo#12`, optionally `, asked 2026-10-15` (or a UTC time,
// `2026-10-15T09:30Z`). A name that is only dots is refused: the line is
// spliced into an API path read with the viewer's token, and `../..` would
// point that read elsewhere on the API.
const ABOUT_LINE = /^About: ((?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+#)[A-Za-z0-9_.-]+)#([1-9]\d{0,8})(?:,? asked (\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?))?\s*$/;

// agent-board writes what an entry blocks at the end of its heading,
// `### D12 Enable scheduler? (P0, blocks owner/repo#7)`; with no About line,
// that item is the one the entry is about. Same name rules as ABOUT_LINE.
const HEADING_ABOUT = /\((?:[^()]*, )?blocks ((?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+#)[A-Za-z0-9_.-]+)#([1-9]\d{0,8})\)\s*$/;

function parseAbout(text: string, title: string): About | undefined {
  for (const line of proseLines(text)) {
    if (!/^About:/.test(line.text)) continue;
    const m = ABOUT_LINE.exec(line.text);
    if (!m) return undefined;
    const asked = m[3] && !Number.isNaN(Date.parse(m[3])) ? new Date(m[3]).toISOString() : undefined;
    return { repo: m[1]!, number: Number(m[2]), ...(asked ? { asked } : {}) };
  }
  const m = HEADING_ABOUT.exec(title);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
}

export function parseDocument(body: string): DocumentEntry[] {
  if (body.length > 65536) throw new Error("Decisions document exceeds 64 KiB");
  const headings: { start: number; end: number; id: string | undefined; title: string; done: boolean }[] = [];
  let fence = "";
  let done = false;
  let offset = 0;
  for (const line of body.split(/(?<=\n)/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    } else if (!fence) {
      if (/^##\s+Done\s*$/.test(line.trimEnd())) done = true;
      if (/^#{1,3} /.test(line)) {
        const m = /^### (D\d+) (.+)/.exec(line);
        headings.push({ start: offset, end: offset + line.length, id: m?.[1], title: m?.[2] ?? "", done });
      }
    }
    offset += line.length;
  }
  const entries = headings.flatMap((heading, i) => {
    if (!heading.id) return [];
    const end = headings[i + 1]?.start ?? body.length;
    const text = body.slice(heading.end, end);
    const options = proseLines(text).flatMap((line) => {
      const m = /^- \[([ xX])\] ([A-Z])\) (.+)$/.exec(line.text);
      return m ? [{ letter: m[2]!, text: m[3]!, checked: m[1] !== " " }] : [];
    });
    if (new Set(options.map((o) => o.letter)).size !== options.length) throw new Error("Duplicate option letters");
    const about = parseAbout(text, heading.title);
    return [{ ...heading, id: heading.id, end, text, options, ...(about ? { about } : {}) }];
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length) throw new Error("Duplicate decision ids");
  return entries;
}

export function answerDocument(body: string, id: string, letter: string, reply: string): string {
  const entry = parseDocument(body).find((e) => e.id === id && !e.done);
  if (!entry || !entry.options.some((o) => o.letter === letter) || entry.options.some((o) => o.checked)) throw new Error("Decision is no longer answerable");
  // A reply is one plain line: it cannot introduce headings or checklist options.
  if (/[\r\n]/.test(reply)) throw new Error("Reply must be one line");
  const original = body.slice(entry.start, entry.end);
  const lines = proseLines(original);
  if (lines.filter((l) => /^Reply:/.test(l.text)).length !== 1) throw new Error("Expected one Reply: line");
  let replacement = original;
  for (const line of lines.reverse()) {
    const option = /^- \[[ xX]\] ([A-Z])\)/.exec(line.text);
    const updated = option ? line.text.replace(/^(- \[)[ xX]/, `$1${option[1] === letter ? "x" : " "}`) : /^Reply:/.test(line.text) ? `Reply: ${reply}` : line.text;
    replacement = replacement.slice(0, line.start) + updated + replacement.slice(line.start + line.text.length);
  }
  return body.slice(0, entry.start) + replacement + body.slice(entry.end);
}

/**
 * answerDocument, only while entry `shown.id` still reads as `shown`: a
 * form kept on the page since then would otherwise tick whatever its
 * letter says now, not the option he picked.
 */
export function answerShownEntry(body: string, shown: DocumentEntry, letter: string, reply: string): string {
  const now = parseDocument(body).find((e) => e.id === shown.id);
  if (!now || now.title !== shown.title || now.text !== shown.text) throw new Error(`${shown.id} changed since it was shown; press r to reload it`);
  return answerDocument(body, shown.id, letter, reply);
}

/** A write refused because the document is no longer `shown`; `body` is what it is now. */
export class DocumentChanged extends Error {
  readonly body: string;
  constructor(body: string) {
    super("changed, reload");
    this.body = body;
  }
}

/** Write `edit(shown)` to the document at `path`, unless it changed since `shown` was read. */
export async function sendDocumentEdit(gh: GitHub, path: string, shown: string, edit: (body: string) => string): Promise<string> {
  const body = edit(shown);
  // Stops a stale form overwriting edits made since its refresh. GitHub has
  // no issue-body CAS: an edit after this GET can still race the PATCH.
  const fresh = await gh.send<{ body: string }>("GET", path);
  if (fresh.body !== shown) throw new DocumentChanged(fresh.body);
  await gh.send("PATCH", path, { body });
  return body;
}

/** What an entry's About item says now: closed or merged resolves the entry; comments since the ask only mark it. */
// `item` is the About it was read for: a redraw from a newer body (a refused
// send) can carry marks read for an older one, and they then apply only to
// entries still about that item.
export type Mark = { item: string; url: string } & ({ state: "closed" | "merged" } | { state: "answered"; comments: number });

// At most this many open entries' items are read per refresh (two GETs
// each, conditional after the first): a long document should not spend the
// viewer's rate limit on every poll. Entries past it are shown unmarked.
export const MAX_ABOUT = 10;

function aboutName(about: About): string {
  return `${about.repo}#${about.number}`;
}

/**
 * The live state of each open entry's About item, by entry id. An item that
 * cannot be read (gone, private to this viewer) leaves its entry unmarked,
 * as a document without About lines is, rather than hiding it on a guess.
 */
export async function readMarks(gh: GitHub, entries: DocumentEntry[]): Promise<Map<string, Mark>> {
  const marks = new Map<string, Mark>();
  for (const entry of entries.filter((e) => !e.done && e.about).slice(0, MAX_ABOUT)) {
    const about = entry.about!;
    const path = `/repos/${about.repo}/issues/${about.number}`;
    try {
      const { data: item } = await gh.get<{ state: string; html_url: string; pull_request?: { merged_at: string | null } }>(path);
      if (item.state === "closed") {
        marks.set(entry.id, { item: aboutName(about), state: item.pull_request?.merged_at ? "merged" : "closed", url: item.html_url });
        continue;
      }
      if (!about.asked) continue;
      // `since` filters on updated_at; the ask is about comments made after it.
      const { data: comments } = await gh.get<{ created_at: string }[]>(`${path}/comments?since=${about.asked}&per_page=100`);
      const after = comments.filter((c) => Date.parse(c.created_at) > Date.parse(about.asked!)).length;
      if (after) marks.set(entry.id, { item: aboutName(about), state: "answered", comments: after, url: item.html_url });
    } catch {
      continue;
    }
  }
  return marks;
}

export const DOCUMENT_KEPT = "The document changed; your answer is kept, check it and send again";

/** The document's API path, refusing a configuration that would name another one. */
export function documentPath(target: DocumentTarget): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repo) || !Number.isSafeInteger(target.number) || target.number < 1) throw new Error("Invalid decisions configuration");
  return `/repos/${target.repo}/issues/${target.number}`;
}

/** The document as it is now, and with `resolve`, the marks of its open entries' items. */
export async function readDocument(gh: GitHub, target: DocumentTarget): Promise<{ body: string; marks: Map<string, Mark> }> {
  const { data: { body } } = await gh.get<{ body: string }>(documentPath(target));
  // An item can close with the document untouched, so its state is read
  // on every refresh, not only when the body changed.
  return { body, marks: target.resolve === true ? await readMarks(gh, parseDocument(body)) : new Map<string, Mark>() };
}
