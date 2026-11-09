import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { err, ok, type Result } from "../result.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import {
  API_CONTRACT_FACT_BYTES,
  API_CONTRACT_OPERATION,
  type ApiContract,
  type ApiContractArtifact,
  type ApiContractDiagnostic,
  type ApiContractOperation,
} from "./apiContract.js";

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
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const pointerPart = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");
const identity = (prefix: string, facts: unknown) =>
  `${prefix}_${digestCanonicalValue(facts)}`;

interface OperationSlot {
  readonly path: string;
  readonly method: string;
  readonly pointer: string;
  readonly hasReference: boolean;
}

/** Own compact declarations and account for repeated path/pointer serialization before allocation. */
class ContractInventory {
  readonly operations: ApiContract["operations"] = [];
  readonly references: ApiContract["path_item_references"] = [];
  readonly diagnostics: ApiContractDiagnostic[] = [];
  #retainedBytes = 0;

  constructor(readonly artifact: ApiContractArtifact) {}

  reserve(bytes: number): Result<void, AnalysisError> {
    // Includes object/index overhead and repeated escaped Evidence delivery, not just source bytes.
    this.#retainedBytes += bytes;
    return this.#retainedBytes <= API_CONTRACT_FACT_BYTES
      ? ok(undefined)
      : err(
          new AnalysisResourceConstraintError(
            API_CONTRACT_OPERATION,
            "memory",
            "API contract declarations exceed the retained-facts representation allowance.",
            { representation_bytes: API_CONTRACT_FACT_BYTES },
            {
              retryable: false,
              remediationAction:
                "Select a smaller complete API document; paging the reply does not increase the parser's retained-facts allowance.",
            },
          ),
        );
  }

  diagnostic(
    code: ApiContractDiagnostic["code"],
    pointer: string,
    message: string,
  ): Result<void, AnalysisError> {
    const admitted = this.reserve(1024 + pointer.length * 12);
    if (!admitted.ok) return admitted;
    this.diagnostics.push({
      diagnostic_id: identity("api_contract_diagnostic", [
        this.artifact.sha256,
        pointer,
        code,
      ]),
      source_pointer: pointer,
      code,
      message,
    });
    return ok(undefined);
  }

  reference(
    path: string,
    pointer: string,
    value: unknown,
  ): Result<void, AnalysisError> {
    const admitted = this.reserve(
      1024 +
        path.length * 12 +
        (typeof value === "string" ? value.length * 12 : 0),
    );
    if (!admitted.ok) return admitted;
    const credentials =
      typeof value === "string"
        ? parseRecordedTransportUrl(value).credentials
        : null;
    const reference =
      typeof value !== "string" || credentials === "ambiguous"
        ? null
        : credentials === null
          ? value
          : value.slice(0, credentials.start) + value.slice(credentials.end);
    this.references.push({
      reference_id: identity("api_path_reference", [
        this.artifact.sha256,
        pointer,
      ]),
      path,
      source_pointer: pointer,
      reference,
      credential_redacted: credentials !== null,
      state: typeof value === "string" ? "unresolved" : "malformed",
    });
    return typeof value === "string"
      ? ok(undefined)
      : this.diagnostic(
          "invalid-path-reference",
          pointer,
          "Path Item $ref must be a string; reference resolution was not attempted.",
        );
  }

  operation(value: unknown, slot: OperationSlot): Result<void, AnalysisError> {
    const object = record(value);
    const declaredId =
      typeof object?.operationId === "string" ? object.operationId : null;
    const admitted = this.reserve(
      1536 +
        slot.path.length * 32 +
        slot.method.length * 24 +
        (declaredId?.length ?? 0) * 12,
    );
    if (!admitted.ok) return admitted;
    const reason: ApiContractOperation["reason"] =
      object === undefined
        ? "malformed-operation"
        : slot.hasReference
          ? "unresolved-path-item-reference"
          : null;
    this.operations.push({
      operation_id: identity("api_operation", [
        this.artifact.sha256,
        slot.pointer,
      ]),
      operation_key: identity("api_operation_key", [slot.path, slot.method]),
      method: slot.method,
      path: slot.path,
      declared_id: declaredId,
      source_pointer: slot.pointer,
      state: reason === null ? "declared" : "unknown",
      reason,
    });
    if (object === undefined)
      return this.diagnostic(
        "invalid-operation",
        slot.pointer,
        "The method's value is not an Operation Object.",
      );
    if (Object.hasOwn(object, "operationId") && declaredId === null)
      return this.diagnostic(
        "invalid-operation-id",
        `${slot.pointer}/operationId`,
        "operationId is present but is not a string; its identity remains unavailable.",
      );
    return ok(undefined);
  }
}

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
    const source = `${pointer}/${pointerPart(method)}`;
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

