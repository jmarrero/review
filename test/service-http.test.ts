import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readService } from "../src/github/service.ts";
import { run } from "../src/cli/controlplane.ts";
import { fixture } from "./helpers.ts";

const NOW = Date.parse("2026-11-09T12:05:00Z");
const PRIVATE_ERROR = "private upstream connection details";

function brokenBody(afterChunk: boolean): Response {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (afterChunk && !sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"schema":'));
      } else {
        controller.error(new Error(PRIVATE_ERROR));
      }
    },
  }));
}

describe("service HTTP body failures", () => {
  for (const afterChunk of [false, true]) {
    it(`sanitizes a failed body ${afterChunk ? "after a chunk" : "before any bytes"}`, async () => {
      await assert.rejects(
        readService("https://control.example", async () => brokenBody(afterChunk), NOW),
        { message: "Service decision unavailable" },
      );
    });
  }

  it("preserves the size bound even when cancellation fails", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; throw new Error(PRIVATE_ERROR); },
    }));
    await assert.rejects(readService("https://control.example", async () => response, NOW),
      { message: "Service state exceeds size bound" });
    assert.equal(cancelled, true);
  });

  it("does not expose body errors or fall back to GitHub in the CLI", async () => {
    let out = "", err = "", calls = 0;
    const code = await run(["status"], {
      serviceUrl: "https://control.example",
      token: async () => { throw new Error("GitHub token must not be read"); },
      fetch: async (url) => {
        calls++;
        assert.equal(url, "https://control.example/api/v1/state");
        return brokenBody(true);
      },
      stdout: (s) => { out += s; }, stderr: (s) => { err += s; },
      now: () => new Date(NOW), isTty: false,
    });
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(out, "");
    assert.match(err, /Service decision unavailable/);
    assert.ok(!err.includes(PRIVATE_ERROR));
  });

  it("still accepts a complete document split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(fixture("service-decision-producer.json")));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 17));
        controller.enqueue(bytes.subarray(17));
        controller.close();
      },
    }));
    const decision = await readService("https://control.example", async () => response, NOW);
    assert.equal(decision.generation, 1);
    assert.equal(decision.error, undefined);
  });
});
