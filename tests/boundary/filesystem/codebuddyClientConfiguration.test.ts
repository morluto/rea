import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import { jsonClientRegistrationContract } from "../../support/jsonClientRegistrationContract.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const codebuddyPath = (
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "codebuddy",
  );

describe("CodeBuddy configuration paths", () => {
  it("resolves the global mcp.json under the home root", () => {
    expect(codebuddyPath("/home/a")?.configPath).toBe(
      join("/home/a", ".codebuddy", "mcp.json"),
    );
    expect(codebuddyPath("/Users/a")?.markerPath).toBe(
      join("/Users/a", ".codebuddy"),
    );
    expect(codebuddyPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".codebuddy", "mcp.json"),
    );
  });

  it("resolves the registration format as the plain mcpServers JSON dialect", () => {
    expect(codebuddyPath("/home/a")?.format).toBe("json");
  });

  it("resolves the personal skills directory under the home root", () => {
    expect(
      skillDestinations("/home/a", ["codebuddy"], {}, process.platform).map(
        ({ path }) => path,
      ),
    ).toEqual([
      join("/home/a", ".codebuddy", "skills", "reverse-engineer-anything"),
    ]);
  });
});

jsonClientRegistrationContract({
  clientName: "codebuddy",
  displayName: "CodeBuddy",
  directory: ".codebuddy",
  filename: "mcp.json",
  initialSettings: {},
  settingsWithoutServers: { unrelated: { setting: true } },
});
