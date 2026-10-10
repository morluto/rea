import {
  clientServerForcedEnabled,
  clientServerListedDisabled,
  effectiveClientServer,
  parseClientConfiguration,
  piExposureSchema,
} from "./ClientConfigurationDocument.js";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import {
  isOwnedClientRegistrationCommand,
  npxRegistrationCommand,
} from "./ClientRegistrationIdentity.js";
import {
  manualRegistrationRemediation,
  supportedClients,
} from "./SupportedClients.js";
import type { SetupClient } from "./SupportedClients.js";

interface ClientRegistrationStatusBase {
  readonly client: string;
  readonly config_path: string;
}

type RegistrationCommand = readonly [string, ...string[]];

export type ClientRegistrationStatus = ClientRegistrationStatusBase &
  (
    | {
        readonly command: RegistrationCommand;
        readonly state: "aligned";
        readonly remediation: null;
      }
    | {
        readonly command: RegistrationCommand;
        readonly state: "stale";
        readonly remediation: string;
      }
    | {
        readonly command: readonly [];
        readonly state: "missing" | "invalid" | "manual";
        readonly remediation: string;
      }
  );

export type UnhealthyClientRegistrationStatus = Exclude<
  ClientRegistrationStatus,
  { readonly state: "aligned" }
>;

const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    startup_timeout_sec: z.number().positive().optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
    exposure: z.string().optional(),
  })
  .passthrough();

