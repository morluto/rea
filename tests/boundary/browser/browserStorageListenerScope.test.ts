import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

const hasNonLoopbackIpv4 = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .some((entry) => entry.family === "IPv4" && !entry.internal);

processTest.skipIf(process.platform !== "win32" && !hasNonLoopbackIpv4)(
  "storage fixture binds to IPv4 loopback and serves localhost",
  async ({ processes }) => {
    const result = await processes.run(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../fixtures/browserFixtureHttpTargets.mjs",
            import.meta.url,
          ),
        ),
        "storage",
        "listener-scope",
      ],
      { timeoutMs: 15_000 },
    );
    expect(result.signal, result.stderr).toBeNull();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "storage: IPv4 loopback binding verified; localhost served\n" +
        (process.platform === "win32"
          ? ""
          : "storage: non-loopback connection refused\n") +
        "storage: target routing, invalid-target recovery and physical close passed\n",
    );
  },
);
