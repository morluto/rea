import { targetFailureReaders } from "../registry.js";

/**
 * Adapters whose worker or engine owns the format. The SQLite engine reads
 * every selected database here; the pwntools and EVM workers need external
 * runtimes and are covered by their provider boundary tests.
 */
export default targetFailureReaders([
  {
    operation: "inspect_sqlite_database",
    cases: [
      {
        name: "not-a-database",
        kind: "malformed",
        bytes: () => Buffer.from("selected non-SQLite bytes"),
        facts: { format: "sqlite" },
        identity: false,
      },
    ],
  },
]);
