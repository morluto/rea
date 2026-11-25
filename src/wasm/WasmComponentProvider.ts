import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  type ArtifactReaderFailure,
  type StableArtifactSnapshot,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { WasmComponentPort } from "../ports/wasm/WasmComponentPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  cancelledBy,
  fixedCeilingConstraint,
  isAborted,
  unsupportedTarget,
  type AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import type { ParseFailureError } from "../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../domain/parseFailureAnalysisError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  WASM_COMPONENT_GRAMMAR,
  wasmComponentSchema,
  type InspectWasmComponentInput,
  type WasmComponent,
} from "../domain/wasm/wasmComponent.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import { decodeWasmComponent } from "./WasmComponentDecoder.js";
import { WASM_COMPONENT_PROVIDER_IDENTITY } from "./WasmComponentProviderIdentity.js";
import {
  componentLimit,
  CORE_MODULE_FIELD,
  isWasmComponentFormatFailure,
  MAX_INLINE_RESULT_BYTES,
  WASM_COMPONENT_FORMAT,
} from "./WasmComponentReader.js";

const OPERATION = "inspect_wasm_component";
const INPUT_BYTES = 8 * 1024 * 1024;

/** The decoder's own allowances; the input and report bounds have no control yet. */
const limitConstraint = (
  failure: ParseFailureError<"limit">,
  path: string,
): AnalysisResourceConstraintError => {
  const { name, maximum } = failure.failure.limit;
  return name === "decoded-items"
    ? parseLimitConstraint(OPERATION, "memory", failure, {
        path,
        legacyMaximumKey: "maximum_decoded_entries",
        ...fixedAllowanceOptions(
          "The decoded component entry allowance",
          "report",
          { limit: maximum, unit: "entries" },
        ),
      })
    : parseLimitConstraint(OPERATION, "transport", failure, {
        path,
        legacyMaximumKey: "maximum_output_bytes",
        ...fixedAllowanceOptions(
          "The inline component report allowance",
          "report",
          { limit: maximum, unit: "bytes" },
        ),
      });
};

const fileSizeConstraint = (
  failure: ArtifactReaderFailure,
): AnalysisResourceConstraintError =>
  fixedCeilingConstraint(
    OPERATION,
    "file-size",
    failure.message,
    fixedAllowanceOptions("the component input allowance", "input", {
      limit: INPUT_BYTES,
      unit: "bytes",
    }).fixedAllowance,
    { cause: failure },
  );

/**
 * Classify one failed inspection, keeping the completed file identity and any
 * unresolved read cleanup on the reported failure.
 */
const failureFor = (
  cause: unknown,
  path: string,
  snapshot: CompletedIdentity | undefined,
  signal?: AbortSignal,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: WASM_COMPONENT_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path,
      description: "WebAssembly component",
      recognise: (failure) => {
        // The decoder throws the signal's own reason. Only that exact value is
        // cancellation; a read failure that merely coincides with a later
        // abort keeps its own classification.
        if (isAborted(signal) && failure === signal.reason)
          return cancelledBy(OPERATION, signal);
        if (isParseLimit(failure, WASM_COMPONENT_FORMAT))
          return limitConstraint(failure, path);
        if (
          isWasmComponentFormatFailure(failure) &&
          failure.failure.field === CORE_MODULE_FIELD
        )
          return unsupportedTarget(
            OPERATION,
            path,
            WASM_COMPONENT_FORMAT,
            failure.message,
            {
              cause: failure,
              field: failure.failure.field,
              ...(failure.failure.offset === undefined
                ? {}
                : { offset: failure.failure.offset }),
              related: { operations: ["inspect_wasm_artifact"] },
            },
          );
        return undefined;
      },
      fileSize: fileSizeConstraint,
      unclassified: (failure) =>
        new ProviderAdapterError(
          WASM_COMPONENT_PROVIDER_IDENTITY.id,
          OPERATION,
          {
            cause: failure,
            diagnostics: { path, reason: errorMessage(failure) },
          },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    path,
    WASM_COMPONENT_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

/** Byte identity of a stable read that completed before a later failure. */
interface CompletedIdentity {
  readonly sha256: string;
  readonly bytes: number;
}

const LIMITATIONS = [
  "Decoding is structural against the pinned component-model Binary.md grammar. Type correctness, name uniqueness, index bounds and canonical ABI rules are not validated, so a decoded component can still be invalid.",
  "Embedded core modules are identified by byte range and SHA-256; only their import and export sections are read. No component or module is instantiated or executed.",
  "Lift and lower relationships follow index-space origins inside one component. Outer aliases, values and instantiated nested components are not traced.",
  "Value-section payloads are retained by type and byte range only.",
];

/** Read one selected component in process, without subprocesses, temporary files or execution. */
export class WasmComponentProvider implements WasmComponentPort {
  readonly identity = WASM_COMPONENT_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  /** Retry release of read handles whose cleanup failed. */
  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        WASM_COMPONENT_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectWasmComponentInput,
    options?: ExecutionOptions,
  ): Promise<Result<WasmComponent, AnalysisError>> {
    let completed: CompletedIdentity | undefined;
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          INPUT_BYTES,
          options?.signal,
          undefined,
          this.#resources,
        );
        completed = { sha256: snapshot.sha256, bytes: snapshot.bytes.length };
        assertArtifactReadActive(options?.signal);
        return ok(await this.#decode(input.path, snapshot, options?.signal));
      });
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, completed, options?.signal));
    }
  }

  async #decode(
    path: string,
    snapshot: StableArtifactSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<WasmComponent> {
    const decoded = await decodeWasmComponent(snapshot.bytes, signal);
    const invalidNames = decoded.components.some(
      (component) => component.names?.status === "invalid",
    );
    const report = {
      artifact: {
        path,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes.length,
      },
      decoder: {
        id: WASM_COMPONENT_PROVIDER_IDENTITY.id,
        version: WASM_COMPONENT_PROVIDER_IDENTITY.version,
        grammar: WASM_COMPONENT_GRAMMAR.source,
        admitted_version: WASM_COMPONENT_GRAMMAR.version,
        admitted_layer: WASM_COMPONENT_GRAMMAR.layer,
      },
      validation: "not_performed",
      components: decoded.components,
      type_scopes: decoded.typeScopes,
      gated_features: decoded.features,
      coverage: {
        status: decoded.notDecoded.length === 0 ? "complete" : "partial",
        not_decoded: decoded.notDecoded,
      },
      limitations: [
        ...LIMITATIONS,
        ...(decoded.notDecoded.length === 0
          ? []
          : [
              "Some content was not decoded (see coverage.not_decoded). After a section that was not decoded, indices that later definitions add to its sorts are null because their positions are unknown; earlier indices stay known.",
            ]),
        ...(invalidNames
          ? [
              "A component-name section could not be decoded completely; names decoded before the failure are retained.",
            ]
          : []),
      ],
    };
    if (
      Buffer.byteLength(JSON.stringify(report), "utf8") >
      MAX_INLINE_RESULT_BYTES
    )
      throw componentLimit("output-bytes", MAX_INLINE_RESULT_BYTES);
    const parsed = wasmComponentSchema.safeParse(report);
    if (!parsed.success)
      throw new AnalysisOutputError(
        OPERATION,
        "Component decoder produced invalid ranges or report values.",
        { cause: parsed.error },
      );
    assertArtifactReadActive(signal);
    return parsed.data;
  }
}
