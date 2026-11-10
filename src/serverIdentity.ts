import { realpathSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { createCatalogIdentity } from "./catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "./identity.js";

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

/**
 * Whether two entrypoint spellings select the same file.
 *
 * A launcher records the canonical path, while a caller passes the spelling it
 * used to start REA, which can reach the same file through a symlink or a `..`
 * segment. Resolving the spelling alone does not follow links, so compare the
 * file each spelling selects and fall back to the resolved path when either
 * cannot be read.
 */
const sameEntrypoint = (left: string, right: string): boolean => {
  const selected = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolve(candidate);
    }
  };
  return selected(left) === selected(right);
};

/** Every observation that disagrees with this runtime, in a stable order. */
const identityReasons = (
  expected: ExpectedServerIdentity | undefined,
  serverPath: string | undefined,
  catalog: ReturnType<typeof createCatalogIdentity>,
): string[] => {
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
  if (
    expected?.server_path !== undefined &&
    serverPath !== undefined &&
    !sameEntrypoint(expected.server_path, serverPath)
  )
    reasons.push("registration_path_mismatch");
  return reasons;
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
  const reasons = identityReasons(input.expected, serverPath, catalog);
  const observedExpectation =
    input.expected !== undefined &&
    Object.values(input.expected).some((value) => value !== undefined);
  const pathComparable =
    input.expected?.server_path === undefined || serverPath !== undefined;
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
    alignment: {
      state:
        reasons.length > 0
          ? "mcp_server_restart_required"
          : observedExpectation && pathComparable
            ? "aligned"
            : "unknown",
      reasons,
      remediation:
        reasons.length > 0
          ? "Restart the registered MCP server/client, then compare identity again."
          : observedExpectation && pathComparable
            ? null
            : input.expected?.server_path !== undefined &&
                serverPath === undefined
              ? "The server entrypoint path is unavailable, so registration identity cannot be compared."
              : "Supply expected package, catalog, or registration identity to compare the live server.",
    },
  } as const;
};
