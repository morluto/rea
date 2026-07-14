import { isSecretLikePath } from "../domain/referenceSourceClassification.js";
import {
  createHistoricalSourceGraph,
  referenceSourceParseFailureKey,
  type HistoricalSourceGraph,
  type HistoricalSourceGraphInput,
} from "../domain/referenceSourceGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { readReferenceSource } from "../reference/ReferenceSourceReader.js";
import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { readReferenceSourceVcs } from "./ReferenceSourceVcsAdapter.js";
import {
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";
import { prepareReferenceSourceImport } from "./ReferenceSourceImportPolicy.js";

export type {
  ReferenceSourceImportError,
  ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";

const compareCodePoints = (left: string, right: string): number => {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};

const byCodePoint = (left: string, right: string): number =>
  compareCodePoints(left, right);

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

const cancelled = (): ReferenceSourceImportError =>
  failure("cancelled", "Reference source import cancelled");

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const relationshipKey = (
  relationship: HistoricalSourceGraphInput["relationships"][number],
): string =>
  `${relationship.from_path}\u0000${relationship.to}\u0000${relationship.kind}\u0000${relationship.resolution}\u0000${relationship.parse_state}`;

const deduplicateRelationships = (
  relationships: HistoricalSourceGraphInput["relationships"],
): HistoricalSourceGraphInput["relationships"] => {
  const seen = new Set<string>();
  const result: HistoricalSourceGraphInput["relationships"] = [];
  for (const relationship of relationships) {
    const key = relationshipKey(relationship);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(relationship);
  }
  return result;
};

const buildProvenance = (
  options: ReferenceSourceImportOptions,
): HistoricalSourceGraphInput["provenance"] => ({
  importer: options.importer ?? "rea-reference-source-import",
  importer_version: options.importerVersion ?? null,
  caller: options.caller,
});

const deriveLanguages = (
  entries: HistoricalSourceGraphInput["entries"],
): string[] =>
  [
    ...new Set(
      entries.flatMap((entry) =>
        entry.kind === "file" && entry.language !== null
          ? [entry.language]
          : [],
      ),
    ),
  ].sort(byCodePoint);

const deriveManifests = (
  entries: HistoricalSourceGraphInput["entries"],
): string[] =>
  entries
    .flatMap((entry) =>
      entry.kind === "file" && entry.classifications.includes("manifest")
        ? [entry.path]
        : [],
    )
    .sort(byCodePoint);

const deriveInventoryState = (
  input: Pick<
    HistoricalSourceGraphInput,
    | "entries"
    | "relationships"
    | "parse_failures"
    | "exclusions"
    | "limitations"
  >,
): "complete" | "partial" | "unknown" => {
  if (input.limitations.length > 0) return "partial";
  if (input.exclusions.length > 0) return "partial";
  if (input.parse_failures.length > 0) return "partial";
  const partialEntry = input.entries.some(
    (entry) =>
      entry.limitations.length > 0 ||
      (entry.kind === "file" && entry.content_state !== "hashed") ||
      (entry.kind === "directory" && entry.tree_state !== "enumerated") ||
      (entry.kind === "symlink" && entry.target_state !== "internal"),
  );
  if (partialEntry) return "partial";
  const partialRelationship = input.relationships.some(
    ({ parse_state, resolution }) =>
      parse_state !== "parsed" ||
      ["unresolved", "unknown"].includes(resolution),
  );
  if (partialRelationship) return "partial";
  return "complete";
};

const sortAndLimit = (
  exclusions: HistoricalSourceGraphInput["exclusions"],
  maxExclusions: number,
): HistoricalSourceGraphInput["exclusions"] => {
  const sorted = [...exclusions].sort((left, right) => {
    const byPath = byCodePoint(left.path, right.path);
    if (byPath !== 0) return byPath;
    return byCodePoint(left.reason, right.reason);
  });
  if (sorted.length <= maxExclusions) return sorted;
  return sorted.slice(0, maxExclusions);
};

/**
 * Import a reference source directory into a committed historical source graph.
 *
 * The import is deterministic, parallel-safe, and never executes source, hooks,
 * git subprocesses, or network requests. Secret-like paths are redacted before
 * they are committed to the graph.
 */
export const importReferenceSource = async (
  options: ReferenceSourceImportOptions,
): Promise<Result<HistoricalSourceGraph, ReferenceSourceImportError>> => {
  if (isAborted(options.signal)) return err(cancelled());
  const prepared = await prepareReferenceSourceImport(options);
  if (!prepared.ok) return prepared;
  const { ignored, limits, root, secrets } = prepared.value;
  if (isAborted(options.signal)) return err(cancelled());

  const exclusions: HistoricalSourceGraphInput["exclusions"] = [];
  const shouldExclude = (path: string): boolean => {
    if (isSecretLikePath(path) || secrets.ignores(path)) {
      exclusions.push({ path, reason: "configured-secret" });
      return true;
    }
    if (ignored.ignores(path)) {
      exclusions.push({ path, reason: "caller-excluded" });
      return true;
    }
    return false;
  };

  const [readResult, vcs] = await Promise.all([
    readReferenceSource(root, limits, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      shouldExclude,
    }),
    readReferenceSourceVcs(root, options.signal),
  ]);

  if (!readResult.ok) {
    const error = readResult.error;
    if (error.code === "cancelled") return err(cancelled());
    return err(
      failure(
        error.code === "invalid-limits" ? "invalid-limits" : "io",
        error.message,
      ),
    );
  }

  if (isAborted(options.signal)) return err(cancelled());

  const read = readResult.value;
  const filePaths = new Set(
    read.entries
      .filter((entry) => entry.status === "read" && entry.kind === "file")
      .map((entry) => entry.path),
  );

  const { entries, relationships, parseFailures, limitations } =
    parseReferenceSourceEntries(read, filePaths, options.signal);

  if (isAborted(options.signal)) return err(cancelled());

  const uniqueRelationships = deduplicateRelationships(relationships);
  const uniqueFailures = [
    ...new Map(
      parseFailures.map((parseFailure) => [
        referenceSourceParseFailureKey(parseFailure),
        parseFailure,
      ]),
    ).values(),
  ].sort((left, right) =>
    byCodePoint(
      referenceSourceParseFailureKey(left),
      referenceSourceParseFailureKey(right),
    ),
  );

  const sortedEntries = [...entries].sort((left, right) =>
    byCodePoint(left.path, right.path),
  );
  const sortedExclusions = sortAndLimit(exclusions, limits.maxEntries);
  const sortedLimitations = [...limitations].sort(byCodePoint);

  const input: HistoricalSourceGraphInput = {
    schema: "HistoricalSourceGraph/v1",
    authority: "historical-reference",
    root_alias: "$REFERENCE_ROOT",
    inventory_state: deriveInventoryState({
      entries: sortedEntries,
      relationships: uniqueRelationships,
      parse_failures: uniqueFailures,
      exclusions: sortedExclusions,
      limitations: sortedLimitations,
    }),
    entries: sortedEntries,
    relationships: uniqueRelationships.sort((left, right) =>
      byCodePoint(relationshipKey(left), relationshipKey(right)),
    ),
    parse_failures: uniqueFailures,
    exclusions: sortedExclusions,
    languages: deriveLanguages(sortedEntries),
    manifests: deriveManifests(sortedEntries),
    vcs,
    provenance: buildProvenance(options),
    limitations: sortedLimitations,
  };

  try {
    return ok(createHistoricalSourceGraph(input));
  } catch (error) {
    return err(
      failure(
        "parse",
        error instanceof Error ? error.message : "Graph failed validation",
      ),
    );
  }
};
