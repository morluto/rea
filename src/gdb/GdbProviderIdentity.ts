/** Source-owned static provider identity and public operation names. */
export const GDB_PROVIDER_IDENTITY = {
  id: "gnu.gdb",
  name: "GNU GDB",
  version: null,
} as const;

/**
 * Why a GDB observation carries no artifact subject. The session identifier
 * names a debugger, not the inferior, so every retention path states the same
 * reason and claims the same authority for it.
 */
export const GDB_SUBJECT_UNAVAILABLE_REASON =
  "The active GDB inferior identity is not established by the debugger session identifier.";

export const GDB_OBSERVATION_AUTHORITY = "controlled-replay" as const;
