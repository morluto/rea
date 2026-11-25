import { escapeJsonPointerToken } from "../jsonPointer.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  unsupportedTarget,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import {
  API_CONTRACT_OPERATION,
  type ApiContract,
  type ApiContractArtifact,
} from "./apiContract.js";
import { ContractInventory } from "./contractInventory.js";
import { isRecord } from "../../kernel/isRecord.js";
import {
  API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS,
  API_CONTRACT_MAX_REF_DEPTH,
  LocalRefResolver,
  type LocalRefOutcome,
} from "./resolveLocalRefs.js";

const methods = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;
const modernMethods = [...methods, "query"];
const reservedAdditionalMethods = new Set(
  modernMethods.map((method) => method.toUpperCase()),
);
const pathMetadata = new Set([
  "$ref",
  "summary",
  "description",
  "servers",
  "parameters",
]);
// HTTP methods are case-sensitive tokens; additionalOperations preserves that spelling.
const httpToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? (value as Record<string, unknown>) : undefined;

const infoFacts = (
  root: Record<string, unknown>,
  inventory: ContractInventory,
): Result<ApiContract["info"], AnalysisError> => {
  const info = record(root.info);
  const title = typeof info?.title === "string" ? info.title : null;
  const version = typeof info?.version === "string" ? info.version : null;
  const admitted = inventory.reserve(
    4096 +
      inventory.artifact.path.length * 12 +
      (title?.length ?? 0) * 12 +
      (version?.length ?? 0) * 12,
  );
  if (!admitted.ok) return admitted;
  if (info === undefined || title === null || version === null) {
    const diagnosed = inventory.diagnostic(
      "invalid-info",
      "/info",
      "Info title/version are not both present strings; usable metadata and operation slots are retained without claiming a valid OpenAPI document.",
    );
    if (!diagnosed.ok) return diagnosed;
  }
  return ok({ title, version });
};

function* additionalOperations(
  value: unknown,
  context: {
    inventory: ContractInventory;
    path: string;
    pointer: string;
    hasReference: boolean;
  },
): Generator<void, Result<void, AnalysisError>> {
  const { inventory, path, pointer, hasReference } = context;
  const operations = record(value);
  if (operations === undefined)
    return inventory.diagnostic(
      "invalid-additional-operations",
      pointer,
      "additionalOperations must be an object mapping HTTP method tokens to Operation Objects.",
    );
  let examined = 0;
  for (const method in operations) {
    if (!Object.hasOwn(operations, method)) continue;
    if (examined++ % 128 === 0) yield;
    const admitted = inventory.reserve(512 + method.length * 24);
    if (!admitted.ok) return admitted;
    const source = `${pointer}/${escapeJsonPointerToken(method)}`;
    const reserved = reservedAdditionalMethods.has(method);
    const added =
      !httpToken.test(method) || reserved
        ? inventory.diagnostic(
            "invalid-additional-method",
            source,
            "The additional HTTP method is not a token or duplicates a fixed method; it is not treated as a valid operation.",
          )
        : inventory.operation(operations[method], {
            path,
            method,
            pointer: source,
            hasReference,
          });
    if (!added.ok) return added;
  }
  return ok(undefined);
}

type PathItemReference =
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly target: Record<string, unknown> }
  | { readonly kind: "unresolved" };

/** Record a Path Item $ref and, for a local fragment, resolve it. */
function pathItemReference(
  item: Record<string, unknown>,
  context: {
    inventory: ContractInventory;
    path: string;
    pointer: string;
    resolver: LocalRefResolver;
  },
): Result<PathItemReference, AnalysisError> {
  const { inventory, path, pointer, resolver } = context;
  if (!Object.hasOwn(item, "$ref")) return ok({ kind: "none" });
  const refValue = item.$ref;
  if (typeof refValue !== "string") {
    const added = inventory.reference(path, `${pointer}/$ref`, refValue);
    if (!added.ok) return added;
    return ok({ kind: "unresolved" });
  }
  if (refValue.startsWith("#")) inventory.localResolutionAttempted = true;
  const outcome: LocalRefOutcome = resolver.resolve(refValue);
  if (outcome.kind === "resolved") {
    const recorded = inventory.reference(
      path,
      `${pointer}/$ref`,
      refValue,
      "resolved",
    );
    if (!recorded.ok) return recorded;
    return ok({ kind: "resolved", target: outcome.target });
  }
  const recorded = inventory.reference(path, `${pointer}/$ref`, refValue);
  if (!recorded.ok) return recorded;
  if (outcome.kind !== "external") {
    const diagnosed = inventory.diagnostic(
      "unresolved-path-reference",
      `${pointer}/$ref`,
      `${outcome.detail} Its effective operations remain unknown; adjacent inline slots are preserved without merging.`,
    );
    if (!diagnosed.ok) return diagnosed;
  }
  return ok({ kind: "unresolved" });
}

