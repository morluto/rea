import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { PriResourcesPort } from "./PriResourcesPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectPriResourcesInputSchema,
  priInspectionParameters,
  priNameSelection,
  priQualifierSelection,
  priResourcesSchema,
  type InspectPriResourcesInput,
  type PriResources,
} from "../../domain/native/priResources.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_pri_resources";

/** Shared caller validation, output parsing and Evidence provenance for CLI/MCP. */
export class PriResourcesService {
  constructor(readonly provider: PriResourcesPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectPriResourcesInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const report = priResourcesSchema.safeParse(result.value);
    if (!report.success || !validReport(report.data, input.data))
      return err(
        new AnalysisOutputError(
          OPERATION,
          "PRI resource provider returned malformed output, changed artifact identity or ignored the caller's selection.",
        ),
      );
    const value = report.data;
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          format: "file",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: priInspectionParameters(input.data),
          result: value,
          confidence: "observed",
          limitations: [...value.limitations, ...value.unknowns],
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
    );
  }
}

type Range = { readonly offset: number; readonly bytes: number };

/** Artifact identity, file framing and coverage arithmetic agree. */
const validSummary = (
  report: PriResources,
  input: InspectPriResourcesInput,
  inside: (range: Range) => boolean,
): boolean => {
  const { coverage, header } = report;
  const total = <Item>(items: readonly Item[], count: (item: Item) => number) =>
    items.reduce((sum, item) => sum + count(item), 0);
  return (
    report.artifact.path === input.path &&
    report.artifact.bytes <= input.max_file_bytes &&
    header.declared_bytes === report.artifact.bytes &&
    inside(header.toc) &&
    inside(header.footer) &&
    coverage.sections === header.section_count &&
    coverage.interpreted_sections <= coverage.sections &&
    coverage.items_without_candidates <= coverage.items &&
    coverage.external_candidates <= coverage.candidates &&
    total(report.section_summary, ({ sections }) => sections) ===
      coverage.sections &&
    total(report.resource_maps, ({ candidates }) => candidates) ===
      coverage.candidates
  );
};

/** The page answers the requested collection, offset and limit consistently. */
const validPaging = (
  page: PriResources["page"],
  input: InspectPriResourcesInput,
): boolean => {
  const rows =
    page.collection === "items"
      ? page.items
      : page.collection === "candidates"
        ? page.candidates
        : page.collection === "sections"
          ? page.sections
          : page.qualifiers;
  const continued = page.next_offset !== null;
  return (
    page.collection === input.collection &&
    page.offset === input.offset &&
    page.limit === input.limit &&
    page.returned === rows.length &&
    page.returned <= page.limit &&
    page.offset + page.returned <= Math.max(page.total, page.offset) &&
    (page.end === "exhausted") === !continued &&
    (!continued ||
      (page.next_offset === page.offset + page.returned &&
        page.offset + page.returned < page.total))
  );
};

/** Every returned row exists and satisfies the caller's selection. */
const validRows = (
  report: PriResources,
  input: InspectPriResourcesInput,
  inside: (range: Range) => boolean,
): boolean => {
  const { page } = report;
  if (page.collection === "sections")
    return page.sections.every(
      (section) =>
        section.index < report.header.section_count && inside(section.location),
    );
  if (page.collection === "qualifiers") return true;
  const selectedName = priNameSelection(input);
  const selectedQualifiers = priQualifierSelection(input.qualifiers);
  const wantedType = (type: string) =>
    input.value_types?.some((wanted) => wanted === type) ?? true;
  const selected = (row: { map: number; item: number; name: string }) =>
    row.item < (report.resource_maps[row.map]?.schema.items ?? 0) &&
    selectedName(row.name);
  if (page.collection === "items") {
    const filtered =
      input.qualifiers !== undefined || input.value_types !== undefined;
    return page.items.every(
      (row) =>
        selected(row) &&
        (row.decision !== null || row.candidates === 0) &&
        (!filtered || row.candidates > 0) &&
        row.value_types.every(wantedType),
    );
  }
  return page.candidates.every(
    (row) =>
      selected(row) &&
      (row.source.kind === "external"
        ? row.value === null
        : row.value !== null && inside(row.source.location)) &&
      wantedType(row.value_type) &&
      (selectedQualifiers?.(row.qualifiers) ?? true),
  );
};

/** Check identity, file ranges and the caller's selection before output becomes Evidence. */
const validReport = (
  report: PriResources,
  input: InspectPriResourcesInput,
): boolean => {
  const inside = ({ offset, bytes }: Range) =>
    offset <= report.artifact.bytes - bytes;
  return (
    validSummary(report, input, inside) &&
    validPaging(report.page, input) &&
    validRows(report, input, inside)
  );
};
