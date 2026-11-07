import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type { AngrConfigurationSources } from "./AngrConfiguration.js";
import { inspectAngrRegistration as inspectWithScope } from "./AngrDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import { createSystemDoctorHost } from "../doctorRuntime.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

it("finishes doctor and releases a registration whose close failed before later inspections", async () => {
  const root = await createTestTempDirectory("rea-angr-doctor-close-");
  const path = join(root, "registration.json");
  await writeFile(path, JSON.stringify({ command: "python" }));
  // An executable Kuna command makes the next inspection enter the doctor's scope.
  const kuna = join(root, "kuna");
  await writeFile(kuna, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const close = OwnedFileHandle.prototype.close;
  const denied: OwnedFileHandle[] = [];
  let released = false;
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
    this: OwnedFileHandle,
  ) {
    if (denied.length === 0) {
      denied.push(this);
      return Promise.reject(new Error("descriptor close denied"));
    }
    if (denied.includes(this)) released = true;
    return close.call(this);
  });
  const host = createSystemDoctorHost({
    REA_ANGR_MCP_CONFIG: path,
    REA_KUNA_COMMAND: kuna,
  });
  const settled = await Promise.race([
    host.providerInspections!(),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  if (settled === "hung")
    throw new Error("doctor waited on its own inspection");
  expect(settled.find(({ id }) => id === "angr")).toMatchObject({
    available: false,
    checks: [{ code: "invalid_configuration" }],
  });
  expect(settled.find(({ id }) => id === "kuna")).toBeDefined();
  expect(released).toBe(false);
  expect(await host.close?.()).toBeUndefined();
  expect(released).toBe(true);
});

it("keeps a failed close from concurrent setup reads of different registrations", async () => {
  const root = await createTestTempDirectory("rea-angr-doctor-setup-");
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writeFile(first, JSON.stringify({ command: "python" }));
  await writeFile(second, JSON.stringify({ command: "python" }));
  let firstLookup: Promise<unknown> | undefined;
  const close = OwnedFileHandle.prototype.close;
  let closes = 0;
  const denied: OwnedFileHandle[] = [];
  let released = false;
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(
    async function (this: OwnedFileHandle) {
      closes += 1;
      if (closes === 2) {
        // The other lookup finishes cleanly before this close fails.
        await firstLookup;
        denied.push(this);
        throw new Error("descriptor close denied");
      }
      if (denied.includes(this)) released = true;
      return close.call(this);
    },
  );
  const host = createSystemDoctorHost({});
  const budget = (path: string) =>
    host.resolveProviderRequestBudget!("angr", { REA_ANGR_MCP_CONFIG: path });
  const lookups = [budget(first), budget(second)];
  firstLookup = Promise.race(lookups);
  await Promise.allSettled(lookups);
  expect(denied).toHaveLength(1);
  expect(released).toBe(false);
  expect(await host.close?.()).toBeUndefined();
  expect(released).toBe(true);
});
