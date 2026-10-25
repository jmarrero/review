// Markdown rendering for untrusted text: issue and PR bodies, comments,
// board fields and gists are all written by others (and the bot's own
// text may quote anyone). Two layers, as docs/design.md asks:
//
// 1. markdown-it with raw HTML off, so any HTML in the source is shown as
//    text, and its default link validation (no javascript:, vbscript:,
//    file:, or data: other than images);
// 2. DOMPurify over the result, with an allowlist of tags, attributes and
//    URL schemes, returning a DocumentFragment so no HTML string ever
//    reaches an innerHTML sink.
//
// Images become plain links: loading them would tell their host when you
// read an item, and the CSP blocks third-party images anyway. Task list
// items ("- [x] done") get a ☑ or ☐ glyph, as GitHub shows a checkbox:
// a real <input> would be one more element for the sanitizer to allow.

import MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";

/** Sources larger than this are cut, with a note, to keep a phone responsive. */
export const MAX_SOURCE_CHARS = 200_000;

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "s", "strong", "table", "tbody", "td", "th", "thead",
  "tr", "ul",
];
const ALLOWED_ATTR = ["href", "title", "start"];
// https, http and mailto only; relative links would resolve against this
// app's origin, which is never what an issue author meant.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

function markdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";
    const src = token.attrGet("src") ?? "";
    const alt = token.children?.map((c) => c.content).join("") || "image";
    if (!md.validateLink(src)) return md.utils.escapeHtml(`[${alt}]`);
    return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(`[image: ${alt}]`)}</a>`;
  };
  // HTML comments are hidden, as GitHub hides them: with raw HTML off they
  // would show as text, such as the bot's `<!-- bot-board-status-v1: … -->`
  // marker. Code spans are consumed before this rule sees their contents, so
  // a quoted comment still shows; so does one spanning a blank line, which
  // markdown-it has already split into paragraphs. `<!-->` and `<!--->`
  // close themselves, as in HTML. The first `-->` at or after the last search's
  // start is remembered per inline run, so many unclosed `<!--` cost one
  // scan, not one each; it is reused only from at or after that start, as
  // markdown-it steps back after a `[` that is not a link.
  const closes = new WeakMap<object, { from: number; end: number }>();
  md.inline.ruler.before("html_inline", "html_comment", (state) => {
    const pos = state.pos;
    if (!state.src.startsWith("<!--", pos)) return false;
    // `end` is where the closing `-->` starts.
    let end: number;
    if (state.src.startsWith("<!-->", pos)) {
      end = pos + 2;
    } else if (state.src.startsWith("<!--->", pos)) {
      end = pos + 3;
    } else {
      let found = closes.get(state);
      if (!found || pos + 4 < found.from || (found.end >= 0 && found.end < pos + 4)) {
        found = { from: pos + 4, end: state.src.indexOf("-->", pos + 4) };
        closes.set(state, found);
      }
      end = found.end;
    }
    if (end < 0 || end + 3 > state.posMax) return false;
    state.pos = end + 3;
    return true;
  });
  return md;
}

/** Whether tokens[i] is a task list item's text, which the renderer gives a ☐/☑ glyph. */
function taskBox(tokens: Token[], i: number): RegExpExecArray | null {
  const token = tokens[i];
  const first = token?.children?.[0];
  if (token?.type !== "inline" || tokens[i - 2]?.type !== "list_item_open" || first?.type !== "text") return null;
  return /^\[([ xX])\] /.exec(first.content);
}

const taskParser = markdownIt();

/**
 * The 0-based source line of each task list item a renderer gives a glyph,
 * in the order the glyphs appear: markdown-it's own line map, so a caller
 * pairing glyphs with lines need not guess which line a list item came from.
 */
export function taskItemLines(source: string): number[] {
  if (source.length > MAX_SOURCE_CHARS) return [];
  const tokens = taskParser.parse(source, {});
  return tokens.flatMap((token, i) => (taskBox(tokens, i) && token.map ? [token.map[0]] : []));
}

export type Renderer = (source: string, repository?: string) => DocumentFragment;

/**
 * Make a renderer bound to a window: the browser's, or jsdom's in tests.
 */
export function createRenderer(win: WindowLike): Renderer {
  const md = markdownIt();
  const purify = createDOMPurify(win);
  if (!purify.isSupported) {
    throw new Error("DOMPurify is not supported in this environment; refusing to render untrusted text");
  }
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (source: string, repository?: string) => {
    const cut = source.length > MAX_SOURCE_CHARS;
    const text = cut ? `${source.slice(0, MAX_SOURCE_CHARS)}\n\n*(cut: too long to show here)*` : source;
    // A paragraph that held only a comment would be left as an empty <p>.
    const parsed = md.parse(text, {});
    const empty = new Set<number>();
    parsed.forEach((token, i) => {
      if (token.type === "paragraph_open" && parsed[i + 1]?.children?.length === 0 && parsed[i + 2]?.type === "paragraph_close") [i, i + 1, i + 2].forEach((n) => empty.add(n));
    });
    const tokens = parsed.filter((_, i) => !empty.has(i));
    tokens.forEach((token, i) => {
      const box = taskBox(tokens, i);
      const first = token.children?.[0];
      if (box && first) first.content = `${box[1] === " " ? "☐" : "☑"} ${first.content.slice(box[0].length)}`;
    });
    if (repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      for (const block of tokens) {
        let depth = 0;
        block.children = block.children?.flatMap((token) => {
          if (token.type === "link_open") depth++;
          if (token.type === "link_close") depth--;
          // Only prose: never rewrite code, URLs or existing link labels.
          if (token.type !== "text" || depth) return [token];
          const result = [];
          let end = 0;
          // Do not retry at each dot/hyphen in a long non-reference word.
          const refs = /(?<![\w/.#-])(?:([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+))?#([1-9][0-9]*)(?![\w])/g;
          for (const match of token.content.matchAll(refs)) {
            const before = new Token("text", "", 0);
            before.content = token.content.slice(end, match.index);
            const open = new Token("link_open", "a", 1);
            open.attrSet("href", `https://github.com/${match[1] ?? repository}/issues/${match[2]}`);
            const label = new Token("text", "", 0);
            label.content = match[0];
            result.push(before, open, label, new Token("link_close", "a", -1));
            end = match.index + match[0].length;
          }
          const tail = new Token("text", "", 0);
          tail.content = token.content.slice(end);
          return [...result, tail];
        }) ?? null;
      }
    }
    return purify.sanitize(md.renderer.render(tokens, md.options, {}), PURIFY_CONFIG);
  };
}
