import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  unlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import {
  primaryAnalysisError,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import { FakeSetupHost, options } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";
import { withPluginSetup } from "./SetupPluginHost.js";
import { CursorLocalPlugin } from "./CursorLocalPlugin.js";
import { MCP_BOOTSTRAP_FILES } from "../../scripts/lib/cli-runtime-files.mjs";

const writeDownloadedPackage = async (
  prefix: string,
  wrongVersion: boolean,
) => {
  const packageRoot = join(prefix, "node_modules", "rea-agents");
  for (const directory of [
    ".claude-plugin",
    "scripts",
    "scripts/lib",
    "dist",
    "dist/mcp",
    "dist/cli-runtime",
    "skills/reverse-engineer-anything",
    "assets",
  ])
    await mkdir(join(packageRoot, directory), { recursive: true });
  await copyFile(
    new URL("../../.claude-plugin/plugin.json", import.meta.url),
    join(packageRoot, ".claude-plugin", "plugin.json"),
  );
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "rea-agents",
      version: wrongVersion ? "0.0.0" : PRODUCT_IDENTITY.packageVersion,
    }),
  );
  for (const path of [
    "scripts/plugin-mcp-launcher.mjs",
    "dist/cli.js",
    ...MCP_BOOTSTRAP_FILES,
    "scripts/rea.mjs",
    "skills/reverse-engineer-anything/SKILL.md",
    "assets/rea-plugin.png",
  ])
    await writeFile(join(packageRoot, path), "fixture package content\n");
};

const fixture = async () => {
  const home = await createTestTempDirectory("rea-cursor-local-");
  const base = new FakeSetupHost(process.platform);
  Object.defineProperty(base, "homeDirectory", { value: home });
  const config = join(home, ".cursor", "mcp.json");
  const local = join(home, ".cursor", "plugins", "local");
  const target = join(local, "rea");
  base.clients = [{ name: "cursor", configPath: config, format: "json" }];
  base.clientInspections.set("cursor", { status: "create" });
  base.productRegistrations = [
    {
      client: "cursor",
      config_path: config,
      command: [],
      state: "missing",
      remediation: "Install REA.",
    },
  ];
  base.doctorHealthy = true;
  const downloads: Array<readonly string[]> = [];
  let fail = false;
  let interrupt = false;
  let allowCleanup = false;
  let foreignDuringDownload = false;
  let directDuringDownload = false;
  let wrongVersion = false;
  let missingNode = false;
  const launch: SetupPluginCommandLauncher = async (
    command,
    args,
    invocation,
  ) => {
    if (command === "node")
      return {
        exitCode: 0,
        signal: null,
        stdout: missingNode ? "" : "v24.22.1",
        stderr: "",
        timedOut: false,
      };
    expect(command).toBe("npm");
    downloads.push(args);
    if (interrupt) {
      invocation.resources.retain({
        kind: "lease",
        resource: "installer child",
        lease: new AnalysisCleanupLease(async () => {
          if (!allowCleanup)
            throw new Error("controlled installer cleanup refusal");
        }, ["installer child"]),
      });
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "cancelled",
        timedOut: false,
        interruptedSignal: "SIGINT",
        ...(allowCleanup
          ? {}
          : { cleanupFailure: "controlled installer cleanup refusal" }),
      };
    }
    if (fail)
      return {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "Registry authentication required",
        timedOut: false,
      };
    const prefix = args[args.indexOf("--prefix") + 1];
    if (prefix === undefined) throw new Error("Missing installer prefix");
    await writeDownloadedPackage(prefix, wrongVersion);
    if (foreignDuringDownload) {
      await mkdir(target);
      await writeFile(join(target, "user-data"), "preserve");
    }
    if (directDuringDownload) {
      base.clientInspections.set("cursor", { status: "already_current" });
      await writeFile(config, "concurrent direct registration");
    }
    return {
      exitCode: 0,
      signal: null,
      stdout: "installed",
      stderr: "",
      timedOut: false,
    };
  };
  const setupOptions = {
    ...options(true),
    clientIds: ["cursor"],
    proposeHopper: false,
  };
  return {
    base,
    home,
    config,
    local,
    target,
    downloads,
    setupOptions,
    host: (cursorPlugin = true, signal?: AbortSignal) =>
      withPluginSetup(
        base,
        {},
        {
          preferPlugins: true,
          cursorPlugin,
          ...(signal === undefined ? {} : { signal }),
        },
        launch,
      ),
    fail: () => {
      fail = true;
    },
    interrupt: (cleanupSucceeds = false) => {
      interrupt = true;
      allowCleanup = cleanupSucceeds;
    },
    allowCleanup: () => {
      allowCleanup = true;
    },
    foreignDuringDownload: () => {
      foreignDuringDownload = true;
    },
    directDuringDownload: () => {
      directDuringDownload = true;
    },
    missingNode: () => {
      missingNode = true;
    },
    wrongVersion: () => {
      wrongVersion = true;
    },
  };
};

