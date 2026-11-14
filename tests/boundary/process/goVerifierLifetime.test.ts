import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const harness = fileURLToPath(
  new URL("../../fixtures/goVerifierLifetime.mjs", import.meta.url),
);
const outcomeSchema = z.object({
  messages: z.array(z.string()),
  retained: z.string().nullable(),
  existedAtFailure: z.boolean(),
  removedAfterRetry: z.boolean(),
  rootRemoved: z.boolean(),
  beforeRetry: z.array(z.string()),
  events: z.array(z.string()),
});

processTest
  .skipIf(process.platform === "win32")
  .for([
    "settled",
    "client-constructor",
    "transport-constructor",
    "handshake",
    "client-close",
    "transport-close",
    "client-close+transport-close",
    "commands-close",
    "root-close",
  ])(
  "owns the Go verifier fixture through %s and cleanup retry",
  async (scenario, { processes }) => {
    const directory = await createTestTempDirectory("rea-go-lifetime-");
    const temporary = join(directory, "temporary");
    await mkdir(temporary);
    const result = await processes.run(
      process.execPath,
      [harness, scenario, directory],
      {
        env: {
          ...process.env,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
        },
      },
    );
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    const outcome = outcomeSchema.parse(JSON.parse(result.stdout));
    const incomplete = scenario.includes("close");
    if (incomplete) {
      expect(outcome.retained).not.toBeNull();
      expect(outcome.existedAtFailure).toBe(true);
      if (scenario !== "root-close")
        expect(outcome.beforeRetry).not.toContain("root-close");
      expect(outcome.messages[0]).toMatch(/ENOENT.*linux-amd64/u);
    } else {
      expect(outcome.retained).toBeNull();
      expect(outcome.messages[0]).toMatch(/fault|ENOENT.*linux-amd64/u);
    }
    expect(outcome.removedAfterRetry).toBe(true);
    expect(outcome.rootRemoved).toBe(true);
    if (!scenario.includes("constructor")) {
      expect(outcome.events.indexOf("transport-close")).toBeGreaterThan(
        outcome.events.indexOf("transport-start"),
      );
      expect(
        outcome.events.lastIndexOf("transport-settled"),
      ).toBeGreaterThanOrEqual(0);
      expect(outcome.events.lastIndexOf("root-close")).toBeGreaterThan(
        outcome.events.lastIndexOf("transport-settled"),
      );
    }
    for (const name of ["client", "transport", "commands", "root"])
      if (scenario.includes(`${name}-close`))
        expect(outcome.messages).toContain(`${name} close fault`);
  },
);
