import type {
  OwnedProviderSetting,
  RecordedProviderSettings,
} from "../ports/DesktopBuildHost.js";
import { validateRegistrationEnvironment } from "./RegistrationEnvironmentValidation.js";
import {
  clientRegistrationSource,
  gooseEnvironmentField,
} from "./ClientRegistrationSource.js";
import type { SetupClient } from "./SupportedClients.js";

import { launchAnalysisSetting } from "../config/analysisSettings.js";
import type { Environment } from "../config/environment.js";
import {
  DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
  DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  effectiveClientServer,
  clientConfigurationRecordSchema,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  mergeEnvironmentOverrides,
  snapshotEnvironment,
} from "../process/snapshotEnvironment.js";
import { dshDocument } from "./DshCordisPatch.js";
import type { McpToolTimeoutInputs } from "../config/mcpStartupPolicy.js";
import type { AnalysisProviderSelector } from "../domain/providerSelection.js";

export type ProviderRequestBudgetResolver = (
  analysisProvider: AnalysisProviderSelector,
  environment: Readonly<Record<string, string>>,
) => Promise<Result<number | undefined, ConfigurationError>>;

export interface ClientRegistrationEnvironmentDetails {
  readonly values: Readonly<Record<string, string>>;
  readonly unresolvedSettings: ReadonlySet<string>;
  readonly timeoutInputs: McpToolTimeoutInputs | undefined;
}

interface ResolvedClientRegistrationEnvironmentDetails extends ClientRegistrationEnvironmentDetails {
  readonly timeoutInputs: McpToolTimeoutInputs;
}

const TIMEOUT_INPUT_SETTINGS: ReadonlySet<string> = new Set([
  "REA_ANALYSIS_PROVIDER",
  "REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS",
  "REA_HOPPER_STARTUP_TIMEOUT_MS",
  "REA_JEB_MCP_TIMEOUT_MS",
]);

const environmentSchema = clientConfigurationRecordSchema.transform(
  (values, context) => {
    const entries: [string, string][] = [];
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string") entries.push([key, value]);
      else
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Environment values must be strings",
        });
    }
    return Object.fromEntries(entries);
  },
);

/**
 * Clients that expand `$VAR` and `${VAR}` in a recorded `env` value from the
 * environment the client itself runs with.
 *
 * REA does not replicate that expansion — it would have to predict a child's
 * environment — but it must not report the literal text as the value either, or
 * a consumer that searches for an inherited `PATH` searches for a literal
 * `${PATH}` entry instead.
 */
const VAR_EXPANDING_CLIENTS: ReadonlySet<string> = new Set(["qwen_code"]);

/** Recorded setting names whose value is an expression, not a literal. */
const expressionSettings = (
  clientName: string | undefined,
  values: Readonly<Record<string, string>>,
): ReadonlySet<string> =>
  clientName !== undefined && VAR_EXPANDING_CLIENTS.has(clientName)
    ? new Set(
        Object.entries(values)
          .filter(([, value]) =>
            /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/u.test(
              value,
            ),
          )
          .map(([name]) => name),
      )
    : new Set();

/** Read explicit REA overrides without dropping peers when one value is invalid. */
export const clientRegistrationEnvironment = (
  parsed: ClientConfigurationDocument | undefined,
  client: Pick<SetupClient, "name" | "registrationProfile"> | undefined,
  platform: NodeJS.Platform,
  overrides: Readonly<Record<string, string>> = {},
  validation: "fragment" | "effective" = "effective",
): Result<Readonly<Record<string, string>>, ConfigurationError> => {
  const details = clientRegistrationEnvironmentDetails(
    parsed,
    client,
    platform,
    overrides,
    validation,
  );
  return details.ok ? ok(details.value.values) : details;
};

