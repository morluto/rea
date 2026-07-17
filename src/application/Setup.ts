import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import writeFileAtomic from "write-file-atomic";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { PRODUCT_IDENTITY } from "../identity.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import { resolveClientConfigTransactionPath } from "./ClientConfigPath.js";
import {
  runDoctor,
  systemDoctorHost,
  type DoctorHost,
  type DoctorProviderInspection,
} from "./Doctor.js";
import {
  installLinuxHopper,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import { installMacHopper } from "./MacHopper.js";
import { configureDetectedClients } from "./SetupClients.js";
import { supportedClients, type SetupClient } from "./SupportedClients.js";
export type { SetupClient } from "./SupportedClients.js";
import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
} from "./SetupSkill.js";
import { setupPlan } from "./SetupPlan.js";
import {
  setupInstallFailure,
  type SetupFailureCode,
  type SetupHopperInstallResult,
} from "./SetupInstallFailure.js";
export type { SetupHopperInstallResult } from "./SetupInstallFailure.js";

/** Exact non-secret provider variables propagated into managed registrations. */
export type SetupProviderEnvironment = Readonly<Record<string, string>>;

export {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
} from "./SetupSkill.js";

const registrationCommand = (): readonly string[] =>
  process.env.npm_command === "exec"
    ? ["npx", "-y", PRODUCT_IDENTITY.packageSpecifier, "mcp"]
    : [resolve(process.argv[1] ?? PRODUCT_IDENTITY.cliBinary), "mcp"];

