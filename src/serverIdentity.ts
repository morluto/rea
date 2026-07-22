import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG_IDENTITY } from "./catalogIdentity.js";
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

/** Build one runtime identity without claiming alignment from absent observations. */
export const createServerIdentity = (input: {
  readonly startedAt: string;
  readonly expected?: ExpectedServerIdentity;
  readonly client?: ConnectedClientIdentity;
  readonly protocolVersion?: string | undefined;
}) => {
  const serverPath = resolve(process.argv[1] ?? "unknown");
  const reasons: string[] = [];
  if (
    input.expected?.package_version !== undefined &&
    input.expected.package_version !== PRODUCT_IDENTITY.packageVersion
  )
    reasons.push("package_version_mismatch");
  if (
    input.expected?.catalog_digest !== undefined &&
    input.expected.catalog_digest !== CATALOG_IDENTITY.digests.combined_sha256
  )
    reasons.push("catalog_digest_mismatch");
  if (
    input.expected?.server_path !== undefined &&
    resolve(input.expected.server_path) !== serverPath
  )
    reasons.push("registration_path_mismatch");
  const observedExpectation =
    input.expected !== undefined &&
    Object.values(input.expected).some((value) => value !== undefined);
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
      command_path: serverPath,
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
    catalog: CATALOG_IDENTITY,
    protocol_features: {
      progress: true,
      cancellation: true,
      evidence_resources: true,
      elicitation: false,
    },
    alignment: {
      state:
        reasons.length > 0
          ? "mcp_server_restart_required"
          : observedExpectation
            ? "aligned"
            : "unknown",
      reasons,
      remediation:
        reasons.length > 0
          ? "Restart the registered MCP server/client, then compare identity again."
          : observedExpectation
            ? null
            : "Supply expected package, catalog, or registration identity to compare the live server.",
    },
  } as const;
};

/** Compact identity projection for CLI summaries; MCP retains full identity. */
export const createServerIdentitySummary = (
  input: Parameters<typeof createServerIdentity>[0],
) => {
  const identity = createServerIdentity(input);
  return {
    package: {
      name: identity.package.name,
      version: identity.package.version,
    },
    server: {
      name: identity.server.name,
      version: identity.server.version,
    },
    catalog: {
      counts: identity.catalog.counts,
      digests: identity.catalog.digests,
    },
    alignment: identity.alignment,
  } as const;
};
