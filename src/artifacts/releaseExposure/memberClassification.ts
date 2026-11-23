import { basename } from "node:path";

import {
  classifyFatContainerEvidence,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
} from "../../domain/apple/machoContainer.js";
import { hasElfMagic } from "../../domain/binaryContainer.js";
import { parsePeRecordStructure } from "../../domain/binaryTarget.js";
import {
  hasDosMzMagic,
  mzWindowsHeaderLayoutLimitation,
  observeMzWindowsHeader,
} from "../../domain/dosMz.js";
import type { ReleaseExposureScan } from "../../domain/releaseExposure.js";
import type { ArtifactReader } from "../../resources/index.js";

export type NativeFormat = "elf" | "mach-o" | "mach-o-universal" | "pe";
export type PackageFormat = Extract<
  ArtifactReader["format"],
  | "asar"
  | "bun-standalone"
  | "deno-standalone"
  | "dotnet-bundle"
  | "node-sea"
  | "pyinstaller"
>;

const PACKAGE_FORMATS = [
  "asar",
  "bun-standalone",
  "deno-standalone",
  "dotnet-bundle",
  "node-sea",
  "pyinstaller",
] as const satisfies readonly PackageFormat[];

export const EXTRACTABLE = new Set<string>(PACKAGE_FORMATS);

export const asPackageFormat = (format: string): PackageFormat | null =>
  EXTRACTABLE.has(format) ? (format as PackageFormat) : null;

export const NATIVE = new Set(["elf", "mach-o", "mach-o-universal", "pe"]);

export const TEXT_EXTENSION =
  /\.(?:cjs|css|cts|env|html|htm|ini|js|json|jsx|map|md|mjs|mts|pem|plist|toml|ts|tsx|txt|xml|yaml|yml)$/iu;

export type PeHeaderState = "other" | "unexamined" | "malformed" | "pe";

/** Judge a PE header by the same structural parser as inventory. */
export const peHeaderState = (
  bytes: Buffer,
  size: number | null,
): PeHeaderState => {
  if (!hasDosMzMagic(bytes)) return "other";
  const windows = observeMzWindowsHeader(bytes, size ?? bytes.length);
  if (windows.state === "declared" && windows.signature === "PE") {
    if (mzWindowsHeaderLayoutLimitation(windows) !== undefined)
      return "malformed";
    const record = parsePeRecordStructure(bytes.subarray(windows.offset));
    if (record.ok) return "pe";
    return record.error.kind === "incomplete" &&
      (size === null || windows.offset + record.error.requiredBytes <= size)
      ? "unexamined"
      : "malformed";
  }
  if (
    windows.state === "signature-needed" ||
    (windows.state === "candidate" && windows.signature === "unobserved")
  )
    return "unexamined";
  return "other";
};

const JAVASCRIPT_SOURCE_MAP = /\.(?:cjs|css|cts|js|jsx|mjs|mts|ts|tsx)\.map$/iu;

export const isJavaScriptSourceMapName = (logical: string): boolean =>
  JAVASCRIPT_SOURCE_MAP.test(logical);

export const isSourceMap = (logical: string, kind: string): boolean =>
  kind === "source-map" || logical.toLowerCase().endsWith(".map");

const isDeclaredText = (kind: string): boolean =>
  kind === "javascript" ||
  kind === "source-map" ||
  kind === "plist" ||
  kind === "entitlements";

export const isText = (logical: string, kind: string): boolean =>
  isDeclaredText(kind) || TEXT_EXTENSION.test(logical);

export const hasCompanionName = (logical: string): boolean => {
  const lower = logical.toLowerCase();
  return (
    lower.endsWith(".pdb") ||
    lower.endsWith(".debug") ||
    lower.endsWith(".dsym")
  );
};

/**
 * FAT identity from the container owner. A prefix can only rule a universal
 * image out against the member's real size: without one, or with slices past
 * the prefix, the image may be native and stays counted as one.
 */
export const sniffFatFormat = (
  bytes: Buffer,
  size: number | null,
): "mach-o-universal" | null => {
  const known = size !== null && size >= bytes.length;
  const header = readFatContainerHeader(bytes, known ? size : bytes.length);
  if (header.state !== "parsed") return null;
  return known &&
    classifyFatContainerEvidence(header, bytes).state === "not-mach-o"
    ? null
    : "mach-o-universal";
};

/** Header facts from the executable owners. A JVM class is not a FAT Mach-O. */
export const sniffNativeFormat = (
  bytes: Buffer,
  size: number | null = bytes.length,
): NativeFormat | null => {
  if (hasElfMagic(bytes)) return "elf";
  if (readMachoHeaderPrefixFacts(bytes).format !== null) return "mach-o";
  const universal = sniffFatFormat(bytes, size);
  if (universal !== null) return universal;
  return peHeaderState(bytes, size) === "pe" ? "pe" : null;
};

export const targetKind = (
  path: string,
  format: string,
  directory: boolean,
): ReleaseExposureScan["target"]["kind"] => {
  if (directory && basename(path).toLowerCase().endsWith(".app")) return "app";
  if (directory || format === "directory") return "directory";
  if (format === "asar") return "asar";
  if (NATIVE.has(format) || EXTRACTABLE.has(format)) return "executable";
  return "file";
};
