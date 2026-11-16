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

it.each(["CLINE_MCP_SETTINGS_PATH", "CLINE_DATA_DIR", "CLINE_DIR"])(
  "refuses a relative %s instead of resolving it against REA's directory",
  (variable) => {
    const client = cline("/home/x", "linux", {
      // A lower-precedence absolute override must not hide the refusal.
      CLINE_DIR: "/ignored",
      [variable]: "relative/cline",
    });
    expect(client.configPathError).toBe(
      `${variable} is relative, so the location Cline CLI reads depends on its working directory. Set an absolute ${variable} before configuring Cline CLI.`,
    );
    expect(client.configPath).toBe("relative/cline");
  },
);

it("refuses a drive-relative Windows CLINE_DATA_DIR", () => {
  expect(
    cline("C:\\Users\\x", "win32", { CLINE_DATA_DIR: "D:\\cline" }).configPath,
  ).toBe("D:\\cline\\settings\\cline_mcp_settings.json");
  expect(
    cline("C:\\Users\\x", "win32", { CLINE_DATA_DIR: "D:cline" })
      .configPathError,
  ).toContain("CLINE_DATA_DIR is relative");
});

it.each(["\\cline", "/cline"])(
  "refuses a drive-less Windows CLINE_DATA_DIR %s that follows Cline's current drive",
  (value) => {
    const client = cline("C:\\Users\\x", "win32", { CLINE_DATA_DIR: value });
    expect(client.configPathError).toBe(
      "CLINE_DATA_DIR has no drive, so the location Cline CLI reads depends on its current drive. Set CLINE_DATA_DIR to a path with a drive letter or a UNC path before configuring Cline CLI.",
    );
  },
);

it("selects a UNC Windows CLINE_DATA_DIR", () => {
  const client = cline("C:\\Users\\x", "win32", {
    CLINE_DATA_DIR: "\\\\server\\share\\cline",
  });
  expect(client.configPathError).toBeUndefined();
  expect(client.configPath).toBe(
    "\\\\server\\share\\cline\\settings\\cline_mcp_settings.json",
  );
});
