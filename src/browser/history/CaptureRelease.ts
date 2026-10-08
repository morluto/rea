/** Exact upstream package profile for unchanged offline HAR validation and numeric parsing. */
export const HAR_CAPTURE_PROVIDER_IDENTITY = {
  id: "har-schema/lossless-json",
  name: "REA HAR capture adapter",
  version: "har-schema@2.0.0;jsonc-parser@3.3.1;lossless-json@4.3.1",
} as const;

/** Fixed V8 heap settings used by the owned HAR decoder process. */
export const HAR_CAPTURE_HEAP_LIMITS = {
  oldGenerationMiB: 192,
  semiSpaceMiB: 8,
} as const;

/** Native executable profile verified with unchanged mitmproxy raw-state decoding. */
export const MITMPROXY_CAPTURE_PROVIDER_IDENTITY = {
  id: "mitmproxy-native-tnetstring",
  name: "REA offline native mitmproxy adapter",
  version: "12.2.3",
} as const;
