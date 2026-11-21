import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, it } from "vitest";

import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../../src/process/OwnedCommand.js";
import type { ProcessTerminationPolicy } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * A command that rolls back on SIGTERM (or ignores it) and reports that it is
 * ready once its handler is installed.
 */
const rollbackScript = (marker: string, onTerm: "roll-back" | "ignore") => `
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {
  ${onTerm === "roll-back" ? `writeFileSync(${JSON.stringify(marker)}, "rolled back"); process.exit(0);` : ""}
});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

/** Cancel the command once it reports that its SIGTERM handler is installed. */
const cancelWhenReady = (controller: AbortController): Writable =>
  new Writable({
    write(_chunk, _encoding, callback) {
      controller.abort("caller stopped");
      callback();
    },
  });

const run = async (
  onTerm: "roll-back" | "ignore",
  termination?: ProcessTerminationPolicy,
) => {
  const root = await createTestTempDirectory("rea-owned-termination-");
  const marker = join(root, "marker");
  const controller = new AbortController();
  const started = performance.now();
  const failure = await runOwnedCommand(
    {
      command: process.execPath,
      arguments: ["-e", rollbackScript(marker, onTerm)],
      runId: `owned-command-termination-${onTerm}`,
      expectedCommand: null,
    },
    {
      timeoutMs: 30_000,
      diagnosticBytes: 1024,
      stdout: cancelWhenReady(controller),
      ...(termination === undefined ? {} : { termination }),
    },
    { signal: controller.signal },
  ).catch((cause: unknown) => cause);
  if (!(failure instanceof OwnedCommandFailure)) throw failure;
  return {
    failure,
    elapsedMs: performance.now() - started,
    marker: await readFile(marker, "utf8").catch(() => undefined),
  };
};

it.skipIf(process.platform === "win32")(
  "asks a command with a termination policy to stop before owned cleanup",
  async () => {
    const { failure, marker } = await run("roll-back", {
      signal: "SIGTERM",
      graceMs: 10_000,
    });
    expect(failure.reason).toBe("cancelled");
    expect(failure.cancellation?.reason).toBe("caller stopped");
    expect(failure.cleanupFailure).toBeNull();
    expect(failure.snapshot?.signal ?? null).toBeNull();
    expect(failure.snapshot?.exitCode).toBe(0);
    expect(marker).toBe("rolled back");
  },
);

it.skipIf(process.platform === "win32")(
  "kills a command without a termination policy without asking it to stop",
  async () => {
    const { failure, marker } = await run("roll-back");
    expect(failure.reason).toBe("cancelled");
    expect(failure.cleanupFailure).toBeNull();
    expect(failure.snapshot?.signal).toBe("SIGKILL");
    expect(marker).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "kills a command that ignores its stop request once the grace period ends",
  async () => {
    const { failure, marker, elapsedMs } = await run("ignore", {
      signal: "SIGTERM",
      graceMs: 300,
    });
    expect(failure.reason).toBe("cancelled");
    expect(failure.cleanupFailure).toBeNull();
    expect(failure.snapshot?.signal).toBe("SIGKILL");
    expect(marker).toBeUndefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(elapsedMs).toBeLessThan(10_000);
  },
);
