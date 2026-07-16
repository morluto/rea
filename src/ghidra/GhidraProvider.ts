import { fileURLToPath } from "node:url";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProfileResolutionOptions,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { AppConfig } from "../config.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  type AnalysisError,
  AnalysisTimeoutError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Logger } from "../logger.js";
import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
} from "../contracts/toolContracts.js";
import { GhidraClient } from "./GhidraClient.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import {
  GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
  GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
  GHIDRA_MAX_LINE_BYTES,
  GHIDRA_REQUEST_TIMEOUT_MS,
  GHIDRA_STARTUP_TIMEOUT_MS,
} from "./GhidraDefaults.js";
import {
  GHIDRA_FUNCTION_OPERATIONS,
  isGhidraFunctionOperation,
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "./GhidraFunctionValues.js";
import {
  GHIDRA_INVENTORY_OPERATIONS,
  isGhidraInventoryOperation,
  parseGhidraInventoryInput,
  parseGhidraInventoryResult,
} from "./GhidraInventoryValues.js";
import {
  ghidraInstallationDiagnostics,
  inspectGhidraInstallation,
  type GhidraInstallationHost,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { resolveGhidraAnalysisProfile } from "./GhidraAnalysisProfile.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";

/** Public identity committed by every Ghidra-backed observation. */
export const GHIDRA_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({
  id: "ghidra",
  name: "Ghidra",
  version: null,
});

const providerContractByName = new Map(
  [...OFFICIAL_TOOL_CONTRACTS, ...ENHANCED_TOOL_CONTRACTS].map((contract) => [
    contract.name,
    contract,
  ]),
);

/** Provider-neutral read-only contracts implemented by the Ghidra adapter. */
export const GHIDRA_PROVIDER_TOOL_CONTRACTS = Object.freeze(
  [...GHIDRA_INVENTORY_OPERATIONS, ...GHIDRA_FUNCTION_OPERATIONS].map(
    (operation) => {
      const contract = providerContractByName.get(operation);
      if (contract === undefined)
        throw new TypeError(
          `Missing provider-neutral contract for ${operation}`,
        );
      return contract;
    },
  ),
);

const PAGINATED_OPERATIONS: ReadonlySet<string> = new Set([
  "list_names",
  "list_procedures",
  "list_strings",
  "search_procedures",
  "search_strings",
  "procedure_references",
  "analyze_function",
]);
const SEARCH_OPERATIONS: ReadonlySet<string> = new Set([
  "search_procedures",
  "search_strings",
]);
const DECOMPILE_OPERATIONS: ReadonlySet<string> = new Set([
  "procedure_pseudo_code",
  "analyze_function",
]);
const healthLimitations = Object.freeze([
  "The session serves operations only after default Ghidra auto-analysis completes; an analysis timeout fails the open instead of exposing partial results.",
  "The imported Program and temporary project are ephemeral, read-only to REA, and deleted on close.",
]);

const limitationsFor = (operation: string): readonly string[] => {
  const common = [
    ...healthLimitations,
    "Default-space addresses use lowercase 0x-prefixed hexadecimal; other address spaces use <percent-encoded-space>:0x<hex>.",
  ];
  switch (operation) {
    case "list_documents":
      return [
        ...common,
        "A headless Ghidra session contains exactly one imported Program, unlike Hopper's multi-document GUI session.",
      ];
    case "list_names":
      return [
        ...common,
        "The symbol inventory includes memory and external symbols, including dynamic symbols, but excludes variable and no-address namespace records.",
      ];
    case "list_procedures":
    case "procedure_address":
      return [
        ...common,
        "External functions and local thunks are distinct; procedure metadata identifies both and preserves a thunk target when Ghidra resolves one.",
      ];
    case "list_strings":
      return [
        ...common,
        "Only Ghidra-defined string Data is observed; charset is reported, while a non-missing terminator cannot distinguish a present terminator from a fixed or Pascal layout.",
        "Returned values are bounded to 1,024 Unicode code points and mark value_truncated instead of silently crossing the wire budget.",
      ];
    case "list_segments":
      return [
        ...common,
        "Memory-block end addresses are exclusive; permissions come from Ghidra MemoryBlock flags rather than inference from section names.",
      ];
    case "search_procedures":
    case "search_strings":
      return [
        ...common,
        "Literal search enforces 1,000,000 cumulative work units; regex mode also accepts only a conservative finite Java-regex subset with 10,000 static paths and 4,096 UTF-16 code units per candidate.",
      ];
    case "procedure_pseudo_code":
      return [
        ...common,
        "Pseudocode is Ghidra decompiler output, not original source and not text-equivalent to Hopper output; each decompile has a 30-second native deadline.",
        "External functions and functions without an analyzable body return null; other decompiler failures remain explicit.",
      ];
    case "procedure_assembly":
      return [
        ...common,
        "Assembly is Ghidra Listing text and fails rather than silently truncating when the 100,000-instruction or 1 MiB wire bound is exceeded.",
      ];
    case "procedure_callers":
    case "procedure_callees":
      return [
        ...common,
        "Only resolved Ghidra call references are returned; unresolved computed or indirect calls remain unknown, while function classifications distinguish thunks and externals.",
      ];
    case "xrefs":
      return [
        ...common,
        "The direct address list projects exact Ghidra references to one address but does not expose their kinds; procedure_references and analyze_function preserve available kind metadata.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
      ];
    case "procedure_references":
      return [
        ...common,
        "Reference kinds are direct Ghidra ReferenceManager observations; unresolved computed flows without a target are absent and remain unknown.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
        "Instruction scans stop at max_instructions; a truncated scan reports an unknown total and no false continuation.",
      ];
    case "analyze_function":
      return [
        ...common,
        "The dossier combines Ghidra FunctionManager, Listing, ReferenceManager, BasicBlockModel, and decompiler observations; provider-specific pseudocode and assembly are not cross-provider text invariants.",
        "Resolved reference metadata identifies computed, indirect, external, call, jump, and data edges; unresolved targetless flows remain unknown, and function classifications distinguish thunks and externals.",
        "Synthetic Ghidra entry-point references without actionable memory sources are omitted.",
        "The Java bridge serializes one function request per Program through a bounded 32-request queue and applies a 30-second native decompilation deadline.",
      ];
    default:
      return common;
  }
};
const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  GHIDRA_PROVIDER_TOOL_CONTRACTS.map((contract) =>
    Object.freeze({
      provider: GHIDRA_PROVIDER_IDENTITY,
      operation: contract.name,
      inputContractVersion: 1,
      outputContractVersion: 1,
      available: true,
      reason: null,
      pagination: PAGINATED_OPERATIONS.has(contract.name)
        ? ("offset" as const)
        : ("none" as const),
      exhaustive: !PAGINATED_OPERATIONS.has(contract.name),
      effects: Object.freeze({
        mutatesArtifact: false,
        launchesProcess: true,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limits: Object.freeze({
        maxResults: PAGINATED_OPERATIONS.has(contract.name)
          ? SEARCH_OPERATIONS.has(contract.name)
            ? 100
            : 500
          : null,
        maxPayloadBytes: GHIDRA_MAX_LINE_BYTES,
        timeoutMs: DECOMPILE_OPERATIONS.has(contract.name)
          ? GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS
          : GHIDRA_REQUEST_TIMEOUT_MS,
      }),
      limitations: Object.freeze(limitationsFor(contract.name)),
    }),
  ),
);

const SUPPORTED_ARCHITECTURES = new Set(["x86", "x86_64", "arm", "arm64"]);
const SUPPORTED_FORMATS = new Set(["elf", "pe", "mach-o"]);

/** Production seam for exercising provider projection without a real process. */
export type GhidraProviderClientFactory = (
  options: GhidraClientOptions,
) => Pick<GhidraClient, "start" | "callTool" | "close">;

/** Linux Ghidra candidate backed by an isolated read-only headless import. */
export class GhidraProvider implements AnalysisProviderCandidate {
  #installation: GhidraInstallationInspection | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly installationHost?: GhidraInstallationHost,
    private readonly clientFactory: GhidraProviderClientFactory = (options) =>
      new GhidraClient(options),
  ) {}

  identity(): ProviderIdentity {
    return GHIDRA_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return CAPABILITIES;
  }

  inspectAvailability(): ProviderAvailability {
    const installation = this.#inspectInstallation();
    const diagnostics = ghidraInstallationDiagnostics(installation);
    return installation.available
      ? {
          status: "available",
          code: null,
          reason: null,
          diagnostics,
        }
      : {
          status: "unavailable",
          code: installation.rejectionCode ?? "not_configured",
          reason:
            installation.reason ?? "Ghidra installation is not available.",
          diagnostics,
        };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Ghidra v1 imports executable targets, not ${target.kind} targets.`,
        diagnostics,
      };
    if (!SUPPORTED_FORMATS.has(target.format))
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Ghidra v1 does not import ${target.format} through this adapter.`,
        diagnostics,
      };
    if (
      target.architecture === undefined ||
      !SUPPORTED_ARCHITECTURES.has(target.architecture)
    )
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason:
          "Ghidra v1 requires a concrete x86, x86_64, arm, or arm64 target architecture.",
        diagnostics,
      };
    return {
      status: "supported",
      code: null,
      reason: null,
      diagnostics,
    };
  }

  resolveAnalysisProfile(
    target: BinaryTarget,
    options?: AnalysisProfileResolutionOptions,
  ) {
    return resolveGhidraAnalysisProfile(
      target,
      GHIDRA_PROVIDER_IDENTITY,
      this.#inspectInstallation(),
      options?.signal,
    );
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
  ): AnalysisClient {
    const installation = this.#inspectInstallation();
    const prerequisites = ghidraClientPrerequisites(
      target,
      profile,
      installation,
    );
    if (!prerequisites.ok) return unavailableClient(prerequisites.error);
    const committedProfile = prerequisites.value.profile;
    const client = this.clientFactory({
      launcher: new GhidraHeadlessLauncher({
        analyzeHeadlessPath: prerequisites.value.analyzeHeadlessPath,
        ...(this.config.ghidraJavaHome === undefined
          ? {}
          : { javaHome: this.config.ghidraJavaHome }),
        bridgeScriptPath: fileURLToPath(
          new URL("../../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
        ),
      }),
      targetPath: target.path,
      providerVersion: prerequisites.value.providerVersion,
      profileDigest: committedProfile.digest,
      logger: this.logger.child({ layer: "ghidra-bridge" }),
    });
    return {
      execute: async (operation, parameters, options) => {
        if (
          operation !== "health" &&
          !isGhidraInventoryOperation(operation) &&
          !isGhidraFunctionOperation(operation)
        )
          return err(
            new AnalysisCapabilityUnavailableError(
              GHIDRA_PROVIDER_IDENTITY.id,
              operation,
              "The Ghidra adapter does not declare this operation.",
            ),
          );
        if (operation === "health") {
          const started = await client.start(options?.signal);
          if (!started.ok)
            return err(projectSessionError(operation, started.error));
          return ok(
            createAnalysisExecution(started.value, committedProfile.provider, {
              analysisProfile: committedProfile,
              limitations: healthLimitations,
            }),
          );
        }
        const input = isGhidraFunctionOperation(operation)
          ? parseGhidraFunctionInput(operation, parameters)
          : parseGhidraInventoryInput(operation, parameters);
        if (!input.ok) return input;
        const called = await client.callTool(operation, input.value, {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(DECOMPILE_OPERATIONS.has(operation)
            ? { timeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS }
            : {}),
        });
        if (!called.ok)
          return err(projectSessionError(operation, called.error));
        const result = isGhidraFunctionOperation(operation)
          ? parseGhidraFunctionResult(operation, called.value)
          : parseGhidraInventoryResult(operation, called.value);
        if (!result.ok) return result;
        return ok(
          createAnalysisExecution(result.value, committedProfile.provider, {
            rawResult: called.value,
            analysisProfile: committedProfile,
            limitations: limitationsFor(operation),
          }),
        );
      },
      close: () => client.close(),
    };
  }

  #inspectInstallation(): GhidraInstallationInspection {
    const options = {
      ...(this.config.ghidraInstallDir === undefined
        ? {}
        : { installDir: this.config.ghidraInstallDir }),
      ...(this.config.ghidraJavaHome === undefined
        ? {}
        : { javaHome: this.config.ghidraJavaHome }),
      ...(this.installationHost?.platform === undefined
        ? {}
        : { platform: this.installationHost.platform }),
      ...(this.installationHost?.architecture === undefined
        ? {}
        : { architecture: this.installationHost.architecture }),
    };
    this.#installation ??=
      this.installationHost === undefined
        ? inspectGhidraInstallation(options)
        : inspectGhidraInstallation(options, this.installationHost);
    return this.#installation;
  }
}

