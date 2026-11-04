import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

for (const kind of ["proxy", "workers", "storage"] as const) {
  processTest(
    `${kind} HTTP fixture preserves targets and survives invalid requests`,
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
          kind,
        ],
        { timeoutMs: 15_000 },
      );
      expect(result.signal, result.stderr).toBeNull();
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `${kind}: target routing, invalid-target recovery and physical close passed\n`,
      );
    },
  );
}
