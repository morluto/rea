import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

processTest(
  "refuses a silent Inspector startup and retires its exact child",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-inspector-startup-");
    const marker = join(root, "child.pid");
    const stopped = join(root, "stop-reason");
    const preload = join(root, "silent-inspector.mjs");
    await writeFile(
      preload,
      `import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const { Client } = await import(${JSON.stringify(import.meta.resolve("@modelcontextprotocol/client"))});
Client.prototype.connect = async () => undefined;
let acknowledgeReady;
const ready = new Promise((resolve) => { acknowledgeReady = resolve; });
const children = [];
process.once("exit", () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (!args[0]?.startsWith("--inspect=")) return spawn(command, args, options);
  // Finite expiry also bounds the baseline control if startup never times out.
  const child = spawn(command, ["-e", ${JSON.stringify(`
const { writeFileSync } = require("node:fs");
process.once("SIGTERM", () => {
  writeFileSync(${JSON.stringify(stopped)}, "SIGTERM");
  process.exit(0);
});
setTimeout(() => {
  writeFileSync(${JSON.stringify(stopped)}, "expired");
  process.exit(0);
}, 2000);
process.stderr.write("REA_STARTUP_READY\\n");
`)}], options);
  child.stderr.on("data", (chunk) => {
    if (chunk.toString().includes("REA_STARTUP_READY")) acknowledgeReady();
  });
  children.push(child);
  writeFileSync(${JSON.stringify(marker)}, String(child.pid));
  return child;
};
syncBuiltinESMExports();
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  delay === 10000
    ? schedule(() => { void ready.then(() => callback(...args)); }, 50)
    : schedule(callback, delay, ...args);
`,
    );
    const result = await processes.run(
      process.execPath,
      ["--import", preload, "scripts/verify/inspector/runtime-observation.mjs"],
      { timeoutMs: 5_000, env: process.env },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Inspector startup exceeded its 10000ms deadline",
    );
    expect(await readFile(stopped, "utf8")).toBe("SIGTERM");
    const pid = Number(await readFile(marker, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrowError(
      expect.objectContaining({ code: "ESRCH" }),
    );
  },
);