/** Retain original strings and the parser-owned timeout facts. */
export const clientRegistrationEnvironmentDetails = (
  parsed: ClientConfigurationDocument | undefined,
  client: Pick<SetupClient, "name" | "registrationProfile"> | undefined,
  platform: NodeJS.Platform,
  overrides: Readonly<Record<string, string>> = {},
  validation: "fragment" | "effective" = "effective",
): Result<ClientRegistrationEnvironmentDetails, ConfigurationError> => {
  if (parsed?.dialect === "dsh") {
    const environment = dshDocument(parsed.document).environment(
      overrides,
      validation,
      platform,
    );
    if (!environment.ok) return environment;
    return ok(
      environmentDetails(
        environment.value.values,
        environment.value.configuration,
        environment.value.unresolvedSettings,
        platform,
      ),
    );
  }
  const key = parsed?.environmentKey ?? "env";
  const registration =
    parsed === undefined
      ? undefined
      : effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
  const source = clientRegistrationSource(
    registration,
    client?.registrationProfile,
  );
  const field =
    key === "envs" ? gooseEnvironmentField(source.connection) : ok(key);
  if (!field.ok) return field;
  const raw = source.connection?.[field.value];
  const existing = environmentSchema.safeParse(raw === undefined ? {} : raw);
  if (!existing.success)
    return err(
      new ConfigurationError("Invalid REA server environment", {
        settings: existing.error.issues.map((issue) => ({
          setting: [
            ...(source.nested ? ["transport"] : []),
            field.value,
            ...issue.path,
          ].join("."),
          constraint:
            "Server environment must be an object containing only string values",
        })),
      }),
    );
  // Validate known settings with the runtime's parser, but retain the original
  // string overrides, including unknown client-specific keys and no defaults.
  const environment = mergeEnvironmentOverrides(
    existing.data,
    overrides,
    platform,
  );
  return validatedDetails(
    environment,
    validation,
    platform,
    expressionSettings(client?.name, environment),
  );
};

/** Consume a resolved setting inside its reader without including its value in diagnostics. */
export type ProviderSettingObserver = (name: string, value: string) => void;

/**
 * Compare settings selected in this process with a registration's own file.
 * The server's environment also depends on what its client passes on, which is
 * not observable here, so a gap is never a claim about the effective value.
 * Returns only names: recorded values stay in the file that owns them.
 */
export const recordedProviderSettings = (
  parsed: ClientConfigurationDocument,
  client: Pick<SetupClient, "name" | "registrationProfile"> | undefined,
  selected: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  owns?: OwnedProviderSetting,
  observe?: ProviderSettingObserver,
): RecordedProviderSettings | undefined => {
  const selection = mergeEnvironmentOverrides({}, selected, platform);
  const names = Object.keys(selection).sort(compareUnicodeCodePoints);
  const identity = (name: string): string =>
    platform === "win32" ? name.toUpperCase() : name;
  if (names.length === 0) return undefined;
  const details = clientRegistrationEnvironmentDetails(
    parsed,
    client,
    platform,
    {},
    "fragment",
  );
  if (!details.ok) return { unrecorded: [], differing: [], unresolved: names };
  const recorded = snapshotEnvironment(details.value.values, platform);
  // Expression names fold like every other environment name on this platform.
  const expressions = snapshotEnvironment(
    Object.fromEntries(
      [...details.value.unresolvedSettings].map((name) => [name, ""]),
    ),
    platform,
  );
  for (const name of names) {
    const value = recorded[identity(name)];
    if (value !== undefined && expressions[identity(name)] === undefined)
      observe?.(name, value);
  }
  const facts = {
    unrecorded: names.filter(
      (name) =>
        recorded[identity(name)] === undefined &&
        expressions[identity(name)] === undefined,
    ),
    differing: names.filter(
      (name) =>
        expressions[identity(name)] === undefined &&
        recorded[identity(name)] !== undefined &&
        recorded[identity(name)] !== selection[name],
    ),
    unresolved: names.filter(
      (name) => expressions[identity(name)] !== undefined,
    ),
  };
  const owned = names.filter((name) => {
    const value = recorded[identity(name)];
    return value !== undefined && owns?.(name, value) === true;
  });
  return facts.unrecorded.length +
    facts.differing.length +
    facts.unresolved.length +
    owned.length ===
    0
    ? undefined
    : { ...facts, ...(owned.length === 0 ? {} : { owned }) };
};

/** Resolve the async provider-specific budget through its retained reader owner. */
export const clientRegistrationEnvironmentDetailsWithBudget = async (
  parsed: ClientConfigurationDocument | undefined,
  client: Pick<SetupClient, "name" | "registrationProfile"> | undefined,
  overrides: Readonly<Record<string, string>>,
  validation: "fragment" | "effective",
  resolveProviderRequestBudget: ProviderRequestBudgetResolver | undefined,
  platform: NodeJS.Platform,
): Promise<
  Result<ResolvedClientRegistrationEnvironmentDetails, ConfigurationError>
