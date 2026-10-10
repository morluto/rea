import { createHash } from "node:crypto";
import { posix } from "node:path";

import { logicalPathEscapesRoot } from "../domain/artifactIdentity.js";
import {
  createReferenceSourcePathLookup,
  isPortableAbsoluteReferenceTarget,
  type ReferenceSourcePathLookup,
} from "../domain/referenceSourcePathIdentity.js";
import {
  classifyReferenceSourcePath,
  detectReferenceSourceLanguage,
} from "../domain/referenceSourceClassification.js";
import type { HistoricalSourceGraphInput } from "../domain/referenceSourceGraph.js";
import { parseReferenceSourceImports } from "../domain/referenceSourceImportParsing.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceRead,
} from "../reference/ReferenceSourceReaderTypes.js";
import { PARSEABLE_REFERENCE_SOURCE_LANGUAGES } from "./ReferenceSourceImportTypes.js";

export interface ParsedReferenceSourceEntries {
  readonly entries: HistoricalSourceGraphInput["entries"];
  readonly relationships: HistoricalSourceGraphInput["relationships"];
  readonly parseFailures: HistoricalSourceGraphInput["parse_failures"];
  readonly limitations: string[];
}

/** Preserve the observed reader failure and add entry-specific recovery guidance. */
export const projectReferenceSourceEntryFailure = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => `${entry.message} ${entryRecoveryGuidance(entry)}`;

const entryRecoveryGuidance = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => {
  if (entry.code === "cancelled")
    return "This entry was not read because the import was cancelled. Start the import again when ready.";
  if (entry.code === "unsupported")
    return "Exclude this entry or replace it with a regular file.";
  if (entry.kind === "directory")
    return "This directory could not be read. Check its permissions, then try again.";
  if (entry.kind === "symlink")
    return "This symbolic link could not be read safely. Check the link and its permissions, then try again.";
  return "This file could not be read. Check its permissions, then try again.";
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const failedEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): HistoricalSourceGraphInput["entries"][number] => {
  const classifications = classifyReferenceSourcePath(entry.path);
  const limitation = projectReferenceSourceEntryFailure(entry);
  if (entry.kind === "directory")
    return {
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "unreadable",
      limitations: [limitation],
    };
  if (entry.kind === "symlink")
    return {
      path: entry.path,
      kind: "symlink",
      target: null,
      target_state: "unreadable",
      classifications,
      limitations: [limitation],
    };
  return {
    path: entry.path,
    kind: "file",
    sha256: null,
    size: entry.size ?? null,
    language: null,
    classifications: entry.kind === "file" ? classifications : ["unknown"],
    content_state: "unreadable",
    limitations: [limitation],
  };
};

const resolveInternalSpecifier = (
  fromPath: string,
  specifier: string,
  lookupPath: ReferenceSourcePathLookup,
): { to: string; resolution: "internal" | "unresolved" } => {
  if (posix.isAbsolute(specifier))
    return { to: specifier, resolution: "unresolved" };
  const normalized = posix.normalize(
    posix.join(posix.dirname(fromPath), specifier),
  );
  if (logicalPathEscapesRoot(normalized))
    return { to: normalized, resolution: "unresolved" };
  const suffixes = ["", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];
  const candidates = suffixes.flatMap((suffix) => [
    `${normalized}${suffix}`,
    `${normalized}/index${suffix}`,
  ]);
  // TypeScript source commonly names the extension emitted for NodeNext.
  // Retain present runtime files first; substitute only a missing counterpart.
  // Counterparts cover explicit filenames, not directory/index resolution.
  if (/\.(?:ts|tsx|mts|cts)$/u.test(fromPath)) {
    const sourceSuffixes = normalized.endsWith(".js")
      ? [".ts", ".tsx", ".d.ts"]
      : normalized.endsWith(".mjs")
        ? [".mts", ".d.mts"]
        : normalized.endsWith(".cjs")
          ? [".cts", ".d.cts"]
          : normalized.endsWith(".jsx")
            ? [".tsx", ".d.ts"]
            : [];
    const stem = normalized.slice(0, -posix.extname(normalized).length);
    candidates.push(...sourceSuffixes.map((suffix) => `${stem}${suffix}`));
  }
  const match = lookupPath.resolveCandidates(candidates);
  return match === undefined
    ? { to: normalized, resolution: "unresolved" }
    : { to: match, resolution: "internal" };
};

const appendFile = (
  entry: Extract<ReferenceSourceEntry, { status: "read"; kind: "file" }>,
  lookupPath: ReferenceSourcePathLookup,
  output: ParsedReferenceSourceEntries,
): void => {
  const language = detectReferenceSourceLanguage(entry.path);
  output.entries.push({
    path: entry.path,
    kind: "file",
    sha256: hashBytes(entry.bytes),
    size: entry.size,
    language,
    classifications: classifyReferenceSourcePath(entry.path),
    content_state: "hashed",
    limitations: [],
  });
  if (language === null || !PARSEABLE_REFERENCE_SOURCE_LANGUAGES.has(language))
    return;
  const parsed = parseReferenceSourceImports(entry.path, entry.bytes, language);
  for (const relationship of parsed.relationships) {
    if (relationship.resolution !== "internal") {
      output.relationships.push(relationship);
      continue;
    }
    const resolved = resolveInternalSpecifier(
      relationship.from_path,
      relationship.to,
      lookupPath,
    );
    output.relationships.push({
      ...relationship,
      to: resolved.to,
      resolution: resolved.resolution,
    });
  }
  output.parseFailures.push(...parsed.parse_failures);
};

const appendReadEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "read" }>,
  lookupPath: ReferenceSourcePathLookup,
  output: ParsedReferenceSourceEntries,
): void => {
  if (entry.kind === "file") {
    appendFile(entry, lookupPath, output);
    return;
  }
  const classifications = classifyReferenceSourcePath(entry.path);
  if (entry.kind === "directory") {
    output.entries.push({
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "enumerated",
      limitations: [],
    });
    return;
  }
  output.entries.push({
    path: entry.path,
    kind: "symlink",
    // The reader resolves inventory identities from its root; the persisted
    // graph represents relative symlink targets from the link's directory.
    target:
      entry.targetState === "internal" ||
      (entry.targetState === "missing" &&
        !isPortableAbsoluteReferenceTarget(entry.target))
        ? posix.relative(posix.dirname(entry.path), entry.target) || "."
        : entry.target,
    target_state: entry.targetState,
    classifications,
    limitations: [],
  });
};

/** Convert bounded reader observations into graph entries and parsed edges. */
export const parseReferenceSourceEntries = (
  read: ReferenceSourceRead,
  filePaths: ReadonlySet<string>,
  signal?: AbortSignal,
): ParsedReferenceSourceEntries => {
  const output: ParsedReferenceSourceEntries = {
    entries: [],
    relationships: [],
    parseFailures: [],
    limitations: [...read.limitations],
  };
  const lookupPath = createReferenceSourcePathLookup(filePaths);
  for (const entry of read.entries) {
    if (signal?.aborted === true) break;
    if (entry.status === "failed") output.entries.push(failedEntry(entry));
    else appendReadEntry(entry, lookupPath, output);
  }
  return output;
};
