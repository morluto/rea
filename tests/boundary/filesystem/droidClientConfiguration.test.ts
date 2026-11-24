import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import { jsonClientRegistrationContract } from "../../support/jsonClientRegistrationContract.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const droidPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) => supportedClients(home, platform, env).find(({ name }) => name === "droid");

describe("Factory Droid configuration paths", () => {
  it("resolves the user MCP config file and marker directory", () => {
    expect(droidPath("/home/a")).toMatchObject({
      name: "droid",
      displayName: "Factory Droid",
      configPath: join("/home/a", ".factory", "mcp.json"),
      markerPath: join("/home/a", ".factory"),
      format: "json",
    });
    expect(droidPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".factory", "mcp.json"),
    );
    expect(droidPath("C:\\Users\\a", "win32")?.configPath).toBe(
      join("C:\\Users\\a", ".factory", "mcp.json"),
    );
  });

  it("resolves the personal skills directory beside the config root", () => {
    expect(
      skillDestinations("/home/a", ["droid"], {}, process.platform).map(
        ({ path }) => path,
      ),
    ).toEqual([
      join("/home/a", ".factory", "skills", "reverse-engineer-anything"),
    ]);
  });

  it("uses Droid's selected home for configuration, discovery, and personal skills", () => {
    const environment = { FACTORY_HOME_OVERRIDE: "/selected/home" };
    expect(droidPath("/home/a", "darwin", environment)).toMatchObject({
      configPath: join("/selected/home", ".factory", "mcp.json"),
      markerPath: join("/selected/home", ".factory"),
    });
    expect(
      skillDestinations(
        "/home/a",
        ["droid"],
        environment,
        process.platform,
      ).map(({ path }) => path),
    ).toEqual([
      join("/selected/home", ".factory", "skills", "reverse-engineer-anything"),
    ]);
    expect(
      droidPath("/home/a", "darwin", { FACTORY_HOME_OVERRIDE: "" }),
    ).toEqual(droidPath("/home/a", "darwin"));
  });
});

jsonClientRegistrationContract({
  clientName: "droid",
  displayName: "Factory Droid",
  directory: ".factory",
  filename: "mcp.json",
  initialSettings: {
    persistentPermissions: {
      servers: {
        other: { approvedAt: "2026-01-01T00:00:00.000Z" },
      },
    },
  },
  settingsWithoutServers: { persistentPermissions: { servers: {} } },
  unrelatedServer: {
    type: "stdio",
    command: "other",
    args: [],
    disabled: false,
  },
});