/** Result of one backup/write/readback transaction. */
export type ClientConfigurationResult =
  | {
      readonly status: "unchanged" | "configured" | "skipped";
      readonly backupPath?: string;
    }
  | {
      readonly status: "failed";
      readonly reason: "path" | "backup" | "write" | "readback";
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
  installHopper(replaceExisting: boolean): Promise<SetupHopperInstallResult>;
  providerEnvironment?(): Promise<SetupProviderEnvironment>;
  detectedClients(): Promise<readonly SetupClient[]>;
  configureClient(
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<ClientConfigurationResult>;
  clientNeedsConfigure(
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<boolean>;
  skillNeedsInstall(): Promise<boolean>;
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
  readonly code?: SetupFailureCode;
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
  const unsupported = await hostRemediation(host, options.installHopper);
  if (unsupported !== undefined) return fail(unsupported);
  let hopperPath = await host.hopperPath();
  let providerEnvironment = await initialProviderEnvironment(host, hopperPath);
  const discovery = await discoverSetupActions(
    host,
    providerEnvironment,
    options.installHopper,
  );
  const { installHopper, installSkill } = discovery;
  let { detectedClients } = discovery;
  plannedActions = discovery.plannedActions;
  let approved = options.approved || plannedActions.length === 0;
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

  if (installHopper && (interactiveApproval || options.installHopper)) {
    const installed = await host.installHopper(options.installHopper);
    if (installed.status === "failed")
      return {
        status: "needs_human",
        plannedActions,
        appliedActions,
        clients,
        doctor: await host.doctor(),
        code: installed.code,
        remediation: installed.remediation,
      };
    hopperPath = installed.launcherPath;
    providerEnvironment = {
      ...providerEnvironment,
      HOPPER_LAUNCHER_PATH: installed.launcherPath,
    };
    appliedActions.push("installed_hopper");
    detectedClients = await filterClientsNeedingConfigure(
      host,
      detectedClients,
      providerEnvironment,
      registrationCommand(),
    );
  }
  const clientFailure = await configureDetectedClients({
    host,
    detectedClients,
    providerEnvironment,
    command: registrationCommand(),
    clients,
    appliedActions,
  });
  if (clientFailure !== undefined) return fail(clientFailure);
  if (installSkill) {
    const skill = await host.installSkill();
    if (skill === "failed")
      return fail(
        "REA analysis skill could not be installed or verified. Check permissions for `~/.agents/skills`, then rerun setup.",
      );
    if (skill === "installed") appliedActions.push("installed_skill");
  }
  const doctor = await host.doctor();
  const remediation = finalSetupRemediation(
    host.platform,
    appliedActions.includes("installed_hopper"),
    doctor.healthy,
    hopperPath,
  );
  return {
    status: remediation === undefined ? "ready" : "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor,
    ...(remediation === undefined ? {} : { remediation }),
  };
};

const discoverSetupActions = async (
  host: SetupHost,
  providerEnvironment: SetupProviderEnvironment,
  forceHopperInstall: boolean,
) => {
  const initialDoctor = await host.doctor();
  const linuxHopperRepairNeeded = initialDoctor.checks.some(
    ({ name, ok, detail }) =>
      !ok &&
      (name === "hopper-demo-runtime" ||
        (name === "hopper-version" && detail === "/opt/hopper/bin/Hopper")),
  );
  const installHopper =
    forceHopperInstall ||
    Object.keys(providerEnvironment).length === 0 ||
    linuxHopperRepairNeeded;
  const [detectedClients, installSkill] = await Promise.all([
    host.detectedClients(),
    host.skillNeedsInstall(),
  ]);
  const command = registrationCommand();
  const clients = installHopper
    ? detectedClients
    : await filterClientsNeedingConfigure(
        host,
        detectedClients,
        providerEnvironment,
        command,
      );
  const plannedActions = setupPlan(
    host.platform,
    installHopper,
    installSkill,
    clients,
    providerEnvironment,
  );
  return {
    installHopper,
    installSkill,
    detectedClients: clients,
    plannedActions,
  };
};

const filterClientsNeedingConfigure = async (
  host: SetupHost,
  detectedClients: readonly SetupClient[],
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    detectedClients.map((client) =>
      host.clientNeedsConfigure(client, providerEnvironment, command),
    ),
  );
  return detectedClients.filter((_, index) => needs[index]);
};

const initialProviderEnvironment = async (
  host: SetupHost,
  hopperPath: string | undefined,
): Promise<SetupProviderEnvironment> => ({
  ...(await host.providerEnvironment?.()),
  ...(hopperPath === undefined ? {} : { HOPPER_LAUNCHER_PATH: hopperPath }),
});

const finalSetupRemediation = (
  platform: NodeJS.Platform,
  installedHopper: boolean,
  healthy: boolean,
  hopperPath: string | undefined,
): string | undefined => {
  if (platform === "darwin" && installedHopper)
    return "Open Hopper, choose its demo mode or activate a license, then rerun rea doctor --json.";
  if (healthy) return undefined;
  return hopperPath === undefined
    ? "Hopper is optional for non-Hopper providers. Rerun with --yes --install-hopper for deep native analysis."
    : "Run rea doctor and apply each reported remediation.";
};

const hostRemediation = async (
  host: SetupHost,
  forceHopperInstall: boolean,
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
  if ((await host.linuxDistribution())?.supported === true) return undefined;
  const providerEnvironment = await host.providerEnvironment?.();
  if (
    !forceHopperInstall &&
    providerEnvironment !== undefined &&
    Object.keys(providerEnvironment).length > 0
  )
    return undefined;
  return "Automated Hopper setup supports Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux; configure an existing supported provider instead.";
};

/** Production setup effects for Hopper, agent configuration, and the canonical skill directory. */
export const systemSetupHost = (
  doctorHost: DoctorHost = systemDoctorHost(),
): SetupHost => {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution: readLinuxDistribution,
    hopperPath: async () => (await runDoctor(undefined, doctorHost)).hopperPath,
    providerEnvironment: async () => {
      const diagnosis = await runDoctor(undefined, doctorHost);
      return {
        ...providerRegistrationEnvironment(diagnosis.providerInspections ?? []),
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { HOPPER_LAUNCHER_PATH: diagnosis.hopperPath }),
      };
    },
    installHopper: async (replaceExisting) => {
      const result =
        process.platform === "linux"
          ? await installLinuxHopper()
          : await installMacHopper({ replaceExisting });
      if (result.status === "installed") return result;
      return setupInstallFailure(result.reason);
    },
    detectedClients: () => detectClients(homedir()),
    configureClient: (client, providerEnvironment, command) =>
      client.format === "unsupported"
        ? Promise.resolve({ status: "skipped" })
        : client.format === "toml"
          ? configureTomlClient(client, providerEnvironment, command)
          : configureJsonClient(client, providerEnvironment, command),
    clientNeedsConfigure: (client, providerEnvironment, command) =>
      clientConfigurationAligned(client, providerEnvironment, command).then(
        (aligned) => !aligned,
      ),
    skillNeedsInstall: () => canonicalSkillNeedsInstall(homedir()),
    installSkill: () => installCanonicalSkill(homedir()),
    doctor: () => runDoctor(undefined, doctorHost),
  };
};

/** Detect supported agents from stable per-user installation markers. */
export const detectClients = async (
  home: string,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home))
    if (await exists(candidate.markerPath ?? candidate.configPath))
      detected.push(candidate);
  return detected;
};

