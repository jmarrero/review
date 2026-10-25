// Issue text is untrusted: none of these inputs may produce script,
// event handlers, dangerous URLs, frames, forms, styles or images.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRenderer, MAX_SOURCE_CHARS } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

it("bounds reference recognition on long punctuation and non-reference words", { timeout: 2000 }, () => {
  for (const character of [".", "-", "a"]) {
    const root = win.document.createElement("div");
    root.append(render(character.repeat(MAX_SOURCE_CHARS), "local/board"));
    assert.equal(root.querySelector("a"), null);
  }
});

it("linkifies status references only in prose, and still sanitizes", () => {
  const root = win.document.createElement("div");
  root.append(render("other/project#12 #34 https://example.com/x#56 `#78`\n\n```\nother/project#90\n```\n\n[#91](https://example.com) <script>alert(1)</script> [bad](javascript:alert(1))", "local/board"));
  assert.deepEqual([...root.querySelectorAll("a")].map((a) => a.getAttribute("href")), [
    "https://github.com/other/project/issues/12", "https://github.com/local/board/issues/34", "https://example.com/x#56", "https://example.com",
  ]);
  assert.equal(root.querySelectorAll("code a, a a").length, 0);
  assertSafe(root);
  assert.equal(dom("#34 other/project#12").querySelector("a"), null);
});

function html(source: string): string {
  const div = win.document.createElement("div");
  div.append(render(source));
  return div.innerHTML;
}

function dom(source: string): Element {
  const div = win.document.createElement("div");
  div.append(render(source));
  return div;
}

const ALLOWED_SCHEMES = /^(https?:|mailto:)/i;

/** Structural checks that must hold for any rendered output. */
function assertSafe(root: Element): void {
  const forbidden = root.querySelectorAll("script, style, iframe, object, embed, form, input, img, svg, math, link, meta, base");
  assert.equal(forbidden.length, 0, `forbidden elements in ${root.innerHTML}`);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(attr), `event handler ${attr} in ${root.innerHTML}`);
      assert.ok(!["style", "src", "srcdoc", "formaction", "xlink:href", "action"].includes(attr.toLowerCase()), `attribute ${attr}`);
    }
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, ALLOWED_SCHEMES, `unsafe href ${href}`);
  }
}