it.each(["dry-run", "unapproved", "declined"] as const)(
  "does not create a Cursor local plugin during %s",
  async (mode) => {
    const f = await fixture();
    const result = await runSetup(
      { ...f.setupOptions, dryRun: mode === "dry-run", approved: false },
      f.host(),
      mode === "declined" ? async () => false : undefined,
    );
    expect(result.status).toBe(
      mode === "dry-run"
        ? "planned"
        : mode === "unapproved"
          ? "needs_confirmation"
          : "cancelled",
    );
    expect(result.plannedActions).toContainEqual(
      expect.objectContaining({
        label: "REA local plugin for Cursor",
        external: true,
        target: f.target,
      }),
    );
    expect(f.downloads).toEqual([]);
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    await expect(access(join(f.home, ".cursor"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("installs the pinned Cursor local plugin and leaves its runtime stable on reruns", async () => {
  const f = await fixture();
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("ready");
  expect(result.doctor.scope.plugin_clients).toEqual(["cursor"]);
  expect(f.downloads).toHaveLength(1);
  expect(f.downloads[0]).toContain(
    PRODUCT_IDENTITY.registrationPackageSpecifier,
  );
  expect(f.downloads[0]).toContain("--ignore-scripts");
  const manifest = JSON.parse(
    await readFile(join(f.target, ".cursor-plugin", "plugin.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    name: "rea",
    homepage: "https://rea.tools/",
    skills: "./node_modules/rea-agents/skills",
  });
  const server = JSON.parse(
    await readFile(join(f.target, ".cursor-plugin", "mcp.json"), "utf8"),
  );
  expect(server.mcpServers.rea.args).toEqual([
    "${CURSOR_PLUGIN_ROOT}/node_modules/rea-agents/scripts/plugin-mcp-launcher.mjs",
    PRODUCT_IDENTITY.packageVersion,
  ]);
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  expect(f.downloads).toHaveLength(1);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
  expect(await readdir(f.local)).toEqual(["rea"]);
  await expect(access(f.config)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(MCP_BOOTSTRAP_FILES)(
  "preserves and refuses a local plugin missing bootstrap file %s",
  async (path) => {
    const f = await fixture();
    expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
    await unlink(join(f.target, "node_modules", "rea-agents", path));
    const result = await runSetup(f.setupOptions, f.host());
    expect(result.status).toBe("needs_human");
    expect(f.downloads).toHaveLength(1);
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    expect(await readdir(f.local)).toEqual(["rea"]);
  },
);

it.each(["foreign", "changed-during-download", "edited"] as const)(
  "preserves an existing %s Cursor plugin",
  async (mode) => {
    const f = await fixture();
    let preserved: string;
    if (mode === "edited") {
      expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
      preserved = join(f.target, ".cursor-plugin", "mcp.json");
      await writeFile(preserved, "edited");
    } else if (mode === "foreign") {
      await mkdir(f.target, { recursive: true });
      preserved = join(f.target, "user-data");
      await writeFile(preserved, "preserve");
    } else {
      f.foreignDuringDownload();
      preserved = join(f.target, "user-data");
    }
    const result = await runSetup(f.setupOptions, f.host());
    expect(result.status).toBe("needs_human");
    expect(await readFile(preserved, "utf8")).toBe(
      mode === "edited" ? "edited" : "preserve",
    );
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    expect(await readdir(f.local)).toEqual(["rea"]);
  },
);

it.each(["download", "version"] as const)(
  "does not publish an incomplete Cursor plugin after a %s failure",
  async (mode) => {
    const f = await fixture();
    if (mode === "download") f.fail();
    else f.wrongVersion();
    const result = await runSetup(f.setupOptions, f.host());
    expect(result.status).toBe("needs_human");
    if (mode === "download")
      expect(JSON.stringify(result)).toContain(
        "Registry authentication required",
      );
    expect(await readdir(f.local)).toEqual([]);
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
  },
);

it("rejects linked local-plugin parents before writing through them", async () => {
  const f = await fixture();
  const outside = await createTestTempDirectory("rea-cursor-outside-");
  await mkdir(join(f.home, ".cursor"));
  await symlink(
    outside,
    join(f.home, ".cursor", "plugins"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("needs_human");
  expect(f.downloads).toEqual([]);
  expect(await readdir(outside)).toEqual([]);
});

it("retains staging while installer cleanup fails and removes it on retry", async () => {
  const f = await fixture();
  f.interrupt();
  const host = f.host();
  onTestFinished(async () => {
    f.allowCleanup();
    await host.close?.();
  });
  const failure: unknown = await runSetup(f.setupOptions, host).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AnalysisError);
  if (!(failure instanceof AnalysisError))
    throw new Error("Expected retained cancellation");
  expect(primaryAnalysisError(failure)).toBeInstanceOf(AnalysisCancelledError);
  expect(failure.cleanupIncomplete).toBe(true);
  expect(await readdir(f.local)).toHaveLength(1);
  await expect(access(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  f.allowCleanup();
  await host.close?.();
  expect(await readdir(f.local)).toEqual([]);
});

it("awaits successful installer and staging cleanup before propagating cancellation", async () => {
  const f = await fixture();
  f.interrupt(true);
  const failure: unknown = await runSetup(f.setupOptions, f.host()).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  if (!(failure instanceof AnalysisCancelledError))
    throw new Error("Expected cancellation");
  expect(failure.cleanupIncomplete).toBe(false);
  expect(await readdir(f.local)).toEqual([]);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it("preserves a setup-owned Cursor integration", async () => {
  const f = await fixture();
  f.base.clientInspections.set("cursor", { status: "already_current" });
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("ready");
  expect(f.downloads).toEqual([]);
  await expect(access(f.local)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not download a Cursor plugin without standalone Node", async () => {
  const f = await fixture();
  f.missingNode();
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(result.remediation).toContain("Node");
  expect(f.downloads).toEqual([]);
  await expect(access(f.local)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rechecks Cursor direct registration after approval before downloading", async () => {
  const f = await fixture();
  const result = await runSetup(
    { ...f.setupOptions, approved: false, structured: false },
    f.host(),
    async () => {
      f.base.clientInspections.set("cursor", { status: "already_current" });
      return true;
    },
  );
  expect(result.status).toBe("needs_human");
  expect(f.downloads).toEqual([]);
  expect(f.base.configurations).toBe(0);
  await expect(access(f.local)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves a direct registration created during download without publishing a Cursor plugin", async () => {
  const f = await fixture();
  f.directDuringDownload();
  const result = await runSetup(f.setupOptions, f.host());
  expect(result.status).toBe("needs_human");
  expect(JSON.stringify(result)).toContain("Rerun setup");
  expect(f.downloads).toHaveLength(1);
  expect(await readFile(f.config, "utf8")).toBe(
    "concurrent direct registration",
  );
  expect(await readdir(f.local)).toEqual([]);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it("stops Cursor publication when cancellation arrives during the final file checks", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const inspect = f.base.inspectClientConfiguration;
  f.base.inspectClientConfiguration = async (...args) => {
    const state = await inspect(...args);
    if (f.downloads.length > 0) controller.abort("cancel before publication");
    return state;
  };
  await expect(
    runSetup(
      { ...f.setupOptions, signal: controller.signal },
      f.host(true, controller.signal),
    ),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(f.downloads).toHaveLength(1);
  expect(await readdir(f.local)).toEqual([]);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it("does not start direct registration when cancellation arrives during Cursor inventory", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const inspect = CursorLocalPlugin.prototype.inspect;
  let reads = 0;
  const spy = vi
    .spyOn(CursorLocalPlugin.prototype, "inspect")
    .mockImplementation(async function (this: CursorLocalPlugin) {
      const state = await inspect.call(this);
      if (++reads === 2) controller.abort("cancel direct handoff");
      return state;
    });
  onTestFinished(() => spy.mockRestore());
  await expect(
    runSetup(
      { ...f.setupOptions, signal: controller.signal },
      f.host(false, controller.signal),
    ),
  ).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(reads).toBe(2);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
  await expect(access(f.config)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps ordinary Cursor setup direct without opting in to a plugin", async () => {
  const f = await fixture();
  f.missingNode();
  const result = await runSetup(f.setupOptions, f.host(false));
  expect(result.status).toBe("ready");
  expect(f.downloads).toEqual([]);
  expect(f.base.configurations).toBe(1);
  expect(f.base.skillInstalls).toBe(1);
  await expect(access(f.local)).rejects.toMatchObject({ code: "ENOENT" });
});

it("recognizes a local Cursor plugin on ordinary reruns without another download or server", async () => {
  const f = await fixture();
  expect((await runSetup(f.setupOptions, f.host())).status).toBe("ready");
  const result = await runSetup(f.setupOptions, f.host(false));
  expect(result.status).toBe("ready");
  expect(result.doctor.scope.plugin_clients).toEqual(["cursor"]);
  expect(f.downloads).toHaveLength(1);
  expect(f.base.configurations + f.base.skillInstalls).toBe(0);
});

it.each(["installed", "foreign"] as const)(
  "refuses an automatically chosen direct route when a %s Cursor plugin appears during approval",
  async (state) => {
    const f = await fixture();
    const result = await runSetup(
      { ...f.setupOptions, approved: false, structured: false },
      f.host(false),
      async () => {
        if (state === "installed") {
          expect((await runSetup(f.setupOptions, f.host())).status).toBe(
            "ready",
          );
        } else {
          await mkdir(f.target, { recursive: true });
          await writeFile(join(f.target, "user-data"), "preserve");
        }
        return true;
      },
    );
    expect(result.status).toBe("needs_human");
    expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    await expect(access(f.config)).rejects.toMatchObject({ code: "ENOENT" });
    if (state === "installed") {
      expect(f.downloads).toHaveLength(1);
      expect(JSON.stringify(result)).toContain("Rerun setup");
      expect((await runSetup(f.setupOptions, f.host(false))).status).toBe(
        "ready",
      );
      expect(f.base.configurations + f.base.skillInstalls).toBe(0);
    } else {
      expect(f.downloads).toEqual([]);
      expect(await readFile(join(f.target, "user-data"), "utf8")).toBe(
        "preserve",
      );
    }
  },
);
