import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { readClientPolicyBlock } from "./GeminiClientSettings.js";
import {
  contributingRegistrationSource,
  hasProjectRegistrationContribution,
  inlineRegistrationOrigins,
  readEffectiveClientRegistrationConfiguration,
  type ClientRegistrationScope,
  type EffectiveClientRegistrationConfiguration,
} from "./ClientConfigurationFiles.js";

export type { ClientRegistrationScope };
import {
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { lstat, stat } from "node:fs/promises";
import { err, ok, type Result } from "../domain/result.js";

import { PRODUCT_IDENTITY } from "../identity.js";
import { CURRENT_ENTRYPOINT_PATH } from "../process/CurrentEntrypointPath.js";
import {
  MCP_STARTUP_POLICY,
  mcpProviderDeadlineAllowanceMs,
  recommendedMcpToolTimeoutMs,
  recommendedMcpToolTimeoutSeconds,
  type McpToolTimeoutInputs,
} from "../config/mcpStartupPolicy.js";
import {
  inspectClientRegistrationCommand,
  transientClientLauncherPaths,
  type ClientRegistrationCommandFacts,
  type ClientRegistrationCommandIdentity,
} from "./ClientRegistrationIdentity.js";
import {
  clientEvidencePaths,
  clientOwnershipEvidencePaths,
  clientProjectConfigurationPaths,
  manualRegistrationRemediation,
  resolveSupportedClients,
} from "./SupportedClients.js";
import type { ClientSystemPaths, SetupClient } from "./SupportedClients.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { dshDocument } from "./DshCordisPatch.js";
import {
  clientRegistrationEnvironmentDetailsWithBudget,
  recordedProviderSettings,
} from "./ClientRegistrationEnvironment.js";
import type { ProviderRequestBudgetResolver } from "./ClientRegistrationEnvironment.js";
import type {
  OwnedProviderSetting,
  RecordedProviderSettings,
} from "../ports/DesktopBuildHost.js";
import type { ArtifactResourceScope } from "../resources/index.js";

import {
  clientRegistrationActivation,
  parseClientRegistrationPolicy,
  parseClientRegistrationLauncher,
  clientRegistrationOwnershipRemediation,
  setupPreservesDisabledActivation,
  type ClientRegistration,
} from "./ClientRegistration.js";
import { admitClientStdioConnection } from "./ClientRegistrationConnection.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isAbsentClientConfigPath } from "./ClientConfigPath.js";

interface ClientRegistrationStatusBase {
  readonly client: string;
  readonly config_path: string;
  /** Configuration scope that produced or governs this status, when project scope is supported. */
  readonly scope?: ClientRegistrationScope;
  /** Configuration scope that provides the launcher command, when distinct from scope. */
  readonly launcher_scope?: ClientRegistrationScope;
  /** Parsed launcher ownership; independent of readiness and retained without reinspection. */
  readonly command_identity: ClientRegistrationCommandIdentity;
  /** Exact package reference requested by npx/bunx, when registration uses one. */
  readonly package_reference?: string;
  /** Non-blocking timeout guidance; caller-selected values remain aligned. */
  readonly advisory?: string;
  /** Provider settings this process selected that the registration's file does not carry. */
  readonly provider_settings?: RecordedProviderSettings;
  /**
   * A non-aligned state that setup cannot repair: the shared row's
   * `enable: false`, which setup preserves for every reader of that storage.
   */
  readonly manual_conflict?: "shared_disabled_activation";
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
        /** Empty when the client's configuration location is unresolved. */
        readonly command: RegistrationCommand | readonly [];
        readonly state: "unknown";
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

interface ClientRegistrationReadOptions {
  readonly platform: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly systemPaths?: ClientSystemPaths;
  readonly resources?: ArtifactResourceScope;
  readonly selectedClientIds?: readonly string[];
  /**
   * Which evidence authorises inspection. `readiness` inspects a client whose
   * product applicability is established, plus clients the caller selected
   * explicitly. `ownership` also inspects shared registration storage, because
   * a version-pinned registration REA wrote must be refreshed even when the
   * product profile is absent.
   */
  readonly evidence?: "readiness" | "ownership";
  /** Limit inspection to user-scoped configuration files. Defaults to inspecting project files when present. */
  readonly scope?: "user" | "all";
  readonly resolveProviderRequestBudget?: ProviderRequestBudgetResolver;
  /** Settings to compare with each registration's file; omitted skips that read. */
  readonly providerSettings?: Readonly<Record<string, string>>;
  /** Which recorded provider settings hold a value the caller owns. */
  readonly ownedProviderSetting?: OwnedProviderSetting;
  /** Supply probe-admitted settings without returning their values in status. */
  readonly observeProbeSetting?: (
    client: string,
    name: string,
    value: string,
  ) => void;
}

/** Registration facts shared by diagnostics and update maintenance. */
export interface ClientRegistrationInspection {
  readonly status: ClientRegistrationStatus;
  readonly activation: "enabled" | "disabled" | "unknown";
  /**
   * The resolved client row this registration was read from, so maintenance
   * can ask setup's own preflight whether it would refresh it.
   */
  readonly client: SetupClient;
}

/** Project diagnostics from the same inspection used to select maintenance. */
export const readClientRegistrationStatuses = async (
  home: string,
  currentCommandPath: string | undefined = CURRENT_ENTRYPOINT_PATH,
  options: ClientRegistrationReadOptions,
): Promise<readonly ClientRegistrationStatus[]> =>
  (
    await readClientRegistrationInspections(home, currentCommandPath, options)
  ).map(({ status }) => status);

/** Parse effective registrations and their client-specific activation once.
 * A supplied scope retains failed cleanup; otherwise transfer its exact failure.
 */
export const readClientRegistrationInspections = async (
  home: string,
  currentCommandPath: string | undefined = CURRENT_ENTRYPOINT_PATH,
  options: ClientRegistrationReadOptions,
): Promise<readonly ClientRegistrationInspection[]> => {
  const inspections: ClientRegistrationInspection[] = [];
  const projectDirectory = options.scope === "user" ? undefined : process.cwd();
  for (const client of await resolveSupportedClients(
    home,
    options.platform,
    options.environment,
    options.systemPaths,
  )) {
    const record = (
      status: ClientRegistrationStatus,
      activation: ClientRegistrationInspection["activation"] = "unknown",
    ): void => {
      inspections.push({ status, activation, client });
    };
    const selected = options.selectedClientIds?.includes(client.name) === true;
    // An unresolved location leaves this client's registration unknown, never
    // absent; diagnostics and maintenance still cover every other client.
    if (client.configPathError !== undefined) {
      record({
        client: client.name,
        config_path: client.configPath,
        command: [],
        command_identity: "unknown",
        state: "unknown",
        remediation: client.configPathError,
      });
      continue;
    }
    const presence = await clientEvidencePresent(client, {
      selected,
      ownership: options.evidence === "ownership",
      projectDirectory,
      platform: options.platform,
    });
    if (!presence.ok) {
      record({
        client: client.name,
        config_path: presence.error.path,
        command: [],
        command_identity: "unknown",
        state: "invalid",
        remediation: presence.error.detail,
      });
      continue;
    }
    if (!presence.value) continue;
    const manualRemediation = manualRegistrationRemediation(client.name);
    if (client.format === "unsupported") {
      if (manualRemediation !== undefined)
        record({
          client: client.name,
          config_path: client.markerPath ?? client.configPath,
          command: [],
          command_identity: "unknown",
          state: "manual",
          remediation: manualRemediation,
        });
      continue;
    }
    let selectedConfigPath = client.configPath;
    let selectedScope: ClientRegistrationScope | undefined;
    try {
      const configuration = await readEffectiveClientRegistrationConfiguration(
        client,
        options.resources,
        options.platform,
        projectDirectory === undefined ? undefined : { projectDirectory },
      );
      if (!configuration.ok) {
        if (
          options.resources === undefined &&
          configuration.error.cleanupFailure !== undefined
        )
          throw configuration.error.cleanupFailure;
        record({
          client: client.name,
          config_path: configuration.error.path,
          ...(configuration.error.scope === "project"
            ? { scope: "project" }
            : {}),
          command: [],
          command_identity: "unknown",
          state: "invalid",
          remediation:
            configuration.error.scope === "project"
              ? `${configuration.error.detail} REA setup writes only user-level configuration and does not modify project-scoped configuration at ${configuration.error.path}. Repair or remove ${configuration.error.path}, then rerun rea doctor.`
              : configuration.error.detail,
        });
        continue;
      }
      const {
        document: parsed,
        configPath,
        scope,
        launcherScope,
        launcherConfigPath,
      } = configuration.value;
      const launcherPath = launcherConfigPath ?? configPath;
      const launcherRegistrationScope = launcherScope ?? scope;
      selectedConfigPath = configPath;
      if (scope !== undefined) selectedScope = scope;
      // A client applicable only through REA's registration has none to report.
      const reportsAbsence =
        selected || client.registrationApplicability !== true;
      if (parsed === undefined) {
        if (reportsAbsence)
          record(
            unavailableStatus(client, "missing", configPath, selectedScope),
          );
        continue;
      }
      const policy = await readClientPolicyBlock(
        client,
        parsed,
        undefined,
        options.resources,
      );
      if (!policy.ok) {
        if (
          options.resources === undefined &&
          policy.error.cleanupFailure !== undefined
        )
          throw policy.error.cleanupFailure;
        record({
          client: client.name,
          config_path: configPath,
          ...(selectedScope === undefined ? {} : { scope: selectedScope }),
          command: [],
          command_identity: "unknown",
          state: "invalid",
          remediation: policy.error.detail,
        });
        continue;
      }
      const policyBlock = policy.value;
      const raw = effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
      if (raw === undefined) {
        const editabilityError =
          parsed.dialect === "dsh"
            ? dshDocument(parsed.document).editabilityError
            : undefined;
        if (editabilityError !== undefined) {
          record({
            client: client.name,
            config_path: configPath,
            ...(selectedScope === undefined ? {} : { scope: selectedScope }),
            command: [],
            command_identity: "unknown",
            state: "invalid",
            remediation: editabilityError.message,
          });
          continue;
        }
        if (reportsAbsence)
          record(
            unavailableStatus(client, "missing", configPath, selectedScope),
          );
        continue;
      }
      const effectiveClient: SetupClient =
        parsed.dialect === "zcode_fallback"
          ? {
              ...client,
              configPath,
              configPaths: [configPath],
              format: "zcode_fallback",
            }
          : client;
      const parsedRegistration = parseClientRegistrationPolicy(
        raw,
        effectiveClient,
      );
      if (!parsedRegistration.ok) {
        // Invalid readiness settings do not erase a usable launcher identity.
        const launcher = parseClientRegistrationLauncher(raw, {
          dialect: parsed.dialect,
          profile: client.registrationProfile,
        });
        const commandIdentity = launcher.ok
          ? inspectClientRegistrationCommand(
              [launcher.value.command, ...launcher.value.args],
              currentCommandPath,
            ).identity
          : "unknown";
        record(
          invalidRegistrationStatus(
            client,
            configuration.value,
            parsedRegistration.error,
            commandIdentity,
          ),
        );
        continue;
      }
      const registration = parsedRegistration.value;
      const command: RegistrationCommand = [
        registration.command,
        ...registration.args,
      ];
      const commandFacts = inspectClientRegistrationCommand(
        command,
        currentCommandPath,
      );
      const transientPaths = transientClientLauncherPaths(
        command,
        options.environment ?? process.env,
        options.platform,
      );
      const nativeApplicability = admitClientStdioConnection(raw, {
        dialect: parsed.dialect,
        profile: client.registrationProfile,
      });
      if (
        !nativeApplicability.ok &&
        nativeApplicability.error.kind === "invalid"
      ) {
        record(
          invalidRegistrationStatus(
            client,
            configuration.value,
            nativeApplicability.error.cause,
            commandFacts.identity,
          ),
        );
        continue;
      }
      const registrationEnvironment =
        client.name === "kimi" ||
        client.name === "codex" ||
        client.name === "lm_studio" ||
        client.name === "dsh"
          ? await clientRegistrationEnvironmentDetailsWithBudget(
              parsed,
              client,
              {},
              "effective",
              client.name === "lm_studio"
                ? undefined
                : options.resolveProviderRequestBudget,
              options.platform,
            )
          : undefined;
      if (
        registrationEnvironment !== undefined &&
        !registrationEnvironment.ok
      ) {
        record({
          client: client.name,
          config_path: configPath,
          ...(selectedScope === undefined ? {} : { scope: selectedScope }),
          command: [],
          command_identity: commandFacts.identity,
          state: "invalid",
          remediation: registrationEnvironment.error.message,
        });
        continue;
      }
      const packageReference = commandFacts.package?.reference;
      const activation = clientRegistrationActivation(
        registration,
        client,
        parsed,
      );
      const packageVersion = commandFacts.package?.exactVersion;
      const packageVersionDrift =
        packageVersion !== undefined &&
        packageVersion !== PRODUCT_IDENTITY.packageVersion;
      // Only a target whose setup preserves the flag is a manual conflict; a
      // native row (for example ZCode's own storage) is repaired by setup.
      const sharedDisabledConflict =
        activation === "disabled" &&
        registration.enable === false &&
        setupPreservesDisabledActivation(
          effectiveClient,
          effectiveClient.format,
        );
      const alignment = !nativeApplicability.ok
        ? "unknown"
        : registrationAligned({
            registration,
            client: effectiveClient,
            commandFacts,
          });
      const observeProbeSetting = hasProjectRegistrationContribution(
        configuration.value,
      )
        ? undefined
        : options.observeProbeSetting;
      const status = configuredStatus({
        client: effectiveClient,
        command,
        commandIdentity: commandFacts.identity,
        state:
          alignment === "unknown"
            ? "unknown"
            : activation === "enabled" &&
                !packageVersionDrift &&
                alignment === "aligned" &&
                transientPaths.length === 0 &&
                (parsed.dialect !== "dsh" ||
                  dshDocument(parsed.document).ready) &&
                policyBlock === undefined
              ? "aligned"
              : "stale",
        policyRemediation:
          (nativeApplicability.ok
            ? await missingTransientLauncherRemediation(
                transientPaths,
                commandFacts.identity,
                effectiveClient,
              )
            : undefined) ??
          (parsed.dialect !== "dsh" && commandFacts.identity !== "owned"
            ? clientRegistrationOwnershipRemediation(commandFacts.identity, [
                launcherPath,
                ...inlineRegistrationOrigins(client),
              ])
            : undefined) ??
          (!nativeApplicability.ok
            ? nativeApplicability.error.cause.message
            : undefined) ??
          policyBlock ??
          (packageReference !== undefined &&
          (packageVersionDrift || launcherRegistrationScope === "project")
            ? packageLauncherRemediation(
                packageReference,
                client,
                launcherPath,
                launcherRegistrationScope,
                packageVersionDrift,
              )
            : alignment === "unknown"
              ? unknownEntryPointRemediation()
              : undefined) ??
          (sharedDisabledConflict
            ? sharedDisabledActivationRemediation()
            : undefined) ??
          (transientPaths.length > 0 && commandFacts.identity === "owned"
            ? `The saved launcher uses a session path (${transientPaths.join(", ")}). ${remediation(effectiveClient, launcherPath, launcherRegistrationScope)}`
            : undefined),
        packageReference,
        advisory:
          registrationEnvironment?.ok === true
            ? timeoutAdvisory(
                client,
                registration,
                registrationEnvironment.value.timeoutInputs,
              )
            : undefined,
        configuration: configuration.value,
        alignmentStale: alignment === "stale",
        providerSettings:
          options.providerSettings === undefined
            ? undefined
            : recordedProviderSettings(
                parsed,
                client,
                options.providerSettings,
                options.platform,
                options.ownedProviderSetting,
                observeProbeSetting === undefined
                  ? undefined
                  : (name, value) =>
                      observeProbeSetting(client.name, name, value),
              ),
        activation,
      });
      record(
        sharedDisabledConflict && status.state !== "aligned"
          ? { ...status, manual_conflict: "shared_disabled_activation" }
          : status,
        activation,
      );
    } catch (cause: unknown) {
      if (
        options.resources === undefined &&
        cause instanceof RegularFileCleanupFailure
      )
        throw cause;
      record(
        unavailableStatus(
          client,
          isMissing(cause) ? "missing" : "invalid",
          selectedConfigPath,
          selectedScope,
        ),
      );
    }
  }
  return inspections.sort((left, right) =>
    compareUnicodeCodePoints(left.status.client, right.status.client),
  );
};

/** A disable that setup preserves is a manual conflict: its remediation
 * must not point at an ineffective setup run. */
const sharedDisabledActivationRemediation = (): string =>
  "This shared registration row carries enable: false, which binds every reader of the shared storage, including ZCode's fallback view. REA preserves that flag, so rea setup will not change this row. Re-enable it with the product that disabled it, or remove enable: false manually, then rerun rea doctor.";
const registrationAligned = ({
  registration,
  client,
  commandFacts,
}: {
  readonly registration: ClientRegistration;
  readonly client: SetupClient;
  readonly commandFacts: ClientRegistrationCommandFacts;
}): "aligned" | "stale" | "unknown" => {
  const { identity } = commandFacts;
  if (identity === "unknown") return "unknown";
  if (identity === "foreign") return "stale";
  if (
    client.name === "grok_build" &&
    registration.startup_timeout_sec === undefined
  )
    return "stale";
  if (
    client.name === "codex" &&
    (registration.startup_timeout_sec === undefined ||
      registration.tool_timeout_sec === undefined)
  )
    return "stale";
  if (
    client.name === "kimi" &&
    (registration.startupTimeoutMs === undefined ||
      registration.toolTimeoutMs === undefined)
  )
    return "stale";
  // Native transport is admitted separately; the Harness route must name REA.
  if (client.format === "dsh" && registration.serverName !== "rea")
    return "stale";
  // Setup repairs missing or malformed literals. Doctor reports the unknown
  // value of a caller-owned expression as an advisory.
  if (client.format === "dsh" && registration.toolCallTimeoutMs === undefined)
    return "stale";
  // Legacy package runners remain owned, but setup migrates them to the selected installation.
  if (commandFacts.package !== undefined) return "stale";
  // Owning the script does not establish how its shebang interpreter resolves
  // in the client. Setup migrates these launchers without losing ownership.
  return commandFacts.launch === "runtime_script" ? "aligned" : "stale";
};

/** A client that rewrites its file from memory must be quit before setup. */
const remediation = (
  client: SetupClient,
  configPath?: string,
  scope?: ClientRegistrationScope,
): string => {
  if (scope === "project") {
    const target = configPath ?? client.configPath;
    return `REA setup writes only user-level client configuration and does not modify project-scoped configuration at ${target}. Update or remove the rea registration in ${target}, then restart the client.`;
  }
  const inline = inlineRegistrationRemediation(client);
  if (client.quitBeforeSetup !== true)
    return `Run rea setup to refresh this registration, then restart the client.${inline}`;
  const name = client.displayName ?? client.name;
  return `Quit ${name} fully, run rea setup to refresh this registration, then start ${name} again. A running ${name} can rewrite its configuration from memory and drop the registration.${inline}`;
};

/** Setup cannot repair what a read-only inline layer sets for REA's entry. */
const inlineRegistrationRemediation = (client: SetupClient): string => {
  const origins = inlineRegistrationOrigins(client);
  const name = PRODUCT_IDENTITY.mcpServerKey;
  return origins.length === 0
    ? ""
    : ` ${origins.join(", ")} also sets the ${name} entry and overrides the client's files; REA does not edit it, so change or remove ${name} there if setup reports that it overrides the registration.`;
};

const unknownEntryPointRemediation = (): string =>
  "The existing registration was retained because its executable identity cannot be verified. Check the registered launcher path, symlink targets and access permissions. Run the installed REA CLI or a supported package runner, then rerun rea doctor; no registration was changed.";

const invalidRegistrationStatus = (
  client: SetupClient,
  configuration: EffectiveClientRegistrationConfiguration,
  error: ConfigurationError,
  commandIdentity: ClientRegistrationCommandIdentity,
): ClientRegistrationStatus => {
  const source = contributingRegistrationSource(configuration, error);
  const path = source?.sourcePath ?? configuration.configPath;
  const scope = source === undefined ? configuration.scope : source.scope;
  const constraints = error.settings
    .map(({ setting, constraint }) => `${setting}: ${constraint}`)
    .join("; ");
  const detail =
    constraints === "" ? error.message : `${error.message}: ${constraints}`;
  return {
    client: client.name,
    config_path: path,
    ...(scope === "project" ? { scope } : {}),
    command: [],
    command_identity: commandIdentity,
    state: "invalid",
    remediation:
      scope === "project"
        ? `${detail}. ${remediation(client, path, scope)}`
        : detail,
  };
};

const missingTransientLauncherRemediation = async (
  paths: readonly string[],
  identity: ClientRegistrationCommandIdentity,
  client: SetupClient,
): Promise<string | undefined> => {
  if (identity !== "unknown") return undefined;
  for (const path of paths) {
    try {
      await stat(path);
    } catch (cause) {
      if (isMissing(cause)) {
        const detail = `The saved session launcher path ${path} is missing.`;
        return client.format === "dsh"
          ? `${detail} Run rea setup --client dsh to review and refresh the installed REA registration, then restart the client.`
          : `${detail} Launcher ownership is unknown. Back up the client configuration and replace that path with the verified installed interpreter or REA script, then rerun rea doctor and restart the client.`;
      }
    }
  }
  return undefined;
};

const configuredStatus = (input: {
  readonly client: SetupClient;
  readonly command: RegistrationCommand;
  readonly commandIdentity: ClientRegistrationCommandIdentity;
  readonly state: "aligned" | "stale" | "unknown";
  readonly policyRemediation: string | undefined;
  readonly packageReference: string | undefined;
  readonly advisory: string | undefined;
  readonly configuration: EffectiveClientRegistrationConfiguration;
  readonly alignmentStale: boolean;
  readonly providerSettings: RecordedProviderSettings | undefined;
  readonly activation: "enabled" | "disabled";
}): ClientRegistrationStatus => {
  const {
    client,
    command,
    commandIdentity,
    state,
    policyRemediation,
    packageReference,
    advisory,
    configuration,
    alignmentStale,
    providerSettings,
    activation,
  } = input;
  const {
    configPath,
    scope,
    launcherScope,
    launcherConfigPath,
    activationScope,
    activationConfigPath,
  } = configuration;
  const base = {
    client: client.name,
    config_path: configPath,
    ...(scope === undefined ? {} : { scope }),
    ...(scope === "project" && launcherScope === "user"
      ? { launcher_scope: "user" as const }
      : {}),
    command,
    command_identity: commandIdentity,
    ...(packageReference === undefined
      ? {}
      : { package_reference: packageReference }),
    ...(providerSettings === undefined
      ? {}
      : { provider_settings: providerSettings }),
  };
  if (state === "aligned")
    return {
      ...base,
      state,
      remediation: null,
      ...(advisory === undefined ? {} : { advisory }),
    };
  const launcherRepair =
    policyRemediation ??
    (alignmentStale
      ? remediation(
          client,
          launcherConfigPath ?? configPath,
          launcherScope ?? scope,
        )
      : undefined);
  const activationRepair =
    activation === "disabled" &&
    (scope === "project" ||
      launcherScope === "project" ||
      activationScope === "project")
      ? remediation(
          client,
          activationConfigPath ?? configPath,
          activationScope ?? scope,
        )
      : undefined;
  const repairs = [
    ...new Set(
      [launcherRepair, activationRepair].filter(
        (message): message is string => message !== undefined,
      ),
    ),
  ];
  return {
    ...base,
    state,
    remediation:
      repairs.length > 0
        ? repairs.join(" ")
        : remediation(client, configPath, scope),
  };
};

const timeoutAdvisory = (
  client: SetupClient,
  registration: ClientRegistration,
  timeoutInputs: McpToolTimeoutInputs,
): string | undefined => {
  const toolTimeout =
    client.name === "kimi"
      ? registration.toolTimeoutMs
      : client.name === "codex"
        ? registration.tool_timeout_sec
        : client.name === "dsh"
          ? registration.toolCallTimeoutMs
          : undefined;
  if (toolTimeout === undefined) return undefined;
  if (client.name === "dsh" && toolTimeout === null)
    return "The effective timeout is unknown because toolCallTimeoutMs is a caller-owned Cordis expression.";
  const providerAllowance = mcpProviderDeadlineAllowanceMs(timeoutInputs);
  const inMilliseconds = client.name === "kimi" || client.name === "dsh";
  // A bigint is beyond the safe Number range, so rounding cannot cross the allowance.
  const toolTimeoutMs = Number(toolTimeout) * (inMilliseconds ? 1 : 1000);
  const batchScope =
    timeoutInputs.ghidraDecompileTimeoutMs !== undefined &&
    (timeoutInputs.analysisProvider === "ghidra" ||
      timeoutInputs.analysisProvider === "auto")
      ? "The derived Ghidra deadline is a single-decompile estimate. For multi-function workflows such as batch_decompile, decompile_all or trace_native_values, allow startup plus every attempted function's limit and other work; split calls, reduce trace_native_values max_functions, or select a larger client deadline when needed. Explicit caller deadlines remain unchanged."
      : undefined;
  if (toolTimeoutMs >= providerAllowance) return batchScope;
  const setting =
    client.name === "kimi"
      ? "toolTimeoutMs"
      : client.name === "dsh"
        ? "toolCallTimeoutMs"
        : "tool_timeout_sec";
  const currentValue = inMilliseconds
    ? `${String(toolTimeout)} ms`
    : `${String(toolTimeout)} seconds`;
  const recommendedValue = inMilliseconds
    ? `${String(recommendedMcpToolTimeoutMs(timeoutInputs))} ms`
    : `${String(recommendedMcpToolTimeoutSeconds(timeoutInputs))} seconds`;
  const headroom = inMilliseconds
    ? `${String(MCP_STARTUP_POLICY.toolOperationHeadroomMs)} ms`
    : `${String(MCP_STARTUP_POLICY.toolOperationHeadroomMs / 1000)} seconds`;
  const recommendation = `The configured ${setting} (${currentValue}) is shorter than REA's known provider allowance (${String(providerAllowance)} ms), so provider startup or an upstream request may exceed this client deadline. REA recommends ${setting} = ${recommendedValue} to cover that allowance plus ${headroom} of operation headroom; this additional headroom is a recommendation, not a guarantee for every analysis.`;
  return batchScope === undefined
    ? recommendation
    : `${recommendation} ${batchScope}`;
};

const packageLauncherRemediation = (
  packageReference: string,
  client: SetupClient,
  launcherTarget: string,
  scope: ClientRegistrationScope | undefined,
  versionDrift: boolean,
): string => {
  const packageDetail = versionDrift
    ? `requests ${packageReference}, while the current REA CLI package is ${PRODUCT_IDENTITY.packageVersion}`
    : `uses the package runner ${packageReference}`;
  return scope === "project"
    ? `This project-scoped registration in ${launcherTarget} ${packageDetail}. Replace the launcher in ${launcherTarget} with the installed JavaScript runtime and REA entry script, or remove the project override and run rea setup --client ${client.name} to configure REA at user scope. Restart the client after making the change.`
    : `This registration ${packageDetail}. REA does not resolve package-runner requests during doctor; update the registration with rea setup --client ${client.name}, then restart the client.`;
};

const unavailableStatus = (
  client: SetupClient,
  state: "missing" | "invalid",
  configPath: string = client.configPath,
  scope?: ClientRegistrationScope,
): ClientRegistrationStatus => ({
  client: client.name,
  config_path: configPath,
  ...(scope === undefined ? {} : { scope }),
  command: [],
  command_identity: "unknown",
  state,
  remediation: remediation(client, configPath, scope),
});

/** Product discovery follows targets; configuration evidence retains entry presence. */
const clientEvidencePresent = async (
  client: SetupClient,
  evidence: {
    readonly selected: boolean;
    readonly ownership: boolean;
    readonly projectDirectory: string | undefined;
    readonly platform: NodeJS.Platform;
  },
): Promise<
  Result<boolean, { readonly path: string; readonly detail: string }>
> => {
  // An explicit selection authorises the read outright: the caller named this
  // client, so an unreadable config must surface as unreadable instead of
  // collapsing to absence. The probes below serve automatic discovery only.
  if (evidence.selected) return ok(true);
  // A read-only inline layer (KILO_CONFIG_CONTENT) that sets REA's entry is
  // parsed evidence on its own, even when none of the client's folders exist.
  if (inlineRegistrationOrigins(client).length > 0) return ok(true);
  const discoveryPaths = new Set(client.discoveryPaths ?? []);
  const paths = [
    // Only the registration file can hold what REA wrote.
    ...(client.registrationApplicability === true
      ? [client.configPath, ...(client.configPaths ?? [])]
      : clientEvidencePaths(client)),
    ...(evidence.projectDirectory === undefined
      ? []
      : clientProjectConfigurationPaths(
          client,
          evidence.projectDirectory,
          evidence.platform,
        )),
    ...(evidence.ownership ? clientOwnershipEvidencePaths(client) : []),
  ];
  let unavailable:
    | { readonly path: string; readonly detail: string }
    | undefined;
  for (const path of paths) {
    try {
      await (discoveryPaths.has(path) ? stat(path) : lstat(path));
      return ok(true);
    } catch (cause: unknown) {
      if (!isAbsentClientConfigPath(cause))
        unavailable ??= {
          path,
          detail: `Client configuration evidence at ${path} could not be inspected: ${errorMessage(cause)}. Check file permissions and rerun rea doctor.`,
        };
    }
  }
  return unavailable === undefined ? ok(false) : err(unavailable);
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