> => {
  const details = clientRegistrationEnvironmentDetails(
    parsed,
    client,
    platform,
    overrides,
    validation,
  );
  if (!details.ok) return details;
  const unresolved = [...details.value.unresolvedSettings].filter(
    (setting) =>
      resolveProviderRequestBudget !== undefined ||
      TIMEOUT_INPUT_SETTINGS.has(setting),
  );
  if (details.value.timeoutInputs === undefined || unresolved.length > 0)
    return err(
      new ConfigurationError(
        "Cannot derive a provider request budget from expression-backed settings",
        {
          settings: unresolved.map((setting) => ({
            setting,
            constraint:
              "Resolve this setting to a literal before deriving a request budget",
          })),
        },
      ),
    );
  const resolved = {
    ...details.value,
    timeoutInputs: details.value.timeoutInputs,
  };
  if (resolveProviderRequestBudget === undefined) return ok(resolved);
  return validatedBudget(resolved, resolveProviderRequestBudget, platform);
};

const validatedDetails = (
  environment: Readonly<Record<string, string>>,
  validation: "fragment" | "effective",
  platform: NodeJS.Platform,
  expressionSettings: ReadonlySet<string>,
): Result<ClientRegistrationEnvironmentDetails, ConfigurationError> => {
  const validated = validateRegistrationEnvironment(
    environment,
    expressionSettings,
    validation,
    platform,
  );
  return validated.ok
    ? ok(
        environmentDetails(
          environment,
          validated.value.configuration,
          validated.value.unresolvedSettings,
          platform,
        ),
      )
    : validated;
};

const admittedTimeout = (
  id: Parameters<typeof launchAnalysisSetting>[0],
  environment: Readonly<Record<string, string | undefined>>,
  fallback: number,
): number => {
  const parsed = launchAnalysisSetting(id, environment);
  return parsed.ok && parsed.value.value !== null
    ? parsed.value.value
    : fallback;
};

const registrationTimeoutInputs = (
  environment: Readonly<Record<string, string>>,
): Pick<
  McpToolTimeoutInputs,
  | "ghidraStartupTimeoutMs"
  | "hopperStartupTimeoutMs"
  | "ghidraDecompileTimeoutMs"
  | "jebMcpTimeoutMs"
> => {
  const decompile = launchAnalysisSetting(
    "ghidra.decompile_timeout_seconds",
    environment,
  );
  const jeb = launchAnalysisSetting("jeb.mcp_timeout_ms", environment);
  return {
    ghidraStartupTimeoutMs: admittedTimeout(
      "ghidra.startup_timeout_ms",
      environment,
      DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS,
    ),
    hopperStartupTimeoutMs: admittedTimeout(
      "hopper.startup_timeout_ms",
      environment,
      DEFAULT_HOPPER_STARTUP_TIMEOUT_MS,
    ),
    ...(decompile.ok &&
    decompile.value.source === "setting" &&
    decompile.value.value !== null
      ? { ghidraDecompileTimeoutMs: decompile.value.value * 1000 }
      : {}),
    ...(jeb.ok &&
    jeb.value.source === "setting" &&
    jeb.value.value !== null &&
    environment.REA_JEB_MCP_TIMEOUT_MS !== undefined
      ? { jebMcpTimeoutMs: jeb.value.value }
      : {}),
  };
};

const environmentDetails = (
  environment: Readonly<Record<string, string>>,
  configuration: Environment,
  unresolvedSettings: ReadonlySet<string>,
  platform: NodeJS.Platform,
): ClientRegistrationEnvironmentDetails => ({
  values: Object.fromEntries(
    Object.entries(environment).sort(([left], [right]) =>
      compareUnicodeCodePoints(left, right),
    ),
  ),
  unresolvedSettings,
  timeoutInputs: [...unresolvedSettings].some((setting) =>
    TIMEOUT_INPUT_SETTINGS.has(setting),
  )
    ? undefined
    : {
        analysisProvider: configuration.REA_ANALYSIS_PROVIDER,
        // The retained spelling is what the file records; the child receives the platform-folded
        // environment, and its facts are what these timeouts must describe. On Windows a
        // differently-cased name is the same setting, so reading the recorded spelling would
        // report the default allowance for a timeout the child really applies.
        ...registrationTimeoutInputs(
          snapshotEnvironment(environment, platform),
        ),
      },
});

const validatedBudget = async (
  details: ResolvedClientRegistrationEnvironmentDetails,
  resolveProviderRequestBudget: ProviderRequestBudgetResolver,
  platform: NodeJS.Platform,
): Promise<
  Result<ResolvedClientRegistrationEnvironmentDetails, ConfigurationError>
> => {
  const providerBudget = await resolveProviderRequestBudget(
    details.timeoutInputs.analysisProvider,
    snapshotEnvironment(details.values, platform),
  );
  if (!providerBudget.ok) return providerBudget;
  return ok({
    ...details,
    timeoutInputs: {
      ...details.timeoutInputs,
      ...(providerBudget.value === undefined
        ? {}
        : { providerRequestTimeoutMs: providerBudget.value }),
    },
  });
};
