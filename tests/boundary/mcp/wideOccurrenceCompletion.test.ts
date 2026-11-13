import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";

processTest.for([3, 130_000])(
  "completes an authenticated inventory with %i child occurrences on the server stack",
  { timeout: 45_000 },
  async (count, { processes }) => {
    // Thread-pool tests have a larger stack than the stdio server. Use a fresh
    // main thread and enough heap for the ledger's conservative admission.
    const result = await processes.run(
      process.execPath,
      [
        "--max-old-space-size=4096",
        "--import",
        "tsx",
        fileURLToPath(
          new URL(
            "../../fixtures/promptOccurrenceCompletion.ts",
            import.meta.url,
          ),
        ),
        String(count),
      ],
      { timeoutMs: 30_000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      values: Math.min(count + 1, 100),
      total: count + 1,
      hasMore: count + 1 > 100,
    });
  },
);
