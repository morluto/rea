import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

const hasNonLoopbackIpv4 = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .some((entry) => entry.family === "IPv4" && !entry.internal);

processTest.skipIf(!hasNonLoopbackIpv4)(
  "storage fixture serves localhost and refuses this host's non-loopback interface",
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
      "storage: localhost served; non-loopback connection refused\n" +
        "storage: target routing, invalid-target recovery and physical close passed\n",
    );
  },
);