const ATTACKS: [string, string][] = [
  ["script tag", "<script>alert(1)</script>"],
  ["img onerror", '<img src=x onerror="alert(1)">'],
  ["svg onload", "<svg onload=alert(1)><circle/></svg>"],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["javascript link", "[click](javascript:alert(1))"],
  ["entity-encoded javascript link", "[click](javascript&#58;alert(1))"],
  ["mixed-case javascript link", "[click](JaVaScRiPt:alert(1))"],
  ["tab-split javascript link", "[click](java\tscript:alert(1))"],
  ["vbscript link", "[click](vbscript:msgbox(1))"],
  ["data html link", "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["javascript autolink", "<javascript:alert(1)>"],
  ["reference link", "[x][r]\n\n[r]: javascript:alert(1)"],
  ["javascript image", "![x](javascript:alert(1))"],
  ["data image", "![x](data:image/svg+xml;base64,PHN2Zy8+)"],
  ["tracking image", "![pixel](https://tracker.example/p.gif)"],
  ["raw anchor", '<a href="javascript:alert(1)">x</a>'],
  ["style attribute", '<p style="background:url(javascript:alert(1))">x</p>'],
  ["form", '<form action="https://evil.example"><input name=x></form>'],
  ["html block in list", "- <details open ontoggle=alert(1)>"],
  ["link title breakout", '[x](https://ok.example "a\\" onmouseover=\\"alert(1)")'],
  ["nested markdown in html", "<div>\n\n[x](javascript:alert(1))\n\n</div>"],
  ["mutation-style payload", "<noscript><p title=\"</noscript><img src=x onerror=alert(1)>\">"],
  ["code span with html", "`<script>alert(1)</script>`"],
  ["relative link", "[x](/settings/tokens)"],
];

describe("sanitization", () => {
  for (const [name, source] of ATTACKS) {
    it(name, () => assertSafe(dom(source)));
  }

  it("shows raw HTML as text instead of dropping it", () => {
    const root = dom("before <script>alert(1)</script> after");
    assert.match(root.textContent ?? "", /<script>alert\(1\)<\/script>/);
  });

  it("drops a relative link's href, which would point into this app", () => {
    assert.equal(dom("[x](/settings/tokens)").querySelector("a[href]"), null);
  });

  it("turns images into plain links with their alt text", () => {
    const a = dom("![a diagram](https://img.example/d.png)").querySelector("a");
    assert.equal(a?.getAttribute("href"), "https://img.example/d.png");
    assert.equal(a?.textContent, "[image: a diagram]");
  });
});

describe("rendering", () => {
  const cases: [string, string, string][] = [
    ["emphasis", "*hi* **there**", "<p><em>hi</em> <strong>there</strong></p>\n"],
    ["code block", "```\n<b>x</b>\n```", "<pre><code>&lt;b&gt;x&lt;/b&gt;\n</code></pre>\n"],
    [
      "https link opens safely",
      "[docs](https://example.com/a?b=1)",
      '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">docs</a></p>\n',
    ],
    [
      "linkified URL",
      "see https://example.com/x",
      '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a></p>\n',
    ],
    ["list", "- a\n- b", "<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n"],
  ];
  for (const [name, source, want] of cases) {
    it(name, () => assert.equal(html(source), want));
  }

  it("hides HTML comments, as GitHub does, but not in code or when unclosed", () => {
    assert.equal(html("before <!-- hidden *x* [y](https://e.example) --> after\n\n<!-- marker: abc -->"), "<p>before  after</p>\n");
    assert.equal(html("- a <!--\nb --> c"), "<ul>\n<li>a  c</li>\n</ul>\n");
    assert.equal(html("`<!-- shown -->`"), "<p><code>&lt;!-- shown --&gt;</code></p>\n");
    assert.equal(html("```\n<!-- shown -->\n```"), "<pre><code>&lt;!-- shown --&gt;\n</code></pre>\n");
    assert.equal(html("a <!-- open"), "<p>a &lt;!-- open</p>\n");
    assert.equal(html("a <!--> b <!---> c -->"), "<p>a  b  c --&gt;</p>\n");
  });

  it("hides only the comments themselves after a [ that is not a link", () => {
    // markdown-it scans past the [ for a label, then steps back and scans again.
    assert.equal(html("[a <!-- x --> visible <!-- y --> tail"), "<p>[a  visible  tail</p>\n");
    assert.equal(html("[a <!-- x --> b <!-- c"), "<p>[a  b &lt;!-- c</p>\n");
  });

  it("hides comments in linear time over many unclosed openers", { timeout: 2000 }, () => {
    assert.match(dom("<!--".repeat(MAX_SOURCE_CHARS / 4)).textContent ?? "", /^<!--/);
    assert.match(dom("[<!--".repeat(MAX_SOURCE_CHARS / 5)).textContent ?? "", /^\[<!--/);
    assert.equal(dom(`${"<!--".repeat(MAX_SOURCE_CHARS / 8)}-->x`).textContent?.trim(), "x");
  });

  it("cuts very long sources", () => {
    const root = dom("x".repeat(MAX_SOURCE_CHARS + 10));
    assert.match(root.textContent ?? "", /cut: too long/);
    assert.ok((root.textContent ?? "").length < MAX_SOURCE_CHARS + 100);
  });
});

it("shows task list items as ☑/☐, also when the list interrupts a paragraph, with no checkbox element", () => {
  const root = dom("allows no ignore for it.\n- [x] A) An org ruleset `x`\n- [ ] B) Not a [ ] box\n\n[x] not in a list");
  assert.deepEqual([...root.querySelectorAll("li")].map((li) => li.textContent), ["☑ A) An org ruleset x", "☐ B) Not a [ ] box"]);
  assert.equal(root.querySelector("p:last-child")!.textContent, "[x] not in a list");
  assertSafe(root);
});
