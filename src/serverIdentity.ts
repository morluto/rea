import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { createCatalogIdentity } from "./catalogIdentity.js";
import { absoluteCallerPath } from "./filesystem/callerPath.js";
import {
  compareExistingFileIdentities,
  hasExistingFileIdentity,
  hasParentPathSegment,
  inspectFileIdentity,
  isMissingFileError,
  resolveFileIdentityHost,
  type FileIdentityComparison,
  type FileIdentityHost,
  type FileIdentitySnapshot,
  type ResolvedFileIdentityHost,
} from "./filesystem/fileIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "./identity.js";

const compareServerPaths = (
  expectedPath: string,
  serverPath: string,
  commandIdentity: FileIdentitySnapshot | undefined,
  host: ResolvedFileIdentityHost,
): FileIdentityComparison => {
  if (commandIdentity !== undefined) {
    if (!hasExistingFileIdentity(commandIdentity, host)) return "unknown";
    const expected = inspectFileIdentity(expectedPath, host);
    const existing = compareExistingFileIdentities(
      expected,
      commandIdentity,
      host,
    );
    if (existing !== undefined) return existing;
    if (!isMissingFileError(expected.statError)) return "unknown";
    if (expected.isSymbolicLink) return "unknown";
    if (host.platform !== "win32" && hasParentPathSegment(expectedPath))
      return "unknown";
    return "different";
  }

  if (expectedPath === serverPath) return "same";
  const expected = inspectFileIdentity(expectedPath, host);
  const observed = inspectFileIdentity(serverPath, host);
  const existing = compareExistingFileIdentities(expected, observed, host);
  if (existing !== undefined) return existing;
  if (
    !isMissingFileError(expected.statError) ||
    !isMissingFileError(observed.statError)
  )
    return "unknown";
  if (expected.isSymbolicLink || observed.isSymbolicLink) return "unknown";
  if (
    absoluteCallerPath(expectedPath, { platform: host.platform }) ===
    absoluteCallerPath(serverPath, { platform: host.platform })
  )
    return "same";
  if (
    host.platform !== "win32" &&
    (hasParentPathSegment(expectedPath) || hasParentPathSegment(serverPath))
  )
    return "unknown";
  return "different";
};

const alignmentRemediation = (input: {
  readonly hasReasons: boolean;
  readonly observedExpectation: boolean;
  readonly pathComparable: boolean;
  readonly expectedServerPath: string | undefined;
  readonly serverPath: string | undefined;
}): string | null => {
  if (input.hasReasons)
    return "Restart the registered MCP server/client, then compare identity again.";
  if (input.observedExpectation && input.pathComparable) return null;
  if (input.expectedServerPath !== undefined && input.serverPath === undefined)
    return "The server entrypoint path is unavailable, so registration identity cannot be compared.";
  if (!input.pathComparable)
    return "The expected and server entrypoint paths could not be resolved to establish whether they identify the same file.";
  return "Supply expected package, catalog, or registration identity to compare the live server.";
};

/** Optional observations supplied by a client comparing its expected server. */
export interface ExpectedServerIdentity {
  readonly package_version?: string;
  readonly catalog_digest?: string;
  readonly server_path?: string;
}

export interface ConnectedClientIdentity {
  readonly name: string;
  readonly version: string;
}

const packageRoot = (): string => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDirectory) === "src" &&
    basename(dirname(moduleDirectory)) === "dist"
    ? resolve(moduleDirectory, "../..")
    : resolve(moduleDirectory, "..");
};

const buildAlignment = (
  expected: ExpectedServerIdentity | undefined,
  serverPath: string | undefined,
  commandIdentity: FileIdentitySnapshot | undefined,
  catalog: ReturnType<typeof createCatalogIdentity>,
  host: ResolvedFileIdentityHost,
) => {
  const reasons: string[] = [];
  if (
    expected?.package_version !== undefined &&
    expected.package_version !== PRODUCT_IDENTITY.packageVersion
  )
    reasons.push("package_version_mismatch");
  if (
    expected?.catalog_digest !== undefined &&
    expected.catalog_digest !== catalog.digests.combined_sha256
  )
    reasons.push("catalog_digest_mismatch");
  const pathComparison =
    expected?.server_path === undefined
      ? "omitted"
      : serverPath === undefined
        ? "unavailable"
        : compareServerPaths(
            expected.server_path,
            serverPath,
            commandIdentity,
            host,
          );
  if (pathComparison === "different")
    reasons.push("registration_path_mismatch");
  const observedExpectation =
    expected !== undefined &&
    Object.values(expected).some((value) => value !== undefined);
  const pathComparable =
    pathComparison === "omitted" ||
    pathComparison === "same" ||
    pathComparison === "different";
  return {
    state:
      reasons.length > 0
        ? ("mcp_server_restart_required" as const)
        : observedExpectation && pathComparable
          ? ("aligned" as const)
          : ("unknown" as const),
    reasons,
    remediation: alignmentRemediation({
      hasReasons: reasons.length > 0,
      observedExpectation,
      pathComparable,
      expectedServerPath: expected?.server_path,
      serverPath,
    }),
  } as const;
};

/** Build one runtime identity without claiming alignment from absent observations. */
export const createServerIdentity = (input: {
  readonly startedAt: string;
  readonly commandPath: string | undefined;
  readonly commandIdentity?: FileIdentitySnapshot | undefined;
  readonly expected?: ExpectedServerIdentity;
  readonly client?: ConnectedClientIdentity;
  readonly protocolVersion?: string | undefined;
  readonly catalog: ReturnType<typeof createCatalogIdentity>;
  readonly host?: FileIdentityHost;
}) => {
  const catalog = input.catalog;
  const serverPath = input.commandPath || undefined;
  const commandIdentity =
    input.commandIdentity !== undefined &&
    serverPath !== undefined &&
    input.commandIdentity.path === serverPath
      ? input.commandIdentity
      : undefined;
  return {
    package: {
      name: PRODUCT_IDENTITY.packageName,
      version: PRODUCT_IDENTITY.packageVersion,
      root_path: packageRoot(),
      build_commit: process.env.REA_BUILD_COMMIT ?? null,
    },
    server: {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
      started_at: input.startedAt,
      command_path: serverPath ?? null,
    },
    sdk: SDK_IDENTITY,
    negotiated_protocol_version: input.protocolVersion ?? null,
    client:
      input.client === undefined
        ? null
        : { name: input.client.name, version: input.client.version },
    skill: {
      name: PRODUCT_IDENTITY.skillName,
      expected_version: PRODUCT_IDENTITY.skillVersion,
    },
    catalog: {
      counts: catalog.counts,
      digests: catalog.digests,
    },
    protocol_features: {
      progress: true,
      cancellation: true,
      elicitation: false,
    },
    alignment: buildAlignment(
      input.expected,
      serverPath,
      commandIdentity,
      catalog,
      resolveFileIdentityHost(input.host),
    ),
  } as const;
};
