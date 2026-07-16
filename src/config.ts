import { z } from "zod";
import { isAbsolute } from "node:path";

import { ConfigurationError } from "./domain/errors.js";
import { err, ok, type Result } from "./domain/result.js";
import type { LogLevel } from "./logger.js";
import type { ProcessExecutionPolicy } from "./domain/processCapture.js";
import type { EvidenceFilePolicy } from "./domain/evidenceBundle.js";
import type { ReferenceSourcePolicy } from "./domain/referenceSourcePolicy.js";
import type {
  PermissionCeiling,
  PermissionGrant,
} from "./domain/permissionPolicy.js";
import {
  browserEndpointSchema,
  browserOriginSchema,
  isLiteralLoopbackHostname,
} from "./domain/browserObservation.js";
import { electronFileRootsSchema } from "./domain/electronObservation.js";
import {
  analysisProviderSelectorSchema,
  type AnalysisProviderSelector,
} from "./contracts/providerSelection.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const defaultHopperLauncherPath = (): string =>
  process.platform === "linux"
    ? "/opt/hopper/bin/Hopper"
    : DEFAULT_HOPPER_LAUNCHER_PATH;

export interface AppConfig {
  readonly analysisProvider: AnalysisProviderSelector;
  readonly ghidraInstallDir: string | undefined;
  readonly ghidraJavaHome: string | undefined;
  readonly hopperLauncherPath: string;
  readonly hopperTargetPath: string | undefined;
  readonly hopperTargetKind: "executable" | "database";
  readonly hopperLoaderArgs: readonly string[];
  readonly logLevel: LogLevel;
  readonly processExecutionPolicy: ProcessExecutionPolicy;
  readonly artifactNativeMountEnabled: boolean;
  readonly artifactIntegrityContinueEnabled: boolean;
  readonly evidenceFilePolicy: EvidenceFilePolicy;
  readonly investigationInputRoots: readonly string[];
  readonly analysisSnapshotFilePolicy: EvidenceFilePolicy;
  readonly referenceSourcePolicy: ReferenceSourcePolicy;
  readonly browserObservationEnabled: boolean;
  readonly browserCdpEndpoints: readonly string[];
  readonly browserAllowedOrigins: readonly string[];
  readonly electronObservationEnabled: boolean;
  readonly electronCdpEndpoints: readonly string[];
  readonly electronFileRoots: readonly string[];
  readonly javascriptReplayPolicy: {
    readonly enabled: boolean;
    readonly roots: readonly string[];
    readonly nodePath: string;
    readonly bubblewrapPath: string;
    readonly systemdRunPath: string;
    readonly systemctlPath: string;
    readonly shellPath: string;
  };
  readonly permissionCeilings: readonly PermissionCeiling[];
  readonly administratorPermissionGrants: readonly PermissionGrant[];
  readonly permissionProjectRoot: string | undefined;
  readonly permissionProjectStore: string | undefined;
}

