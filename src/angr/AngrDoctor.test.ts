import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectAngrRegistration } from "./AngrDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("keeps angr configuration for setup without copying credentials or claiming runtime verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-angr-doctor-"));
  roots.push(root);
  const path = join(root, "registration.json");
  await writeFile(
    path,
    JSON.stringify({
      url: "http://127.0.0.1:8000/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
    }),
  );
  const inspection = inspectAngrRegistration({ mcpConfigPath: path });
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
      inspectAngrRegistration({ pythonPath: process.execPath }),
    ]),
  ).toEqual({ REA_ANGR_PYTHON: process.execPath });
  await writeFile(path, JSON.stringify({ url: "https://example.com/mcp" }));
  expect(inspectAngrRegistration({ mcpConfigPath: path })).toMatchObject({
    available: false,
    registrationEnvironment: {},
    checks: [{ code: "invalid_configuration" }],
  });
  expect(inspectAngrRegistration({})).toMatchObject({
    configured: false,
    available: false,
    checks: [{ code: "not_configured" }],
  });
});

it("contributes angr's startup and request budgets to the client tool deadline", async () => {
  const { createSystemDoctorHost } = await import("../doctorRuntime.js");
  const { recommendedMcpToolTimeoutMs } =
    await import("../mcpStartupPolicy.js");
  const root = await mkdtemp(join(tmpdir(), "rea-angr-budget-"));
  roots.push(root);
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
  const budget = (
    provider: "angr" | "auto" | "ida",
    env: Record<string, string>,
  ) =>
    createSystemDoctorHost(env).resolveProviderRequestBudget?.(provider, env);

  // Defaults: load_binary and get_cfg at 600 s each, then a 300 s request.
  const defaults = budget("angr", { REA_ANGR_PYTHON: process.execPath });
  expect(defaults).toEqual({ ok: true, value: 1_500_000 });
  expect(budget("angr", { REA_ANGR_MCP_CONFIG: angrFile })).toEqual({
    ok: true,
    value: 5_000,
  });
  // auto takes the largest configured provider budget.
  expect(
    budget("auto", {
      REA_ANGR_MCP_CONFIG: angrFile,
      REA_IDA_MCP_CONFIG: idaFile,
    }),
  ).toEqual({ ok: true, value: 9_000_000 });
  expect(budget("auto", { REA_ANGR_PYTHON: process.execPath })).toEqual({
    ok: true,
    value: 1_500_000,
  });
  // Explicitly selected, an invalid registration is an error; under auto it is skipped.
  await writeFile(angrFile, JSON.stringify({ url: "https://example.com/mcp" }));
  expect(budget("angr", { REA_ANGR_MCP_CONFIG: angrFile })?.ok).toBe(false);
  expect(budget("auto", { REA_ANGR_MCP_CONFIG: angrFile })).toEqual({
    ok: true,
    value: undefined,
  });
  expect(budget("angr", {})).toEqual({ ok: true, value: undefined });

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
