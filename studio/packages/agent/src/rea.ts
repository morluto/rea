import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { TargetKind } from "@rea-studio/core";

/** The REA release Studio falls back to when no local build is found. */
export const PINNED_REA_PACKAGE = "rea-agents@6.8.0";

export interface ReaLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Where the launch came from, for diagnostics. */
  readonly source: "env" | "fork" | "path" | "npx";
  /** Package or repository root, used to find the skill and docs. */
  readonly root?: string;
}

/** The fork checkout that contains this studio/ folder. */
export const forkRoot = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const launchFromScript = (
  script: string,
  source: ReaLaunch["source"],
): ReaLaunch => {
  const real = realpathSync(script);
  return /\.(mjs|cjs|js)$/.test(real)
    ? {
        command: process.execPath,
        args: [real, "mcp"],
        source,
        root: resolve(dirname(real), ".."),
      }
    : { command: real, args: ["mcp"], source };
};

const findOnPath = (name: string, env: NodeJS.ProcessEnv): string | undefined => {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Resolve how to start REA's MCP server, in order: STUDIO_REA_BIN, this
 * fork's own build, a `rea` on PATH, then the pinned npm release via npx.
 * Script launches reuse the current Node binary, which must satisfy REA's
 * engine range.
 */
export const resolveReaLaunch = (
  env: NodeJS.ProcessEnv = process.env,
): ReaLaunch => {
  if (env.STUDIO_REA_BIN) return launchFromScript(env.STUDIO_REA_BIN, "env");
  const fork = forkRoot();
  const forkScript = join(fork, "scripts", "rea.mjs");
  if (existsSync(join(fork, "dist", "main.js")) && existsSync(forkScript)) {
    return { ...launchFromScript(forkScript, "fork"), root: fork };
  }
  // Prefer the REA installed with the Node running Studio, then PATH.
  const besideNode = join(dirname(process.execPath), "rea");
  if (existsSync(besideNode)) return launchFromScript(besideNode, "path");
  const onPath = findOnPath("rea", env);
  if (onPath) return launchFromScript(onPath, "path");
  return { command: "npx", args: ["-y", PINNED_REA_PACKAGE, "mcp"], source: "npx" };
};

/**
 * Tool families per target kind. REA builds that support
 * REA_MCP_TOOL_FAMILIES advertise only these; older releases ignore the
 * variable and Studio filters on the client instead.
 */
export const TOOL_FAMILIES: Record<TargetKind, string> = {
  web: "browser,pcap,session,javascript-runtime",
  javascript: "browser,electron,application,javascript-runtime,session",
  android: "android,apktool,artifact,managed,flutter,session",
  native: "direct,enhanced,native,artifact,session",
};

export interface ReaSession {
  readonly client: MCPClient;
  readonly launch: ReaLaunch;
  /** Server instructions REA sends at initialization. */
  readonly instructions: string;
  close(): Promise<void>;
}

export interface StartReaOptions {
  readonly kind: TargetKind;
  /** Extra environment, e.g. STUDIO_SECRET_* values for browser scenarios. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** File that receives REA's stderr log. */
  readonly logFile: string;
  readonly launch?: ReaLaunch;
}

/** Variables REA and its native tools need; everything else is dropped. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "JAVA_HOME",
  "GHIDRA_INSTALL_DIR",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
];

export const reaEnvironment = (
  kind: TargetKind,
  extra: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  for (const [name, value] of Object.entries(env)) {
    // Pass REA's own configuration through (provider paths, timeouts, …).
    if (name.startsWith("REA_") && value !== undefined) base[name] = value;
  }
  return {
    ...base,
    REA_MCP_TOOL_FAMILIES: TOOL_FAMILIES[kind],
    REA_MCP_INPUT_SCHEMA_PROFILE: env.STUDIO_REA_SCHEMA_PROFILE || "compact",
    // The model never sees output schemas; skipping them shrinks tools/list.
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
    ...extra,
  };
};

/** Start one REA MCP server for one job and connect to it over stdio. */
export const startRea = async (options: StartReaOptions): Promise<ReaSession> => {
  const launch = options.launch ?? resolveReaLaunch();
  const log = createWriteStream(options.logFile, { flags: "a" });
  await new Promise<void>((done, fail) => {
    log.once("open", () => done());
    log.once("error", fail);
  });
  const transport = new Experimental_StdioMCPTransport({
    command: launch.command,
    args: [...launch.args],
    env: reaEnvironment(options.kind, options.env),
    cwd: options.cwd,
    stderr: log,
  });
  const client = await createMCPClient({
    transport,
    name: "rea-studio",
    version: "0.1.0",
  });
  return {
    client,
    launch,
    instructions: client.instructions ?? "",
    async close() {
      try {
        await client.close();
      } finally {
        log.end();
      }
    },
  };
};
