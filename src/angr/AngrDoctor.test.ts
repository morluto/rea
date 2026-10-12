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
