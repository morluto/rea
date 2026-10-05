import { parseClientConfiguration } from "./ClientConfigurationDocument.js";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import { isOwnedClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import { supportedClients } from "./SupportedClients.js";
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
        readonly state: "missing" | "invalid";
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
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
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
          OPENCODE_CONFIG: options.environment.OPENCODE_CONFIG,
          XDG_CONFIG_HOME: options.environment.XDG_CONFIG_HOME,
        },
  )) {
    if (
      client.format === "unsupported" ||
      (!(await exists(client.markerPath)) && !(await exists(client.configPath)))
    )
      continue;
    try {
      const content = await readFile(client.configPath, "utf8");
      const { servers } = parseClientConfiguration(content, client.format);
      const raw = servers[PRODUCT_IDENTITY.mcpServerKey];
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
          registrationAligned(registration, client, currentCommandPath)
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
): boolean => {
  const command = [registration.command, ...registration.args];
  if (registration.disabled === true || registration.enabled === false)
    return false;
  if (!isOwnedClientRegistrationCommand(command, currentCommandPath))
    return false;
  if (
    command.length === 3 &&
    command[2] === "mcp" &&
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === currentCommandPath
  )
    return true;
  if (
    client.name === "codex" &&
    registration.startup_timeout_sec !==
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds
  )
    return false;
  if (client.format === "vscode" && registration.type !== "stdio") return false;
  if (
    client.format === "copilot_cli" &&
    (registration.type !== "stdio" ||
      JSON.stringify(registration.tools) !== JSON.stringify(["*"]))
  )
    return false;
  if (
    command.length === 4 &&
    command[0] === "npx" &&
    command[1] === "-y" &&
    command[2] === PRODUCT_IDENTITY.registrationPackageSpecifier &&
    command[3] === "mcp"
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
  } catch {
    return false;
  }
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
