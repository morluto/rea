/** xpanda release whose MCP tool surface REA verified; others report as unverified. */
export const XPANDA_VERIFIED_VERSION = "3.6.0";

/**
 * REA admits these xpanda majors. The MCP surface is not stable across majors;
 * operations added in a later major are reported unavailable when the
 * configured producer does not advertise them.
 */
export const XPANDA_ADMITTED_MAJOR_VERSIONS = [2, 3] as const;

/** Stable provider ID shared by readiness, doctor and Evidence. */
export const XPANDA_PROVIDER_ID = "xpanda";

/** Catalog identity; runtime Evidence records the configured checkout's version. */
export const XPANDA_PROVIDER_IDENTITY = {
  id: XPANDA_PROVIDER_ID,
  name: "xpanda",
  version: XPANDA_VERIFIED_VERSION,
} as const;

/** Environment variable naming the caller-supplied xpanda checkout. */
export const XPANDA_ROOT_VARIABLE = "REA_XPANDA_ROOT";

/** Remediation when `REA_XPANDA_ROOT` is missing or not an absolute path. */
export const XPANDA_ROOT_REMEDIATION = `Set ${XPANDA_ROOT_VARIABLE} to the absolute path of a caller-supplied xpanda checkout with its dependencies installed (verified with ${XPANDA_VERIFIED_VERSION}). REA does not download, install or update xpanda.`;

/** Remediation when the configured checkout layout does not satisfy the bridge. */
export const XPANDA_CHECKOUT_REMEDIATION =
  "Inspect the configured xpanda checkout: REA launches its MCP server through packages/xpanda-mcp/src/server.ts (3.x) or src/mcp/server.ts (2.x) and requires the tsx loader under node_modules. Reinstall the checkout's dependencies with its own package manager; REA never installs them.";

/** Remediation when the configured checkout's version cannot be admitted. */
export const XPANDA_VERSION_REMEDIATION = `Check package.json in the configured xpanda checkout: REA admits xpanda ${XPANDA_ADMITTED_MAJOR_VERSIONS.join(".x and ")}.x checkouts (verified with ${XPANDA_VERIFIED_VERSION}) whose MCP surface matches this integration.`;

/** Remediation when the host cannot supervise an xpanda bridge process tree. */
export const XPANDA_UNSUPPORTED_HOST_REMEDIATION =
  "Use Linux or macOS for the xpanda provider. Windows process-tree ownership for xpanda is not verified.";

/** Producer bytecode surfaces the verification exercised. */
export const XPANDA_BYTECODE_VERSION_SUPPORT =
  "dynamic 24.0.0.0; ArkTS-Sta static (producer-owned)";

/** Bounds for one xpanda operation. */
export const XPANDA_LIMITS = {
  /** Largest admitted .abc or .hap input, staged as a private snapshot per operation. */
  inputBytes: 256 * 1024 * 1024,
  /** Engine source-tree digest scan bounds (files and bytes). */
  engineFiles: 2_000,
  engineBytes: 64 * 1024 * 1024,
  /** Single decompiled class transferred inline from the producer. */
  decompileOutputCharacters: 50_000,
  /** Class file names returned per whole-file export. */
  exportFileNames: 200,
} as const;

/** Result-specific limits and degradation semantics of the producer surface. */
export const XPANDA_LIMITATIONS = [
  "The producer also accepts ArkTS-Sta (static runtime) bytecode and .hap packages; class browsing, decompilation, disassembly, string and symbol search, cross-references and call graphs cover both runtimes, while HAP entry extraction and resource tables are package operations.",
  "Decompiled-source search decompiles matching classes on demand and stops after the selected class budget; scanned, skipped, failed and truncated classes are reported per result, and whole-file decompilation is the exhaustive route.",
  "Dynamic bytecode keeps method call targets in the accumulator, so bytecode cross-references cannot see direct call edges; enable source scanning to recover call sites, which may still miss indirect calls.",
  "HAP resource results are parsed declarations from resources.index (Restool or RestoolV2), not resolved runtime values; resource qualifiers and value formatting remain producer-owned.",
  "Call graphs are bounded by depth and node count and report truncation; dynamic bytecode edges come from decompiled source and report the scanned class budget and disassembly failures.",
  "Decompiled output is producer-generated JavaScript, not recovered source. Methods beyond the producer's structural-analysis limits, including unimplemented conditional-jump instructions (the jeq/jne family), degrade to linear output with decompiler_goto labels; the degraded flag and degraded class lists report this per result.",
  "Instruction and block rendering belong to the producer: disassembly text is preserved verbatim behind the parsed method header, and REA does not re-derive control flow from it.",
  "Single-class decompilation is capped by the producer at 50,000 characters and reports truncation; use whole-file decompilation to write every class to disk instead.",
  "Whole-file decompilation reports per-class failures as skipped or failed counts without aborting, and returns at most 200 written file names. The producer writes into a private runtime root; REA publishes only regular files under the selected absent directory and refuses linked, escaping or count-mismatched output instead of overwriting.",
  "The TypeScript loader, Node runtime and installed producer dependencies are not independently attested; the engine digest covers the configured checkout's package.json and its src tree (2.x) or each workspace's manifest and src tree (3.x) only.",
  "The producer string-pool search requires a full disassembly pass per query; methods that fail disassembly are absent from the pool without being reported individually.",
] as const;
