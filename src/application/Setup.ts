import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { runDoctor, systemDoctorHost } from "./Doctor.js";
import { probeHomebrew } from "./homebrew.js";

const execFileAsync = promisify(execFile);

/** A detected agent configuration owned by setup. */
export interface SetupClient {
  readonly name: string;
  readonly configPath: string;
}
/** Result of one backup/write/readback transaction. */
export type ClientConfigurationResult =
  | {
      readonly status: "unchanged" | "configured";
      readonly backupPath?: string;
    }
  | {
      readonly status: "failed";
      readonly reason: "backup" | "write" | "readback";
    };
/**
 * Effects required by the idempotent setup workflow.
 * Implementations report interrupted installers as values: setup must not wait
 * indefinitely for stdin or a GUI response in an unattended agent invocation.
 */
export interface SetupHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  macosVersion(): Promise<string | undefined>;
  hasHomebrew(): Promise<boolean>;
  installHomebrew(): Promise<boolean>;
  hopperPath(): Promise<string | undefined>;
  installHopper(): Promise<boolean>;
  detectedClients(): Promise<readonly SetupClient[]>;
  configureClient(
    client: SetupClient,
    hopperPath: string,
  ): Promise<ClientConfigurationResult>;
  installSkill(): Promise<"installed" | "unchanged" | "failed">;
  doctor(): Promise<Awaited<ReturnType<typeof runDoctor>>>;
}
/**
 * Structured setup outcome intended to travel back through an agent to a human.
 * `needs_human` carries remediation text instead of initiating an interactive
 * prompt, avoiding deadlocks in stdio and other unattended environments.
 */
export interface SetupResult {
  readonly status: "ready" | "needs_human";
  readonly actions: readonly string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly doctor: Awaited<ReturnType<typeof runDoctor>>;
  readonly remediation?: string;
}

/**
 * Install prerequisites and configure detected clients idempotently.
 * With `yes` false, mutations requiring consent are reported as `needs_human`;
 * with `yes` true, external installers still fail closed if they require UI.
 */
export const runSetup = async (
  yes: boolean,
  host: SetupHost = systemSetupHost(),
): Promise<SetupResult> => {
  const actions: string[] = [];
  const clients: Record<string, ClientConfigurationResult> = {};
  const fail = async (remediation: string): Promise<SetupResult> => ({
    status: "needs_human",
    actions,
    clients,
    doctor: await host.doctor(),
    remediation,
  });
  if (host.platform !== "darwin")
    return fail("Hopper requires macOS 12 or newer.");
  const macosVersion = await host.macosVersion();
  if (macosVersion === undefined || major(macosVersion) < 12)
    return fail("Upgrade to macOS 12 or newer.");
  if (major(host.nodeVersion) < 22) return fail("Install Node.js 22 or newer.");
  if (!(await host.hasHomebrew())) {
    if (!yes) return fail("Re-run with --yes to install Homebrew.");
    if (!(await host.installHomebrew()))
      return fail(
        "Homebrew installation was interrupted; resolve the installer prompt and re-run setup.",
      );
    actions.push("installed_homebrew");
  }
  let hopperPath = await host.hopperPath();
  if (hopperPath === undefined) {
    if (!yes) return fail("Re-run with --yes to install Hopper.");
    if (!(await host.installHopper()))
      return fail(
        "Hopper installation was interrupted; resolve the system prompt and re-run setup.",
      );
    actions.push("installed_hopper");
    hopperPath = await host.hopperPath();
    if (hopperPath === undefined)
      return fail(
        "Hopper installation completed but its launcher was not found.",
      );
  }
  for (const client of await host.detectedClients()) {
    const result = await host.configureClient(client, hopperPath);
    clients[client.name] = result;
    if (result.status === "failed")
      return fail(
        `${client.name} configuration ${result.reason} verification failed; no successful configuration was reported.`,
      );
    if (result.status === "configured")
      actions.push(`configured_${client.name}`);
  }
  const skill = await host.installSkill();
  if (skill === "failed")
    return fail("Agent skill installation or readback failed.");
  if (skill === "installed") actions.push("installed_skill");
  const doctor = await host.doctor();
  return {
    status: doctor.healthy ? "ready" : "needs_human",
    actions,
    clients,
    doctor,
    ...(doctor.healthy
      ? {}
      : {
          remediation: "Run rea doctor and apply each reported remediation.",
        }),
  };
};

