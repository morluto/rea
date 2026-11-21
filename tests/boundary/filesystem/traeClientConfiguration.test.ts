import { join, win32 } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import { jsonClientRegistrationContract } from "../../support/jsonClientRegistrationContract.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const traePath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "trae");

describe("Trae configuration paths", () => {
  it("resolves the VS Code-style user directory per platform", () => {
    expect(traePath("/home/a", "linux", {})?.configPath).toBe(
      join("/home/a", ".config", "Trae", "User", "mcp.json"),
    );
    expect(
      traePath("/home/a", "linux", { XDG_CONFIG_HOME: "/xdg" })?.configPath,
    ).toBe(join("/xdg", "Trae", "User", "mcp.json"));
    expect(traePath("/Users/a", "darwin")?.configPath).toBe(
      join(
        "/Users/a",
        "Library",
        "Application Support",
        "Trae",
        "User",
        "mcp.json",
      ),
    );
    expect(
      traePath("C:\\Users\\a", "win32", {
        APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      })?.configPath,
    ).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Trae", "User", "mcp.json"));
    expect(
      traePath("C:\\Users\\a", "win32", {
        APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      })?.markerPath,
    ).toBe(join("C:\\Users\\a\\AppData\\Roaming", "Trae", "User"));
  });

  it("resolves the registration format as the plain mcpServers JSON dialect", () => {
    expect(traePath("/home/a")?.format).toBe("json");
  });

  it("resolves the personal skills directory under the home root", () => {
    expect(
      skillDestinations("/home/a", ["trae"], {}, process.platform).map(
        ({ path }) => path,
      ),
    ).toEqual([
      join("/home/a", ".trae", "skills", "reverse-engineer-anything"),
    ]);
    expect(
      skillDestinations("C:\\Users\\a", ["trae"], {}, "win32").map(
        ({ path }) => path,
      ),
    ).toEqual([
      win32.join(
        "C:\\Users\\a",
        ".trae",
        "skills",
        "reverse-engineer-anything",
      ),
    ]);
  });
});

jsonClientRegistrationContract({
  clientName: "trae",
  displayName: "Trae",
  resolveLocation: (home, platform) => {
    const markerPath =
      platform === "darwin"
        ? join(home, "Library", "Application Support", "Trae", "User")
        : platform === "win32"
          ? join(home, "AppData", "Roaming", "Trae", "User")
          : join(home, ".config", "Trae", "User");
    return { markerPath, configPath: join(markerPath, "mcp.json") };
  },
  initialSettings: {},
  settingsWithoutServers: { unrelated: { setting: true } },
});
