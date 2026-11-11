import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { createCatalogIdentity } from "./catalogIdentity.js";
import { absoluteCallerPath } from "./filesystem/callerPath.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "./identity.js";

type ServerPathComparison = "same" | "different" | "unknown";

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const hasParentSegment = (path: string): boolean =>
  path.split("/").includes("..");

const isSymbolicLinkPath = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const inspectServerFile = (path: string) => {
  let stats: ReturnType<typeof statSync> | undefined;
  let statError: string | undefined;
  try {
    stats = statSync(path);
  } catch (cause: unknown) {
    statError = errorCode(cause) ?? "unknown";
  }
  let realpath: string | undefined;
  try {
    realpath = realpathSync.native(path);
  } catch {
    // Missing or unreadable targets fall back to stat and path checks below.
  }
  return { stats, statError, realpath };
};

const sameExistingServerFile = (
  expected: ReturnType<typeof inspectServerFile>,
  observed: ReturnType<typeof inspectServerFile>,
): ServerPathComparison | undefined => {
  if (
    expected.realpath !== undefined &&
    observed.realpath !== undefined &&
    expected.realpath === observed.realpath
  )
    return "same";
  if (expected.stats === undefined || observed.stats === undefined)
    return undefined;
  const bothHaveInode = expected.stats.ino !== 0 && observed.stats.ino !== 0;
  if (
    bothHaveInode &&
    expected.stats.dev === observed.stats.dev &&
    expected.stats.ino === observed.stats.ino
  )
    return "same";
  if (
    bothHaveInode ||
    (expected.realpath !== undefined && observed.realpath !== undefined)
  )
    return "different";
  return "unknown";
};

const isMissingPathError = (code: string | undefined): boolean =>
  code === undefined || code === "ENOENT" || code === "ENOTDIR";

const compareServerPaths = (
  expectedPath: string,
  serverPath: string,
): ServerPathComparison => {
  if (expectedPath === serverPath) return "same";
  const expected = inspectServerFile(expectedPath);
  const observed = inspectServerFile(serverPath);
  const existing = sameExistingServerFile(expected, observed);
  if (existing !== undefined) return existing;
  if (
    !isMissingPathError(expected.statError) ||
    !isMissingPathError(observed.statError)
  )
    return "unknown";
  if (isSymbolicLinkPath(expectedPath) || isSymbolicLinkPath(serverPath))
    return "unknown";
  if (absoluteCallerPath(expectedPath) === absoluteCallerPath(serverPath))
    return "same";
  if (
    process.platform !== "win32" &&
    (hasParentSegment(expectedPath) || hasParentSegment(serverPath))
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
  catalog: ReturnType<typeof createCatalogIdentity>,
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
        : compareServerPaths(expected.server_path, serverPath);
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
  readonly expected?: ExpectedServerIdentity;
  readonly client?: ConnectedClientIdentity;
  readonly protocolVersion?: string | undefined;
  readonly catalog: ReturnType<typeof createCatalogIdentity>;
}) => {
  const catalog = input.catalog;
  const serverPath = input.commandPath || undefined;
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
    alignment: buildAlignment(input.expected, serverPath, catalog),
  } as const;
};
