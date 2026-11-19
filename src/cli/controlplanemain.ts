// The control-app entry point; everything testable is in controlplane.ts.

import { run } from "./controlplane.ts";
import { tokenFrom } from "./queue.ts";

// A closed pipe (`| head`) is the reader being done, not an error.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

process.exitCode = await run(process.argv.slice(2), {
  fetch: (input, init) => fetch(input, init),
  token: tokenFrom(process.env),
  serviceUrl: process.env.CONTROL_APP_SERVICE,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  isTty: process.stdout.isTTY === true,
  now: () => new Date(),
});
