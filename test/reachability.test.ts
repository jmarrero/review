import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { it } from "node:test";
import { build } from "esbuild";

it("keeps production modules reachable from the app or a built CLI", async () => {
  // The entry points in build.ts, including the private hosted-only bundle.
  const entries = ["src/github/main.ts", "src/cli/main.ts", "src/cli/controlplanemain.ts", "src/hosted/main.ts"];
  const inputs = await Promise.all(entries.map(async (entry) => {
    const result = await build({
      entryPoints: [entry], bundle: true, packages: "external", format: "esm",
      platform: entry.startsWith("src/cli/") ? "node" : "browser",
      write: false, metafile: true,
    });
    return new Set(Object.keys(result.metafile.inputs));
  }));
  const files = (await readdir("src", { recursive: true })).filter((file) => file.endsWith(".ts")).map((file) => `src/${file}`);
  assert.deepEqual(files.filter((file) => !inputs.some((input) => input.has(file))).sort(), [], "unreachable production modules");
  assert.deepEqual(files.filter((file) => !inputs[0]!.has(file) && !file.startsWith("src/cli/") && !file.startsWith("src/hosted/")).sort(), [], "Non-static modules belong under src/cli/ or src/hosted/");
  assert.deepEqual([...inputs[0]!].filter((file) => file.startsWith("src/hosted/")), [], "Private infrastructure must never enter the static app");
});
