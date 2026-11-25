import { Budget } from "../budget.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
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
import { isRecord } from "../../kernel/isRecord.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? (value as Record<string, unknown>) : undefined;
const identity = (prefix: string, facts: unknown) =>
  `${prefix}_${digestCanonicalValue(facts)}`;

interface OperationSlot {
  readonly path: string;
  readonly method: string;
  readonly pointer: string;
  readonly hasReference: boolean;
}

/** Own compact declarations and account for repeated path/pointer serialization before allocation. */
export class ContractInventory {
  readonly operations: ApiContract["operations"] = [];
  readonly references: ApiContract["path_item_references"] = [];
  readonly diagnostics: ApiContractDiagnostic[] = [];
  /** A local "#/..." Path Item $ref was seen, so resolution was attempted. */
  localResolutionAttempted = false;
  readonly #retainedBytes = new Budget(API_CONTRACT_FACT_BYTES);

  constructor(readonly artifact: ApiContractArtifact) {}

  reserve(bytes: number): Result<void, AnalysisError> {
    // Includes object/index overhead and repeated escaped Evidence delivery, not just source bytes.
    return this.#retainedBytes.tryCharge(bytes)
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
    state: "resolved" | "unresolved" = "unresolved",
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
      state: typeof value === "string" ? state : "malformed",
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
