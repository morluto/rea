import { isAbsolute } from "node:path";

import type { ArtifactInventoryResult } from "../../domain/artifactGraph.js";
import { logicalPathNfc } from "../../domain/artifactIdentity.js";
import { appendCallerPath } from "../../filesystem/callerPath.js";
import { EXTRACTABLE } from "./memberClassification.js";

export type InventoryOccurrence =
  ArtifactInventoryResult["occurrences"][number];

export interface OccurrenceRootTarget {
  readonly path: string;
  readonly directory: boolean;
}

export const packageAncestor = (
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): InventoryOccurrence | undefined => {
  const seen = new Set<string>();
  let parentId = occurrence.parent_occurrence_id;
  while (parentId !== null) {
    if (seen.has(parentId)) return undefined;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined;
    if (EXTRACTABLE.has(formatOf(parent))) return parent;
    parentId = parent.parent_occurrence_id;
  }
  return undefined;
};

export const hasExtractableAncestor = (
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): boolean => packageAncestor(occurrence, byId, formatOf) !== undefined;

export const diskPath = (
  input: OccurrenceRootTarget,
  occurrence: InventoryOccurrence,
  byId: Map<string, InventoryOccurrence>,
  formatOf: (occurrence: InventoryOccurrence) => string,
): string | null => {
  if (hasExtractableAncestor(occurrence, byId, formatOf)) return null;
  if (
    occurrence.source_path !== undefined &&
    occurrence.source_path.length > 0 &&
    isAbsolute(occurrence.source_path)
  )
    return occurrence.source_path;
  if (!input.directory) {
    if (occurrence.parent_occurrence_id === null) return input.path;
    return null;
  }
  if (occurrence.logical_path.split("/").includes("..")) return null;
  if (occurrence.logical_path.length === 0 || occurrence.logical_path === ".")
    return input.path;
  const source = occurrence.source_path;
  return appendCallerPath(
    input.path,
    source !== undefined && logicalPathNfc(source) === occurrence.logical_path
      ? source
      : occurrence.logical_path,
  );
};

export const entryPath = (
  occurrence: InventoryOccurrence,
  parent: InventoryOccurrence,
): string => {
  const logical = occurrence.logical_path;
  const parentLogical = parent.logical_path;
  if (parentLogical.length === 0 || parentLogical === ".") return logical;
  const prefix = `${parentLogical}/`;
  return logical.startsWith(prefix) ? logical.slice(prefix.length) : logical;
};
