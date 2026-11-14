import { expect, it as test } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../../../../src/domain/analysisOperationSnapshot.js";
import { session } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

it("retries inventory after a reset exposes an invalid function deadline", async () => {
  const snapshot = {
    revision: 1,
    overrides: { "kuna.function_timeout_ms": 1000 },
  } as const;
  const fixture = await runWithAnalysisOperationSnapshot(snapshot, () =>
    session(
      "rea-kuna-deadline-inventory-",
      {},
      { REA_KUNA_TIMEOUT_MS: "invalid" },
    ),
  );
  const client = runWithAnalysisOperationSnapshot(snapshot, () =>
    fixture.open(),
  );
  try {
    const ready = await runWithAnalysisOperationSnapshot(snapshot, () =>
      client.execute("health", {}),
    );
    expect(ready.ok).toBe(true);
    const refused = await client.execute("list_procedures", {});
    expect(refused).toMatchObject({
      ok: false,
      error: {
        _tag: "ConfigurationError",
        settings: [{ setting: "REA_KUNA_TIMEOUT_MS", update_mode: "runtime" }],
        remediationAction: expect.stringContaining("kuna.function_timeout_ms"),
      },
    });
    const retried = await runWithAnalysisOperationSnapshot(snapshot, () =>
      client.execute(
        "list_procedures",
        {},
        { signal: AbortSignal.timeout(3000) },
      ),
    );
    expect(retried).toMatchObject({ ok: true });
  } finally {
    await client.close();
  }
});

it.each([
  ["list_strings", {}],
  ["procedure_callers", { procedure: "main" }],
  ["xrefs", { address: "0x1000" }],
] as const)(
  "retries %s after a reset exposes an invalid project deadline",
  async (operation, parameters) => {
    const snapshot = {
      revision: 1,
      overrides: { "kuna.project_timeout_ms": 1000 },
    } as const;
    const fixture = await runWithAnalysisOperationSnapshot(snapshot, () =>
      session(
        "rea-kuna-deadline-query-",
        {},
        { REA_KUNA_PROJECT_TIMEOUT_MS: "invalid" },
      ),
    );
    const client = runWithAnalysisOperationSnapshot(snapshot, () =>
      fixture.open(),
    );
    try {
      const ready = await runWithAnalysisOperationSnapshot(snapshot, () =>
        client.execute("health", {}),
      );
      expect(ready.ok).toBe(true);
      const refused = await client.execute(operation, parameters);
      expect(refused).toMatchObject({
        ok: false,
        error: {
          _tag: "ConfigurationError",
          settings: [
            { setting: "REA_KUNA_PROJECT_TIMEOUT_MS", update_mode: "runtime" },
          ],
          remediationAction: expect.stringContaining("kuna.project_timeout_ms"),
        },
      });
      const retried = await runWithAnalysisOperationSnapshot(snapshot, () =>
        client.execute(operation, parameters, {
          signal: AbortSignal.timeout(3000),
        }),
      );
      expect(retried).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
  },
);