/** Production setup effects for macOS, Homebrew, JSON MCP clients, and the canonical skill directory. */
export const systemSetupHost = (): SetupHost => {
  const doctorHost = systemDoctorHost();
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    hasHomebrew: () => brewSucceeds(["--version"]),
    installHomebrew: () =>
      commandSucceeds(
        "/bin/bash",
        [
          "-c",
          "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)",
        ],
        { ...process.env, NONINTERACTIVE: "1" },
      ),
    hopperPath: async () => (await runDoctor(undefined, doctorHost)).hopperPath,
    installHopper: () =>
      brewSucceeds(["install", "--cask", "hopper-disassembler"]),
    detectedClients: () => detectJsonClients(homedir()),
    configureClient: configureJsonClient,
    installSkill: () => installCanonicalSkill(homedir()),
    doctor: () => runDoctor(undefined, doctorHost),
  };
};

const detectJsonClients = async (
  home: string,
): Promise<readonly SetupClient[]> => {
  const candidates = [
    {
      name: "claude_desktop",
      configPath: join(
        home,
        "Library/Application Support/Claude/claude_desktop_config.json",
      ),
      marker: join(home, "Library/Application Support/Claude"),
    },
    {
      name: "cursor",
      configPath: join(home, ".cursor/mcp.json"),
      marker: join(home, ".cursor"),
    },
  ];
  const detected: SetupClient[] = [];
  for (const candidate of candidates)
    if (await exists(candidate.marker))
      detected.push({ name: candidate.name, configPath: candidate.configPath });
  return detected;
};

/** Back up, atomically update, and semantically read back one JSON MCP configuration. */
export const configureJsonClient = async (
  client: SetupClient,
  hopperPath?: string,
): Promise<ClientConfigurationResult> => {
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(client.configPath, "utf8");
    document = parseObject(original);
  } catch (cause: unknown) {
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let servers: Record<string, unknown>;
  try {
    servers = parseOptionalObject(document.mcpServers);
  } catch {
    return { status: "failed", reason: "readback" };
  }
  const desired = {
    command: "npx",
    args: ["-y", PRODUCT_IDENTITY.packageName, "mcp"],
    ...(hopperPath === undefined
      ? {}
      : { env: { HOPPER_LAUNCHER_PATH: hopperPath } }),
  };
  if (
    JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
    JSON.stringify(desired)
  )
    return { status: "unchanged" };
  let backupPath: string | undefined;
  if (original !== undefined) {
    backupPath = `${client.configPath}.rea.backup`;
    try {
      await copyFile(client.configPath, backupPath);
    } catch {
      return { status: "failed", reason: "backup" };
    }
  }
  document.mcpServers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  const encoded = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = `${client.configPath}.rea.tmp`;
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, client.configPath);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    return { status: "failed", reason: "write" };
  }
  try {
    const readback = parseObject(await readFile(client.configPath, "utf8"));
    const value = parseOptionalObject(readback.mcpServers)[
      PRODUCT_IDENTITY.mcpServerKey
    ];
    if (JSON.stringify(value) !== JSON.stringify(desired)) {
      await restoreConfig(client.configPath, original);
      return { status: "failed", reason: "readback" };
    }
  } catch {
    await restoreConfig(client.configPath, original);
    return { status: "failed", reason: "readback" };
  }
  return {
    status: "configured",
    ...(backupPath === undefined ? {} : { backupPath }),
  };
};

const installCanonicalSkill = async (
  home: string,
): Promise<"installed" | "unchanged" | "failed"> => {
  const destination = join(
    home,
    ".agents/skills",
    PRODUCT_IDENTITY.skillName,
    "SKILL.md",
  );
  const content = `---\nname: ${PRODUCT_IDENTITY.skillName}\ndescription: Analyze binaries with REA and Hopper.\n---\n\nOpen a target with open_binary, begin with binary_overview, and close it when finished.\n`;
  try {
    if (
      (await readFile(destination, "utf8").catch(() => undefined)) === content
    )
      return "unchanged";
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, { encoding: "utf8", mode: 0o600 });
    return (await readFile(destination, "utf8")) === content
      ? "installed"
      : "failed";
  } catch {
    return "failed";
  }
};

const commandSucceeds = async (
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<boolean> => {
  try {
    await execFileAsync(command, args, env === undefined ? {} : { env });
    return true;
  } catch {
    return false;
  }
};
const brewSucceeds = async (args: readonly string[]): Promise<boolean> => {
  const result = await probeHomebrew(async (command) =>
    (await commandSucceeds(command, args)) ? true : undefined,
  );
  return result === true;
};
const major = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
const objectSchema = z.record(z.string(), z.unknown());
const parseOptionalObject = (value: unknown): Record<string, unknown> =>
  value === undefined ? {} : objectSchema.parse(value);
const parseObject = (text: string): Record<string, unknown> =>
  objectSchema.parse(JSON.parse(text));
const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const restoreConfig = async (
  path: string,
  original: string | undefined,
): Promise<void> => {
  try {
    if (original === undefined) await rm(path, { force: true });
    else await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The backup remains available for the remediation reported by setup.
  }
};