/** Back up, atomically update, and semantically read back one JSON MCP configuration. */
export const configureJsonClient = async (
  client: SetupClient,
  environment: SetupProviderEnvironment | string = {},
  command: readonly string[] = [
    "npx",
    "-y",
    PRODUCT_IDENTITY.packageSpecifier,
    "mcp",
  ],
): Promise<ClientConfigurationResult> => {
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(transactionPath, "utf8");
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
  const desired = clientConfigurationDesired(
    normalizeProviderEnvironment(environment),
    command,
  );
  if (
    JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
    JSON.stringify(desired)
  )
    return { status: "unchanged" };
  let backupPath: string | undefined;
  if (original !== undefined) {
    backupPath = `${client.configPath}.rea.backup`;
    if (!(await preserveConfigBackup(transactionPath, backupPath)))
      return { status: "failed", reason: "backup" };
  }
  document.mcpServers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  const encoded = `${JSON.stringify(document, null, 2)}\n`;
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(transactionPath, encoded, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    return { status: "failed", reason: "write" };
  }
  try {
    const readback = parseObject(await readFile(transactionPath, "utf8"));
    const value = parseOptionalObject(readback.mcpServers)[
      PRODUCT_IDENTITY.mcpServerKey
    ];
    if (JSON.stringify(value) !== JSON.stringify(desired)) {
      await restoreConfig(transactionPath, original);
      return { status: "failed", reason: "readback" };
    }
  } catch {
    await restoreConfig(transactionPath, original);
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
  environment: SetupProviderEnvironment | string = {},
  command: readonly string[] = [
    "npx",
    "-y",
    PRODUCT_IDENTITY.packageSpecifier,
    "mcp",
  ],
): Promise<ClientConfigurationResult> => {
  const transactionPath = await resolveClientConfigTransactionPath(
    client.configPath,
  );
  if (transactionPath === undefined)
    return { status: "failed", reason: "path" };
  let document: Record<string, unknown> = {};
  let original: string | undefined;
  try {
    original = await readFile(transactionPath, "utf8");
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
  const desired = clientConfigurationDesired(
    normalizeProviderEnvironment(environment),
    command,
  );
  if (
    JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
    JSON.stringify(desired)
  )
    return { status: "unchanged" };
  const backupPath =
    original === undefined ? undefined : `${client.configPath}.rea.backup`;
  if (
    backupPath !== undefined &&
    !(await preserveConfigBackup(transactionPath, backupPath))
  )
    return { status: "failed", reason: "backup" };
  document.mcp_servers = {
    ...servers,
    [PRODUCT_IDENTITY.mcpServerKey]: desired,
  };
  try {
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFileAtomic(transactionPath, stringifyToml(document), {
      encoding: "utf8",
      mode: 0o600,
    });
    const readback = objectSchema.parse(
      parseToml(await readFile(transactionPath, "utf8")),
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
    await restoreConfig(transactionPath, original);
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
const preserveConfigBackup = async (
  source: string,
  destination: string,
): Promise<boolean> => {
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (cause: unknown) {
    return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
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

const clientConfigurationDesired = (
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
) => {
  const environment = Object.fromEntries(
    Object.entries(providerEnvironment).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return {
    command: command[0] ?? PRODUCT_IDENTITY.cliBinary,
    args: command.slice(1),
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  };
};

const clientConfigurationAligned = async (
  client: SetupClient,
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<boolean> => {
  const desired = clientConfigurationDesired(providerEnvironment, command);
  try {
    const original = await readFile(client.configPath, "utf8");
    if (client.format === "toml") {
      const document = objectSchema.parse(parseToml(original));
      const servers = parseOptionalObject(document.mcp_servers);
      return (
        JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
        JSON.stringify(desired)
      );
    }
    const document = parseObject(original);
    const servers = parseOptionalObject(document.mcpServers);
    return (
      JSON.stringify(servers[PRODUCT_IDENTITY.mcpServerKey]) ===
      JSON.stringify(desired)
    );
  } catch {
    return false;
  }
};

const normalizeProviderEnvironment = (
  environment: SetupProviderEnvironment | string,
): SetupProviderEnvironment =>
  typeof environment === "string"
    ? { HOPPER_LAUNCHER_PATH: environment }
    : environment;

const providerRegistrationEnvironment = (
  inspections: readonly DoctorProviderInspection[],
): SetupProviderEnvironment =>
  Object.fromEntries(
    inspections
      .filter(({ available }) => available)
      .flatMap(({ registrationEnvironment }) =>
        Object.entries(registrationEnvironment),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
