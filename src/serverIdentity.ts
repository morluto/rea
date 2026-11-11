import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { createCatalogIdentity } from "./catalogIdentity.js";
import {
  javaScriptRuntime,
  type JavaScriptRuntime,
} from "./domain/runtimeVersion.js";
import { absoluteCallerPath } from "./filesystem/callerPath.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "./identity.js";

type ServerPathComparison = "same" | "different" | "unknown";

export interface ServerFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface ServerIdentityHost {
  readonly platform?: NodeJS.Platform;
  readonly runtime?: JavaScriptRuntime["id"];
  readonly stat?: (path: string) => ServerFileStat;
  readonly lstatIsSymbolicLink?: (path: string) => boolean;
  readonly realpath?: (path: string) => string;
}

interface ResolvedServerIdentityHost {
  readonly platform: NodeJS.Platform;
  readonly runtime: JavaScriptRuntime["id"];
  readonly stat: (path: string) => ServerFileStat;
  readonly lstatIsSymbolicLink: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

const resolveHost = (
  host: ServerIdentityHost | undefined,
): ResolvedServerIdentityHost => ({
  platform: host?.platform ?? process.platform,
  runtime: host?.runtime ?? javaScriptRuntime(process.versions).id,
  stat: host?.stat ?? ((path) => statSync(path, { bigint: true })),
  lstatIsSymbolicLink:
    host?.lstatIsSymbolicLink ?? ((path) => lstatSync(path).isSymbolicLink()),
  realpath: host?.realpath ?? realpathSync.native,
});

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const hasParentSegment = (path: string): boolean =>
  path.split("/").includes("..");

const isSymbolicLinkPath = (
  path: string,
  host: ResolvedServerIdentityHost,
): boolean => {
  try {
    return host.lstatIsSymbolicLink(path);
  } catch {
    return false;
  }
};

const inspectServerFile = (path: string, host: ResolvedServerIdentityHost) => {
  let stats: ServerFileStat | undefined;
  let statError: string | undefined;
  try {
    stats = host.stat(path);
  } catch (cause: unknown) {
    statError = errorCode(cause) ?? "unknown";
  }
  let realpath: string | undefined;
  try {
    realpath = host.realpath(path);
  } catch {
    // Missing or unreadable targets fall back to stat and path checks below.
  }
  return { stats, statError, realpath };
};

const sameExistingServerFile = (
  expected: ReturnType<typeof inspectServerFile>,
  observed: ReturnType<typeof inspectServerFile>,
  bunPosixTraversal: boolean,
): ServerPathComparison | undefined => {
  if (expected.stats !== undefined && observed.stats !== undefined) {
    const bothHaveInode =
      expected.stats.ino !== 0n && observed.stats.ino !== 0n;
    if (bothHaveInode) {
      return expected.stats.dev === observed.stats.dev &&
        expected.stats.ino === observed.stats.ino
        ? "same"
        : "different";
    }
  }
  if (bunPosixTraversal)
    return expected.stats !== undefined && observed.stats !== undefined
      ? "unknown"
      : undefined;
  if (expected.realpath !== undefined && observed.realpath !== undefined)
    return expected.realpath === observed.realpath ? "same" : "different";
  if (expected.stats !== undefined && observed.stats !== undefined)
    return "unknown";
  return undefined;
};

const isMissingPathError = (code: string | undefined): boolean =>
  code === undefined || code === "ENOENT" || code === "ENOTDIR";

const compareServerPaths = (
  expectedPath: string,
  serverPath: string,
  host: ResolvedServerIdentityHost,
): ServerPathComparison => {
  if (expectedPath === serverPath) return "same";
  const expected = inspectServerFile(expectedPath, host);
  const observed = inspectServerFile(serverPath, host);
  const bunPosixTraversal =
    host.platform !== "win32" &&
    host.runtime === "bun" &&
    (hasParentSegment(expectedPath) || hasParentSegment(serverPath));
  const existing = sameExistingServerFile(
    expected,
    observed,
    bunPosixTraversal,
  );
  if (existing !== undefined) return existing;
  if (
    !isMissingPathError(expected.statError) ||
    !isMissingPathError(observed.statError)
  )
    return "unknown";
  if (
    isSymbolicLinkPath(expectedPath, host) ||
    isSymbolicLinkPath(serverPath, host)
  )
    return "unknown";
  if (
    absoluteCallerPath(expectedPath, { platform: host.platform }) ===
    absoluteCallerPath(serverPath, { platform: host.platform })
  )
    return "same";
  if (
    host.platform !== "win32" &&
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
  host: ResolvedServerIdentityHost,
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
        : compareServerPaths(expected.server_path, serverPath, host);
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
  readonly host?: ServerIdentityHost;
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
    alignment: buildAlignment(
      input.expected,
      serverPath,
      catalog,
      resolveHost(input.host),
    ),
  } as const;
};
