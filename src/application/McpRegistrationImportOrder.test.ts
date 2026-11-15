import { expect, it, vi } from "vitest";

// The client table imports Kilo's project location, so the location modules
// must not import the table's values back: loading them first would read the
// table before its imports are initialized.
it("loads Kilo's project location before the client table", async () => {
  vi.resetModules();
  const kilo = await import("./McpRegistrationKiloLocations.js");
  const table = await import("./SupportedClients.js");
  expect(kilo.kiloProjectLocation).toBeTypeOf("function");
  expect(table.supportedClientDefinition("kilo").mcpAdd?.projectLocation).toBe(
    kilo.kiloProjectLocation,
  );
});
