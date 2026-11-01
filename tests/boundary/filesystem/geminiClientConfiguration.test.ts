import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import {
  clientEvidencePaths,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = currentClientRegistrationCommand({
  platform: process.platform,
});

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const geminiPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "gemini_cli",
  );

describe("Gemini CLI configuration paths", () => {
  it("resolves the user settings file, marker directory, and discovery paths", () => {
    const client = geminiPath("/home/a");
    expect(client).toMatchObject({
      name: "gemini_cli",
      displayName: "Gemini CLI",
      configPath: join("/home/a", ".gemini", "settings.json"),
      markerPath: join("/home/a", ".gemini"),
      format: "json",
    });
    expect(client?.discoveryPaths).toEqual([
      join("/home/a", ".gemini", "settings.json"),
      join("/home/a", ".gemini", "tmp"),
      join("/home/a", ".gemini", "trustedFolders.json"),
    ]);
  });

  it("resolves the personal skills directory", () => {
    expect(
      skillDestinations("/home/a", ["gemini_cli"]).map(({ path }) => path),
    ).toEqual([
      join("/home/a", ".agents", "skills", "reverse-engineer-anything"),
    ]);
  });
});

describe("Gemini CLI detection isolation", () => {
  it("stays undetected when only Antigravity configuration exists", async () => {
    const home = await createTestTempDirectory(
      "rea-gemini-antigravity-detection-",
    );
    const antigravity = supportedClients(home).find(
      ({ name }) => name === "antigravity",
    );
    if (antigravity === undefined)
      throw new Error("missing Antigravity client");

    await mkdir(dirname(antigravity.configPath), { recursive: true });
    await configureClientConfiguration(antigravity, {}, command);

    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).not.toContain("gemini_cli");
    expect(detected.map(({ name }) => name)).toContain("antigravity");

    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: process.platform,
      environment: {},
    });
    expect(statuses.map(({ client }) => client)).not.toContain("gemini_cli");
    expect(statuses.map(({ client }) => client)).toContain("antigravity");
  });

  it("is detected when Gemini CLI's own settings file exists", async () => {
    const home = await createTestTempDirectory("rea-gemini-settings-");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "settings.json"), "{}\n");

    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toContain("gemini_cli");
  });

  it("is detected when Gemini CLI runtime state exists", async () => {
    const home = await createTestTempDirectory("rea-gemini-tmp-");
    await mkdir(join(home, ".gemini", "tmp"), { recursive: true });

    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toContain("gemini_cli");
  });

  it("is detected when trusted folders record exists", async () => {
    const home = await createTestTempDirectory("rea-gemini-trusted-");
    await mkdir(join(home, ".gemini"), { recursive: true });
    await writeFile(join(home, ".gemini", "trustedFolders.json"), "{}\n");

    const detected = await detectClients(home);
    expect(detected.map(({ name }) => name)).toContain("gemini_cli");
  });
});