const environmentSchema = z
  .object({
    REA_ANALYSIS_PROVIDER: analysisProviderSelectorSchema.default("auto"),
    GHIDRA_INSTALL_DIR: z
      .string()
      .min(1)
      .refine(isAbsolute, "GHIDRA_INSTALL_DIR must be absolute")
      .optional(),
    JAVA_HOME: z
      .string()
      .min(1)
      .refine(isAbsolute, "JAVA_HOME must be absolute")
      .optional(),
    HOPPER_LAUNCHER_PATH: z.string().min(1).optional(),
    HOPPER_TARGET_PATH: z.string().min(1).optional(),
    HOPPER_TARGET_KIND: z
      .enum(["executable", "database"])
      .default("executable"),
    HOPPER_LOADER_ARGS_JSON: z.string().optional(),
    REA_LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    REA_PROCESS_CAPTURE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_ARTIFACT_NATIVE_MOUNT_ENABLED: z
      .enum(["true", "false"])
      .default("false"),
    REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED: z
      .enum(["true", "false"])
      .default("false"),
    REA_PROCESS_ALLOW_EXTERNAL_NETWORK: z
      .enum(["true", "false"])
      .default("false"),
    REA_PROCESS_EXECUTABLE_ROOTS_JSON: z.string().default("[]"),
    REA_PROCESS_WORKING_ROOTS_JSON: z.string().default("[]"),
    REA_PROCESS_ALLOWED_ENV_JSON: z.string().default("[]"),
    REA_EVIDENCE_ROOTS_JSON: z.string().default("[]"),
    REA_INVESTIGATION_INPUT_ROOTS_JSON: z.string().default("[]"),
    REA_ANALYSIS_SNAPSHOT_ROOTS_JSON: z.string().default("[]"),
    REA_REFERENCE_ROOTS_JSON: z.string().default("[]"),
    REA_REFERENCE_SECRET_PATTERNS_JSON: z.string().default("[]"),
    REA_BROWSER_OBSERVE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_BROWSER_CDP_ENDPOINTS_JSON: z.string().default("[]"),
    REA_BROWSER_ALLOWED_ORIGINS_JSON: z.string().default("[]"),
    REA_ELECTRON_OBSERVE_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_ELECTRON_CDP_ENDPOINTS_JSON: z.string().default("[]"),
    REA_ELECTRON_FILE_ROOTS_JSON: z.string().default("[]"),
    REA_JAVASCRIPT_REPLAY_ENABLED: z.enum(["true", "false"]).default("false"),
    REA_JAVASCRIPT_REPLAY_ROOTS_JSON: z.string().default("[]"),
    REA_JAVASCRIPT_REPLAY_NODE_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_NODE_PATH must be absolute")
      .default(process.execPath),
    REA_JAVASCRIPT_REPLAY_BWRAP_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_BWRAP_PATH must be absolute")
      .default("/usr/bin/bwrap"),
    REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH: z
      .string()
      .min(1)
      .refine(
        isAbsolute,
        "REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH must be absolute",
      )
      .default("/usr/bin/systemd-run"),
    REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH: z
      .string()
      .min(1)
      .refine(
        isAbsolute,
        "REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH must be absolute",
      )
      .default("/usr/bin/systemctl"),
    REA_JAVASCRIPT_REPLAY_SHELL_PATH: z
      .string()
      .min(1)
      .refine(isAbsolute, "REA_JAVASCRIPT_REPLAY_SHELL_PATH must be absolute")
      .default("/usr/bin/bash"),
    REA_PERMISSION_PROJECT_ROOT: z.string().min(1).optional(),
    REA_PERMISSION_PROJECT_STORE: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      (value.REA_PERMISSION_PROJECT_ROOT === undefined) ===
      (value.REA_PERMISSION_PROJECT_STORE === undefined),
    {
      message:
        "REA_PERMISSION_PROJECT_ROOT and REA_PERMISSION_PROJECT_STORE must be configured together",
    },
  );

const parseStringArray = (
  encoded: string,
  name: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z
      .array(z.string().min(1))
      .max(128)
      .safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(
            parsed.error.issues.some(({ code }) => code === "too_big")
              ? `${name} must encode at most 128 strings`
              : `${name} must encode an array of strings`,
            { cause: parsed.error },
          ),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

const parseBrowserArray = (
  encoded: string,
  name: string,
  itemSchema: z.ZodType<string>,
  maximum: number,
): Result<readonly string[], ConfigurationError> => {
  try {
    const parsed = z
      .array(itemSchema)
      .max(maximum)
      .safeParse(JSON.parse(encoded));
    return parsed.success
      ? ok([...new Set(parsed.data)].sort())
      : err(
          new ConfigurationError(`${name} must encode valid browser scopes`, {
            cause: parsed.error,
          }),
        );
  } catch (cause: unknown) {
    return err(new ConfigurationError(`${name} must be valid JSON`, { cause }));
  }
};

const parseElectronFileRoots = (
  encoded: string,
): Result<readonly string[], ConfigurationError> => {
  try {
    const decoded: unknown = JSON.parse(encoded);
    if (Array.isArray(decoded) && decoded.length === 0) return ok([]);
    const parsed = electronFileRootsSchema.safeParse(decoded);
    return parsed.success
      ? ok(parsed.data)
      : err(
          new ConfigurationError(
            "REA_ELECTRON_FILE_ROOTS_JSON must encode absolute roots",
            { cause: parsed.error },
          ),
        );
  } catch (cause: unknown) {
    return err(
      new ConfigurationError(
        "REA_ELECTRON_FILE_ROOTS_JSON must be valid JSON",
        { cause },
      ),
    );
  }
};

const filePolicy = (roots: readonly string[]): EvidenceFilePolicy => ({
  roots,
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

const permissionScope = (
  capability: PermissionCeiling["capability"],
  roots: readonly string[],
  options: Partial<Omit<PermissionCeiling, "capability" | "roots">> = {},
): PermissionCeiling => ({
  capability,
  roots,
  executables: options.executables ?? [],
  environment_names: options.environment_names ?? [],
  ...(options.origins === undefined ? {} : { origins: options.origins }),
  network: options.network ?? "none",
  mount: options.mount ?? false,
});

const administratorGrants = (
  ceilings: readonly PermissionCeiling[],
): readonly PermissionGrant[] =>
  ceilings.map((ceiling) => ({
    ...ceiling,
    grant_id: `administrator:${ceiling.capability}`,
    lifetime: "administrator",
    operation_identity: null,
    expires_at: null,
  }));

const parseLoaderArgs = (
  encoded: string | undefined,
): Result<readonly string[], ConfigurationError> => {
  if (encoded === undefined) return ok([]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (cause: unknown) {
    return err(
      new ConfigurationError("HOPPER_LOADER_ARGS_JSON must be valid JSON", {
        cause,
      }),
    );
  }
  const parsed = z.array(z.string()).safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new ConfigurationError(
          "HOPPER_LOADER_ARGS_JSON must encode an array of strings",
          { cause: parsed.error },
        ),
      );
};

/**
 * Parse provider and authority configuration once at the composition root.
 * Explicit loader arguments override REA's header-derived defaults for a
 * supported target, allowing callers to refine Hopper's loader behavior without
 * bypassing REA's path and executable-header checks.
 */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsedEnvironment = environmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) {
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        cause: parsedEnvironment.error,
      }),
    );
  }
  const loaderArgs = parseLoaderArgs(
    parsedEnvironment.data.HOPPER_LOADER_ARGS_JSON,
  );
  if (!loaderArgs.ok) return loaderArgs;
  const executableRoots = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_EXECUTABLE_ROOTS_JSON,
    "REA_PROCESS_EXECUTABLE_ROOTS_JSON",
  );
  if (!executableRoots.ok) return executableRoots;
  const workingRoots = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_WORKING_ROOTS_JSON,
    "REA_PROCESS_WORKING_ROOTS_JSON",
  );
  if (!workingRoots.ok) return workingRoots;
  const allowedEnvironment = parseStringArray(
    parsedEnvironment.data.REA_PROCESS_ALLOWED_ENV_JSON,
    "REA_PROCESS_ALLOWED_ENV_JSON",
  );
  if (!allowedEnvironment.ok) return allowedEnvironment;
  const evidenceRoots = parseStringArray(
    parsedEnvironment.data.REA_EVIDENCE_ROOTS_JSON,
    "REA_EVIDENCE_ROOTS_JSON",
  );
  if (!evidenceRoots.ok) return evidenceRoots;
  const investigationInputRoots = parseStringArray(
    parsedEnvironment.data.REA_INVESTIGATION_INPUT_ROOTS_JSON,
    "REA_INVESTIGATION_INPUT_ROOTS_JSON",
  );
  if (!investigationInputRoots.ok) return investigationInputRoots;
  const analysisSnapshotRoots = parseStringArray(
    parsedEnvironment.data.REA_ANALYSIS_SNAPSHOT_ROOTS_JSON,
    "REA_ANALYSIS_SNAPSHOT_ROOTS_JSON",
  );
  if (!analysisSnapshotRoots.ok) return analysisSnapshotRoots;
  const referenceRoots = parseStringArray(
    parsedEnvironment.data.REA_REFERENCE_ROOTS_JSON,
    "REA_REFERENCE_ROOTS_JSON",
  );
  if (!referenceRoots.ok) return referenceRoots;
  const secretPatterns = parseStringArray(
    parsedEnvironment.data.REA_REFERENCE_SECRET_PATTERNS_JSON,
    "REA_REFERENCE_SECRET_PATTERNS_JSON",
  );
  if (!secretPatterns.ok) return secretPatterns;
  const browserEndpoints = parseBrowserArray(
    parsedEnvironment.data.REA_BROWSER_CDP_ENDPOINTS_JSON,
    "REA_BROWSER_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!browserEndpoints.ok) return browserEndpoints;
  const browserOrigins = parseBrowserArray(
    parsedEnvironment.data.REA_BROWSER_ALLOWED_ORIGINS_JSON,
    "REA_BROWSER_ALLOWED_ORIGINS_JSON",
    browserOriginSchema,
    32,
  );
  if (!browserOrigins.ok) return browserOrigins;
  const electronEndpoints = parseBrowserArray(
    parsedEnvironment.data.REA_ELECTRON_CDP_ENDPOINTS_JSON,
    "REA_ELECTRON_CDP_ENDPOINTS_JSON",
    browserEndpointSchema,
    16,
  );
  if (!electronEndpoints.ok) return electronEndpoints;
  const electronFileRoots = parseElectronFileRoots(
    parsedEnvironment.data.REA_ELECTRON_FILE_ROOTS_JSON,
  );
  if (!electronFileRoots.ok) return electronFileRoots;
  const javascriptReplayRoots = parseStringArray(
    parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_ROOTS_JSON,
    "REA_JAVASCRIPT_REPLAY_ROOTS_JSON",
  );
  if (!javascriptReplayRoots.ok) return javascriptReplayRoots;
  if (javascriptReplayRoots.value.some((root) => !isAbsolute(root)))
    return err(
      new ConfigurationError(
        "REA_JAVASCRIPT_REPLAY_ROOTS_JSON must encode absolute roots",
      ),
    );
  const permissionCeilings = [
    ...(parsedEnvironment.data.REA_PROCESS_CAPTURE_ENABLED === "true"
      ? [
          permissionScope("process_capture", workingRoots.value, {
            executables: executableRoots.value,
            environment_names: allowedEnvironment.value,
            network:
              parsedEnvironment.data.REA_PROCESS_ALLOW_EXTERNAL_NETWORK ===
              "true"
                ? "external"
                : "none",
          }),
        ]
      : []),
    permissionScope("evidence_read", evidenceRoots.value),
    permissionScope("evidence_write", evidenceRoots.value),
    permissionScope("investigation_input", investigationInputRoots.value),
    permissionScope("investigation_workspace_read", evidenceRoots.value),
    permissionScope("investigation_workspace_write", evidenceRoots.value),
    permissionScope("snapshot_read", analysisSnapshotRoots.value),
    permissionScope("snapshot_write", analysisSnapshotRoots.value),
    permissionScope("artifact_extract", ["/"]),
    permissionScope("reference_read", referenceRoots.value),
    ...(parsedEnvironment.data.REA_BROWSER_OBSERVE_ENABLED === "true"
      ? [
          permissionScope("browser_observe", [], {
            origins: [...browserEndpoints.value, ...browserOrigins.value],
            network: browserNetworkScope(browserOrigins.value),
          }),
        ]
      : []),
    ...(parsedEnvironment.data.REA_ELECTRON_OBSERVE_ENABLED === "true"
      ? [
          permissionScope("electron_observe", electronFileRoots.value, {
            origins: electronEndpoints.value,
            network: "loopback",
          }),
        ]
      : []),
    ...(parsedEnvironment.data.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true"
      ? [permissionScope("native_mount", [], { mount: true })]
      : []),
    ...(parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_ENABLED === "true"
      ? [
          permissionScope("javascript_replay", javascriptReplayRoots.value, {
            executables: [
              parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_NODE_PATH,
              parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
              parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
              parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
              parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
            ],
            network: "none",
            mount: true,
          }),
        ]
      : []),
  ] satisfies readonly PermissionCeiling[];
  return ok({
    analysisProvider: parsedEnvironment.data.REA_ANALYSIS_PROVIDER,
    ghidraInstallDir: parsedEnvironment.data.GHIDRA_INSTALL_DIR,
    ghidraJavaHome: parsedEnvironment.data.JAVA_HOME,
    hopperLauncherPath:
      parsedEnvironment.data.HOPPER_LAUNCHER_PATH ??
      defaultHopperLauncherPath(),
    hopperTargetPath: parsedEnvironment.data.HOPPER_TARGET_PATH,
    hopperTargetKind: parsedEnvironment.data.HOPPER_TARGET_KIND,
    hopperLoaderArgs: loaderArgs.value,
    logLevel: parsedEnvironment.data.REA_LOG_LEVEL,
    processExecutionPolicy: {
      enabled: parsedEnvironment.data.REA_PROCESS_CAPTURE_ENABLED === "true",
      executableRoots: executableRoots.value,
      workingRoots: workingRoots.value,
      allowedEnvironment: allowedEnvironment.value,
      allowExternalNetwork:
        parsedEnvironment.data.REA_PROCESS_ALLOW_EXTERNAL_NETWORK === "true",
    },
    artifactNativeMountEnabled:
      parsedEnvironment.data.REA_ARTIFACT_NATIVE_MOUNT_ENABLED === "true",
    artifactIntegrityContinueEnabled:
      parsedEnvironment.data.REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED === "true",
    evidenceFilePolicy: filePolicy(evidenceRoots.value),
    investigationInputRoots: investigationInputRoots.value,
    analysisSnapshotFilePolicy: filePolicy(analysisSnapshotRoots.value),
    referenceSourcePolicy: {
      roots: referenceRoots.value,
      secretPatterns: secretPatterns.value,
      maxBytes: 16 * 1024 * 1024,
      maxEntries: 10_000,
      maxDepth: 32,
      maxPathBytes: 4_096,
    },
    browserObservationEnabled:
      parsedEnvironment.data.REA_BROWSER_OBSERVE_ENABLED === "true",
    browserCdpEndpoints: browserEndpoints.value,
    browserAllowedOrigins: browserOrigins.value,
    electronObservationEnabled:
      parsedEnvironment.data.REA_ELECTRON_OBSERVE_ENABLED === "true",
    electronCdpEndpoints: electronEndpoints.value,
    electronFileRoots: electronFileRoots.value,
    javascriptReplayPolicy: {
      enabled: parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_ENABLED === "true",
      roots: javascriptReplayRoots.value,
      nodePath: parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_NODE_PATH,
      bubblewrapPath: parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_BWRAP_PATH,
      systemdRunPath:
        parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SYSTEMD_RUN_PATH,
      systemctlPath:
        parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SYSTEMCTL_PATH,
      shellPath: parsedEnvironment.data.REA_JAVASCRIPT_REPLAY_SHELL_PATH,
    },
    permissionCeilings,
    administratorPermissionGrants: administratorGrants(permissionCeilings),
    permissionProjectRoot: parsedEnvironment.data.REA_PERMISSION_PROJECT_ROOT,
    permissionProjectStore: parsedEnvironment.data.REA_PERMISSION_PROJECT_STORE,
  });
};

const browserNetworkScope = (
  origins: readonly string[],
): "loopback" | "external" =>
  origins.every((origin) => {
    const hostname = new URL(origin).hostname;
    return isLiteralLoopbackHostname(hostname);
  })
    ? "loopback"
    : "external";
