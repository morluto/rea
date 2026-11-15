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
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
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

it("reads KILO_CONFIG_CONTENT as Kilo's top read-only layer", async () => {
  const home = await createTestTempDirectory("rea-kilo-inline-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const target = join(root, "kilo.json");
  const registered = JSON.stringify({
    mcp: { rea: { type: "local", command, enabled: true } },
  });
  await writeFile(target, registered);
  const status = async (environment: NodeJS.ProcessEnv) =>
    (
      await readClientRegistrationStatuses(home, command[1], {
        platform,
        environment,
      })
    ).find(({ client }) => client === "kilo");
  // An inline layer that leaves REA alone keeps the file registration current.
  const peer = {
    KILO_CONFIG_CONTENT: JSON.stringify({ mcp: { other: { command: ["x"] } } }),
  };
  expect(await status(peer)).toMatchObject({ state: "aligned" });
  const row = await kiloRow(home, peer);
  if (row === undefined) throw new Error("Kilo row is missing");
  expect(await inspectClientConfiguration(row, {}, command)).toMatchObject({
    status: "already_current",
  });
  const remediation = async (environment: NodeJS.ProcessEnv) => {
    const overridden = await kiloRow(home, environment);
    if (overridden === undefined) throw new Error("Kilo row is missing");
    expect(overridden.configPath).toBe(target);
    const inspection = await inspectClientConfiguration(
      overridden,
      {},
      command,
    );
    if (inspection.status !== "invalid")
      throw new Error(`Setup admitted the override: ${inspection.status}`);
    return inspection.remediation;
  };
  // An inline launcher replaces the one setup wrote; its owner is unknown.
  const launcher = {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { command: ["/opt/other/rea", "mcp"] } },
    }),
  };
  // Doctor and setup name the layer the unowned launcher may come from.
  const doctor = await status(launcher);
  expect(doctor?.state).not.toBe("aligned");
  expect(doctor?.remediation).toContain(", KILO_CONFIG_CONTENT has unknown");
  expect(await remediation(launcher)).toContain(
    "has unknown ownership and was not changed",
  );
  expect(await remediation(launcher)).toContain("KILO_CONFIG_CONTENT");
  // An inline setting overrides the registration setup would write.
  const disabled = {
    KILO_CONFIG_CONTENT: JSON.stringify({ mcp: { rea: { enabled: false } } }),
  };
  // Doctor's recovery names the layer setup cannot edit.
  expect(await status(disabled)).toMatchObject({
    state: "stale",
    remediation: expect.stringContaining(
      "KILO_CONFIG_CONTENT also sets the rea entry",
    ),
  });
  expect(await remediation(disabled)).toContain(
    "KILO_CONFIG_CONTENT overrides REA's rea registration",
  );
  expect(await readFile(target, "utf8")).toBe(registered);
});

