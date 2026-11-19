// Build the static app into dist/, or serve it for development:
//
//   node build.ts           # dist/: index.html, style.css, app.js; and dist-cli/
//   node build.ts --serve   # http://127.0.0.1:8787/, rebuilt on reload
//
// dist-cli/ holds the review-queue and control-app CLIs (package.json's
// bin), bundled for Node from the app's code; they aren't published.
//
// The output is code only. Nothing about the board or its items is
// fetched or embedded at build time.

import { chmod, copyFile, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { CHAT_CONFIG } from "./src/github/chatconfig.ts";
import * as esbuild from "esbuild";
import { buildDocumentation } from "./build-docs.ts";

const OUT_DIR = "dist";
// Only the private service build may contact same-origin infrastructure APIs.
const hosted = process.argv.includes("--hosted");
const serviceDecisions = process.argv.includes("--service-decisions");
if (serviceDecisions && !hosted) throw new Error("--service-decisions requires --hosted (private same-origin service)");
const serviceRuns = process.argv.includes("--service-runs");
if (serviceRuns && !hosted) throw new Error("--service-runs requires --hosted (private same-origin service)");
const serviceBoard = process.argv.includes("--service-board");
if (serviceBoard && !hosted) throw new Error("--service-board requires --hosted (private same-origin service)");
const CLIS = { "dist-cli/review-queue.js": "src/cli/main.ts", "dist-cli/control-app.js": "src/cli/controlplanemain.ts" };
const STATIC_FILES = ["index.html", "style.css"];
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 8787;

const options: esbuild.BuildOptions = {
  entryPoints: { app: "src/github/main.ts", ...(hosted ? { "personal-infra": "src/hosted/main.ts" } : {}) },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: OUT_DIR,
  minify: true,
  charset: "utf8",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
};

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });
await Promise.all(STATIC_FILES.map((f) => copyFile(`static/${f}`, `${OUT_DIR}/${f}`)));
await buildDocumentation(OUT_DIR);
if (CHAT_CONFIG) {
  const html = await readFile(`${OUT_DIR}/index.html`, "utf8");
  await writeFile(`${OUT_DIR}/index.html`, html.replace("connect-src https://api.github.com;", `connect-src https://api.github.com wss://*.${CHAT_CONFIG.tailnetDomain};`));
}
if (hosted) {
  const html = await readFile(`${OUT_DIR}/index.html`, "utf8");
  await writeFile(`${OUT_DIR}/index.html`, html
    .replace("connect-src https://api.github.com", "connect-src 'self' https://api.github.com")
    .replace('</head>', '<script type="module" src="personal-infra.js"></script>\n</head>'));
}
if (serviceDecisions) {
  const html = await readFile(`${OUT_DIR}/index.html`, "utf8");
  await writeFile(`${OUT_DIR}/index.html`, html.replace("</head>", '<meta name="service-decisions" content="enabled">\n</head>'));
}
if (serviceRuns) {
  const html = await readFile(`${OUT_DIR}/index.html`, "utf8");
  await writeFile(`${OUT_DIR}/index.html`, html.replace("</head>", '<meta name="service-runs" content="enabled">\n</head>'));
}
if (serviceBoard) {
  const html = await readFile(`${OUT_DIR}/index.html`, "utf8");
  await writeFile(`${OUT_DIR}/index.html`, html.replace("</head>", '<meta name="service-board" content="enabled">\n</head>'));
}

if (process.argv.includes("--serve")) {
  const ctx = await esbuild.context(options);
  const { hosts, port } = await ctx.serve({ servedir: OUT_DIR, host: DEV_HOST, port: DEV_PORT });
  console.log(`Serving on http://${hosts[0] ?? DEV_HOST}:${port}/`);
} else {
  await esbuild.build(options);
  for (const [outfile, entry] of Object.entries(CLIS)) {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile,
      banner: { js: "#!/usr/bin/env node" },
      logLevel: "info",
    });
    await chmod(outfile, 0o755);
  }
  // Keep the old command and direct bundle path for one release.
  await copyFile("dist-cli/control-app.js", "dist-cli/control-plane.js");
  await chmod("dist-cli/control-plane.js", 0o755);
}
