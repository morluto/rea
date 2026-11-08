import {
  isJavaScriptExportLink,
  javaScriptExportModuleOrigin,
  type JavaScriptModuleSemanticIr,
} from "./javascriptModuleSemanticIr.js";
import {
  semanticCoverageResourceLimits,
  semanticResourceLimitCoverage,
} from "./javascriptSemanticCoverage.js";
import { semanticResourceLimitReason } from "./javascriptSemanticResourceLimits.js";
import { estimateSemanticReturnValueBytes } from "./javascriptSemanticReturns.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";

/** Forecast retained heap and serialized Evidence separately. */
export const estimateJavaScriptStaticApplicationProjectionSizes = (
  facts: JavaScriptStaticAnalysis,
  checkpointBytes: number,
  sourcePath: string,
): { readonly retentionBytes: number; readonly evidenceBytes: number } => {
  // A finding can produce a node, a separate observation and several edges.
  // Allow for identifiers, locations, authority, coverage and schema copies,
  // independently of the producer's compact checkpoint representation.
  const findings =
    (facts.electron.app_path_changes?.length ?? 0) +
    facts.references.length +
    facts.endpoints.length +
    facts.storage.length +
    facts.role_paths.length +
    facts.source_map_urls.length +
    facts.electron.browser_windows.length +
    facts.electron.context_bridge_apis.length +
    facts.electron.ipc.length +
    facts.electron.sender_validations.length +
    facts.electron.utility_processes.length +
    facts.electron.native_addon_bindings.length +
    facts.electron.protocols.length;
  let records = findings * 8;
  let repeatedBytes = 0;
  for (const registration of facts.bundler_registrations) {
    records +=
      3 +
      registration.modules.length * 3 +
      registration.entry_module_keys.length * 3 +
      registration.async_chunk_keys.length * 3;
    // Every module observation and containment edge repeats its chunk keys.
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(registration.chunk_keys)) *
      registration.modules.length *
      2;
  }
  for (const binding of facts.electron.native_addon_bindings)
    records += binding.members.length * 3;
  for (const path of facts.electron.call_paths ?? []) {
    // One contextual node and edge per step, with repeated guards and identity.
    records += path.steps.length * 4 + 8;
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(path.conditions)) *
      path.steps.length *
      2;
  }
  // The per-record allowance already covers retention: projected Vite-style
  // chunks serialize to about 0.46 KB per record, under a quarter of it.
  // Expanding the allowance again charged about 25x the serialized
  // relationships, so a few files used up the parent budget that every later
  // source shares. Checkpoint and repeated bytes keep their expansion.
  const metadataBytes = 2048 + Buffer.byteLength(sourcePath) * 4;
  // Measured on a complete Grok Bot app.asar analysis: the sum of these
  // forecasts was 89 MB for 73 MB of retained application-graph objects.
  return {
    retentionBytes:
      (checkpointBytes * 4 + repeatedBytes) * 8 + records * metadataBytes,
    evidenceBytes:
      checkpointBytes * 4 + repeatedBytes + records * metadataBytes,
  };
};

/** Forecast parent-heap retention for static-fact expansion. */
export const estimateJavaScriptStaticApplicationProjection = (
  facts: JavaScriptStaticAnalysis,
  checkpointBytes: number,
  sourcePath: string,
): number =>
  estimateJavaScriptStaticApplicationProjectionSizes(
    facts,
    checkpointBytes,
    sourcePath,
  ).retentionBytes;

/**
 * Serialized bytes of one application node, observation or edge apart from
 * the path, link, limitation and return-shape payloads counted separately:
 * identifiers, identity, evidence skeleton, coverage, enum fields and source
 * positions. Module-link records measured at most 1,559 bytes of this content
 * with three-digit positions; the rest covers longer positions and counts.
 */
const APPLICATION_RECORD_BYTES = 1792;
/**
 * Fixed evidence sentences the graph adds to a module's own limitations
 * (runtime-proof, incomplete-coverage and return-shape notes).
 */