function* pathItem(
  value: unknown,
  context: {
    inventory: ContractInventory;
    path: string;
    pointer: string;
    modern: boolean;
  },
): Generator<void, Result<void, AnalysisError>> {
  const { inventory, path, pointer, modern } = context;
  const item = record(value);
  if (item === undefined)
    return inventory.diagnostic(
      "invalid-path-item",
      pointer,
      "Path Item must be an object; its operations are unknown.",
    );
  const hasReference = Object.hasOwn(item, "$ref");
  if (hasReference) {
    const added = inventory.reference(path, `${pointer}/$ref`, item.$ref);
    if (!added.ok) return added;
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
        `${pointer}/${pointerPart(key)}`,
        "This field is not an operation or a recognized Path Item field in the selected OpenAPI minor version.",
      );
      if (!diagnosed.ok) return diagnosed;
    }
  }
  return ok(undefined);
}

const completedInventory = (
  inventory: ContractInventory,
  context: {
    openapi: string;
    info: ApiContract["info"];
    pathsState: ApiContract["source_coverage"]["paths_state"];
    examined: number;
  },
): ApiContract => {
  const artifact = inventory.artifact;
  let declared = 0;
  for (const operation of inventory.operations)
    if (operation.state === "declared") declared++;
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
      unresolved_path_items: inventory.references.length,
      diagnostics: inventory.diagnostics.length,
    },
    source_coverage: {
      scope: "inline-path-operations",
      status:
        inventory.references.length > 0 || inventory.diagnostics.length > 0
          ? "partial"
          : "complete-within-scope",
      paths_state: context.pathsState,
      path_entries_examined: context.examined,
      reference_resolution: "not-attempted",
      schema_validation: "not-performed",
      duplicate_json_members: "last-value-wins",
    },
    limitations: [
      "Operations are document declarations, not evidence of runtime implementation, reachability or authorization.",
      "Only inline operations under paths are inventoried; callbacks, webhooks, components, servers, parameters, schemas, request/response contracts and security are not analyzed.",
      "No reference is resolved, including local fragments. A Path Item reference makes its effective operations unknown; adjacent inline slots are preserved without merging referenced definitions.",
      "Transport userinfo credentials are excluded from reference URIs. credential_redacted marks the exclusion; an ambiguous credential span leaves the displayed reference unknown. Other reference text is preserved.",
      "This is a structural inventory, not full OpenAPI schema validation. operationId values are preserved without assuming uniqueness; operation_key matches exact method/path spelling, not semantic equivalence across APIs.",
      "Source JSON members use last-value-wins parsing. Original bytes remain in the caller-selected artifact, identified by SHA-256; this Evidence does not embed the complete source document.",
    ],
  };
};

/** Enumerate declarations only; never resolve references, servers, callbacks or runtime expressions. */
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
      new AnalysisUnsupportedTargetError(
        API_CONTRACT_OPERATION,
        artifact.path,
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
  if (
    pathsState === "malformed" ||
    (pathsState === "absent" && version[1] === "0")
  ) {
    const diagnosed = inventory.diagnostic(
      "invalid-paths",
      "/paths",
      "paths must be an object and is required for OpenAPI 3.0; a missing or malformed inventory is not proof of zero operations.",
    );
    if (!diagnosed.ok) return diagnosed;
  }
  let examined = 0;
  const sourcePaths = paths ?? {};
  for (const path in sourcePaths) {
    if (!Object.hasOwn(sourcePaths, path) || path.startsWith("x-")) continue;
    yield;
    examined++;
    // Reserve expanded pointer/path strings before escaping or building a row.
    const admitted = inventory.reserve(512 + path.length * 16);
    if (!admitted.ok) return admitted;
    const pointer = `/paths/${pointerPart(path)}`;
    const read = path.startsWith("/")
      ? yield* pathItem(sourcePaths[path], {
          inventory,
          path,
          pointer,
          modern: version[1] === "2",
        })
      : inventory.diagnostic(
          "invalid-path-key",
          pointer,
          "A Paths entry must start with /; it was not interpreted as an endpoint.",
        );
    if (!read.ok) return read;
  }
  return ok(
    completedInventory(inventory, {
      openapi: root.openapi,
      info: info.value,
      pathsState,
      examined,
    }),
  );
}
