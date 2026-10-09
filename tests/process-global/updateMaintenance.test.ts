import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result.js";
import { PRODUCT_IDENTITY } from "../../src/identity.js";
import { supportedClients } from "../../src/application/SupportedClients.js";
import {
  existingMaintenanceScope,
  planIntegrationMaintenance,
} from "../../src/application/UpdateMaintenance.js";
import {
  runUpdateCommand,
  systemUpdateHost,
} from "../../src/application/UpdateRuntime.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const entryPoint = resolve("scripts/rea.mjs");
let home: string;

beforeEach(async () => {
  home = await createTestTempDirectory("rea-update-maintenance-");
  for (const [name, value] of Object.entries({
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    CLAUDE_CONFIG_DIR: home,
    CODEX_HOME: join(home, ".codex"),
    COPILOT_HOME: join(home, ".copilot"),
    GROK_HOME: join(home, ".grok"),
    SAND_DATA_ROOT: join(home, ".grokbot"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.jsonc"),
    OMP_PROFILE: undefined,
    PI_CODING_AGENT_DIR: undefined,
    PI_CONFIG_DIR: undefined,
    PI_PROFILE: undefined,
  }))
    vi.stubEnv(name, value);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const writeClient = async (id: string, content: string): Promise<string> => {
  const client = supportedClients(home).find(({ name }) => name === id);
  if (client === undefined) throw new Error(`Unknown test client ${id}`);
  await mkdir(dirname(client.configPath), { recursive: true });
  await writeFile(client.configPath, content);
  return client.configPath;
};

const writeSkill = async (content: string): Promise<string> => {
  const path = join(
    home,
    ".agents",
    "skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
};

const staleCodex =
  '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@0.1.0", "mcp"]\n';
const action = {
  id: "configure_client:codex",
  kind: "configure_client",
  label: "Codex",
  target: "/test/.codex/config.toml",
  detail: "Refresh the pinned REA version",
  external: false,
  operation: "update",
  backupPath: "/test/.codex/config.toml.rea.backup",
  commands: ["rea mcp"],
};

describe("OMP integration maintenance", () => {
  it("refreshes an OMP entry that enabledServers forces on", async () => {
    const entry = { type: "stdio", command: entryPoint, args: ["mcp"] };
    await writeClient(
      "omp",
      JSON.stringify({ mcpServers: { rea: { ...entry, enabled: false } } }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    await writeClient(
      "omp",
      JSON.stringify({
        mcpServers: { rea: { ...entry, enabled: false } },
        enabledServers: ["rea"],
      }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["omp"] });
  });
});

describe("existing REA integration maintenance", () => {
  it("selects owned registrations while preserving unconfigured, foreign, and disabled choices", async () => {
    await writeClient("codex", staleCodex);
    await writeClient("claude_code", '{"mcpServers":{}}');
    await writeClient(
      "cursor",
      '{"mcpServers":{"rea":{"command":"foreign-server","args":[]}}}',
    );
    await writeClient(
      "opencode",
      '{"mcp":{"rea":{"type":"local","command":["npx","-y","rea-agents@0.1.0","mcp"],"enabled":false}}}',
    );
    await writeClient(
      "vscode",
      JSON.stringify({
        servers: { rea: { type: "stdio", command: entryPoint, args: ["mcp"] } },
      }),
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: ["codex", "vscode"],
      skill: false,
    });
  });

  it("does not install a missing skill or overwrite an unrelated skill", async () => {
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
    });
    await writeSkill("---\nname: another-skill\n---\nUser-authored content\n");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
    });
  });

  it("includes an existing REA skill and leaves files untouched", async () => {
    const path = await writeSkill(
      `---\nname: ${PRODUCT_IDENTITY.skillName}\nmetadata:\n  version: "1"\n---\n# REA\n`,
    );
    const original = await readFile(path, "utf8");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: true,
    });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("skips setup entirely when there is no existing integration", async () => {
    let invoked = false;
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      async () => {
        invoked = true;
        return err("Unexpected setup");
      },
    );
    expect(result).toEqual({ status: "current", plannedActions: [] });
    expect(invoked).toBe(false);
  });

  it("returns exact backup and command evidence with a scoped unapplied setup command", async () => {
    await writeClient("codex", staleCodex);
    const recorded: string[][] = [];
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      async (command) => {
        recorded.push([...command]);
        return ok(
          JSON.stringify({ status: "planned", plannedActions: [action] }),
        );
      },
    );
    expect(recorded).toEqual([
      [
        process.execPath,
        entryPoint,
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
    ]);
    expect(result).toEqual({
      status: "planned",
      scope: { clients: ["codex"], skill: false },
      command: recorded[0]?.slice(0, -2),
      plannedActions: [action],
    });
  });

  it.each([
    "{broken",
    JSON.stringify({ status: "ready", plannedActions: [action] }),
    JSON.stringify({
      status: "planned",
      plannedActions: [{ ...action, kind: "install_hopper", external: true }],
    }),
    JSON.stringify({
      status: "planned",
      plannedActions: [{ ...action, id: "configure_client:cursor" }],
    }),
  ])("rejects malformed or out-of-scope subprocess plans", async (output) => {
    await writeClient("codex", staleCodex);
    expect(
      await planIntegrationMaintenance(
        home,
        entryPoint,
        process.env,
        async () => ok(output),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  it("preserves actual setup failure diagnostics", async () => {
    await writeClient("codex", staleCodex);
    expect(
      await planIntegrationMaintenance(
        home,
        entryPoint,
        process.env,
        async () => err("EACCES /test/.codex/config.toml"),
      ),
    ).toEqual({
      status: "unavailable",
      remediation: "EACCES /test/.codex/config.toml",
    });
  });
});

describe("updated executable maintenance planning", () => {
  it("runs real setup as a noninteractive dry run and creates no new integrations or backups", async () => {
    const configPath = await writeClient("codex", staleCodex);
    const untouched = await writeClient("claude_code", '{"mcpServers":{}}');
    vi.stubEnv("npm_command", "exec");
    const result = await planIntegrationMaintenance(
      home,
      entryPoint,
      process.env,
      (command) => runUpdateCommand(command, process.env),
    );
    expect(result).toMatchObject({
      status: "planned",
      scope: { clients: ["codex"], skill: false },
      plannedActions: [
        { id: "configure_client:codex", kind: "configure_client" },
      ],
    });
    expect(await readFile(configPath, "utf8")).toBe(staleCodex);
    expect(await readFile(untouched, "utf8")).toBe('{"mcpServers":{}}');
    await expect(access(`${configPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(home, ".agents", "skills", PRODUCT_IDENTITY.skillName)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("update subprocess boundaries", () => {
  it("exposes update as the sole CLI command", async () => {
    const help = await runUpdateCommand(
      [process.execPath, entryPoint, "--help"],
      process.env,
    );
    expect(help.ok).toBe(true);
    if (help.ok) {
      expect(help.value).toMatch(/^\s{2}update\s/mu);
      expect(help.value).not.toMatch(/^\s{2}upgrade\s/mu);
    }
    const removed = await runUpdateCommand(
      [process.execPath, entryPoint, "upgrade", "--json"],
      process.env,
    );
    expect(removed.ok).toBe(false);
  });
  it("captures output through stream closure and keeps arguments literal", async () => {
    const literal = 'space and $(echo bad); & | "quotes"';
    const result = await runUpdateCommand(
      [
        process.execPath,
        "-e",
        'process.stdout.write("x".repeat(1024 * 1024) + process.argv[1])',
        literal,
      ],
      process.env,
    );
    expect(result).toEqual(ok(`${"x".repeat(1024 * 1024)}${literal}`));
  });

  it("reports actual stderr and launch failures", async () => {
    await expect(
      runUpdateCommand(
        [
          process.execPath,
          "-e",
          'process.stderr.write("EACCES /test/install"); process.exitCode = 2',
        ],
        process.env,
      ),
    ).resolves.toEqual(err("EACCES /test/install"));
    const missing = await runUpdateCommand(
      [join(home, "missing-executable")],
      process.env,
    );
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error).toContain("ENOENT");
  });

  it("verifies the requested package entry rather than PATH's rea", async () => {
    const packageRoot = join(home, "package");
    const script = join(packageRoot, "scripts", "rea.mjs");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(script, 'process.stdout.write("3.3.0\\n")');
    await expect(
      systemUpdateHost(packageRoot, home).installedVersion({
        prefix: home,
        packageRoot,
      }),
    ).resolves.toEqual(ok("3.3.0"));
  });
});
