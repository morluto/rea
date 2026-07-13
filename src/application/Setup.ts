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
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { PRODUCT_IDENTITY } from "../identity.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import { runDoctor, systemDoctorHost } from "./Doctor.js";
import {
  installLinuxHopper,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import { installMacHopper } from "./MacHopper.js";
import { installCanonicalSkill } from "./SetupSkill.js";

export { installCanonicalSkill } from "./SetupSkill.js";

const registrationCommand = (): readonly string[] =>
  process.env.npm_command === "exec"
    ? ["npx", "-y", PRODUCT_IDENTITY.packageName, "mcp"]
    : [resolve(process.argv[1] ?? PRODUCT_IDENTITY.cliBinary), "mcp"];

/** A detected agent configuration owned by setup. */
export interface SetupClient {
  readonly name: string;
  readonly configPath: string;
  readonly markerPath?: string;
  readonly format?: "json" | "toml" | "unsupported";
}
/** Result of one backup/write/readback transaction. */
export type ClientConfigurationResult =
  | {
      readonly status: "unchanged" | "configured" | "skipped";
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
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  hopperPath(): Promise<string | undefined>;
  installHopper(): Promise<string | undefined>;
  detectedClients(): Promise<readonly SetupClient[]>;
  configureClient(
    client: SetupClient,
    hopperPath: string | undefined,
    command: readonly string[],
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
  readonly status: "planned" | "needs_confirmation" | "ready" | "needs_human";
  readonly plannedActions: readonly SetupAction[];
  readonly appliedActions: readonly string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly doctor: Awaited<ReturnType<typeof runDoctor>>;
  readonly remediation?: string;
}

/** One concrete setup mutation disclosed before approval. */
export interface SetupAction {
  readonly kind: "install_hopper" | "configure_client" | "install_skill";
  readonly target: string;
  readonly detail: string;
  readonly external: boolean;
}

/** Explicit authorization supplied by an interactive or unattended CLI adapter. */
export interface SetupOptions {
  readonly approved: boolean;
  readonly installHopper: boolean;
  readonly structured: boolean;
}

/** Adapter-owned interactive confirmation for a fully discovered setup plan. */
export type SetupConfirmation = (
  actions: readonly SetupAction[],
) => Promise<boolean>;

const setupPlan = (
  platform: NodeJS.Platform,
  hopperPath: string | undefined,
  clients: readonly SetupClient[],
): readonly SetupAction[] => [
  ...(hopperPath === undefined
    ? [
        {
          kind: "install_hopper" as const,
          target:
            platform === "darwin"
              ? "~/Applications/Hopper Disassembler.app"
              : "system package manager",
          detail:
            "Download the official Hopper package, verify it, install it, and open Hopper for activation.",
          external: true,
        },
      ]
    : []),
  ...clients
    .filter(({ format }) => format !== "unsupported")
    .map(
      (client): SetupAction => ({
        kind: "configure_client",
        target: client.configPath,
        detail: `Add the REA MCP registration for ${client.name}; preserve unrelated configuration.`,
        external: false,
      }),
    ),
  {
    kind: "install_skill",
    target: "~/.agents/skills/rea-analysis/SKILL.md",
    detail: "Install or update the bundled REA analysis skill.",
    external: false,
  },
];

const configureDetectedClients = async (options: {
  readonly host: SetupHost;
  readonly detectedClients: readonly SetupClient[];
  readonly hopperPath: string | undefined;
  readonly clients: Record<string, ClientConfigurationResult>;
  readonly appliedActions: string[];
}): Promise<string | undefined> => {
  for (const client of options.detectedClients) {
    const result = await options.host.configureClient(
      client,
      options.hopperPath,
      registrationCommand(),
    );
    options.clients[client.name] = result;
    if (result.status === "failed")
      return `${client.name} configuration ${result.reason} verification failed; no successful configuration was reported.`;
    if (result.status === "configured")
      options.appliedActions.push(`configured_${client.name}`);
  }
  return undefined;
};

/**
 * Install prerequisites and configure detected clients idempotently.
 * Discovery always precedes mutation. Interactive confirmation or explicit
 * unattended options authorize only the actions represented in the result.
 */
export const runSetup = async (
  options: SetupOptions,
  host: SetupHost = systemSetupHost(),
  confirm?: SetupConfirmation,
): Promise<SetupResult> => {
  const appliedActions: string[] = [];
  let plannedActions: readonly SetupAction[] = [];
  const clients: Record<string, ClientConfigurationResult> = {};
  const fail = async (remediation: string): Promise<SetupResult> => ({
    status: "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor: await host.doctor(),
    remediation,
  });
  const unsupported = await hostRemediation(host);
  if (unsupported !== undefined) return fail(unsupported);
  let hopperPath = await host.hopperPath();
  const detectedClients = await host.detectedClients();
  plannedActions = setupPlan(host.platform, hopperPath, detectedClients);
  let approved = options.approved;
  let interactiveApproval = false;
  if (!approved && confirm !== undefined && !options.structured) {
    interactiveApproval = await confirm(plannedActions);
    approved = interactiveApproval;
  }
  if (!approved)
    return {
      status: confirm === undefined ? "needs_confirmation" : "planned",
      plannedActions,
      appliedActions,
      clients,
      doctor: await host.doctor(),
      remediation:
        "Review the setup plan, then rerun interactively or with --yes.",
    };

  if (
    hopperPath === undefined &&
    (interactiveApproval || options.installHopper)
  ) {
    hopperPath = await host.installHopper();
    if (hopperPath === undefined)
      return {
        status: "needs_human",
        plannedActions,
        appliedActions,
        clients,
        doctor: await host.doctor(),
        remediation:
          "Hopper installation failed; install Hopper manually or rerun setup after resolving the reported system error.",
      };
    appliedActions.push("installed_hopper");
  }
  const clientFailure = await configureDetectedClients({
    host,
    detectedClients,
    hopperPath,
    clients,
    appliedActions,
  });
  if (clientFailure !== undefined) return fail(clientFailure);
  const skill = await host.installSkill();
  if (skill === "failed")
    return fail("Agent skill installation or readback failed.");
  if (skill === "installed") appliedActions.push("installed_skill");
  const doctor = await host.doctor();
  const activationRequired = appliedActions.includes("installed_hopper");
  const ready = doctor.healthy && !activationRequired;
  return {
    status: ready ? "ready" : "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor,
    ...(ready
      ? {}
      : {
          remediation: activationRequired
            ? "Open Hopper, complete its one-time activation, then rerun rea doctor --json."
            : hopperPath === undefined
              ? "Hopper is optional for non-Hopper providers. Rerun with --yes --install-hopper for deep native analysis."
              : "Run rea doctor and apply each reported remediation.",
        }),
  };
};

const hostRemediation = async (
  host: SetupHost,
): Promise<string | undefined> => {
  if (host.platform !== "darwin" && host.platform !== "linux")
    return "REA supports Hopper on macOS and selected 64-bit Linux distributions.";
  if (!supportsNodeVersion(host.nodeVersion))
    return "Install Node.js 22.19+ or 24.11+ and rerun setup.";
  if (host.platform === "darwin") {
    const version = await host.macosVersion();
    return version === undefined || major(version) < 12
      ? "Upgrade to macOS 12 or newer."
      : undefined;
  }
  return (await host.linuxDistribution())?.supported === true
    ? undefined
    : "REA supports Hopper on Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux.";
};

/** Production setup effects for Hopper, agent configuration, and the canonical skill directory. */
const systemSetupHost = (): SetupHost => {
  const doctorHost = systemDoctorHost();
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution: readLinuxDistribution,
    hopperPath: async () => (await runDoctor(undefined, doctorHost)).hopperPath,
    installHopper: async () => {
      const result =
        process.platform === "linux"
          ? await installLinuxHopper()
          : await installMacHopper();
      return result.status === "installed" ? result.launcherPath : undefined;
    },
    detectedClients: () => detectClients(homedir()),
    configureClient: (client, hopperPath, command) =>
      client.format === "unsupported"
        ? Promise.resolve({ status: "skipped" })
        : client.format === "toml"
          ? configureTomlClient(client, hopperPath, command)
          : configureJsonClient(client, hopperPath, command),
    installSkill: () => installCanonicalSkill(homedir()),
    doctor: () => runDoctor(undefined, doctorHost),
  };
};

/** Detect supported coding agents from stable per-user installation markers. */
export const detectClients = async (
  home: string,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home))
    if (await exists(candidate.markerPath ?? candidate.configPath))
      detected.push(candidate);
  return detected;
};