const APPLICATION_RECORD_SENTENCE_BYTES = 384;

/** Serialized application facts one module adds, and how many records carry them. */
export interface JavaScriptModuleApplicationProjectionEstimate {
  readonly bytes: number;
  readonly records: number;
}

/**
 * Forecast the serialized source-module, export, return-shape and module
 * relationship records without materializing flattened shapes or ancestor
 * paths. Import resolution can add package-metadata limitations that depend on
 * other inventoried files; those are not part of this forecast.
 */
export const estimateJavaScriptModuleApplicationProjection = (
  module: JavaScriptModuleSemanticIr,
  sourcePath: string,
  allowance = Number.MAX_SAFE_INTEGER - 1,
): JavaScriptModuleApplicationProjectionEstimate => {
  const callables = new Map(
    module.callables.map((callable) => [callable.callableId, callable]),
  );
  const resourceLimits = semanticCoverageResourceLimits(module.coverage);
  // Every record repeats its module path in labels, identity and location,
  // and its evidence carries the module limitations and resource limits.
  const recordBytes =
    APPLICATION_RECORD_BYTES +
    Buffer.byteLength(JSON.stringify(sourcePath)) * 4 +
    Buffer.byteLength(JSON.stringify(module.limitations)) +
    Buffer.byteLength(
      JSON.stringify(resourceLimits.map(semanticResourceLimitReason)),
    ) +
    Buffer.byteLength(
      JSON.stringify(semanticResourceLimitCoverage(resourceLimits)),
    ) +
    APPLICATION_RECORD_SENTENCE_BYTES;
  const shapesByCallable = new Map<string, number>();
  // The source-module node and its containment edge list every export name.
  let records = 2;
  let bytes = recordBytes * records;
  for (const link of module.moduleLinks) {
    if (link.exportedName !== null)
      bytes += Buffer.byteLength(JSON.stringify(link.exportedName)) + 1;
    if (link.kind === "type-import") continue;
    const exported = isJavaScriptExportLink(link);
    if (exported && link.exportedName === null) continue;
    if (!exported && link.specifier === null) continue;
    // Names, specifier and location recur in labels, identity and properties.
    const linkBytes = Buffer.byteLength(JSON.stringify(link)) * 3;
    // An export node and its exposes edge; a module origin or an import adds
    // an imports edge and possibly an unresolved module node.
    const linkRecords =
      (exported ? 2 : 0) +
      (!exported || javaScriptExportModuleOrigin(module, link) !== null
        ? 2
        : 0);
    records += linkRecords;
    bytes += linkRecords * (recordBytes + linkBytes);
    if (bytes > allowance) return { bytes: allowance + 1, records };
    const callable =
      exported && link.callableId !== null
        ? callables.get(link.callableId)
        : undefined;
    if (callable === undefined) continue;
    let shapeBytes = shapesByCallable.get(callable.callableId);
    if (shapeBytes === undefined) {
      shapeBytes =
        Buffer.byteLength(JSON.stringify(callable.location)) +
        Buffer.byteLength(JSON.stringify(callable.callableId));
      for (const site of callable.returnSites) {
        // Site range, value status and property-coverage punctuation.
        shapeBytes += 256 + Buffer.byteLength(JSON.stringify(site.location));
        shapeBytes += estimateSemanticReturnValueBytes(
          site.value,
          Math.max(0, allowance - bytes - shapeBytes),
        );
        if (bytes + shapeBytes > allowance)
          return { bytes: allowance + 1, records };
      }
      shapesByCallable.set(callable.callableId, shapeBytes);
    }
    // Each exported name carries its own return-shape observation.
    records += 1;
    bytes += recordBytes + linkBytes + shapeBytes;
    if (bytes > allowance) return { bytes: allowance + 1, records };
  }
  return { bytes, records };
};
