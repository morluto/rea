import { basename } from "node:path";
import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { GO_BINARY_PROVIDER_IDENTITY } from "./GoBinaryProviderIdentity.js";
import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  yieldArtifactRead,
  ArtifactResourceScope,
  ArtifactReaderFailure,
} from "../resources/index.js";
import type { ExecutionOptions } from "../ports/AnalysisProvider.js";
import type { GoBinaryPort } from "../ports/go/GoBinaryPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../providers/offlineArtifactFailure.js";
import {
  goBinarySchema,
  goAnalysisBudgets,
  GO_ANALYSIS_BUDGET_DEFAULTS,
  GO_ANALYSIS_BUDGET_MAXIMA,
  type GoAnalysisBudgets,
  type GoBinary,
  type GoStringLiterals,
  type InspectGoBinaryInput,
} from "../domain/go/goBinary.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readGoBinaryImage,
  readGoBinaryImageCooperative,
  type GoBinaryImage,
} from "./GoBinaryImage.js";
import { requireSelectedNativeImage } from "../domain/apple/machoSliceSelection.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../domain/binaryContainer.js";
import { errorMessage } from "../kernel/errorMessage.js";

const OPERATION = "inspect_go_binary";

const budgetRecovery = (
  parameter: keyof GoAnalysisBudgets,
  value: number,
): string =>
  value < GO_ANALYSIS_BUDGET_MAXIMA[parameter]
    ? `Increase ${parameter} above ${String(value)} (maximum ${String(GO_ANALYSIS_BUDGET_MAXIMA[parameter])}) on the next inspect_go_binary request; no restart is required.`
    : `${parameter} is at its runtime representation maximum ${String(value)}; no larger value is supported. Preserve the complete selected artifact and report this boundary rather than repeating the unchanged request.`;

/** The per-call control of an exhausted budget, while a larger value is selectable. */
const budgetLimit = (
  parameter: keyof GoAnalysisBudgets,
  value: number,
): { readonly limit?: AnalysisControlLimit } =>
  value < GO_ANALYSIS_BUDGET_MAXIMA[parameter]
    ? {
        limit: {
          control_kind: "parameter",
          parameter,
          effective_value: value,
          unit: parameter.endsWith("_bytes") ? "bytes" : "count",
          minimum: 1,
          maximum: GO_ANALYSIS_BUDGET_MAXIMA[parameter],
          default_value: GO_ANALYSIS_BUDGET_DEFAULTS[parameter],
          applies_at: "next_call",
        },
      }
    : {};

const failureFor = (
  cause: unknown,
  path: string,
  budgets: GoAnalysisBudgets,
  snapshot?: StableArtifactSnapshot,
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: GO_BINARY_PROVIDER_IDENTITY.id,
      operation: OPERATION,
      path,
      description: "artifact",
      recognise: (failure, origin) => {
        if (failure instanceof BinaryResourceFailure) {
          const parameter =
            failure.boundary === "search"
              ? "max_header_search_bytes"
              : failure.boundary === "build-info"
                ? "max_build_info_bytes"
                : undefined;
          return parseLimitConstraint(
            OPERATION,
            failure.boundary === "search" ? "cpu" : "memory",
            failure,
            {
              path,
              ...(parameter === undefined
                ? fixedAllowanceOptions(
                    "The Go structural decoding allowance",
                    "parser",
                    binaryResourceCeiling(failure),
                  )
                : {
                    retryable: false,
                    remediationAction: `${failure.boundary === "search" ? "The Go build-info header-search allowance" : "The Go build-info string allowance"} is ${String(budgets[parameter])} bytes. ${budgetRecovery(parameter, budgets[parameter])} Other byte and report budgets are independent. Repeating the unchanged request cannot raise this allowance.`,
                    ...budgetLimit(parameter, budgets[parameter]),
                  }),
            },
          );
        }
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        )
          return new AnalysisResourceConstraintError(
            OPERATION,
            "file-size",
            failure.message,
            {
              maximum_input_bytes: budgets.max_input_bytes,
              parameter: "max_input_bytes",
              unit: "bytes",
            },
            {
              cause: failure,
              retryable: false,
              remediationAction: `${budgetRecovery("max_input_bytes", budgets.max_input_bytes)} Report, build-info and structural allowances remain independent. Preserve the complete artifact; do not truncate required bytes.`,
              ...budgetLimit("max_input_bytes", budgets.max_input_bytes),
            },
          );
        return undefined;
      },
      unclassified: (failure) =>
        new ProviderAdapterError(GO_BINARY_PROVIDER_IDENTITY.id, OPERATION, {
          cause: failure,
          diagnostics: {
            path,
            reason: errorMessage(failure),
          },
        }),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    path,
    GO_BINARY_PROVIDER_IDENTITY.id,
    OPERATION,
    snapshot,
  );
};