/** Describe every client location that setup or uninstall may own. */
export const supportedClients = (home: string): readonly SetupClient[] => [
  {
    name: "claude_code",
    configPath: join(home, ".claude.json"),
    markerPath: join(home, ".claude"),
  },
  {
    name: "claude_desktop",
    configPath: join(
      home,
      "Library/Application Support/Claude/claude_desktop_config.json",
    ),
    markerPath: join(home, "Library/Application Support/Claude"),
  },
  {
    name: "codex",
    configPath: join(home, ".codex/config.toml"),
    markerPath: join(home, ".codex"),
    format: "toml" as const,
  },
  {
    name: "cursor",
    configPath: join(home, ".cursor/mcp.json"),
    markerPath: join(home, ".cursor"),
  },
  {
    name: "gemini_cli",
    configPath: join(home, ".gemini/settings.json"),
    markerPath: join(home, ".gemini"),
  },
  {
    name: "windsurf",
    configPath: join(home, ".codeium/windsurf/mcp_config.json"),
    markerPath: join(home, ".codeium/windsurf"),
  },
  {
    name: "devin",
    configPath: join(home, ".devin"),
    markerPath: join(home, ".devin"),
    format: "unsupported" as const,
  },
];

/** Back up, atomically update, and semantically read back one JSON MCP configuration. */
export const configureJsonClient = async (
  client: SetupClient,
  hopperPath?: string,
  command: readonly string[] = [
    "npx",
    "-y",
    PRODUCT_IDENTITY.packageName,
    "mcp",
  ],
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
    command: command[0] ?? PRODUCT_IDENTITY.cliBinary,
    args: command.slice(1),
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

/** Back up, atomically update, and semantically read back Codex TOML configuration. */
export const configureTomlClient = async (
  client: SetupClient,
  hopperPath?: string,
  command: readonly string[] = [
    "npx",
    "-y",
    PRODUCT_IDENTITY.packageName,
    "mcp",
  ],
): Promise<ClientConfigurationResult> => {
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(client.configPath, "utf8");
    document = objectSchema.parse(parseToml(original));
  } catch (cause: unknown) {
    if (!isMissing(cause)) return { status: "failed", reason: "readback" };
  }
  let servers: Record<string, unknown>;
  try {
    servers = parseOptionalObject(document.mcp_servers);
  } catch {
    return { status: "failed", reason: "readback" };
  }
  const desired = {
    command: command[0] ?? PRODUCT_IDENTITY.cliBinary,
    args: command.slice(1),
    ...(hopperPath === undefined
      ? {}
      : { env: { HOPPER_LAUNCHER_PATH: hopperPath } }),
  };
  if (
    JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
    JSON.stringify(desired)
  )
    return { status: "unchanged" };
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  try {
    if (backupPath !== undefined) await copyFile(client.configPath, backupPath);
  } catch {
    return { status: "failed", reason: "backup" };
  }
  document.mcp_servers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(client.configPath, stringifyToml(document), {
      encoding: "utf8",
      mode: 0o600,
    });
    const readback = objectSchema.parse(
      parseToml(await readFile(client.configPath, "utf8")),
    );
    if (
      JSON.stringify(
        parseOptionalObject(readback.mcp_servers)[
          PRODUCT_IDENTITY.mcpServerKey
        ],
      ) !== JSON.stringify(desired)
    )
      throw new Error("TOML readback mismatch");
  } catch {
    await restoreConfig(client.configPath, original);
    return { status: "failed", reason: "readback" };
  }
  return {
    status: "configured",
    ...(backupPath === undefined ? {} : { backupPath }),
  };
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
