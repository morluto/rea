import { registerMcpClientsOnHost } from "../../fixtures/mcpRegistration.js";
import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { readEffectiveClientRegistrationConfiguration } from "../../../src/application/ClientConfigurationFiles.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { resolveMcpRegistrationClients } from "../../../src/application/McpRegistrationCatalog.js";
import {
  resolveSupportedClients,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import {
  clientRefreshRefusal,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
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

it("loads KILO_CONFIG above Kilo's root files and below its home folders", async () => {
  const home = await createTestTempDirectory("rea-kilo-config-file-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "kilo.json"), "{}");
  const explicit = join(home, "profiles", "kilo.json");
  const environment = { KILO_CONFIG: explicit };
  // A selected file that does not exist yet is still Kilo's last root layer.
  const planned = await kiloRow(home, environment);
  expect(planned).toMatchObject({
    configPath: explicit,
    configPaths: [join(root, "kilo.json"), explicit],
  });
  expect(await mcpAddTarget(home, environment)).toBe(explicit);
  // A home folder layer loads after it and becomes the write target.
  await mkdir(join(home, ".kilo"));
  await writeFile(join(home, ".kilo", "kilo.jsonc"), "{}");
  const layered = await kiloRow(home, environment);
  expect(layered).toMatchObject({
    configPath: join(home, ".kilo", "kilo.jsonc"),
    configPaths: [
      join(root, "kilo.json"),
      explicit,
      join(home, ".kilo", "kilo.jsonc"),
    ],
  });
  expect(await mcpAddTarget(home, environment)).toBe(layered?.configPath);
});

it("loads ~/.kilo after the legacy ~/.kilocode folder", async () => {
  const home = await createTestTempDirectory("rea-kilo-home-folders-");
  for (const folder of [".kilocode", ".kilo"]) {
    await mkdir(join(home, folder));
    await writeFile(join(home, folder, "kilo.json"), "{}");
  }
  const row = await kiloRow(home);
  expect(row).toMatchObject({
    configPath: join(home, ".kilo", "kilo.json"),
    configPaths: [
      join(home, ".kilocode", "kilo.json"),
      join(home, ".kilo", "kilo.json"),
    ],
  });
  expect(await mcpAddTarget(home, {})).toBe(row?.configPath);
});

it("lets doctor and setup accept REA's entry that only KILO_CONFIG_CONTENT defines", async () => {
  const home = await createTestTempDirectory("rea-kilo-inline-only-");
  // Kilo is installed but none of its files exists yet.
  await mkdir(join(home, ".config", "kilo"), { recursive: true });
  const environment = {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { type: "local", command, enabled: true } },
    }),
  };
  const statuses = await readClientRegistrationStatuses(home, command[1], {
    platform,
    environment,
  });
  expect(statuses.find(({ client }) => client === "kilo")).toMatchObject({
    state: "aligned",
  });
  const row = await kiloRow(home, environment);
  if (row === undefined) throw new Error("Kilo row is missing");
  // Writing the same entry beneath it changes nothing Kilo loads, so setup
  // may still record it in the file it manages.
  expect(await inspectClientConfiguration(row, {}, command)).toMatchObject({
    status: "create",
  });
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
    const resolved = await kiloRow(home, environment);
    expect(resolved?.configPathError).toContain("is relative");
    if (resolved === undefined) throw new Error("Kilo row is missing");
    // Readers such as doctor's provider settings refuse it instead of reading
    // a file relative to REA's own folder.
    expect(
      await readEffectiveClientRegistrationConfiguration(
        resolved,
        undefined,
        HOST_PLATFORM.platform,
      ),
    ).toMatchObject({ ok: false, error: { kind: "unreadable" } });
  }
});

it.each(["\\kilo.json", "/kilo.json"])(
  "refuses a drive-less Windows KILO_CONFIG %s that follows Kilo's current drive",
  (value) => {
    const row = supportedClients("C:\\Users\\x", "win32", {
      KILO_CONFIG: value,
    }).find(({ name }) => name === "kilo");
    expect(row?.configPathError).toContain("has no drive");
  },
);

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
  const [outcome] = await registerMcpClientsOnHost(
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
  const [outcome] = await registerMcpClientsOnHost(
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

it("reports REA's Kilo entry that only KILO_CONFIG_CONTENT sets instead of calling uninstall complete", async () => {
  const home = await createTestTempDirectory("rea-kilo-uninstall-inline-only-");
  // Kilo is installed, and both files exist without REA's entry.
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const other = JSON.stringify({ mcp: { other: { command: ["x"] } } });
  await writeFile(join(root, "kilo.json"), other);
  await mkdir(join(home, ".kilo"));
  await writeFile(join(home, ".kilo", "kilo.json"), other);
  const { kilo, details } = await uninstallKilo(home, {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { type: "local", command, enabled: true } },
    }),
  });
  expect(kilo?.status).toBe("failed");
  expect(details).toContain("Remove the rea entry from KILO_CONFIG_CONTENT");
  // One report although uninstall visits each Kilo file.
  expect(details.match(/KILO_CONFIG_CONTENT sets/g)).toHaveLength(1);
  expect(await readFile(join(root, "kilo.json"), "utf8")).toBe(other);
});

