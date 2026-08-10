import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import { PRODUCT_IDENTITY } from "../identity.js";
import { MCP_STARTUP_POLICY } from "../mcpStartupPolicy.js";
import { supportedClients } from "./SupportedClients.js";

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

const objectSchema = z.record(z.string(), z.unknown());
const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    startup_timeout_sec: z.number().positive().optional(),
  })
  .passthrough();

/** Inspect supported client registrations without reading their environment. */
export const readClientRegistrationStatuses = async (
  home: string,
  currentCommandPath: string = resolve(process.argv[1] ?? "unknown"),
): Promise<readonly ClientRegistrationStatus[]> => {
  const statuses: ClientRegistrationStatus[] = [];
  for (const client of supportedClients(home)) {
    if (client.format === "unsupported" || !(await exists(client.markerPath)))
      continue;
    try {
      const content = await readFile(client.configPath, "utf8");
      const document = objectSchema.parse(
        client.format === "toml" ? parseToml(content) : JSON.parse(content),
      );
      const servers = objectSchema.parse(
        document[client.format === "toml" ? "mcp_servers" : "mcpServers"] ?? {},
      );
      const raw = servers[PRODUCT_IDENTITY.mcpServerKey];
      if (raw === undefined) {
        statuses.push(
          unavailableStatus(client.name, client.configPath, "missing"),
        );
        continue;
      }
      const registration = registrationSchema.parse(raw);
      const command: RegistrationCommand = [
        registration.command,
        ...registration.args,
      ];
      statuses.push(
        configuredStatus(
          client.name,
          client.configPath,
          command,
          registrationAligned(registration, client.name, currentCommandPath)
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
  client: string,
  currentCommandPath: string,
): boolean => {
  const command = [registration.command, ...registration.args];
  if (
    client === "codex" &&
    registration.startup_timeout_sec !==
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds
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
