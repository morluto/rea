/** Maximum wall-clock analysis time passed to Ghidra for one imported file. */
export const GHIDRA_ANALYSIS_TIMEOUT_SECONDS = 300;
/** Maximum CPU cores made available to one headless analysis. */
export const GHIDRA_MAX_CPU = 2;
/** Explicit JVM heap ceiling for one headless provider process. */
export const GHIDRA_MAX_HEAP = "2G";
/** Absolute import, analysis, bridge, and health startup deadline. */
export const GHIDRA_STARTUP_TIMEOUT_MS = 330_000;
/** Default bounded wait for one established bridge request. */
export const GHIDRA_REQUEST_TIMEOUT_MS = 10_000;
/** Maximum encoded response line accepted from the Java bridge. */
export const GHIDRA_MAX_LINE_BYTES = 1024 * 1024;
/** Version of REA's Java bridge handshake and request protocol. */
export const GHIDRA_BRIDGE_VERSION = 2;
