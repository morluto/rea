import { z } from "zod";
import { clientRegistrationSource } from "./ClientRegistrationSource.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { jsonRecordSchema } from "../domain/jsonRecord.js";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  MCP_STARTUP_POLICY,
  recommendedMcpToolTimeoutMs,
  recommendedMcpToolTimeoutSeconds,
  type McpToolTimeoutInputs,
} from "../mcpStartupPolicy.js";
import {
  clientConfigurationRecordSchema,
  clientRegistrationEntry,
  clientRegistrationLauncherEntry,
  type ClientRegistrationDialect,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import type { ClientRegistrationTarget } from "./ClientRegistrationProfile.js";
import {
  classifyClientRegistrationCommand,
  equivalentClientRegistrationCommands,
  type ClientRegistrationCommandIdentity,
} from "./ClientRegistrationIdentity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";

const tomlTimeoutSchema = z.union([
  z.number().positive(),
  z.bigint().positive(),
]);

const launcherSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .passthrough();
const arrayLauncherSchema = z
  .object({
    command: z.array(z.string()).min(1),
  })
  .passthrough();
const opencodeLauncherSchema = arrayLauncherSchema.extend({
  type: z.literal("local"),
});
const normalizeOpencodeLauncher = (
  entry: z.output<typeof arrayLauncherSchema>,
): z.output<typeof launcherSchema> => {
  const [command = "", ...args] = entry.command;
  return { ...entry, command, args };
};

const registrationSchema = launcherSchema.extend({
  startup_timeout_sec: tomlTimeoutSchema.optional(),
  tool_timeout_sec: tomlTimeoutSchema.optional(),
  startupTimeoutMs: z.number().positive().optional(),
  toolTimeoutMs: z.number().positive().optional(),
  // Native transport tags belong to the selected profile's admission owner.
  // Other clients may retain arbitrary metadata under these same names.
  type: z.unknown().optional(),
  transport: z.unknown().optional(),
  serverName: z.string().optional(),
  disabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export type ClientRegistration = z.output<typeof registrationSchema>;

// https://developers.openai.com/codex/config-reference/#mcp_servers
const codexApprovalModeSchema = z.enum(["auto", "prompt", "writes", "approve"]);
const codexToolPolicySchema = z
  .object({
    approval_mode: codexApprovalModeSchema.optional(),
    output_token_limit: z
      .union([z.number().int().positive(), z.bigint().positive()])
      .optional(),
  })
  .passthrough();
const codexPolicySchema = z
  .object({
    default_tools_approval_mode: codexApprovalModeSchema.optional(),
    enabled_tools: z.array(z.string()).optional(),
    disabled_tools: z.array(z.string()).optional(),
    tools: clientConfigurationRecordSchema
      .superRefine((tools, context) => {
        for (const [name, value] of Object.entries(tools)) {
          const policy = codexToolPolicySchema.safeParse(value);
          if (!policy.success)
            for (const issue of policy.error.issues)
              context.addIssue({ ...issue, path: [name, ...issue.path] });
        }
      })
      .optional(),
  })
  .passthrough();

const registrationError = (error: z.ZodError): ConfigurationError =>
  new ConfigurationError("Invalid client registration settings", {
    settings: error.issues.map((issue) => ({
      setting: issue.path.join("."),
      constraint: issue.message,
    })),
  });

/** Launcher identity remains usable when unrelated readiness settings are invalid. */
export const parseClientRegistrationLauncher = (
  value: unknown,
  target: ClientRegistrationTarget,
): Result<{ command: string; args: string[] }, ConfigurationError> => {
  const { dialect, profile } = target;
  if (profile.connection.kind === "unavailable")
    return err(new ConfigurationError(profile.connection.reason));
  value = clientRegistrationSource(value, profile).connection ?? value;
  const parsed =
    dialect === "opencode" ||
    dialect === "opencode_v2" ||
    dialect === "fx" ||
    dialect === "kilo"
      ? arrayLauncherSchema
          .transform(normalizeOpencodeLauncher)
          .safeParse(value)
      : dialect === "goose"
        ? z
            .object({
              cmd: z.string().min(1),
              args: z.array(z.string()).default([]),
            })
            .passthrough()
            .transform((entry) => ({ command: entry.cmd, args: entry.args }))
            .safeParse(value)
        : launcherSchema.safeParse(value);
  return parsed.success
    ? ok({ command: parsed.data.command, args: parsed.data.args })
    : err(registrationError(parsed.error));
};

/** Launcher ownership is independent of readiness and caller-owned policy. */
export const clientRegistrationOwnership = (
  value: unknown,
  client: SetupClient,
): ClientRegistrationCommandIdentity => {
  const parsed = parseClientRegistrationLauncher(value, {
    dialect: client.format ?? "json",
    profile: client.registrationProfile,
  });
  return parsed.ok
    ? classifyClientRegistrationCommand(
        [parsed.value.command, ...parsed.value.args],
        CURRENT_ENTRYPOINT_PATH,
      )
    : "unknown";
};

/** Explain the same ownership admission decision in setup and doctor. */
export const clientRegistrationOwnershipRemediation = (
  ownership: Exclude<ClientRegistrationCommandIdentity, "owned">,
  paths: readonly string[],
): string =>
  `The existing "${PRODUCT_IDENTITY.mcpServerKey}" registration read from ${paths.join(", ")} has ${ownership} ownership and was not changed. Review its launcher and manually rename or remove that registration before rerunning setup. A different installation path does not prove REA ownership.`;

/** Policy belongs to the client dialect, and is validated before refresh writes. */
const validateClientPolicy = (
  value: unknown,
  client: SetupClient,
): Result<void, ConfigurationError> => {
  const policy =
    client.name === "codex"
      ? codexPolicySchema.safeParse(value)
      : client.format === "copilot_cli"
        ? z.object({ tools: z.array(z.string()).optional() }).safeParse(value)
        : undefined;
  return policy === undefined || policy.success
    ? ok(undefined)
    : err(registrationError(policy.error));
};

/** Parse launcher syntax and client policy; native transport selection is admitted separately. */
export const parseClientRegistrationPolicy = (
  value: unknown,
  client: SetupClient,
): Result<ClientRegistration, ConfigurationError> => {
  const policy = validateClientPolicy(value, client);
  if (!policy.ok) return policy;
  if (client.format === "dsh") {
    const parsed = registrationSchema
      .pick({ command: true, args: true, serverName: true, transport: true })
      .strip()
      .safeParse(value);
    return parsed.success
      ? ok(parsed.data)
      : err(registrationError(parsed.error));
  }
  if (client.format === "opencode") {
    const entry = opencodeLauncherSchema
      .extend({
        environment: jsonRecordSchema(z.string()).optional(),
      })
      .transform(normalizeOpencodeLauncher)
      .safeParse(value);
    if (!entry.success) return err(registrationError(entry.error));
    value = entry.data;
  }
  const source = clientRegistrationSource(value, client.registrationProfile);
  if (source.nested)
    value = {
      ...source.source,
      command: source.connection?.command,
      args: source.connection?.args,
    };
  const parsed = registrationSchema.safeParse(value);
  if (!parsed.success) return err(registrationError(parsed.error));
  const registration = parsed.data;
  return ok(registration);
};

// These fields select REA's connection and activation. Everything else belongs
// to the caller/client, including future policy keys. Client-specific timeout
// defaults and preservation rules are applied below.
const managedPolicyKeys = new Set([
  "env",
  "environment",
  "enabled",
  "disabled",
  "enable",
  "serverName",
]);

/** Own only fields selected by this native client's admitted profile. */
export const clientRegistrationSourceFacts = (
  target: ClientRegistrationTarget,
  command: readonly string[],
  previous: unknown,
): Result<
  {
    readonly source: Record<string, unknown> | undefined;
    readonly connection: Record<string, unknown> | undefined;
    readonly nested: boolean;
    readonly connectionFields: ReadonlySet<string>;
  },
  ConfigurationError
> => {
  const { profile } = target;
  const connection = profile.connection;
  if (connection.kind === "unavailable")
    return err(new ConfigurationError(connection.reason));
  const parsed = clientRegistrationSource(previous, profile);
  const { source } = parsed;
  const fields = new Set(
    Object.keys(clientRegistrationLauncherEntry(target.dialect, command)),
  );
  if (connection.kind === "stdio-only") {
    const admitted = new Set([...fields, ...connection.documentedFields]);
    const unknown = Object.keys(source ?? {}).filter(
      (key) => !admitted.has(key),
    );
    if (
      (previous !== undefined && source === undefined) ||
      unknown.length > 0 ||
      (source !== undefined &&
        Object.hasOwn(source, "type") &&
        source.type !== "stdio")
    )
      return err(
        new ConfigurationError(
          `Write applicability for ${profile.nativeClient} is unknown outside its documented stdio profile. Review the selected row in the client's native settings; no configuration was changed.`,
          {
            settings: [
              {
                setting: unknown[0] ?? "type",
                constraint:
                  "Native interpretation is not established by the documented stdio profile",
              },
            ],
          },
        ),
      );
  } else {
    for (const field of connection.kind === "cline"
      ? ["transport", "type", "transportType", "url"]
      : connection.kind === "commandcode"
        ? ["type", "url"]
        : connection.fields)
      fields.add(field);
  }
  return ok({ ...parsed, connectionFields: fields });
};

/** Explicit launcher replacement preserves policy and native environment, while
 * superseding connection selectors that could keep the old remote transport.
 * Goose's single env alias becomes envs; declaring both remains ambiguous. */
export const replaceClientRegistrationLauncher = (
  target: ClientRegistrationTarget,
  command: readonly string[],
  previous: unknown,
  inherited?: unknown,
): Result<Record<string, unknown>, ConfigurationError> => {
  const { dialect } = target;
  const facts = clientRegistrationSourceFacts(target, command, previous);
  if (!facts.ok) return facts;
  const { source, connectionFields: launcherConnectionKeys } = facts.value;
  const retained: Record<string, unknown> =
    source === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(source).filter(
            ([key]) => !launcherConnectionKeys.has(key),
          ),
        );
  if (dialect === "goose" && Object.hasOwn(retained, "env")) {
    if (Object.hasOwn(retained, "envs"))
      return err(
        new ConfigurationError(
          "Goose environment is ambiguous: keep only envs or its env alias, not both.",
          {
            settings: [
              {
                setting: "envs",
                constraint: "env and envs declare the same native field",
              },
            ],
          },
        ),
      );
    const alias = jsonRecordSchema(z.string()).safeParse(retained.env);
    if (!alias.success)
      return err(
        new ConfigurationError("Invalid Goose env alias", {
          cause: alias.error,
          settings: [
            {
              setting: "env",
              constraint: "Expected a mapping of string environment values",
            },
          ],
        }),
      );
    retained.envs = alias.data;
    delete retained.env;
  }
  const defaults = clientRegistrationEntry(dialect, command, {});
  // Layered native clients inherit policy without copying it into the edited
  // fragment. Defaults must not override an explicitly configured lower layer.
  const inheritedPolicy = clientConfigurationRecordSchema.safeParse(inherited);
  if (inheritedPolicy.success)
    for (const key of Object.keys(defaults))
      if (
        !launcherConnectionKeys.has(key) &&
        (Object.hasOwn(inheritedPolicy.data, key) ||
          (dialect === "opencode" &&
            key === "enabled" &&
            Object.hasOwn(inheritedPolicy.data, "disabled")))
      )
        delete defaults[key];
  // V1 already accepts a disabled policy. Adding enabled:true would override
  // that existing activation dialect when OpenCode migrates the row.
  if (
    dialect === "opencode" &&
    source !== undefined &&
    Object.hasOwn(source, "disabled")
  )
    delete defaults.enabled;
  const launcher = clientRegistrationLauncherEntry(dialect, command);
  if (facts.value.nested)
    for (const key of Object.keys(launcher)) delete defaults[key];
  return ok(
    writeRegistrationConnection(
      facts.value,
      { ...defaults, ...retained },
      launcher,
    ),
  );
};

const writeRegistrationConnection = (
  facts: ReturnType<typeof clientRegistrationSource>,
  retained: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> =>
  facts.nested
    ? {
        ...retained,
        transport: {
          ...Object.fromEntries(
            Object.entries(facts.connection ?? {}).filter(
              ([key]) =>
                key !== "type" && key !== "url" && !Object.hasOwn(fields, key),
            ),
          ),
          type: "stdio",
          ...fields,
        },
      }
    : { ...retained, ...fields };

/** Whether a rea setup repair for this target preserves the row's
 * `enable: false` instead of dropping it. Shared registration doubles as
 * ZCode's fallback, so the activation fact belongs to every reader; a repair
 * preserves it instead of silently re-enabling a row it does not own. A
 * client's own native storage has a single reader, so an explicitly selected
 * setup may still repair it. Doctor's remediation reads this same rule so a
 * preserved disable never points at an ineffective setup run. */
export const setupPreservesDisabledActivation = (
  client: Pick<SetupClient, "sharedRegistration">,
  format: string | undefined,
): boolean => client.sharedRegistration === true || format === "zcode_fallback";

/** Patch a source fragment, retaining client-owned settings rather than rebuilding it. */
export const refreshClientRegistration = (
  client: SetupClient,
  dialect: ClientRegistrationDialect,
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  previous: unknown,
  timeoutInputs: McpToolTimeoutInputs,
): Result<Record<string, unknown>, ConfigurationError> => {
  const target = { dialect, profile: client.registrationProfile };
  const facts = clientRegistrationSourceFacts(target, command, previous);
  if (!facts.ok) return facts;
  const existing = facts.value.source ?? {};
  const policy = validateClientPolicy(existing, client);
  if (!policy.ok) return policy;
  const prior = parseClientRegistrationLauncher(existing, target);
  const priorCommand = prior.ok
    ? [prior.value.command, ...prior.value.args]
    : undefined;
  const launcher =
    priorCommand !== undefined &&
    equivalentClientRegistrationCommands(priorCommand, command)
      ? priorCommand
      : command;
  const defaults = clientRegistrationEntry(dialect, launcher, environment);
  const fields = facts.value.nested
    ? {
        ...clientRegistrationLauncherEntry(dialect, launcher),
        ...(Object.keys(environment).length === 0
          ? {}
          : { env: { ...environment } }),
      }
    : clientRegistrationLauncherEntry(dialect, launcher);
  if (facts.value.nested)
    for (const key of Object.keys(fields)) delete defaults[key];
  const registration = writeRegistrationConnection(
    facts.value,
    {
      ...defaults,
      ...Object.fromEntries(
        Object.entries(existing).filter(
          ([key]) =>
            !facts.value.connectionFields.has(key) &&
            (!managedPolicyKeys.has(key) ||
              (facts.value.nested && key === "env")),
        ),
      ),
    },
    fields,
  );
  if (
    setupPreservesDisabledActivation(client, dialect) &&
    existing.enable === false
  )
    registration.enable = false;
  if (client.name === "codex" || client.name === "grok_build")
    registration.startup_timeout_sec =
      positiveTimeout(existing.startup_timeout_sec) ??
      MCP_STARTUP_POLICY.codexStartupTimeoutSeconds;
  if (client.name === "codex")
    registration.tool_timeout_sec =
      positiveTimeout(existing.tool_timeout_sec) ??
      recommendedMcpToolTimeoutSeconds(timeoutInputs);
  if (client.name === "kimi") {
    registration.startupTimeoutMs =
      positiveTimeout(existing.startupTimeoutMs) ??
      MCP_STARTUP_POLICY.kimiStartupTimeoutMs;
    registration.toolTimeoutMs =
      positiveTimeout(existing.toolTimeoutMs) ??
      recommendedMcpToolTimeoutMs(timeoutInputs);
  }
  return ok(registration);
};

const positiveTimeout = (value: unknown): number | bigint | undefined => {
  // TOML keeps integers beyond the safe Number range exact as bigint.
  if (typeof value === "bigint") return value > 0n ? value : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
};