/** Inspect supported client registrations without reading their environment. */
export const readClientRegistrationStatuses = async (
  home: string,
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<readonly ClientRegistrationStatus[]> => {
  const statuses: ClientRegistrationStatus[] = [];
  for (const client of supportedClients(
    home,
    options.platform,
    options.environment === undefined
      ? undefined
      : {
          APPDATA: options.environment.APPDATA,
          CLAUDE_CONFIG_DIR: options.environment.CLAUDE_CONFIG_DIR,
          CODEX_HOME: options.environment.CODEX_HOME,
          COPILOT_HOME: options.environment.COPILOT_HOME,
          GROK_HOME: options.environment.GROK_HOME,
          OMP_PROFILE: options.environment.OMP_PROFILE,
          OPENCODE_CONFIG: options.environment.OPENCODE_CONFIG,
          PI_CODING_AGENT_DIR: options.environment.PI_CODING_AGENT_DIR,
          PI_CONFIG_DIR: options.environment.PI_CONFIG_DIR,
          PI_PROFILE: options.environment.PI_PROFILE,
          SAND_DATA_ROOT: options.environment.SAND_DATA_ROOT,
          XDG_CONFIG_HOME: options.environment.XDG_CONFIG_HOME,
        },
  )) {
    if (
      !(await exists(client.markerPath)) &&
      !(await exists(client.configPath))
    )
      continue;
    const manualRemediation = manualRegistrationRemediation(client.name);
    if (client.format === "unsupported") {
      if (manualRemediation !== undefined)
        statuses.push({
          client: client.name,
          config_path: client.markerPath ?? client.configPath,
          command: [],
          state: "manual",
          remediation: manualRemediation,
        });
      continue;
    }
    try {
      const content = await readFile(client.configPath, "utf8");
      const parsed = parseClientConfiguration(content, client.format);
      const raw = effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
      if (raw === undefined) {
        statuses.push(
          unavailableStatus(client.name, client.configPath, "missing"),
        );
        continue;
      }
      const registration = parseRegistration(raw, client);
      const command: RegistrationCommand = [
        registration.command,
        ...registration.args,
      ];
      statuses.push(
        configuredStatus(
          client.name,
          client.configPath,
          command,
          registrationAligned(
            registration,
            client,
            currentCommandPath,
            options.platform ?? process.platform,
            clientServerForcedEnabled(parsed, PRODUCT_IDENTITY.mcpServerKey),
          ) &&
            !clientServerListedDisabled(parsed, PRODUCT_IDENTITY.mcpServerKey)
            ? "aligned"
            : "stale",
        ),
      );
    } catch (cause: unknown) {
      statuses.push(
        unavailableStatus(
          client.name,
          client.configPath,
          isMissing(cause) ? "missing" : "invalid",
        ),
      );
    }
  }
  return statuses.sort((left, right) =>
    left.client.localeCompare(right.client),
  );
};

const registrationAligned = (
  registration: z.output<typeof registrationSchema>,
  client: SetupClient,
  currentCommandPath: string,
  platform: NodeJS.Platform,
  forcedEnabled = false,
): boolean => {
  const command = [registration.command, ...registration.args];
  if (
    registration.disabled === true ||
    (registration.enabled === false && !forcedEnabled)
  )
    return false;
  if (!isOwnedClientRegistrationCommand(command, currentCommandPath))
    return false;
  if (
    (client.name === "codex" || client.name === "grok_build") &&
    registration.startup_timeout_sec !==
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds
  )
    return false;
  if (client.format === "vscode" && registration.type !== "stdio") return false;
  // OMP infers stdio for a command entry without an explicit type.
  if (
    client.format === "omp" &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    return false;
  // Pi infers stdio from a command and defaults to callable codemode exposure.
  if (
    client.format === "pi" &&
    ((registration.type !== undefined && registration.type !== "stdio") ||
      registration.exposure === "hidden" ||
      (registration.exposure !== undefined &&
        !piExposureSchema.safeParse(registration.exposure).success))
  )
    return false;
  if (
    client.format === "copilot_cli" &&
    (registration.type !== "stdio" ||
      JSON.stringify(registration.tools) !== JSON.stringify(["*"]))
  )
    return false;
  if (client.format === "commandcode" && registration.transport !== "stdio")
    return false;
  if (
    command.length === 3 &&
    command[2] === "mcp" &&
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === currentCommandPath
  )
    return true;
  const npxCommand = npxRegistrationCommand(platform);
  if (
    command.length === npxCommand.length &&
    command.every((argument, index) => argument === npxCommand[index])
  )
    return true;
  return (
    command.length === 2 &&
    command[1] === "mcp" &&
    resolve(command[0] ?? "") === currentCommandPath
  );
};

const parseRegistration = (
  value: unknown,
  client: SetupClient,
): z.output<typeof registrationSchema> => {
  if (client.format === "opencode") {
    const entry = z
      .object({
        type: z.literal("local"),
        command: z.array(z.string()).min(1),
        environment: z.record(z.string(), z.string()).optional(),
      })
      .passthrough()
      .parse(value);
    const [command = "", ...args] = entry.command;
    return registrationSchema.parse({
      ...entry,
      command,
      args,
    });
  }
  const registration = registrationSchema.parse(value);
  if (
    (client.format === "vscode" || client.format === "copilot_cli") &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  if (client.format === "commandcode" && registration.transport !== "stdio")
    throw new TypeError("Expected an stdio registration");
  if (
    (client.format === "omp" || client.format === "pi") &&
    registration.type !== undefined &&
    registration.type !== "stdio"
  )
    throw new TypeError("Expected an stdio registration");
  return registration;
};

const remediation =
  "Run rea setup to refresh this registration, then restart the client.";

const configuredStatus = (
  client: string,
  configPath: string,
  command: RegistrationCommand,
  state: "aligned" | "stale",
): ClientRegistrationStatus =>
  state === "aligned"
    ? { client, config_path: configPath, command, state, remediation: null }
    : { client, config_path: configPath, command, state, remediation };

const unavailableStatus = (
  client: string,
  configPath: string,
  state: "missing" | "invalid",
): ClientRegistrationStatus => ({
  client,
  config_path: configPath,
  command: [],
  state,
  remediation,
});

const exists = async (path: string | undefined): Promise<boolean> => {
  if (path === undefined) return false;
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional registration probing; absence means unregistered.
    void cause;
    return false;
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