it.each(["lower", "upper"])(
  "keeps an inline Kilo registration disabled by its %s file during uninstall",
  async (layer) => {
    const home = await createTestTempDirectory("rea-kilo-uninstall-disabled-");
    const lowerRoot = join(home, ".config", "kilo");
    const upperRoot = join(home, ".kilo");
    await mkdir(lowerRoot, { recursive: true });
    await mkdir(upperRoot);
    const lower = join(lowerRoot, "kilo.json");
    const upper = join(upperRoot, "kilo.json");
    const disabled = JSON.stringify({ mcp: { rea: { enabled: false } } });
    const other = JSON.stringify({ mcp: { other: { command: ["x"] } } });
    await writeFile(lower, layer === "lower" ? disabled : other);
    await writeFile(upper, layer === "upper" ? disabled : other);
    const environment = {
      KILO_CONFIG_CONTENT: JSON.stringify({
        mcp: { rea: { type: "local", command } },
      }),
    };
    const row = await kiloRow(home, environment);
    if (row === undefined) throw new Error("Kilo row is missing");
    const before = await readEffectiveClientRegistrationConfiguration(
      row,
      undefined,
      platform,
    );
    expect(before).toMatchObject({
      ok: true,
      value: { document: { servers: { rea: { enabled: false } } } },
    });
    const { kilo } = await uninstallKilo(home, environment);
    expect(kilo).toBeDefined();
    expect(kilo?.status).not.toBe("failed");
    const enabled = await uninstallKilo(home, {
      KILO_CONFIG_CONTENT: JSON.stringify({
        mcp: { rea: { type: "local", command, enabled: true } },
      }),
    });
    expect(enabled.kilo?.status).toBe("failed");
    expect(await readFile(lower, "utf8")).toBe(
      layer === "lower" ? disabled : other,
    );
    expect(await readFile(upper, "utf8")).toBe(
      layer === "upper" ? disabled : other,
    );
  },
);

it("leaves a stale Kilo registration KILO_CONFIG_CONTENT pins out of update maintenance", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-inline-");
  await mkdir(join(home, ".config", "kilo"), { recursive: true });
  const environment = {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [
            "npx",
            "-y",
            `${PRODUCT_IDENTITY.packageName}@3.2.0`,
            "mcp",
          ],
          enabled: true,
        },
      },
    }),
  };
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    environment,
    { platform: HOST_PLATFORM.platform },
  );
  expect(scope.clients).not.toContain("kilo");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({
      client: "kilo",
      state: "stale",
      remediation: expect.stringContaining(
        "KILO_CONFIG_CONTENT overrides REA's rea registration",
      ),
    }),
  ]);
});

it("maintains a stale Kilo registration whose KILO_CONFIG_CONTENT entry setup's refresh keeps", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-inline-kept-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command: [
            "npx",
            "-y",
            `${PRODUCT_IDENTITY.packageName}@3.2.0`,
            "mcp",
          ],
          enabled: true,
        },
      },
    }),
  );
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    {
      KILO_CONFIG_CONTENT: JSON.stringify({ mcp: { rea: { enabled: true } } }),
    },
    { platform: HOST_PLATFORM.platform },
  );
  expect(scope.clients).toContain("kilo");
  expect(scope.unresolved).toBeUndefined();
});

it("leaves an aligned Kilo registration out of update maintenance when KILO_CONFIG_CONTENT adds what setup would not write", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-inline-aligned-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({ mcp: { rea: { type: "local", command, enabled: true } } }),
  );
  const environment = {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { environment: { FOO: "bar" } } },
    }),
  };
  const [status] = await readClientRegistrationStatuses(
    home,
    command[1] ?? "",
    {
      platform: HOST_PLATFORM.platform,
      environment,
      selectedClientIds: ["kilo"],
    },
  );
  expect(status).toMatchObject({ client: "kilo", state: "aligned" });
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    environment,
    { platform: HOST_PLATFORM.platform },
  );
  expect(scope.clients).not.toContain("kilo");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({
      client: "kilo",
      state: "aligned",
      remediation: expect.stringContaining(
        "KILO_CONFIG_CONTENT overrides REA's rea registration",
      ),
    }),
  ]);
});

