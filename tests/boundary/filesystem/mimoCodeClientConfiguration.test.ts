import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import {
  resolveSupportedClients,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { existingMaintenanceScope } from "../../../src/application/UpdateMaintenance.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const platform = process.platform;
const command = currentClientRegistrationCommand({ platform });
const registration = { type: "local", command, enabled: true };
const foreign = { type: "local", command: ["/opt/other/rea", "mcp"] };
const claudeEntry = { command: command[0], args: command.slice(1) };

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const mimoRow = async (home: string, environment: NodeJS.ProcessEnv = {}) => {
  const row = (await resolveSupportedClients(home, platform, environment)).find(
    ({ name }) => name === "mimo_code",
  );
  if (row === undefined) throw new Error("MiMo Code row is missing");
  return row;
};

/** A home where MiMo Code has created its global configuration folder. */
const installedHome = async (prefix: string) => {
  const home = await createTestTempDirectory(prefix);
  const directory = join(home, ".config", "mimocode");
  await mkdir(directory, { recursive: true });
  return { home, directory, target: join(directory, "mimocode.jsonc") };
};

const doctor = async (
  home: string,
  environment: NodeJS.ProcessEnv = {},
  scope?: "user",
) =>
  (
    await readClientRegistrationStatuses(home, command[1], {
      platform,
      environment,
      ...(scope === undefined ? {} : { scope }),
    })
  ).find(({ client }) => client === "mimo_code");

const uninstall = async (home: string, environment: NodeJS.ProcessEnv = {}) =>
  (
    await runUninstall(
      false,
      systemUninstallHost(home, undefined, environment, platform),
    )
  ).items;

describe("MiMo Code configuration location", () => {
  it("writes mimocode.jsonc until another global file exists, as MiMo Code's writer does", async () => {
    const { home, directory } = await installedHome("rea-mimo-default-");
    expect(await mimoRow(home)).toMatchObject({
      displayName: "MiMo Code",
      format: "mimo_code",
      configPath: join(directory, "mimocode.jsonc"),
      configPaths: ["config.json", "mimocode.json", "mimocode.jsonc"].map(
        (name) => join(directory, name),
      ),
      markerPath: directory,
    });
    await writeFile(join(directory, "config.json"), "{}");
    expect((await mimoRow(home)).configPath).toBe(
      join(directory, "config.json"),
    );
    await writeFile(join(directory, "mimocode.json"), "{}");
    expect((await mimoRow(home)).configPath).toBe(
      join(directory, "mimocode.json"),
    );
    await writeFile(join(directory, "mimocode.jsonc"), "{}");
    expect((await mimoRow(home)).configPath).toBe(
      join(directory, "mimocode.jsonc"),
    );
  });

  it("follows MIMOCODE_HOME before XDG_CONFIG_HOME", async () => {
    const home = await createTestTempDirectory("rea-mimo-home-");
    const xdg = join(home, "xdg");
    const profile = join(home, "profile");
    expect((await mimoRow(home, { XDG_CONFIG_HOME: xdg })).configPath).toBe(
      join(xdg, "mimocode", "mimocode.jsonc"),
    );
    expect(
      await mimoRow(home, { XDG_CONFIG_HOME: xdg, MIMOCODE_HOME: profile }),
    ).toMatchObject({
      configPath: join(profile, "config", "mimocode.jsonc"),
      markerPath: join(profile, "config"),
    });
    // MiMo Code treats an empty MIMOCODE_HOME as unset.
    expect((await mimoRow(home, { MIMOCODE_HOME: "" })).markerPath).toBe(
      join(home, ".config", "mimocode"),
    );
  });

  it("refuses a relative configuration home instead of guessing a folder", async () => {
    const home = await createTestTempDirectory("rea-mimo-relative-");
    for (const [variable, environment] of [
      ["MIMOCODE_HOME", { MIMOCODE_HOME: "profile" }],
      ["XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "config" }],
    ] as const) {
      const row = supportedClients(home, platform, environment).find(
        ({ name }) => name === "mimo_code",
      );
      expect(row?.configPathError).toContain(`${variable} is relative`);
      expect(row).not.toHaveProperty("markerPath");
    }
  });
});

describe("MiMo Code registration lifecycle", () => {
  it("registers once in a commented mimocode.jsonc and uninstalls only REA's entry", async () => {
    const { home, target } = await installedHome("rea-mimo-lifecycle-");
    const other = { type: "local", command: ["other-server"], disabled: true };
    await writeFile(
      target,
      `{
  // MiMo Code's starter settings
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "mcp": {
    // A server the user manages
    "other": { "type": "local", "command": ["other-server"], "disabled": true },
  },
}
`,
    );
    const client = await mimoRow(home);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(target, "utf8");
    expect(text).toContain("// MiMo Code's starter settings");
    expect(text).toContain("// A server the user manages");
    expect(parse(text).mcp).toEqual({ other, rea: registration });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(target, "utf8")).toBe(text);
    expect(await doctor(home)).toMatchObject({
      config_path: target,
      state: "aligned",
    });

    expect(await uninstall(home)).toContainEqual(
      expect.objectContaining({ name: "mimo_code", status: "removed" }),
    );
    const after = await readFile(target, "utf8");
    expect(after).toContain("// A server the user manages");
    expect(parse(after).mcp).toEqual({ other });
  });

  it("ignores the disabled key MiMo Code strips, whatever its value", async () => {
    const { home, target } = await installedHome("rea-mimo-stripped-");
    for (const disabled of ["false", true]) {
      await writeFile(
        target,
        JSON.stringify({ mcp: { rea: { ...registration, disabled } } }),
      );
      expect(await doctor(home, {}, "user")).toMatchObject({
        config_path: target,
        state: "aligned",
      });
    }
  });

  it("keeps a same-name entry REA does not own", async () => {
    const { home, target } = await installedHome("rea-mimo-foreign-");
    const original = JSON.stringify({ mcp: { rea: foreign } });
    await writeFile(target, original);
    const items = await uninstall(home);
    expect(items.find(({ name }) => name === "mimo_code")?.status).not.toBe(
      "removed",
    );
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("removes REA's entries from every global file MiMo Code merges", async () => {
    const { home, directory, target } = await installedHome(
      "rea-mimo-global-layers-",
    );
    const lower = join(directory, "config.json");
    await writeFile(lower, JSON.stringify({ mcp: { rea: registration } }));
    await writeFile(target, JSON.stringify({ mcp: { rea: registration } }));
    expect(await uninstall(home)).toContainEqual(
      expect.objectContaining({ name: "mimo_code", status: "removed" }),
    );
    for (const path of [lower, target])
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcp: {} });
  });

  it("removes REA's lower entry when only the stripped disabled key differs from the override", async () => {
    const { home, directory, target } = await installedHome(
      "rea-mimo-stripped-override-",
    );
    const lower = join(directory, "config.json");
    await writeFile(
      lower,
      JSON.stringify({
        mcp: { rea: { type: "local", command, disabled: false } },
      }),
    );
    const kept = JSON.stringify({
      mcp: { rea: { ...foreign, enabled: true } },
    });
    await writeFile(target, kept);
    const items = (await uninstall(home)).filter(
      ({ name }) => name === "mimo_code",
    );
    expect(items).toContainEqual(
      expect.objectContaining({ status: "removed" }),
    );
    expect(items).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(JSON.parse(await readFile(lower, "utf8"))).toEqual({ mcp: {} });
    expect(await readFile(target, "utf8")).toBe(kept);
  });
});

describe("MiMo Code project configuration", () => {
  it("reports a project .mimocode entry that disables REA without editing it", async () => {
    const { home, target } = await installedHome("rea-mimo-project-");
    await writeFile(target, JSON.stringify({ mcp: { rea: registration } }));
    const project = await createTestTempDirectory("rea-mimo-project-root-");
    const projectFile = join(project, ".mimocode", "mimocode.jsonc");
    await mkdir(join(project, ".mimocode"));
    const disabled = '{ "mcp": { "rea": { "enabled": false } } }\n';
    await writeFile(projectFile, disabled);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      expect(await doctor(home)).toMatchObject({
        config_path: projectFile,
        scope: "project",
        state: "stale",
        remediation: expect.stringContaining(
          `does not modify project-scoped configuration at ${projectFile}`,
        ),
      });
      // The user file already holds REA's entry, so setup leaves both alone.
      expect(
        await configureClientConfiguration(await mimoRow(home), {}, command),
      ).toEqual({ status: "unchanged" });
    } finally {
      cwd.mockRestore();
    }
    expect(await readFile(projectFile, "utf8")).toBe(disabled);
    // A user-scope view ignores the project folder.
    expect(await doctor(home, {}, "user")).toMatchObject({
      config_path: target,
      state: "aligned",
    });
  });

  it("loads a project's mimocode.jsonc over its mimocode.json", async () => {
    const { home, target } = await installedHome("rea-mimo-project-files-");
    await writeFile(target, JSON.stringify({ mcp: { rea: registration } }));
    const project = await createTestTempDirectory("rea-mimo-project-files-");
    await writeFile(
      join(project, "mimocode.json"),
      JSON.stringify({ mcp: { rea: { enabled: false } } }),
    );
    await writeFile(
      join(project, "mimocode.jsonc"),
      JSON.stringify({ mcp: { rea: { enabled: true } } }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      expect(await doctor(home)).toMatchObject({
        config_path: join(project, "mimocode.jsonc"),
        scope: "project",
        state: "aligned",
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it("sends the repair to the user file when a project only adds the disabled key MiMo Code strips", async () => {
    const { home, target } = await installedHome("rea-mimo-project-disabled-");
    await writeFile(
      target,
      JSON.stringify({ mcp: { rea: { ...registration, enabled: false } } }),
    );
    const project = await createTestTempDirectory("rea-mimo-project-disabled-");
    const projectFile = join(project, "mimocode.json");
    await writeFile(
      projectFile,
      JSON.stringify({ mcp: { rea: { disabled: true } } }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
    try {
      const status = await doctor(home);
      expect(status).toMatchObject({
        state: "stale",
        remediation: expect.stringContaining("Run rea setup"),
      });
      expect(status?.remediation).not.toContain(projectFile);
    } finally {
      cwd.mockRestore();
    }
  });

  it("keeps user scope for the Claude Code import when the project is the home folder", async () => {
    const { home } = await installedHome("rea-mimo-project-home-");
    const claude = join(home, ".claude.json");
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { rea: claudeEntry } }),
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
    try {
      const status = await doctor(home);
      expect(status).toMatchObject({ config_path: claude, state: "aligned" });
      expect(status).not.toHaveProperty("scope", "project");
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("MiMo Code's Claude Code import", () => {
  it("reports the rea entry MiMo Code imports from ~/.claude.json until it has its own", async () => {
    const { home, target } = await installedHome("rea-mimo-claude-");
    const claude = join(home, ".claude.json");
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { rea: claudeEntry } }),
    );
    expect(await doctor(home, {}, "user")).toMatchObject({
      config_path: claude,
      command,
      state: "aligned",
      advisory: expect.stringContaining(
        "MiMo Code imports this rea entry from Claude Code",
      ),
    });
    for (const variable of [
      "MIMOCODE_DISABLE_CLAUDE_CODE",
      "MIMOCODE_DISABLE_CLAUDE_CODE_MCP",
    ])
      expect(await doctor(home, { [variable]: "TRUE" }, "user")).toMatchObject({
        config_path: target,
        state: "missing",
      });
    // MiMo Code's own entry wins over the import.
    await writeFile(target, JSON.stringify({ mcp: { rea: registration } }));
    const own = await doctor(home, {}, "user");
    expect(own).toMatchObject({ config_path: target, state: "aligned" });
    expect(own).not.toHaveProperty("advisory");
  });

  it("asks for setup when the imported Claude Code entry is disabled", async () => {
    const { home } = await installedHome("rea-mimo-claude-disabled-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { rea: { ...claudeEntry, disabled: true } },
      }),
    );
    expect(await doctor(home, {}, "user")).toMatchObject({
      state: "stale",
      remediation: expect.stringMatching(
        /MiMo Code imports this rea entry from Claude Code.*Run rea setup/,
      ),
    });
  });
});

describe("MiMo Code setup with a Claude Code import", () => {
  it("refuses setup that would replace an imported Claude Code entry REA does not own", async () => {
    const { home, target } = await installedHome("rea-mimo-claude-setup-");
    const claude = join(home, ".claude.json");
    await writeFile(
      claude,
      JSON.stringify({
        mcpServers: { rea: { command: "/opt/other/rea", args: ["mcp"] } },
      }),
    );
    const client = await mimoRow(home);
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      { status: "invalid", remediation: expect.stringContaining(claude) },
    );
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({
      status: "failed",
      reason: "registration_ownership",
      detail: expect.stringContaining(claude),
    });
    await expect(readFile(target, "utf8")).rejects.toThrow();
    expect((await doctor(home, {}, "user"))?.remediation).not.toContain(
      "gives it its own entry",
    );
    const unimported = await mimoRow(home, {
      MIMOCODE_DISABLE_CLAUDE_CODE_MCP: "1",
    });
    expect(await inspectClientConfiguration(unimported, {}, command)).toEqual({
      status: "create",
    });
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { rea: claudeEntry } }),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
  });

  it.skipIf(platform === "win32")(
    "refuses a native write target that resolves to the Claude import",
    async () => {
      const { home, target } = await installedHome("rea-mimo-aliased-target-");
      const claude = join(home, ".claude.json");
      const original = JSON.stringify({ mcpServers: { rea: claudeEntry } });
      await writeFile(claude, original);
      await symlink(claude, target);
      const client = await mimoRow(home);
      const preview = await inspectClientConfiguration(client, {}, command);
      const apply = await configureClientConfiguration(client, {}, command);
      expect(await readFile(claude, "utf8")).toBe(original);
      expect(preview).toMatchObject({
        status: "invalid",
        remediation: expect.stringContaining(claude),
      });
      expect(apply.status).toBe("failed");
      await expect(readFile(`${target}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([false, true])(
    "combines imported language and selected compiler before preview and apply (existing native file: %s)",
    async (exists) => {
      const { home, target } = await installedHome("rea-mimo-import-compiler-");
      if (exists) await writeFile(target, "{}");
      const client = await mimoRow(home);
      const imported = join(home, ".claude.json");
      const language = { REA_GHIDRA_LANGUAGE_ID: "x86:LE:64:default" };
      const compiler = { REA_GHIDRA_COMPILER_SPEC_ID: "gcc" };
      const original = JSON.stringify({
        mcpServers: { rea: { ...claudeEntry, env: language } },
      });
      await writeFile(imported, original);
      expect(
        (await inspectClientConfiguration(client, compiler, command)).status,
      ).toBe(exists ? "update" : "create");
      expect(
        (await configureClientConfiguration(client, compiler, command)).status,
      ).toBe("configured");
      expect(parse(await readFile(target, "utf8")).mcp.rea.environment).toEqual(
        { ...language, ...compiler },
      );
      expect(await readFile(imported, "utf8")).toBe(original);
    },
  );

  it("keeps the settings of REA's imported Claude Code entry when setup gives MiMo Code its own", async () => {
    const { home, target } = await installedHome("rea-mimo-claude-settings-");
    const environment = {
      REA_ANALYSIS_PROVIDER: "auto",
      REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
    };
    const claude = join(home, ".claude.json");
    const original = JSON.stringify({
      mcpServers: { rea: { ...claudeEntry, disabled: true, env: environment } },
    });
    await writeFile(claude, original);
    expect(
      (await configureClientConfiguration(await mimoRow(home), {}, command))
        .status,
    ).toBe("configured");
    expect(parse(await readFile(target, "utf8")).mcp.rea).toEqual({
      ...registration,
      environment,
    });
    expect(await readFile(claude, "utf8")).toBe(original);
    expect(await doctor(home, {}, "user")).toMatchObject({
      config_path: target,
      state: "aligned",
    });
  });

  it.each(["missing", "existing"] as const)(
    "rejects an invalid imported environment when the native file is %s",
    async (targetState) => {
      const { home, target } = await installedHome("rea-mimo-import-preview-");
      const claude = join(home, ".claude.json");
      const original = JSON.stringify({
        mcpServers: {
          rea: { ...claudeEntry, env: { REA_ANALYSIS_PROVIDER: "Auto" } },
        },
      });
      await writeFile(claude, original);
      if (targetState === "existing") await writeFile(target, "{}");

      const client = await mimoRow(home);
      expect(
        await inspectClientConfiguration(client, {}, command),
      ).toMatchObject({
        status: "invalid",
        remediation: expect.stringContaining("REA_ANALYSIS_PROVIDER"),
      });
      expect(
        await configureClientConfiguration(client, {}, command),
      ).toMatchObject({
        status: "failed",
      });
      expect(await readFile(claude, "utf8")).toBe(original);
      if (targetState === "existing")
        expect(await readFile(target, "utf8")).toBe("{}");
      else
        await expect(readFile(target, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );
});

describe("MiMo Code uninstall with a Claude Code import", () => {
  it("keeps the native registration if Claude retains a replacement after preflight", async () => {
    const { home, target } = await installedHome("rea-mimo-replaced-import-");
    const claude = join(home, ".claude.json");
    const native = JSON.stringify({ mcp: { rea: registration } });
    const replacement = JSON.stringify({
      mcpServers: { rea: { command: "/opt/other/rea", args: ["mcp"] } },
    });
    await writeFile(target, native);
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { rea: claudeEntry } }),
    );
    const host = systemUninstallHost(home, undefined, {}, platform);
    const purgeData = vi.fn(async () => []);
    const result = await runUninstall(true, {
      ...host,
      purgeData,
      removeClient: async (client) => {
        if (client.name === "claude_code") await writeFile(claude, replacement);
        return host.removeClient(client);
      },
    });
    expect(result.status).toBe("failed");
    expect(purgeData).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(native);
    expect(await readFile(claude, "utf8")).toBe(replacement);
  });
  it.each([false, true])(
    "blocks purge when only an owned Claude import remains (existing native file: %s)",
    async (exists) => {
      const { home, target } = await installedHome("rea-mimo-only-import-");
      if (exists) await writeFile(target, "{}");
      const path = join(home, ".claude.json");
      const environment = { CLAUDE_CONFIG_DIR: join(home, "other-profile") };
      const host = systemUninstallHost(home, undefined, environment, platform);
      const purgeData = vi.fn(async () => []);
      const original = JSON.stringify({ mcpServers: { rea: claudeEntry } });
      await writeFile(path, original);
      const result = await runUninstall(true, { ...host, purgeData });
      expect(result.status).toBe("failed");
      expect(
        result.items.filter(
          ({ name, status }) => name === "mimo_code" && status === "failed",
        ),
      ).toEqual([
        expect.objectContaining({ detail: expect.stringContaining(path) }),
      ]);
      expect(purgeData).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(original);
    },
  );

  it.each([
    "disabled",
    "foreign",
    "shadowed",
    "opted-out",
    "absent-client",
  ] as const)(
    "leaves an existing Claude entry alone when the import is %s",
    async (state) => {
      const home = await createTestTempDirectory("rea-mimo-kept-import-");
      const directory = join(home, ".config", "mimocode");
      if (state !== "absent-client")
        await mkdir(directory, { recursive: true });
      if (state === "shadowed")
        await writeFile(
          join(directory, "mimocode.json"),
          JSON.stringify({ mcp: { rea: foreign } }),
        );
      const path = join(home, ".claude.json");
      const entry =
        state === "foreign"
          ? { command: "/opt/other/rea", args: ["mcp"] }
          : { ...claudeEntry, disabled: state === "disabled" };
      const original = JSON.stringify({ mcpServers: { rea: entry } });
      await writeFile(path, original);
      const items = await uninstall(home, {
        CLAUDE_CONFIG_DIR: join(home, "other-profile"),
        ...(state === "opted-out"
          ? { MIMOCODE_DISABLE_CLAUDE_CODE_MCP: "1" }
          : {}),
      });
      expect(items.filter(({ status }) => status === "failed")).toEqual([]);
      expect(await readFile(path, "utf8")).toBe(original);
    },
  );

  it("refuses to uninstall when removal would let MiMo Code import a Claude Code entry REA keeps", async () => {
    const { home, target } = await installedHome("rea-mimo-claude-expose-");
    const owned = JSON.stringify({ mcp: { rea: registration } });
    await writeFile(target, owned);
    const claude = join(home, ".claude.json");
    const kept = JSON.stringify({
      mcpServers: { rea: { command: "/opt/other/rea", args: ["mcp"] } },
    });
    await writeFile(claude, kept);
    const mimo = (await uninstall(home)).find(
      ({ name }) => name === "mimo_code",
    );
    expect(mimo).toMatchObject({
      status: "failed",
      detail: expect.stringContaining(claude),
    });
    expect(await readFile(target, "utf8")).toBe(owned);
    expect(await readFile(claude, "utf8")).toBe(kept);
    // Without the import, nothing takes REA's place.
    expect(
      await uninstall(home, { MIMOCODE_DISABLE_CLAUDE_CODE_MCP: "1" }),
    ).toContainEqual(
      expect.objectContaining({ name: "mimo_code", status: "removed" }),
    );
  });

  it("uninstalls both entries when the Claude Code entry is REA's own", async () => {
    const { home, target } = await installedHome("rea-mimo-claude-owned-");
    await writeFile(target, JSON.stringify({ mcp: { rea: registration } }));
    const claude = join(home, ".claude.json");
    await writeFile(
      claude,
      JSON.stringify({ mcpServers: { rea: claudeEntry } }),
    );
    const items = await uninstall(home, {
      CLAUDE_CONFIG_DIR: relative(process.cwd(), home),
    });
    for (const name of ["mimo_code", "claude_code"])
      expect(items).toContainEqual(
        expect.objectContaining({ name, status: "removed" }),
      );
    expect(JSON.parse(await readFile(claude, "utf8"))).toEqual({
      mcpServers: {},
    });
  });
});

describe("Update maintenance of MiMo Code's Claude Code import", () => {
  const pinned = JSON.stringify({
    mcpServers: {
      rea: {
        command: "npx",
        args: ["-y", `${PRODUCT_IDENTITY.packageName}@3.2.0`, "mcp"],
      },
    },
  });

  it("leaves an imported registration to Claude Code's own update maintenance", async () => {
    const { home } = await installedHome("rea-mimo-claude-update-");
    await writeFile(join(home, ".claude.json"), pinned);
    const scope = await existingMaintenanceScope(
      home,
      command[1] ?? "",
      { CLAUDE_CONFIG_DIR: relative(process.cwd(), home) },
      {
        platform,
      },
    );
    expect(scope.clients).toContain("claude_code");
    expect(scope.clients).not.toContain("mimo_code");
    expect(scope).not.toHaveProperty("unresolved");
  });

  it("reports an imported entry update cannot refresh when Claude Code reads another file", async () => {
    const { home } = await installedHome("rea-mimo-claude-config-dir-");
    const imported = join(home, ".claude.json");
    await writeFile(imported, pinned);
    const scope = await existingMaintenanceScope(
      home,
      command[1] ?? "",
      { CLAUDE_CONFIG_DIR: join(home, "claude-profile") },
      { platform },
    );
    expect(scope.clients).not.toContain("mimo_code");
    expect(scope.unresolved).toContainEqual(
      expect.objectContaining({
        client: "mimo_code",
        config_path: imported,
        state: "stale",
        remediation: expect.stringContaining("rea setup --client mimo_code"),
      }),
    );
  });

  it("reports an imported entry whose environment REA rejects as invalid", async () => {
    const { home } = await installedHome("rea-mimo-claude-environment-");
    const imported = join(home, ".claude.json");
    await writeFile(
      imported,
      JSON.stringify({
        mcpServers: {
          rea: { ...claudeEntry, env: { REA_ANALYSIS_PROVIDER: "Auto" } },
        },
      }),
    );
    const invalid = {
      client: "mimo_code",
      config_path: imported,
      command_identity: "owned",
      state: "invalid",
      remediation: expect.stringMatching(
        /^MiMo Code imports this rea entry from Claude Code.*REA_ANALYSIS_PROVIDER/,
      ),
    };
    expect(await doctor(home, {}, "user")).toMatchObject(invalid);
    const scope = await existingMaintenanceScope(
      home,
      command[1] ?? "",
      { CLAUDE_CONFIG_DIR: join(home, "claude-profile") },
      { platform },
    );
    expect(scope.unresolved).toContainEqual(expect.objectContaining(invalid));
  });
});
