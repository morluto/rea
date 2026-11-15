import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { registerMcpClients } from "../../../src/application/McpClientRegistration.js";
import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  resolveSupportedClients,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const platform = process.platform;
const command = currentClientRegistrationCommand({ platform });

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
  // Any folder Kilo reads is evidence that setup should offer it.
  await rm(root, { recursive: true });
  expect(
    (await detectClients(home, platform, {})).map(({ name }) => name),
  ).toContain("kilo");
});

it("selects an existing file in a KILO_CONFIG_DIR spelled with a dot segment", async () => {
  const home = await createTestTempDirectory("rea-kilo-config-dir-dot-");
  const custom = join(home, "profiles", "kilo");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "kilo.jsonc"), "{}");
  const environment = { KILO_CONFIG_DIR: `${home}/profiles/./kilo` };
  const row = await kiloRow(home, environment);
  expect(row?.configPath).toBe(join(custom, "kilo.jsonc"));
  expect(row?.configPaths).toContain(row?.configPath);
  expect(await mcpAddTarget(home, environment)).toBe(row?.configPath);
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

it("lets doctor and uninstall act on the Kilo layer rea mcp add wrote", async () => {
  const home = await createTestTempDirectory("rea-kilo-lifecycle-");
  const legacy = join(home, ".kilocode");
  await mkdir(legacy);
  const target = join(legacy, "kilo.jsonc");
  await writeFile(target, "{}\n");
  const resources = new ArtifactResourceScope();
  const selected = await resolveMcpRegistrationClients(
    {
      agents: ["kilo"],
      global: true,
      cwd: home,
      home,
      platform,
      environment: {},
    },
    resources,
  );
  if (!selected.ok) throw selected.error;
  const [outcome] = await registerMcpClients(
    selected.value,
    { command: command[0] ?? "", args: command.slice(1) },
    undefined,
    resources,
  );
  expect(outcome).toMatchObject({ status: "completed" });
  const statuses = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment: {},
  });
  expect(statuses.find(({ client }) => client === "kilo")).toMatchObject({
    config_path: target,
    state: "aligned",
  });
  const uninstall = await runUninstall(
    false,
    systemUninstallHost(home, undefined, {}, platform),
  );
  expect(uninstall.items).toContainEqual(
    expect.objectContaining({ name: "kilo", status: "removed" }),
  );
  expect(await readFile(target, "utf8")).not.toContain('"rea"');
});