interface GhidraClientCoordinates {
  readonly analyzeHeadlessPath: string;
  readonly providerVersion: string;
  readonly profile: AnalysisProfileCommitment;
}

const ghidraClientPrerequisites = (
  target: BinaryTarget,
  profile: AnalysisProfileCommitment | undefined,
  installation: GhidraInstallationInspection,
): Result<GhidraClientCoordinates, AnalysisError> => {
  if (target.kind !== "executable")
    return err(
      new AnalysisCapabilityUnavailableError(
        "ghidra",
        "health",
        `Ghidra cannot import ${target.kind} targets through this adapter.`,
      ),
    );
  if (
    !installation.available ||
    installation.analyzeHeadlessPath === null ||
    installation.providerVersion === null
  )
    return err(
      new ProviderAdapterError("ghidra", "health", {
        diagnostics: ghidraInstallationDiagnostics(installation),
      }),
    );
  if (profile === undefined || profile.provider.id !== "ghidra")
    return err(new ProviderAdapterError("ghidra", "health"));
  return ok({
    analyzeHeadlessPath: installation.analyzeHeadlessPath,
    providerVersion: installation.providerVersion,
    profile,
  });
};

const unavailableClient = (failure: AnalysisError): AnalysisClient => ({
  execute: () => Promise.resolve(err(failure)),
  close: () => Promise.resolve(),
});

const projectSessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
): AnalysisError => {
  if (failure.kind === "cancelled")
    return new AnalysisCancelledError(operation);
  if (failure.kind === "timeout" || failure.kind === "analysis_timeout")
    return new AnalysisTimeoutError(
      operation,
      failure.timeoutMs ??
        (failure.kind === "analysis_timeout"
          ? GHIDRA_ANALYSIS_TIMEOUT_SECONDS * 1_000
          : GHIDRA_STARTUP_TIMEOUT_MS),
    );
  if (failure.kind === "remote" && failure.remoteCode === "decompile_timeout")
    return new AnalysisTimeoutError(
      operation,
      GHIDRA_DECOMPILE_TIMEOUT_SECONDS * 1_000,
    );
  if (failure.kind === "remote" && failure.remoteCode === "decompile_cancelled")
    return new AnalysisCancelledError(operation);
  if (
    failure.kind === "remote" &&
    ["invalid_request", "not_found", "ambiguous"].includes(
      failure.remoteCode ?? "",
    )
  )
    return new AnalysisInputError(operation, { cause: failure });
  if (failure.kind === "remote" && failure.remoteCode === "method_unavailable")
    return new AnalysisCapabilityUnavailableError(
      "ghidra",
      operation,
      failure.message,
    );
  return new ProviderAdapterError("ghidra", operation, {
    cause: failure,
    diagnostics: failure.diagnostics,
  });
};
