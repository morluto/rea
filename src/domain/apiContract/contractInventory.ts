import { Budget } from "../budget.js";
import { decodeLimit } from "../parseFailure.js";
import { parseLimitConstraint } from "../parseFailureAnalysisError.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { ellipsisExcerpt } from "../excerpt.js";
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
  /** Effective pointer for the operation slot under the referencing path. */
  readonly pointer: string;
  /**
   * Pointer where the operation is actually declared; it exists in the
   * artifact. For an inline operation it equals `pointer`; for an operation
   * reached through a resolved local $ref it names the target declaration.
   */
  readonly sourcePointer: string;
  readonly hasReference: boolean;
}

/** Defining pointers kept in a conflict diagnostic; never copied whole. */
const CONFLICT_POINTER_CHARS = 512;

/** Own compact declarations and account for repeated path/pointer serialization before allocation. */
export class ContractInventory {
  readonly operations: ApiContract["operations"] = [];
  readonly references: ApiContract["path_item_references"] = [];
  readonly diagnostics: ApiContractDiagnostic[] = [];
  /** A local "#/..." Path Item $ref was seen, so resolution was attempted. */
  localResolutionAttempted = false;
  readonly #retainedBytes = new Budget(API_CONTRACT_FACT_BYTES);
  /** Operation row index by operation_key; one row per path/method slot. */
  readonly #operationRowByKey = new Map<string, number>();
  /** Operation keys already diagnosed as conflicting declarations. */
  readonly #conflictedKeys = new Set<string>();
  /**
   * Diagnostics already retained, by code then source pointer. A diagnostic
   * identifies one fact at one location; a shared $ref target enumerated
   * under several paths must not repeat the same fact under one ID. The
   * nested lookup compares pointers without serializing them, so no copy
   * is made before the retained-facts allowance is checked.
   */
  readonly #reportedDiagnostics = new Map<string, Set<string>>();

  constructor(readonly artifact: ApiContractArtifact) {}

  reserve(bytes: number): Result<void, AnalysisError> {
    // Includes object/index overhead and repeated escaped Evidence delivery, not just source bytes.
    // The refusal is built from the limit the parser stopped at, so its name
    // and maximum travel with the failure instead of being spelled again here.
    return this.#retainedBytes.tryCharge(bytes)
      ? ok(undefined)
      : err(
          parseLimitConstraint(
            API_CONTRACT_OPERATION,
            "memory",
            decodeLimit(
              "openapi-json",
              "API contract declarations exceed the retained-facts representation allowance.",
              {
                name: "api-contract-retained-facts",
                maximum: API_CONTRACT_FACT_BYTES,
              },
            ),
            {
              legacyMaximumKey: "representation_bytes",
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
    const reported = this.#reportedDiagnostics.get(code);
    if (reported?.has(pointer)) return ok(undefined);
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
    let retained = reported;
    if (retained === undefined) {
      retained = new Set<string>();
      this.#reportedDiagnostics.set(code, retained);
    }
    retained.add(pointer);
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
    const operationKey = identity("api_operation_key", [
      slot.path,
      slot.method,
    ]);
    const earlierIndex = this.#operationRowByKey.get(operationKey);
    if (earlierIndex !== undefined) {
      // A second declaration of the same path/method slot: neither is
      // settled. Reclassify the earlier row when it claimed a declaration
      // and diagnose the conflict once, naming both defining pointers.
      const earlier = this.operations[earlierIndex];
      if (earlier !== undefined && earlier.state === "declared")
        this.operations[earlierIndex] = {
          ...earlier,
          state: "unknown",
          reason: "conflicting-operation",
          declared_id: null,
        };
      if (!this.#conflictedKeys.has(operationKey)) {
        this.#conflictedKeys.add(operationKey);
        return this.diagnostic(
          "conflicting-operation",
          slot.pointer,
          `${slot.method} is declared more than once for ${slot.path}: ${ellipsisExcerpt(earlier?.source_pointer ?? slot.sourcePointer, CONFLICT_POINTER_CHARS)} and ${ellipsisExcerpt(slot.sourcePointer, CONFLICT_POINTER_CHARS)}. The effective operation is unknown.`,
        );
      }
      return ok(undefined);
    }
    const admitted = this.reserve(
      1536 +
        slot.path.length * 32 +
        slot.method.length * 24 +
        slot.sourcePointer.length * 12 +
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
      // Identity carries both the effective slot and the defining pointer,
      // so two declarations of one slot stay distinguishable by operation_id.
      operation_id: identity("api_operation", [
        this.artifact.sha256,
        slot.pointer,
        slot.sourcePointer,
      ]),
      operation_key: operationKey,
      method: slot.method,
      path: slot.path,
      declared_id: declaredId,
      source_pointer: slot.sourcePointer,
      state: reason === null ? "declared" : "unknown",
      reason,
    });
    this.#operationRowByKey.set(operationKey, this.operations.length - 1);
    if (object === undefined)
      return this.diagnostic(
        "invalid-operation",
        slot.sourcePointer,
        "The method's value is not an Operation Object.",
      );
    if (Object.hasOwn(object, "operationId") && declaredId === null)
      return this.diagnostic(
        "invalid-operation-id",
        `${slot.sourcePointer}/operationId`,
        "operationId is present but is not a string; its identity remains unavailable.",
      );
    return ok(undefined);
  }
}