it("reports a Kilo registration whose KILO_CONFIG_CONTENT differs only in a discovered provider path as needing setup", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-discovered-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({ mcp: { rea: { type: "local", command, enabled: true } } }),
  );
  const inline = (environment: Record<string, string>) =>
    JSON.stringify({ mcp: { rea: { environment } } });
  const hopper = "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    {
      KILO_CONFIG_CONTENT: inline({ HOPPER_LAUNCHER_PATH: hopper }),
    },
    { platform: HOST_PLATFORM.platform },
  );
  // Setup may discover this launcher and write the same value, so update
  // can neither maintain nor refuse the client: its alignment is unknown.
  expect(scope.clients).not.toContain("kilo");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({
      client: "kilo",
      state: "unknown",
      remediation: expect.stringMatching(
        /KILO_CONFIG_CONTENT sets HOPPER_LAUNCHER_PATH .*Run rea setup to check and refresh it\.$/,
      ),
    }),
  ]);

  // An explicit selection or another setting is a conflict update can prove.
  for (const environment of [
    {
      HOPPER_LAUNCHER_PATH: "/opt/hopper",
      KILO_CONFIG_CONTENT: inline({ HOPPER_LAUNCHER_PATH: hopper }),
    },
    {
      KILO_CONFIG_CONTENT: inline({ HOPPER_LAUNCHER_PATH: hopper, FOO: "bar" }),
    },
  ]) {
    const refused = await existingMaintenanceScope(
      home,
      command[1] ?? "",
      environment,
      { platform: HOST_PLATFORM.platform },
    );
    expect(refused.unresolved).toEqual([
      expect.objectContaining({
        client: "kilo",
        state: "aligned",
        remediation: expect.stringContaining(
          "KILO_CONFIG_CONTENT overrides REA's rea registration",
        ),
      }),
    ]);
  }
});

it("reports a Kilo registration whose matching KILO_CONFIG_CONTENT sets a discovered provider path as needing setup", async () => {
  const home = await createTestTempDirectory(
    "rea-kilo-update-discovered-match-",
  );
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  const hopper = "/opt/hopper/hopper";
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({
      mcp: {
        rea: {
          type: "local",
          command,
          enabled: true,
          environment: { HOPPER_LAUNCHER_PATH: hopper },
        },
      },
    }),
  );
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    {
      KILO_CONFIG_CONTENT: JSON.stringify({
        mcp: { rea: { environment: { HOPPER_LAUNCHER_PATH: hopper } } },
      }),
    },
    { platform: HOST_PLATFORM.platform },
  );
  // The entry matches today, but setup may discover another launcher that
  // the inline layer would then override.
  expect(scope.clients).not.toContain("kilo");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({
      client: "kilo",
      state: "unknown",
      remediation: expect.stringContaining(
        "KILO_CONFIG_CONTENT sets HOPPER_LAUNCHER_PATH",
      ),
    }),
  ]);
});

it("leaves a Kilo file whose own launcher REA does not own out of update maintenance", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-foreign-file-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({
      mcp: {
        rea: { type: "local", command: ["/opt/other/server"], enabled: true },
      },
    }),
  );
  const scope = await existingMaintenanceScope(
    home,
    command[1] ?? "",
    {
      KILO_CONFIG_CONTENT: JSON.stringify({ mcp: { rea: { command } } }),
    },
    { platform: HOST_PLATFORM.platform },
  );
  // The effective entry is REA's, but setup refuses to replace the file's
  // foreign launcher, so maintenance must not select Kilo.
  expect(scope.clients).not.toContain("kilo");
  expect(scope.unresolved).toEqual([
    expect.objectContaining({ client: "kilo" }),
  ]);
});

it("matches a discovered setting by Windows environment identity in KILO_CONFIG_CONTENT", async () => {
  const home = await createTestTempDirectory("rea-kilo-update-discovered-win-");
  const root = join(home, ".config", "kilo");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "kilo.json"),
    JSON.stringify({ mcp: { rea: { type: "local", command, enabled: true } } }),
  );
  const environment = {
    KILO_CONFIG_CONTENT: JSON.stringify({
      mcp: { rea: { environment: { Java_Home: "/opt/java" } } },
    }),
  };
  const kilo = await kiloRow(home, environment);
  if (kilo === undefined) throw new Error("Kilo row missing");
  // `Java_Home` is the JAVA_HOME setup discovers on Windows, and a distinct
  // name elsewhere.
  expect(
    await clientRefreshRefusal(kilo, {}, command, {
      platform: "win32",
      currentCommandPath: command[1] ?? "",
    }),
  ).toMatchObject({
    alignment: "unknown",
    remediation: expect.stringContaining("KILO_CONFIG_CONTENT sets JAVA_HOME"),
  });
  expect(
    await clientRefreshRefusal(kilo, {}, command, {
      platform: "linux",
      currentCommandPath: command[1] ?? "",
    }),
  ).toMatchObject({
    alignment: "refused",
  });
});

it("inspects REA's Kilo entry that only KILO_CONFIG_CONTENT sets when no Kilo folder exists", async () => {
  const home = await createTestTempDirectory("rea-kilo-inline-evidence-");
  const statuses = await readClientRegistrationStatuses(
    home,
    command[1] ?? "",
    {
      platform: HOST_PLATFORM.platform,
      environment: {
        KILO_CONFIG_CONTENT: JSON.stringify({
          mcp: { rea: { type: "local", command, enabled: true } },
        }),
      },
    },
  );
  expect(statuses).toContainEqual(
    expect.objectContaining({ client: "kilo", state: "aligned" }),
  );
});
