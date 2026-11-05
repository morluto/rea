import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type { AngrConfigurationSources } from "./AngrConfiguration.js";
import { inspectAngrRegistration as inspectWithScope } from "./AngrDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";

const resourceScope: RetainedResourceScope = {
  retain: () => undefined,
  run: (operation) => operation(),
};
const inspectAngrRegistration = (sources: AngrConfigurationSources) =>
  inspectWithScope(sources, resourceScope);
it("keeps angr configuration for setup without copying credentials or claiming runtime verification", async () => {
  const root = await createTestTempDirectory("rea-angr-doctor-");
  const path = join(root, "registration.json");
  await writeFile(
    path,
    JSON.stringify({
      url: "http://127.0.0.1:8000/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
    }),
  );
  const inspection = await inspectAngrRegistration({ mcpConfigPath: path });
  expect(inspection).toMatchObject({
    id: "angr",
    configured: true,
    available: true,
    providerVersion: null,
  });
  expect(inspection.checks[0]?.detail).toContain(
    "no angr process was launched",
  );
  expect(providerRegistrationEnvironment([inspection])).toEqual({
    REA_ANGR_MCP_CONFIG: path,
  });
  expect(JSON.stringify(inspection)).not.toContain("fixture-secret");
  expect(
    providerRegistrationEnvironment([
      await inspectAngrRegistration({ pythonPath: process.execPath }),
    ]),
  ).toEqual({ REA_ANGR_PYTHON: process.execPath });
  await writeFile(path, JSON.stringify({ url: "https://example.com/mcp" }));
  expect(await inspectAngrRegistration({ mcpConfigPath: path })).toMatchObject({
    available: false,
    registrationEnvironment: {},
    checks: [{ code: "invalid_configuration" }],
  });
  expect(await inspectAngrRegistration({})).toMatchObject({
    configured: false,
    available: false,
    checks: [{ code: "not_configured" }],
  });
});

it("contributes angr's startup and request budgets to the client tool deadline", async () => {
  const { createSystemDoctorHost } = await import("../doctorRuntime.js");
  const { recommendedMcpToolTimeoutMs } =
    await import("../mcpStartupPolicy.js");
  const root = await createTestTempDirectory("rea-angr-budget-");
  const angrFile = join(root, "angr.json");
  const idaFile = join(root, "ida.json");
  await writeFile(
    angrFile,
    JSON.stringify({
      command: "python",
      timeoutMs: 1_000,
      startupTimeoutMs: 2_000,
    }),
  );
  await writeFile(
    idaFile,
    JSON.stringify({ command: "python", timeoutMs: 9_000_000 }),
  );
  const budget = async (
    provider: "angr" | "auto" | "ida",
    env: Record<string, string>,
  ) =>
    await createSystemDoctorHost(env).resolveProviderRequestBudget?.(
      provider,
      env,
    );

  // Defaults: load_binary and get_cfg at 600 s each, then a 300 s request.
  const defaults = await budget("angr", { REA_ANGR_PYTHON: process.execPath });
  expect(defaults).toEqual({ ok: true, value: 1_500_000 });
  expect(await budget("angr", { REA_ANGR_MCP_CONFIG: angrFile })).toEqual({
    ok: true,
    value: 5_000,
  });
  // auto takes the largest configured provider budget.
  expect(
    await budget("auto", {
      REA_ANGR_MCP_CONFIG: angrFile,
      REA_IDA_MCP_CONFIG: idaFile,
    }),
  ).toEqual({ ok: true, value: 9_000_000 });
  expect(await budget("auto", { REA_ANGR_PYTHON: process.execPath })).toEqual({
    ok: true,
    value: 1_500_000,
  });
  // Explicitly selected, an invalid registration is an error; under auto it is skipped.
  await writeFile(angrFile, JSON.stringify({ url: "https://example.com/mcp" }));
  expect((await budget("angr", { REA_ANGR_MCP_CONFIG: angrFile }))?.ok).toBe(
    false,
  );
  expect(await budget("auto", { REA_ANGR_MCP_CONFIG: angrFile })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await budget("angr", {})).toEqual({ ok: true, value: undefined });

  // The recommended client deadline covers angr's budget instead of the 450 s default.
  if (!defaults?.ok || defaults.value === undefined)
    throw new Error("expected a budget");
  expect(
    recommendedMcpToolTimeoutMs({
      analysisProvider: "angr",
      ghidraStartupTimeoutMs: 330_000,
      hopperStartupTimeoutMs: 120_000,
      providerRequestTimeoutMs: defaults.value,
    }),
  ).toBeGreaterThan(defaults.value);
});
