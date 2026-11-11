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
  expect(client.markerPath).toBe("/home/x/.cline/data/settings");
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

it.each([
  {
    env: {
      CLINE_MCP_SETTINGS_PATH: " ",
      CLINE_DATA_DIR: " /selected/data ",
      CLINE_DIR: "/ignored",
    },
    expected: "/selected/data/settings/cline_mcp_settings.json",
  },
  {
    env: { CLINE_DATA_DIR: " ", CLINE_DIR: " /selected/root " },
    expected: "/selected/root/data/settings/cline_mcp_settings.json",
  },
])("uses the native CLI override precedence for setup", ({ env, expected }) => {
  const client = cline("/home/x", "linux", env);
  expect(client.configPath).toBe(expected);
  expect(client.markerPath).toBe(expected.slice(0, expected.lastIndexOf("/")));
  expect(client.registrationProfile.connection).toEqual({ kind: "cline" });
});

it("keeps an unresolved native home unavailable to setup", () => {
  const client = cline("C:\\fallback", "win32", { USERPROFILE: " " });
  expect(client.configPathError).toContain(
    "Cannot determine Cline CLI's system home",
  );
  expect(client.configPath).toBe("");
});
