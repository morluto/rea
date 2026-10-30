import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import { uniqueSorted } from "../canonicalOrdering.js";
import {
  evmInterfaceSchema,
  inspectEvmInterfaceInputSchema,
  matchesEvmInterfaceInput,
} from "../evm/evmInterface.js";
import { solcArtifactSchema, type SolcArtifact } from "../evm/solcArtifact.js";
import { err, ok, type Result } from "../result.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
  unknownViewCoverage,
} from "./analysisViewCoverage.js";
import {
  analysisTextPage,
  analysisTextPageItemSchema,
} from "./analysisViewText.js";

/** Retained inferred candidates or exact text; offsets for text count UTF-16 code units. */
export const evmViewRequestSchema = z.strictObject({
  kind: z.literal("evm"),
  facet: z.enum(["functions", "bytecode_hex", "stdout", "stderr"]),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
});

export const evmViewItemSchema = z.union([
  evmInterfaceSchema.shape.functions,
  analysisTextPageItemSchema,
]);

/** Selected compiler facts without duplicate bytecode or raw metadata text. */
const {
  object: _objectSchema,
  metadata: _metadataSchema,
  ...compilerFactsShape
} = solcArtifactSchema.shape;
const compilerArtifactSummarySchema = z.strictObject({
  ...compilerFactsShape,
  object_code_units: z.number().int().nonnegative().nullable(),
  metadata: solcArtifactSchema.shape.metadata.omit({ raw: true }).extend({
    raw_code_units: z.number().int().nonnegative().nullable(),
  }),
});

const compilerArtifactSummary = (artifact: SolcArtifact) => {
  const { object, metadata, ...facts } = artifact;
  const { raw, ...metadataFacts } = metadata;
  return {
    ...facts,
    object_code_units: object?.length ?? null,
    metadata: { ...metadataFacts, raw_code_units: raw?.length ?? null },
  };
};

/** Complete inferred interface facts without the unrequested hex or duplicated stdout. */
export const evmSummarySchema = z.strictObject({
  artifact: evmInterfaceSchema.shape.artifact,
  bytecode: evmInterfaceSchema.shape.bytecode.omit({ hex: true }),
  evidence_kind: evmInterfaceSchema.shape.evidence_kind,
  functions: evmInterfaceSchema.shape.functions,
  discovery_completeness: evmInterfaceSchema.shape.discovery_completeness,
  runtime_execution: evmInterfaceSchema.shape.runtime_execution,
  compiler_artifact: compilerArtifactSummarySchema.optional(),
  inference_status: evmInterfaceSchema.shape.inference_status,
  diagnostics: evmInterfaceSchema.shape.diagnostics
    .omit({ stdout: true })
    .extend({
      stdout_code_units: z.int().nonnegative(),
    }),
  limitations: evmInterfaceSchema.shape.limitations,
});

/** Select already authenticated producer facts; no interpreter or provider is invoked. */
export const projectEvmInterfaceView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof evmViewRequestSchema>
  >(admitted, "summary", "evm");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "EVM Evidence supports summary and evm views.",
        },
      ]),
    );
  const parsed = parseAnalysisViewResult(evmInterfaceSchema, parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const subject = parent.subject;
  if (
    subject == null ||
    subject.format !== "file" ||
    subject.digest.sha256 !== report.artifact.sha256
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "EVM parent subject must identify the report's carrier format and SHA-256.",
        },
      ]),
    );
  if (report.compiler_artifact !== undefined) {
    const input = inspectEvmInterfaceInputSchema.safeParse(parent.parameters);
    if (!input.success || !matchesEvmInterfaceInput(report, input.data))
      return err(
        analysisViewInputError([
          {
            path: ["source", "parameters"],
            reason: "invalid_value",
            message:
              "EVM compiler parent parameters must identify the exact carrier, encoding and compiler selection.",
          },
        ]),
      );
  }
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_evm_interface" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      `Candidates remain inferred; discovery completeness, ${report.bytecode.kind === "unknown" ? "bytecode kind, " : ""}hardfork and deployment authenticity are unknown. Runtime execution was not performed.`,
      ...(report.inference_status === "unavailable"
        ? [
            "Interface inference is unavailable for the selected compiler object; candidate total and exhaustion are unknown.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const { hex: _hex, ...bytecode } = report.bytecode;
    const { stdout, ...diagnostics } = report.diagnostics;
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: {
        artifact: report.artifact,
        bytecode,
        evidence_kind: report.evidence_kind,
        functions: report.functions,
        discovery_completeness: report.discovery_completeness,
        runtime_execution: report.runtime_execution,
        ...(report.compiler_artifact === undefined
          ? {}
          : {
              compiler_artifact: compilerArtifactSummary(
                report.compiler_artifact,
              ),
            }),
        ...(report.inference_status === undefined
          ? {}
          : { inference_status: report.inference_status }),
        diagnostics: { ...diagnostics, stdout_code_units: stdout.length },
        limitations: report.limitations,
      },
      coverage:
        report.inference_status === "unavailable"
          ? unknownViewCoverage()
          : completeWithinViewCoverage(
              report.functions.length,
              report.functions.length,
            ),
    });
  }
  if (view.facet === "functions") {
    const item = report.functions.slice(view.offset, view.offset + view.limit);
    return ok({
      kind: "evm" as const,
      view,
      item,
      ...shared,
      coverage:
        report.inference_status === "unavailable"
          ? unknownViewCoverage()
          : pageViewCoverage(view.offset, item.length, report.functions.length),
    });
  }
  const text =
    view.facet === "bytecode_hex"
      ? report.bytecode.hex
      : report.diagnostics[view.facet];
  if (text === null)
    return err(
      analysisViewInputError([
        {
          path: ["view", "facet"],
          reason: "invalid_value",
          message:
            "Decoded bytecode hex is unavailable for the selected compiler object; inspect its compiler artifact evidence.",
        },
      ]),
    );
  const page = analysisTextPage(text, view.offset, view.limit, view.facet);
  return page.ok
    ? ok({ kind: "evm" as const, view, ...page.value, ...shared })
    : page;
};
