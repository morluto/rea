import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectIdaRegistration } from "./IdaDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("keeps IDA configuration for setup without copying transport credentials or claiming runtime verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-ida-doctor-"));
  roots.push(root);
  const path = join(root, "registration.json");
  await writeFile(
    path,
    JSON.stringify({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "headless",
    }),
  );
  const inspection = inspectIdaRegistration(path);
  expect(inspection).toMatchObject({
    configured: true,
    available: true,
    providerVersion: null,
  });
  expect(inspection.checks[0]?.detail).toContain("no IDA process was launched");
  expect(providerRegistrationEnvironment([inspection])).toEqual({
    REA_IDA_MCP_CONFIG: path,
  });
  expect(JSON.stringify(inspection)).not.toContain("fixture-secret");
  await writeFile(path, JSON.stringify({ url: "https://example.com/mcp" }));
  expect(inspectIdaRegistration(path)).toMatchObject({
    available: false,
    registrationEnvironment: {},
  });
  expect(inspectIdaRegistration(undefined)).toMatchObject({
    configured: false,
    available: false,
  });
});
