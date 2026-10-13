import { javaScriptRuntime } from "../../domain/runtimeVersion.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../process/JavaScriptWorkerMemoryLimit.js";

/** Exact upstream package profile for unchanged offline HAR validation and numeric parsing. */
export const HAR_CAPTURE_PROVIDER_IDENTITY = {
  id: "har-schema/lossless-json",
  name: "REA HAR capture adapter",
  version: "har-schema@2.0.0;jsonc-parser@3.3.1;lossless-json@4.3.1",
} as const;

/** Fixed V8 heap settings used by the owned Node capture decoder process. */
export const NODE_CAPTURE_HEAP_LIMITS = {
  oldGenerationMiB: 192,
  semiSpaceMiB: 8,
} as const;

/** The Node capture decoder runs on this executable; Bun accepts but ignores V8 heap flags. */
export const NODE_CAPTURE_HEAP_ENFORCED =
  javaScriptRuntime(process.versions).id === "node";

/** Windows Job Object commit limit replacing the ignored heap flags under Bun; otherwise null. */
export const NODE_CAPTURE_PROCESS_MEMORY_LIMIT_BYTES =
  javaScriptWorkerMemoryLimitBytes(NODE_CAPTURE_HEAP_LIMITS.oldGenerationMiB);

/** Native executable profile verified with unchanged mitmproxy raw-state decoding. */
export const MITMPROXY_CAPTURE_PROVIDER_IDENTITY = {
  id: "mitmproxy-native-tnetstring",
  name: "REA offline native mitmproxy adapter",
  version: "12.2.3",
} as const;

/** Native SAZ member decoding with the existing ZIP and XML package profiles. */
export const SAZ_CAPTURE_PROVIDER_IDENTITY = {
  id: "fiddler-saz",
  name: "REA Fiddler SAZ capture adapter",
  version: "1;zip.js@2.15.0;xmldom@0.9.12",
} as const;

/** Fixed offline interpretation profile, not an authenticated producer claim. */
export const QLOG_CAPTURE_PROVIDER_IDENTITY = {
  id: "aioquic-qlog-json",
  name: "REA aioquic qlog capture adapter",
  version:
    "aioquic-profile@1.5.0;qlog@0.3;jsonc-parser@3.3.1;lossless-json@4.3.1",
} as const;
