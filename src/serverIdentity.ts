import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { createCatalogIdentity } from "./catalogIdentity.js";
import { PRODUCT_IDENTITY, SDK_IDENTITY } from "./identity.js";
import { CURRENT_ENTRYPOINT_PATH } from "./process/CurrentEntrypointPath.js";
import {
  entrypointSpellingVerdict,
  selectEntrypoint,
  type EntrypointSpellingVerdict,
} from "./process/EntrypointSpelling.js";

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
 * The file this process launched from, captured once.
 *
 * `CURRENT_ENTRYPOINT_PATH` keeps the spelling from `argv[1]`, which may be a manager alias.
 * Re-reading that spelling on every comparison would follow a retargeted alias to the release
 * it points at now, and report alignment while this process still executes the earlier one. The
 * snapshot keeps the file that was actually launched.
 */
const LAUNCHED_FILE: string | undefined =
  CURRENT_ENTRYPOINT_PATH === undefined
    ? undefined
    : // The snapshot follows the traversal the launcher performed: Bun reaches the link's target
      // where Node reaches the lexical path.
      selectEntrypoint(CURRENT_ENTRYPOINT_PATH).path;

/**
 * Whether two entrypoint spellings select the same file.
 *
 * The spelling rules live in `EntrypointSpelling`; this wrapper adds the launch snapshot, so a
 * retargeted manager alias cannot move the live side after the process started.
 */
const entrypointVerdict = (
  left: string,
  right: string,
): EntrypointSpellingVerdict => {
  if (right === CURRENT_ENTRYPOINT_PATH && LAUNCHED_FILE !== undefined) {
    // An unchanged registered alias is not alignment by itself: the alias may have been
    // retargeted while this process runs the release it started from. Both sides are resolved
    // against the snapshot, so equality is still decided by what each spelling selects now.
    return entrypointSpellingVerdict(left, LAUNCHED_FILE);
  }
  return entrypointSpellingVerdict(left, right);
};

/** Every observation that disagrees with this runtime, in a stable order. */
const identityReasons = (
  expected: ExpectedServerIdentity | undefined,
  serverPath: string | undefined,
  catalog: ReturnType<typeof createCatalogIdentity>,
): { readonly reasons: string[]; readonly pathUndecided: boolean } => {
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
  let pathUndecided = false;
  if (expected?.server_path !== undefined && serverPath !== undefined) {
    const verdict = entrypointVerdict(expected.server_path, serverPath);
    // `unknown` must not read as alignment: the comparison could not be made, so the caller
    // reports "unknown" rather than suppressing a restart.
    if (verdict === "different") reasons.push("registration_path_mismatch");
    else if (verdict === "unknown") pathUndecided = true;
  }
  return { reasons, pathUndecided };
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
  const { reasons, pathUndecided } = identityReasons(
    input.expected,
    serverPath,
    catalog,
  );
  const observedExpectation =
    input.expected !== undefined &&
    Object.values(input.expected).some((value) => value !== undefined);
  const pathComparable =
    !pathUndecided &&
    (input.expected?.server_path === undefined || serverPath !== undefined);
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
