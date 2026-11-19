import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import MarkdownIt from "markdown-it";
import { JSDOM } from "jsdom";
import { buildDocumentation, renderDocumentation } from "../build-docs.ts";

const root = new URL("../", import.meta.url);

it("keeps README as a short entry point to the website and checkout docs", () => {
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.ok(readme.split("\n").length <= 20);
  assert.match(readme, /^# Control app\n\n> This text is LLM generated\./);
  assert.match(readme, /\]\(https:\/\/jmarrero\.github\.io\/review\/\)/);
  assert.match(readme, /\]\(https:\/\/jmarrero\.github\.io\/review\/docs\/\)/);
  assert.match(readme, /\]\(docs\/index\.md\)/);
  assert.match(readme, /\]\(LICENSE-MIT\)/);
  assert.match(readme, /\]\(LICENSE-APACHE\)/);
});

for (const file of ["README.md", "docs/index.md"]) {
  it(`${file} has resolvable relative links`, () => {
    const source = new URL(file, root);
    const tokens = new MarkdownIt().parse(readFileSync(source, "utf8"), {});
    for (const block of tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href")!;
        if (/^https?:/.test(href)) continue;
        const target = new URL(href, source);
        target.hash = "";
        assert.ok(existsSync(target), `${file}: missing ${href}`);
      }
    }
  });
}

it("publishes every documentation page with working local links and heading fragments", async () => {
  const out = mkdtempSync(join(tmpdir(), "review-docs-"));
  try {
    await buildDocumentation(out);
    const files = readdirSync(join(out, "docs"));
    assert.equal(files.length, readdirSync(new URL("docs/", root)).filter((file) => file.endsWith(".md")).length);
    for (const file of files) {
      const document = new JSDOM(readFileSync(join(out, "docs", file), "utf8")).window.document;
      assert.ok(document.querySelector("main h1"), file);
      assert.match(document.querySelector("main")!.textContent!, /This text is LLM generated\./);
      for (const link of document.querySelectorAll("main a[href]")) {
        const href = link.getAttribute("href")!;
        if (/^https?:/.test(href)) continue;
        const target = new URL(href, `https://site.invalid/review/docs/${file}`);
        const targetFile = target.pathname.split("/").at(-1)!;
        assert.ok(files.includes(targetFile), `${file}: ${href}`);
        if (target.hash) {
          const targetDoc = new JSDOM(readFileSync(join(out, "docs", targetFile), "utf8")).window.document;
          assert.ok(targetDoc.getElementById(decodeURIComponent(target.hash.slice(1))), `${file}: ${href}`);
        }
      }
    }
    const index = readFileSync(join(out, "docs/index.html"), "utf8");
    assert.match(index, /href="design.html"/);
    assert.match(index, /href="https:\/\/github.com\/jmarrero\/review\/blob\/main\/AGENTS.md"/);
    assert.match(index, /href="\.\.\/"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

it("keeps inbound documentation heading links valid after the README move", () => {
  const pages = new Set(readdirSync(new URL("docs/", root)).filter((file) => file.endsWith(".md")));
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const file of files) {
    const tokens = new MarkdownIt().parse(readFileSync(new URL(file, root), "utf8"), {});
    for (const block of tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== "link_open") continue;
        const href = token.attrGet("href")!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const target = new URL(href, new URL(file, root));
        if (!target.hash || !(target.pathname.endsWith("/README.md") || target.pathname.endsWith("/docs/index.md"))) continue;
        const fragment = decodeURIComponent(target.hash.slice(1));
        target.hash = "";
        const html = renderDocumentation(readFileSync(target, "utf8"), "index.md", pages);
        assert.ok(new JSDOM(html).window.document.getElementById(fragment), `${file}: ${href}`);
      }
    }
  }
});

it("renders unique heading IDs and refuses raw HTML", () => {
  const html = renderDocumentation("# Same\n\n# Same\n\n<script>alert(1)</script>", "index.md", new Set());
  const document = new JSDOM(html).window.document;
  assert.ok(document.getElementById("same"));
  assert.ok(document.getElementById("same-1"));
  assert.equal(document.querySelector("script"), null);
});