function* pathItem(
  value: unknown,
  context: {
    inventory: ContractInventory;
    path: string;
    pointer: string;
    modern: boolean;
    resolver: LocalRefResolver;
    /** True when this item is already a resolved $ref target; its own $ref is not re-recorded. */
    resolved?: boolean;
  },
): Generator<void, Result<void, AnalysisError>> {
  const { inventory, path, pointer, modern, resolver } = context;
  const item = record(value);
  if (item === undefined)
    return inventory.diagnostic(
      "invalid-path-item",
      pointer,
      "Path Item must be an object; its operations are unknown.",
    );
  let hasReference = false;
  if (!context.resolved) {
    const reference = pathItemReference(item, {
      inventory,
      path,
      pointer,
      resolver,
    });
    if (!reference.ok) return reference;
    if (reference.value.kind === "resolved") {
      // Enumerate the target's operations under the referencing path;
      // source pointers stay scoped to this path so identities stay unique.
      const read = yield* pathItem(reference.value.target, {
        inventory,
        path,
        pointer,
        modern,
        resolver,
        resolved: true,
      });
      if (!read.ok) return read;
    } else if (reference.value.kind !== "none") {
      hasReference = true;
    }
  }
  const fixedMethods: readonly string[] = modern ? modernMethods : methods;
  let examined = 0;
  for (const key in item) {
    if (!Object.hasOwn(item, key)) continue;
    if (examined++ % 128 === 0) yield;
    if (fixedMethods.includes(key)) {
      const added = inventory.operation(item[key], {
        path,
        method: key.toUpperCase(),
        pointer: `${pointer}/${key}`,
        hasReference,
      });
      if (!added.ok) return added;
    } else if (key === "additionalOperations" && modern) {
      const added = yield* additionalOperations(item[key], {
        inventory,
        path,
        pointer: `${pointer}/${key}`,
        hasReference,
      });
      if (!added.ok) return added;
    } else if (!pathMetadata.has(key) && !key.startsWith("x-")) {
      const admitted = inventory.reserve(512 + key.length * 24);
      if (!admitted.ok) return admitted;
      const diagnosed = inventory.diagnostic(
        "unknown-path-item-field",
        `${pointer}/${escapeJsonPointerToken(key)}`,
        "This field is not an operation or a recognized Path Item field in the selected OpenAPI minor version.",
      );
      if (!diagnosed.ok) return diagnosed;
    }
  }
  return ok(undefined);
}

interface ContractReportContext {
  readonly openapi: string;
  readonly info: ApiContract["info"];
  readonly pathsState: ApiContract["source_coverage"]["paths_state"];
  /** True for the OpenAPI 3.2 minor family (QUERY + additionalOperations). */
  readonly modern: boolean;
  examined: number;
}

const contractReport = (
  inventory: ContractInventory,
  context: ContractReportContext,
  incomplete = false,
): ApiContract => {
  const artifact = inventory.artifact;
  let declared = 0;
  for (const operation of inventory.operations)
    if (operation.state === "declared") declared++;
  const unresolvedPathItems = inventory.references.filter(
    (row) => row.state !== "resolved",
  ).length;
  const referenceResolution: ApiContract["source_coverage"]["reference_resolution"] =
    inventory.localResolutionAttempted ? "local-only" : "not-attempted";
  return {
    contract_id: `api_contract_${artifact.sha256}`,
    format: "openapi-json",
    openapi: context.openapi,
    artifact,
    info: context.info,
    operations: inventory.operations,
    path_item_references: inventory.references,
    diagnostics: inventory.diagnostics,
    summary: {
      operation_slots: inventory.operations.length,
      declared,
      unknown: inventory.operations.length - declared,
      unresolved_path_items: unresolvedPathItems,
      diagnostics: inventory.diagnostics.length,
    },
    source_coverage: {
      scope: "inline-path-operations",
      status:
        incomplete ||
        unresolvedPathItems > 0 ||
        inventory.diagnostics.length > 0
          ? "partial"
          : "complete-within-scope",
      paths_state: context.pathsState,
      path_entries_examined: context.examined,
      reference_resolution: referenceResolution,
      schema_validation: "not-performed",
      duplicate_json_members: "last-value-wins",
    },
    limitations: [
      ...(incomplete
        ? [
            "Traversal stopped before the inventory was complete. Row counts describe retained facts; path_entries_examined counts fully traversed entries, excluding an interrupted entry whose rows may be retained.",
          ]
        : []),
      "Operations are document declarations, not evidence of runtime implementation, reachability or authorization.",
      "Only inline operations under paths are inventoried; callbacks, webhooks, components, servers, parameters, schemas, request/response contracts and security are not analyzed.",
      ...(referenceResolution === "local-only"
        ? [
            `Local same-document $ref fragments (#/...) are resolved within a depth budget of ${API_CONTRACT_MAX_REF_DEPTH} hops and an expansion budget of ${API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS} resolved references per document. Cycles, missing targets, invalid pointers, budget overflows and external or non-local references remain unresolved, and their Path Item operations stay unknown. No network fetch or external file read is performed.`,
          ]
        : [
            "No reference is resolved, including local fragments. A Path Item reference makes its effective operations unknown; adjacent inline slots are preserved without merging referenced definitions.",
          ]),
      "Transport userinfo credentials are excluded from reference URIs. credential_redacted marks the exclusion; an ambiguous credential span leaves the displayed reference unknown. Other reference text is preserved.",
      "This is a structural inventory, not full OpenAPI schema validation. operationId values are preserved without assuming uniqueness; operation_key matches exact method/path spelling, not semantic equivalence across APIs.",
      "Source JSON members use last-value-wins parsing. Original bytes remain in the caller-selected artifact, identified by SHA-256; this Evidence does not embed the complete source document.",
    ],
  };
};

