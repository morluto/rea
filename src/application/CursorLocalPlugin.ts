import { lstat, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { readSkillFile } from "./SetupSkill.js";
import type { SetupPluginCommandLauncher } from "./SetupPluginCommand.js";
import type { PluginInspection } from "./SetupPluginClient.js";
import {
  SetupPluginCommands,
  pluginCommandFailure,
} from "./SetupPluginCommands.js";

const version = PRODUCT_IDENTITY.packageVersion;
const packagePath = "node_modules/rea-agents";
const receipt = { format: "rea-cursor-local-v1", version };
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && Reflect.get(cause, "code") === "ENOENT";
const sharedManifest = z.object({
  name: z.literal("rea"),
  version: z.literal(version),
  description: z.string(),
  author: z.object({ name: z.string(), url: z.string().optional() }),
  homepage: z.string(),
  repository: z.literal("https://github.com/morluto/rea"),
  license: z.string(),
  keywords: z.array(z.string()),
  skills: z.literal("./skills"),
  icon: z.literal("./assets/rea-plugin.png"),
  mcpServers: z.object({
    rea: z.object({
      command: z.literal("node"),
      args: z.tuple([
        z.literal("${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs"),
        z.literal(version),
      ]),
    }),
  }),
});

/** Cursor's supported local import consumes a complete, version-pinned npm runtime. */
export class CursorLocalPlugin extends SetupPluginCommands {
  readonly command = "npm";
  readonly directory: string;
  private staging: PrivateRuntimeRoot | undefined;

  constructor(
    private readonly home: string,
    environment: Readonly<NodeJS.ProcessEnv>,
    resources: ArtifactResourceScope,
    launch?: SetupPluginCommandLauncher,
  ) {
    const commands = new ArtifactResourceScope();
    super(environment, commands, launch);
    this.directory = join(home, ".cursor", "plugins", "local", "rea");
    resources.retain({
      kind: "lease",
      resource: this.directory,
      lease: new AnalysisCleanupLease(async () => {
        // Keep the staging root until every installer child has been joined.
        await commands.close();
        await this.staging?.close();
      }, [this.directory]),
    });
  }

  private async parent(create: boolean): Promise<string | undefined> {
    let path = await realpath(this.home);
    for (const component of [".cursor", "plugins", "local"]) {
      path = join(path, component);
      if (create) {
        try {
          await mkdir(path);
        } catch (cause: unknown) {
          if (
            !(cause instanceof Error) ||
            Reflect.get(cause, "code") !== "EEXIST"
          )
            throw cause;
        }
      }
      try {
        const state = await lstat(path);
        if (!state.isDirectory() || state.isSymbolicLink())
          throw new Error(
            `Local plugin path is not a regular directory: ${path}`,
          );
      } catch (cause: unknown) {
        if (!create && isMissing(cause)) return undefined;
        throw cause;
      }
    }
    return path;
  }

  private async read(root: string, path: string): Promise<string> {
    let selected = root;
    const parts = path.split("/");
    for (const component of parts.slice(0, -1)) {
      selected = join(selected, component);
      const state = await lstat(selected);
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error(
          `Linked or non-directory plugin component: ${selected}`,
        );
    }
    return readSkillFile(join(root, ...parts), this.resources, 4 * 1024 * 1024);
  }

  private async configuration(root: string) {
    const manifest = sharedManifest.parse(
      JSON.parse(
        await this.read(root, `${packagePath}/.claude-plugin/plugin.json`),
      ),
    );
    const metadata = z
      .object({ name: z.literal("rea-agents"), version: z.literal(version) })
      .parse(JSON.parse(await this.read(root, `${packagePath}/package.json`)));
    for (const path of [
      "scripts/plugin-mcp-launcher.mjs",
      "dist/cli.js",
      "dist/mcp/main.js",
      "scripts/rea.mjs",
      `skills/${PRODUCT_IDENTITY.skillName}/SKILL.md`,
      "assets/rea-plugin.png",
    ])
      await this.read(root, `${packagePath}/${path}`);
    const { icon, mcpServers: _server, ...identity } = manifest;
    return {
      manifest: {
        ...identity,
        author: { name: manifest.author.name },
        version: metadata.version,
        logo: `./${packagePath}/${icon.slice(2)}`,
        skills: `./${packagePath}/skills`,
        mcpServers: "./.cursor-plugin/mcp.json",
      },
      server: {
        mcpServers: {
          rea: {
            command: "node",
            args: [
              `${"${CURSOR_PLUGIN_ROOT}"}/${packagePath}/scripts/plugin-mcp-launcher.mjs`,
              version,
            ],
          },
        },
      },
    };
  }

  async inspect(): Promise<PluginInspection> {
    try {
      const parent = await this.parent(false);
      if (parent === undefined)
        return { status: "available", installed: false, enabled: false };
      const target = join(parent, "rea");
      let state;
      try {
        state = await lstat(target);
      } catch (cause: unknown) {
        if (isMissing(cause))
          return { status: "available", installed: false, enabled: false };
        throw cause;
      }
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error(
          "The existing REA local plugin is linked or is not a directory.",
        );
      if ((await this.read(target, ".rea-local-plugin.json")) !== json(receipt))
        throw new Error(
          "The existing local plugin was not installed by this setup version.",
        );
      const expected = await this.configuration(target);
      if (
        (await this.read(target, ".cursor-plugin/plugin.json")) !==
          json(expected.manifest) ||
        (await this.read(target, ".cursor-plugin/mcp.json")) !==
          json(expected.server)
      )
        throw new Error(
          "The local plugin configuration was edited or is incomplete.",
        );
      return { status: "available", installed: true, enabled: true };
    } catch (cause: unknown) {
      if (cause instanceof AnalysisCancelledError) throw cause;
      return {
        status: "invalid",
        remediation: `Cursor local plugin inspection failed: ${errorMessage(cause)} Existing files were preserved. Resolve the local plugin in ${this.directory}, then rerun setup.`,
      };
    }
  }

  commands(
    _installed: boolean,
    prefix = "<private staging directory>",
  ): readonly (readonly string[])[] {
    return [
      [
        "install",
        "--prefix",
        prefix,
        "--no-save",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--bin-links=false",
        "--registry=https://registry.npmjs.org",
        PRODUCT_IDENTITY.registrationPackageSpecifier,
      ],
    ];
  }

  async install(_installed: boolean): Promise<string | undefined> {
    try {
      const current = await this.inspect();
      if (current.status !== "available") return current.remediation;
      if (current.installed) return undefined;
      const parent = await this.parent(true);
      if (parent === undefined)
        throw new Error("Local plugin directory is unavailable.");
      this.staging = await PrivateRuntimeRoot.create({
        parent,
        prefix: ".rea-download-",
      });
      const staged = join(this.staging.path, "plugin");
      await mkdir(staged);
      for (const args of this.commands(false, staged)) {
        const result = await this.run(this.command, args, 180_000);
        if (
          result.exitCode !== 0 ||
          result.spawnError !== undefined ||
          result.timedOut ||
          result.cleanupFailure !== undefined
        )
          throw new Error(pluginCommandFailure(result));
      }
      const configuration = await this.configuration(staged);
      await mkdir(join(staged, ".cursor-plugin"));
      await writeFile(
        join(staged, ".cursor-plugin", "plugin.json"),
        json(configuration.manifest),
        { flag: "wx" },
      );
      await writeFile(
        join(staged, ".cursor-plugin", "mcp.json"),
        json(configuration.server),
        { flag: "wx" },
      );
      await writeFile(join(staged, ".rea-local-plugin.json"), json(receipt), {
        flag: "wx",
      });
      // Recheck after the download; never replace an existing plugin directory.
      const beforePublish = await this.inspect();
      if (beforePublish.status !== "available")
        return beforePublish.remediation;
      if (beforePublish.installed) return undefined;
      await rename(staged, join(parent, "rea"));
      const verified = await this.inspect();
      return verified.status === "available" && verified.installed
        ? undefined
        : verified.status === "available"
          ? "Cursor local plugin readback did not confirm installation."
          : verified.remediation;
    } catch (cause: unknown) {
      if (cause instanceof AnalysisCancelledError) throw cause;
      return `Cursor local plugin installation failed: ${errorMessage(cause)} No direct MCP registration was added. Check npm access and the released plugin package, then rerun setup.`;
    }
  }
}