it("refuses a setup write that KILO_CONFIG_CONTENT would override", async () => {
  const home = await createTestTempDirectory("rea-kilo-inline-write-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const target = join(root, "kilo.json");
  const environment = { HOPPER_LAUNCHER_PATH: "/opt/first/hopper" };
  const registered = JSON.stringify({
    mcp: { rea: { type: "local", command, enabled: true, environment } },
  });
  await writeFile(target, registered);
  const row = await kiloRow(home, {
    KILO_CONFIG_CONTENT: JSON.stringify({ mcp: { rea: { environment } } }),
  });
  if (row === undefined) throw new Error("Kilo row is missing");
  // Settings chosen after inspection, such as a newly installed Hopper,
  // would be written beneath the inline value that Kilo keeps loading.
  const result = await configureClientConfiguration(
    row,
    { HOPPER_LAUNCHER_PATH: "/opt/second/hopper" },
    command,
  );
  expect(result).toMatchObject({
    status: "failed",
    reason: "read_only_override",
  });
  expect(await readFile(target, "utf8")).toBe(registered);
});

it("refuses Kilo's location while KILO_CONFIG_CONTENT cannot be parsed", async () => {
  const home = await createTestTempDirectory("rea-kilo-inline-malformed-");
  const row = await kiloRow(home, { KILO_CONFIG_CONTENT: "{" });
  expect(row?.configPathError).toContain(
    "KILO_CONFIG_CONTENT cannot be admitted",
  );
});

it("registers Kilo through its table row in rea mcp add", async () => {
  const home = await createTestTempDirectory("rea-kilo-mcp-add-row-");
  const resources = new ArtifactResourceScope();
  const select = (environment: NodeJS.ProcessEnv) =>
    resolveMcpRegistrationClients(
      {
        agents: ["kilo"],
        global: true,
        cwd: home,
        home,
        platform,
        environment,
      },
      resources,
    );
  // A relative path is refused as setup refuses it, not resolved from cwd.
  const relative = await select({ KILO_CONFIG: "kilo.json" });
  expect(relative.ok).toBe(false);
  if (!relative.ok) expect(relative.error.message).toContain("is relative");
  // The row's inline layer still decides what Kilo loads.
  const selected = await select({
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { command: ["/opt/other/rea", "mcp"] } },
    }),
  });
  if (!selected.ok) throw selected.error;
  expect(selected.value[0]?.inlineConfiguration?.origin).toBe(
    "KILO_CONFIG_CONTENT",
  );
  const [outcome] = await registerMcpClients(
    selected.value,
    { command: command[0] ?? "", args: command.slice(1) },
    undefined,
    resources,
  );
  if (outcome?.status !== "completed") throw new Error("Kilo did not run");
  if (outcome.result.ok) throw new Error("The inline launcher was ignored");
  expect(outcome.result.error.message).toContain(
    "higher-priority configuration overrides",
  );
});

/** Uninstall's Kilo outcome, and every action detail it reported. */
const uninstallKilo = async (home: string, environment: NodeJS.ProcessEnv) => {
  const result = await runUninstall(
    false,
    systemUninstallHost(home, undefined, environment, platform),
  );
  const kilo = result.items.find(({ name }) => name === "kilo");
  return {
    kilo,
    details: [kilo?.detail, ...(kilo?.actions ?? []).map((a) => a.detail)].join(
      "\n",
    ),
  };
};

it("refuses to uninstall when removal would expose a lower Kilo layer's unowned entry", async () => {
  const home = await createTestTempDirectory("rea-kilo-uninstall-lower-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const lower = join(root, "kilo.json");
  const unowned = JSON.stringify({
    mcp: { rea: { type: "local", command: ["/opt/other/rea", "mcp"] } },
  });
  await writeFile(lower, unowned);
  await mkdir(join(home, ".kilo"));
  const upper = join(home, ".kilo", "kilo.json");
  const owned = JSON.stringify({
    mcp: { rea: { type: "local", command, enabled: true } },
  });
  await writeFile(upper, owned);
  const { kilo, details } = await uninstallKilo(home, {});
  expect(kilo?.status).toBe("failed");
  expect(details).toContain("another Kilo configuration layer");
  expect(await readFile(lower, "utf8")).toBe(unowned);
  expect(await readFile(upper, "utf8")).toBe(owned);
});

it("refuses to uninstall while KILO_CONFIG_CONTENT keeps REA's entry in effect", async () => {
  const home = await createTestTempDirectory("rea-kilo-uninstall-inline-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const target = join(root, "kilo.json");
  const owned = JSON.stringify({
    mcp: { rea: { type: "local", command, enabled: true } },
  });
  await writeFile(target, owned);
  const { kilo, details } = await uninstallKilo(home, {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { type: "local", command } },
    }),
  });
  expect(kilo?.status).toBe("failed");
  expect(details).toContain("KILO_CONFIG_CONTENT, which REA does not edit");
  expect(await readFile(target, "utf8")).toBe(owned);
});
