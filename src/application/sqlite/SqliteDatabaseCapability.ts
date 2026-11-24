import { satisfies } from "semver";
import { toolContract } from "../../contracts/toolContracts.js";
import { SQLITE_PROVIDER_IDENTITY } from "../../domain/sqlite/SqliteProviderIdentity.js";

const SQLITE_RUNTIME_REQUIREMENT =
  "SQLite inspection requires the native DatabaseSync.limits API, which REA's supported Node.js 24.x and 26.x runtimes provide; it is unavailable on Node.js 22.x. Other REA features retain their published runtime requirements. The inspection worker verifies the API before querying the snapshot.";

/** Discover inspection readiness without opening a database or starting a worker. */
export const sqliteDatabaseCapability = (nodeVersion: string) => {
  const contract = toolContract("inspect_sqlite_database");
  const facts = {
    operation: contract.name,
    provider: SQLITE_PROVIDER_IDENTITY,
    effects: {
      mutatesArtifact: contract.effects.mutatesTarget,
      launchesProcess: contract.effects.launchesProcess,
      mayShowUi: contract.effects.changesUiState,
      mayAccessNetwork: contract.effects.accessesNetwork,
      mayWriteFilesystem: contract.effects.writesFilesystem,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [SQLITE_RUNTIME_REQUIREMENT],
  };
  return satisfies(nodeVersion, "^24.15.0 || >=26.0.0")
    ? { ...facts, available: true as const, reason: null }
    : {
        ...facts,
        available: false as const,
        reason: SQLITE_RUNTIME_REQUIREMENT,
        availabilityCode: "unsupported_version" as const,
      };
};
