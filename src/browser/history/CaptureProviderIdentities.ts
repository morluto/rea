import { PACKAGE_METADATA } from "../../generatedPackageMetadata.js";

const captureJsonVersions = `jsonc-parser@${PACKAGE_METADATA.jsoncParserVersion};lossless-json@${PACKAGE_METADATA.losslessJsonVersion}`;

/** Upstream packages and owned schema corrections for offline HAR decoding. */
export const HAR_CAPTURE_PROVIDER_IDENTITY = {
  id: "har-schema/lossless-json",
  name: "REA HAR capture adapter",
  version: `har-schema@2.0.0;har-schema-corrections@1;${captureJsonVersions}`,
} as const;

/** Native SAZ member decoding with the existing ZIP and XML package profiles. */
export const SAZ_CAPTURE_PROVIDER_IDENTITY = {
  id: "fiddler-saz",
  name: "REA Fiddler SAZ capture adapter",
  version: "1;zip.js@2.25.0;xmldom@0.9.12",
} as const;

/** Native executable profile verified with unchanged mitmproxy raw-state decoding. */
export const MITMPROXY_CAPTURE_PROVIDER_IDENTITY = {
  id: "mitmproxy-native-tnetstring",
  name: "REA offline native mitmproxy adapter",
  version: "12.3.1",
} as const;

export const QLOG_CAPTURE_PROVIDER_IDENTITY = {
  id: "aioquic-qlog-json",
  name: "REA aioquic qlog capture adapter",
  version: `aioquic-profile@1.5.0;qlog@0.3;${captureJsonVersions}`,
} as const;
