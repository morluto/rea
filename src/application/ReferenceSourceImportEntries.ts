import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  classifyReferenceSourcePath,
  detectReferenceSourceLanguage,
} from "../domain/referenceSourceClassification.js";
import type { HistoricalSourceGraphInput } from "../domain/referenceSourceGraph.js";
import { parseReferenceSourceImports } from "../domain/referenceSourceImportParsing.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceRead,
} from "../reference/ReferenceSourceReader.js";
import { PARSEABLE_REFERENCE_SOURCE_LANGUAGES } from "./ReferenceSourceImportTypes.js";

export interface ParsedReferenceSourceEntries {
  readonly entries: HistoricalSourceGraphInput["entries"];
  readonly relationships: HistoricalSourceGraphInput["relationships"];
  readonly parseFailures: HistoricalSourceGraphInput["parse_failures"];
  readonly limitations: string[];
}

/** Project a low-level entry failure into safe import guidance. */
export const projectReferenceSourceEntryFailure = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => {
  if (entry.code === "cancelled")
    return "This entry was not read because the import was cancelled. Start the import again when ready.";
  if (entry.code === "limit")
    return "This entry was not read because an import limit was reached. Import a smaller directory or raise the configured limits.";
  if (entry.code === "unsupported")
    return "This entry cannot be read safely on this system. Exclude it or import the directory on a supported system.";
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
      tree_state: entry.code === "limit" ? "partial" : "unreadable",
      limitations: [limitation],
    };
  if (entry.kind === "symlink")
    return {
      path: entry.path,
      kind: "symlink",
      target: "<unreadable>",
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
    content_state: entry.code === "limit" ? "too-large" : "unreadable",
    limitations: [limitation],
  };
};

const resolveInternalSpecifier = (
  fromPath: string,
  specifier: string,
  filePaths: ReadonlySet<string>,
): { to: string; resolution: "internal" | "unresolved" } => {
  const normalized = posix.normalize(
    posix.join(posix.dirname(fromPath), specifier),
  );
  if (normalized.startsWith("../") || normalized === "..")
    return { to: normalized, resolution: "unresolved" };
  const suffixes = ["", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];
  const candidates = suffixes.flatMap((suffix) => [
    `${normalized}${suffix}`,
    `${normalized}/index${suffix}`,
  ]);
  const match = candidates.find((candidate) => filePaths.has(candidate));
  return match === undefined
    ? { to: normalized, resolution: "unresolved" }
    : { to: match, resolution: "internal" };
};

const appendFile = (
  entry: Extract<ReferenceSourceEntry, { status: "read"; kind: "file" }>,
  filePaths: ReadonlySet<string>,
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
      filePaths,
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
  filePaths: ReadonlySet<string>,
  output: ParsedReferenceSourceEntries,
): void => {
  if (entry.kind === "file") {
    appendFile(entry, filePaths, output);
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
    target: entry.target,
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
  for (const entry of read.entries) {
    if (signal?.aborted === true) break;
    if (entry.status === "failed") output.entries.push(failedEntry(entry));
    else appendReadEntry(entry, filePaths, output);
  }
  return output;
};
