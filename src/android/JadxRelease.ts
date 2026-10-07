/** Audited upstream release; source remains unmodified in the Git submodule. */
export const JADX_RELEASE = Object.freeze({
  version: "0.7.1",
  revision: "5844800a486d2248fa949b74c9896285f5b54de2",
  sha256: "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75",
  url: "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar",
});

/** JVM heap ceiling applied to every owned JADX worker process. */
export const JADX_HEAP_LIMIT_MIB = 512;

/** JVM `-Xmx` argument matching {@link JADX_HEAP_LIMIT_MIB}. */
export const JADX_HEAP_XMX_ARGUMENT = `-Xmx${JADX_HEAP_LIMIT_MIB}m`;

/** Remediation when `REA_JADX_MCP_JAR` is missing or not an absolute path. */
export const JADX_JAR_CONFIGURATION_REMEDIATION = `Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp ${JADX_RELEASE.version} JAR. REA does not download or install it.`;

/** Producing engine identity used by Evidence and the generated product catalog. */
export const JADX_PROVIDER_IDENTITY = Object.freeze({
  id: "jadx",
  name: "JADX headless",
  version: JADX_RELEASE.version,
});

/** Audited engine coverage, kept outside portable Android semantics. */
export const JADX_LIMITATIONS = [
  "Static decompiler observations do not establish runtime behavior; the APK is never executed.",
  "Method signatures use provider display types; exact DEX descriptors and instruction offsets are unavailable. Overload indices are local to this engine and artifact.",
  "Manifest summary fields are extracted by the upstream engine; decoded XML is retained for verification. APK signatures, split APKs, native libraries and Android runtime capture are not verified by this provider.",
] as const;