function* collectPaths(
  sourcePaths: Record<string, unknown>,
  inventory: ContractInventory,
  context: ContractReportContext,
  resolver: LocalRefResolver,
): Generator<void, Result<void, AnalysisError>> {
  for (const path in sourcePaths) {
    if (!Object.hasOwn(sourcePaths, path) || path.startsWith("x-")) continue;
    yield;
    // Reserve expanded pointer/path strings before escaping or building a row.
    const admitted = inventory.reserve(512 + path.length * 16);
    if (!admitted.ok) return admitted;
    const pointer = `/paths/${escapeJsonPointerToken(path)}`;
    const read = path.startsWith("/")
      ? yield* pathItem(sourcePaths[path], {
          inventory,
          path,
          pointer,
          modern: context.modern,
          resolver,
        })
      : inventory.diagnostic(
          "invalid-path-key",
          pointer,
          "A Paths entry must start with /; it was not interpreted as an endpoint.",
        );
    if (!read.ok) return read;
    context.examined++;
  }
  return ok(undefined);
}

/** Enumerate declarations, resolving local same-document references only; never fetch servers, callbacks, runtime expressions or external references. */
export function* parseApiContractSteps(
  value: unknown,
  artifact: ApiContractArtifact,
): Generator<void, Result<ApiContract, AnalysisError>> {
  const root = record(value);
  if (root === undefined || typeof root.openapi !== "string")
    return err(
      new AnalysisInputError(API_CONTRACT_OPERATION, undefined, [
        {
          path: ["path"],
          reason: "invalid_format",
          message:
            "Expected an OpenAPI JSON object with an openapi version string.",
        },
      ]),
    );
  const version = /^3\.([012])\.(?:0|[1-9][0-9]*)$/u.exec(root.openapi);
  if (version === null)
    return err(
      unsupportedTarget(
        API_CONTRACT_OPERATION,
        artifact.path,
        "openapi",
        "Only OpenAPI 3.0, 3.1 and 3.2 JSON documents are supported.",
      ),
    );
  const inventory = new ContractInventory(artifact);
  const versionAdmitted = inventory.reserve(root.openapi.length * 12);
  if (!versionAdmitted.ok) return versionAdmitted;
  const info = infoFacts(root, inventory);
  if (!info.ok) return info;
  const paths = record(root.paths);
  const pathsState =
    paths !== undefined
      ? "object"
      : Object.hasOwn(root, "paths")
        ? "malformed"
        : "absent";
  const context: ContractReportContext = {
    openapi: root.openapi,
    info: info.value,
    pathsState,
    modern: version[1] === "2",
    examined: 0,
  };
  const interrupted = (error: AnalysisError) => {
    const retainedRows =
      inventory.operations.length +
      inventory.references.length +
      inventory.diagnostics.length;
    if (retainedRows > 0)
      error.retainPartialObservation(contractReport(inventory, context, true));
    return err(error);
  };
  if (
    pathsState === "malformed" ||
    (pathsState === "absent" && version[1] === "0")
  ) {
    const diagnosed = inventory.diagnostic(
      "invalid-paths",
      "/paths",
      "paths must be an object and is required for OpenAPI 3.0; a missing or malformed inventory is not proof of zero operations.",
    );
    if (!diagnosed.ok) return interrupted(diagnosed.error);
  }
  try {
    const read = yield* collectPaths(
      paths ?? {},
      inventory,
      context,
      new LocalRefResolver(root),
    );
    if (!read.ok) return interrupted(read.error);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) return interrupted(cause);
    throw cause;
  }
  return ok(contractReport(inventory, context));
}