const outputLimit = (path: string, maximumBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete Go metadata for ${path} exceeds the inline output budget; no partial success is returned.`,
    {
      maximum_output_bytes: maximumBytes,
      parameter: "max_report_bytes",
      unit: "bytes",
    },
    {
      retryable: false,
      remediationAction: `The Go complete-report allowance is ${String(maximumBytes)} bytes. ${budgetRecovery("max_report_bytes", maximumBytes)} This did not produce complete Evidence to page. MCP delivery limits remain independent.`,
      ...budgetLimit("max_report_bytes", maximumBytes),
    },
  );

/** Fixed reader boundaries plus unknowns left by the observed metadata. */
const limitationsFor = (
  image: GoBinaryImage,
  stringLiterals: GoStringLiterals | undefined,
  budgets: GoAnalysisBudgets,
): string[] => {
  const {
    build_info: info,
    section_names_limitation: sectionNamesLimitation,
    macho_chained_fixups: machoChainedFixups,
  } = image;
  return [
    "Embedded build metadata is observed file content, not proof of compiler identity, dependency authenticity or runtime behavior.",
    stringLiterals === undefined
      ? "Only Go build information is inspected; function names, source mappings, type metadata and decompiled code are not recovered."
      : "Only Go build information and inferred static (ptr, len) string-header candidates are inspected; function names, source mappings, type metadata and decompiled code are not recovered.",
    `Resource guards use max_input_bytes=${String(budgets.max_input_bytes)}, max_header_search_bytes=${String(budgets.max_header_search_bytes)}, max_build_info_bytes=${String(budgets.max_build_info_bytes)} and max_report_bytes=${String(budgets.max_report_bytes)}; increase the named per-call budget for the next inspection when needed. Native structural table decoding retains its separate 16 MiB bound. These are not operating-system memory or CPU limits.`,
    ...(info !== null && (info.go_version === null || info.module_text === null)
      ? [
          "Some embedded Go strings contain non-UTF8 bytes; undecodable text is null and exact source bytes are preserved as base64.",
        ]
      : []),
    ...(info === null
      ? [
          "No recognized Go build-info record was found in the inspected image; absent metadata does not establish that the binary is not Go.",
        ]
      : []),
    ...(sectionNamesLimitation === undefined ? [] : [sectionNamesLimitation]),
    ...(info !== null && info.module.main === null
      ? [
          "Dependency coverage is unknown because no main-module record was decoded from the embedded module information, as in GOPATH-mode builds. Decoded dependency records remain visible; an empty list does not establish the absence of dependencies.",
        ]
      : []),
    ...(info?.module.complete === false
      ? [
          "Some embedded module-text records could not be parsed completely; their original lines are preserved and additional metadata remains unknown.",
        ]
      : []),
    ...(stringLiterals === undefined
      ? []
      : [
          "Recovered string_literals are inferred from pointer-aligned (ptr, len) pairs in non-executable mapped data pointing to printable UTF-8 slices within single read-only spans; compiler-inlined or stack-constructed strings without static headers, unapplied relocation addends and runtime reachability are not established.",
          ...(machoChainedFixups === true
            ? [
                "This Mach-O declares LC_DYLD_CHAINED_FIXUPS; rebase-encoded pointer slots in writable data may not hold raw virtual addresses statically, so (ptr, len) recovery can miss writable-section string headers.",
              ]
            : []),
          ...(stringLiterals.truncated
            ? [
                `Recovered string_literals were truncated at ${stringLiterals.limits_reached?.map((parameter) => `${parameter}=${String(budgets[parameter])}`).join(", ") ?? "a configured recovery budget"}; increase the named per-call budget(s), then inspect the same complete artifact again. Additional static (ptr, len) candidates may exist. No restart is required.`,
              ]
            : []),
        ]),
  ];
};

/** Locate image-relative build-info ranges in the selected file. */
const inFile = (
  info: GoBinaryImage["build_info"],
  fileOffset: number,
): GoBinaryImage["build_info"] =>
  info === null || fileOffset === 0
    ? info
    : {
        ...info,
        header_offset: info.header_offset + fileOffset,
        version_location: {
          ...info.version_location,
          offset: info.version_location.offset + fileOffset,
        },
        module_location: {
          ...info.module_location,
          offset: info.module_location.offset + fileOffset,
        },
      };

const inFileStringLiterals = (
  literals: GoStringLiterals | undefined,
  fileOffset: number,
): GoStringLiterals | undefined =>
  literals === undefined || fileOffset === 0
    ? literals
    : {
        ...literals,
        items: literals.items.map((item) => ({
          ...item,
          location: {
            ...item.location,
            offset: item.location.offset + fileOffset,
          },
          first_header_offset: item.first_header_offset + fileOffset,
        })),
      };

/** Stable in-process metadata inspection without subprocesses, temporary files or Go installation. */
export class GoBinaryProvider implements GoBinaryPort {
  readonly identity = GO_BINARY_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        GO_BINARY_PROVIDER_IDENTITY.id,
        OPERATION,
      );
    }
  }

  /** Read complete compiler/module metadata while preserving original byte identity and source ranges. */
  async inspect(
    input: Omit<InspectGoBinaryInput, "detail">,
    options?: ExecutionOptions,
  ): Promise<Result<GoBinary, AnalysisError>> {
    let snapshot: StableArtifactSnapshot | undefined;
    const budgets = goAnalysisBudgets(input);
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          budgets.max_input_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const selected = requireSelectedNativeImage(
          OPERATION,
          input.path,
          snapshot.bytes,
          input.architecture,
        );
        const imageOptions = {
          includeStringLiterals: input.include_string_literals === true,
          budgets,
          checkActive: () => assertArtifactReadActive(options?.signal),
        };
        const image =
          options?.signal === undefined
            ? readGoBinaryImage(selected.bytes, imageOptions)
            : await readGoBinaryImageCooperative(
                selected.bytes,
                imageOptions,
                () => yieldArtifactRead(options.signal),
              );
        const {
          section_names_limitation: _sectionNamesLimitation,
          macho_chained_fixups: _machoChainedFixups,
          string_literals: rawStringLiterals,
          ...publicImage
        } = image;
        const info = inFile(image.build_info, selected.fileOffset);
        const stringLiterals = inFileStringLiterals(
          rawStringLiterals,
          selected.fileOffset,
        );
        const report = {
          ...publicImage,
          artifact: {
            path: input.path,
            file_name: basename(input.path),
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          ...(selected.selection === null
            ? {}
            : { selected_slice: selected.selection }),
          build_info: info,
          ...(stringLiterals === undefined
            ? {}
            : { string_literals: stringLiterals }),
          limitations: [
            ...limitationsFor(image, stringLiterals, budgets),
            ...selected.limitations,
          ],
        };
        if (
          jsonValueByteLength(report, budgets.max_report_bytes) >
          budgets.max_report_bytes
        )
          throw outputLimit(input.path, budgets.max_report_bytes);
        const parsed = goBinarySchema.safeParse(report);
        if (!parsed.success)
          throw new AnalysisOutputError(
            OPERATION,
            "Go reader produced invalid source ranges or report values.",
            { cause: parsed.error },
          );
        assertArtifactReadActive(options?.signal);
        return ok(parsed.data);
      });
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, budgets, snapshot));
    }
  }
}
