// Publish checkout documentation alongside the Pages app, without fetching data.
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";

export function renderDocumentation(source: string, file: string, pages: Set<string>): string {
  const md = new MarkdownIt(); // Raw HTML stays disabled.
  const tokens = md.parse(source, {});
  const ids = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.type === "heading_open") {
      const text = (tokens[i + 1]?.children ?? [])
        .filter((child) => child.type === "text" || child.type === "code_inline")
        .map((child) => child.content).join("");
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
      let id = slug;
      for (let suffix = 1; ids.has(id); suffix++) id = `${slug}-${suffix}`;
      ids.add(id);
      token.attrSet("id", id);
    }
    for (const child of token.children ?? []) {
      if (child.type !== "link_open") continue;
      const href = child.attrGet("href")!;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
      const target = new URL(href, `https://checkout.invalid/docs/${file}`);
      const name = decodeURIComponent(target.pathname.slice("/docs/".length));
      if (target.pathname.startsWith("/docs/") && pages.has(name)) {
        child.attrSet("href", `${name.replace(/\.md$/, ".html")}${target.search}${target.hash}`);
      } else {
        child.attrSet("href", `https://github.com/jmarrero/review/blob/main${target.pathname}${target.search}${target.hash}`);
      }
    }
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Control app documentation</title>
<style>body{max-width:72rem;margin:2rem auto;padding:0 1rem;font:1rem/1.6 system-ui}pre,table{display:block;overflow:auto}pre{padding:1rem;background:#f4f4f4}code{overflow-wrap:anywhere}img{max-width:100%}td,th{padding:.4rem;border:1px solid #ccc}a{color:#0756a3}</style>
</head><body><nav><a href="../">Open app</a> · <a href="index.html">Documentation</a></nav>
<main>${md.renderer.render(tokens, md.options, {})}</main></body></html>\n`;
}

export async function buildDocumentation(outDir: string): Promise<void> {
  const pages = new Set((await readdir(new URL("docs/", import.meta.url))).filter((file) => file.endsWith(".md")));
  await mkdir(`${outDir}/docs`, { recursive: true });
  for (const file of pages) {
    const source = await readFile(new URL(`docs/${file}`, import.meta.url), "utf8");
    await writeFile(`${outDir}/docs/${file.replace(/\.md$/, ".html")}`, renderDocumentation(source, file, pages));
  }
}
