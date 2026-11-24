import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";

// The client table imports Kilo's project location, so the location modules
// must not import the table's values back: loading them first would read the
// table before its imports are initialized.
it("can select Kilo project registration after its location loads first", async () => {
  vi.resetModules();
  await import("./McpRegistrationKiloLocations.js");
  const { resolveMcpRegistrationClients } =
    await import("./McpRegistrationCatalog.js");
  const home = await createTestTempDirectory("rea-kilo-import-order-");
  const resources = new ArtifactResourceScope();
  try {
    await expect(
      resolveMcpRegistrationClients(
        {
          agents: ["kilo-code"],
          global: false,
          cwd: home,
          home,
          platform: process.platform,
          environment: { KILO_DISABLE_PROJECT_CONFIG: "true" },
        },
        resources,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "ConfigurationError",
        message: expect.stringContaining("KILO_DISABLE_PROJECT_CONFIG"),
      },
    });
  } finally {
    await resources.close();
  }
});
