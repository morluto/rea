import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  resolveSupportedClients,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const platform = process.platform;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const kiloRow = async (home: string, environment: NodeJS.ProcessEnv = {}) =>
  (await resolveSupportedClients(home, platform, environment)).find(
    ({ name }) => name === "kilo",
  );

/** The user-scope file `rea mcp add --agent kilo` selects from the same layers. */
const mcpAddTarget = async (home: string, environment: NodeJS.ProcessEnv) => {
  const selected = await resolveMcpRegistrationClients(
    { agents: ["kilo"], global: true, cwd: home, home, platform, environment },
    new ArtifactResourceScope(),
  );
  if (!selected.ok) throw selected.error;
  return selected.value[0]?.configPath;
};

it("writes Kilo's kilo.json in its config root until another layer exists", async () => {
  const home = await createTestTempDirectory("rea-kilo-default-");
  const root = join(home, ".config", "kilo");
  const synchronous = supportedClients(home, platform, {}).find(
    ({ name }) => name === "kilo",
  );
  expect(synchronous).toMatchObject({
    configPath: join(root, "kilo.json"),
    markerPath: root,
  });
  expect(synchronous?.configPaths).toContain(join(home, ".kilo", "kilo.jsonc"));
  expect(await kiloRow(home)).toMatchObject({
    configPath: join(root, "kilo.json"),
    configPaths: [join(root, "kilo.json")],
  });
});

it("selects the last present Kilo layer, as rea mcp add does", async () => {
  const home = await createTestTempDirectory("rea-kilo-layers-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), "{}");
  const legacy = join(home, ".kilocode");
  await mkdir(legacy);
  await writeFile(join(legacy, "kilo.jsonc"), "{}");
  const row = await kiloRow(home);
  expect(row).toMatchObject({
    configPath: join(legacy, "kilo.jsonc"),
    configPaths: [join(root, "config.json"), join(legacy, "kilo.jsonc")],
  });
  expect(await mcpAddTarget(home, {})).toBe(row?.configPath);
});

it("plans kilo.json in an empty KILO_CONFIG_DIR", async () => {
  const home = await createTestTempDirectory("rea-kilo-config-dir-");
  const custom = join(home, "custom-kilo");
  const environment = { KILO_CONFIG_DIR: custom };
  const row = await kiloRow(home, environment);
  expect(row?.configPath).toBe(join(custom, "kilo.json"));
  expect(await mcpAddTarget(home, environment)).toBe(row?.configPath);
});

it("refuses a relative Kilo configuration path instead of guessing its folder", async () => {
  const home = await createTestTempDirectory("rea-kilo-relative-");
  for (const environment of [
    { KILO_CONFIG: "kilo.json" },
    { KILO_CONFIG_DIR: "kilo" },
    { XDG_CONFIG_HOME: "config" },
  ]) {
    const row = supportedClients(home, platform, environment).find(
      ({ name }) => name === "kilo",
    );
    expect(row?.configPathError).toContain("is relative");
    expect((await kiloRow(home, environment))?.configPathError).toContain(
      "is relative",
    );
  }
});
