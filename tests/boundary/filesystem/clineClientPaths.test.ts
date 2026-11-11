import { expect, it } from "vitest";

import { supportedClients } from "../../../src/application/SupportedClients.js";

const cline = (home: string, platform: NodeJS.Platform, env = {}) => {
  const client = supportedClients(home, platform, env).find(
    ({ name }) => name === "cline",
  );
  expect(client, "cline must be a supported client").toBeDefined();
  return client!;
};

it("resolves Cline's POSIX configuration and marker paths", () => {
  const client = cline("/home/x", "linux");
  expect(client.configPath).toBe(
    "/home/x/.cline/data/settings/cline_mcp_settings.json",
  );
  expect(client.markerPath).toBe("/home/x/.cline");
});

it("resolves Cline's Windows configuration path", () => {
  const client = cline("C:\\Users\\x", "win32");
  expect(client.configPath).toBe(
    "C:\\Users\\x\\.cline\\data\\settings\\cline_mcp_settings.json",
  );
});

it("prefers CLINE_MCP_SETTINGS_PATH over the default location", () => {
  const client = cline("/home/x", "linux", {
    CLINE_MCP_SETTINGS_PATH: "/custom/settings.json",
  });
  expect(client.configPath).toBe("/custom/settings.json");
});
