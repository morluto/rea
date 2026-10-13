import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { err, ok } from "../../src/domain/result.js";
import { runUpdate, type UpdateResult } from "../../src/application/Update.js";
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
    LOCALAPPDATA: join(home, "AppData", "Local"),
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

  it("preserves Grok Build disabled_mcp_servers during maintenance planning", async () => {
    // Strict identity: a user-disabled integration must never be selected
    // for maintenance, even with a healthy owned entry underneath.
    const registration = `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entryPoint)}, "mcp"]\nstartup_timeout_sec = 30\n`;
    const configPath = await writeClient(
      "grok_build",
      `disabled_mcp_servers = ["rea", "other"]\n${registration}`,
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    expect(await readFile(configPath, "utf8")).toContain(
      'disabled_mcp_servers = ["rea", "other"]',
    );
    await writeFile(
      configPath,
      `disabled_mcp_servers = ["other"]\n${registration}`,
    );
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["grok_build"] });
  });
});

describe("maintenance activation and layered configuration", () => {
  it("leaves a natively disabled ZCode registration outside maintenance", async () => {
    const configPath = await writeClient(
      "zcode",
      JSON.stringify({
        mcp: {
          servers: {
            rea: { command: entryPoint, args: ["mcp"], enable: false },
          },
        },
      }),
    );
    const original = await readFile(configPath, "utf8");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: [] });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("selects an enabled registration inherited through layered OpenCode files", async () => {
    const directory = join(home, ".config", "opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({
        mcp: { rea: { type: "local", command: [entryPoint, "mcp"] } },
      }),
    );
    await writeClient("opencode", JSON.stringify({ theme: "user-selected" }));
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toMatchObject({ clients: ["opencode"] });
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
      skillDestinations: [],
    });
  });

  it("does not install a missing skill or overwrite an unrelated skill", async () => {
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
      skillDestinations: [],
    });
    await writeSkill("---\nname: another-skill\n---\nUser-authored content\n");
    await expect(
      existingMaintenanceScope(home, entryPoint, process.env),
    ).resolves.toEqual({
      clients: [],
      skill: false,
      skillDestinations: [],
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
      skillDestinations: [
        {
          client: "shared",
          path: join(home, ".agents", "skills", PRODUCT_IDENTITY.skillName),
        },
      ],
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
      scope: { clients: ["codex"], skill: false, skillDestinations: [] },
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
        manager: "npm",
        prefix: home,
        packageRoot,
      }),
    ).resolves.toEqual(ok("3.3.0"));
  });
});

describe("Bun global installation update", () => {
  it.each([
    ["1.4.2", "updated", "absolute"],
    ["1.2.17", "updated", "absolute"],
    ["1.2.17", "updated", "relative"],
    ["1.2.14", "failed", "absolute"],
    ["1.2.17-canary.1", "failed", "absolute"],
    ["unknown", "failed", "absolute"],
  ])(
    "handles Bun %s with outcome %s using %s global-directory configuration",
    async (bunVersion, status, directoryMode) => {
      // A recording `bun` on PATH crosses the real subprocess boundary without registry access.
      const root = await createTestTempDirectory("rea-update-bun-");
      const globalDirectory = join(root, "bun", "install", "global");
      const packageRoot = join(
        globalDirectory,
        "node_modules",
        PRODUCT_IDENTITY.packageName,
      );
      const versionPath = join(root, "installed-version");
      const logPath = join(root, "bun-invocations.jsonl");
      await mkdir(join(packageRoot, "scripts"), { recursive: true });
      await writeFile(
        join(globalDirectory, "package.json"),
        '{"dependencies":{"rea-agents":"3.2.1"}}\n',
      );
      await writeFile(versionPath, "3.2.1");
      await writeFile(
        join(packageRoot, "scripts", "rea.mjs"),
        `import { readFileSync } from "node:fs";\nprocess.stdout.write(readFileSync(${JSON.stringify(versionPath)}, "utf8") + "\\n");\n`,
      );
      const binDirectory = join(root, "bin");
      const recorder = join(binDirectory, "record-bun.mjs");
      await mkdir(binDirectory);
      await writeFile(
        recorder,
        [
          'import { appendFileSync, writeFileSync } from "node:fs";',
          "const args = process.argv.slice(2);",
          `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), globalDirectory: process.env.BUN_INSTALL_GLOBAL_DIR }) + "\\n");`,
          `if (JSON.stringify(args) === '["--version"]') console.log(${JSON.stringify(bunVersion)});`,
          `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["info", PRODUCT_IDENTITY.packageName, "dist-tags.latest", "--json"]))}) process.stdout.write('"3.3.0"\\n');`,
          `else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(["add", "--global", "--ignore-scripts", `${PRODUCT_IDENTITY.packageName}@3.3.0`]))}) writeFileSync(${JSON.stringify(versionPath)}, "3.3.0");`,
          "else process.exitCode = 2;",
          "",
        ].join("\n"),
      );
      if (process.platform === "win32") {
        await writeFile(
          join(binDirectory, "bun.cmd"),
          `@"${process.execPath}" "${recorder}" %*\r\n`,
        );
      } else {
        await writeFile(
          join(binDirectory, "bun"),
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`,
          { mode: 0o755 },
        );
      }
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
        "PATH";
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        [pathKey]: `${binDirectory}${delimiter}${process.env[pathKey] ?? ""}`,
        BUN_INSTALL: join(root, "bun"),
      };
      delete environment.BUN_INSTALL_GLOBAL_DIR;
      if (directoryMode === "relative")
        environment.BUN_INSTALL_GLOBAL_DIR = relative(root, globalDirectory);

      const callerDirectory = process.cwd();
      let result: UpdateResult;
      try {
        process.chdir(root);
        result = await runUpdate(
          "3.2.1",
          systemUpdateHost(packageRoot, home, environment),
          "structured",
        );
      } finally {
        process.chdir(callerDirectory);
      }

      const invocations = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      const versionInvocation = {
        args: ["--version"],
        cwd: globalDirectory,
        globalDirectory,
      };
      if (status === "failed") {
        expect(result).toEqual({
          status: "failed",
          currentVersion: "3.2.1",
          latestVersion: null,
          reason: "version-check",
          remediation: `REA updates for Bun global installations require Bun 1.2.17 or later; bun --version returned ${JSON.stringify(bunVersion)}. Upgrade Bun manually, then rerun rea update.`,
        });
        expect(invocations).toEqual([versionInvocation]);
        expect(await readFile(versionPath, "utf8")).toBe("3.2.1");
        return;
      }

      expect(result).toMatchObject({
        status: "updated",
        installMethod: "bun",
        installedVersion: "3.3.0",
        command: [
          "bun",
          "add",
          "--global",
          "--ignore-scripts",
          `${PRODUCT_IDENTITY.packageName}@3.3.0`,
        ],
      });
      // `bun info` needs a project in its working directory, and the caller's
      // directory must never be selected, so all commands run in the owner.
      expect(invocations).toEqual([
        versionInvocation,
        {
          args: [
            "info",
            PRODUCT_IDENTITY.packageName,
            "dist-tags.latest",
            "--json",
          ],
          cwd: globalDirectory,
          globalDirectory,
        },
        {
          args: [
            "add",
            "--global",
            "--ignore-scripts",
            `${PRODUCT_IDENTITY.packageName}@3.3.0`,
          ],
          cwd: globalDirectory,
          globalDirectory,
        },
      ]);
    },
  );
});
