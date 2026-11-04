import type { z } from "zod";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import type { recordedArrayViewSchema } from "./analysisViewRequest.js";

const PAGE_BYTES = 1024 * 1024;

/** Page an exact array within authenticated provider-recorded raw JSON. */
export const projectRecordedArrayView = (
  parent: AnalysisViewParent,
  view: z.output<typeof recordedArrayViewSchema>,
) => {
  let value: unknown = parent.rawResult;
  for (const key of view.path) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, key)
    )
      return err(
        analysisViewInputError([
          {
            path: ["view", "path"],
            reason: "invalid_value",
            message:
              "The selected path does not identify an object member in recorded raw data.",
          },
        ]),
      );
    value = (value as Record<string, unknown>)[key];
  }
  if (!Array.isArray(value))
    return err(
      analysisViewInputError([
        {
          path: ["view", "path"],
          reason: "invalid_value",
          message: "The selected recorded raw value is not an array.",
        },
      ]),
    );
  const rows: JsonValue[] = [];
  const result = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: parent.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    kind: "recorded-array" as const,
    view,
    rows,
    coverage: pageViewCoverage(view.offset, 0, value.length),
    limitations: [
      "These are raw provider-recorded values; interpretation and provider coverage require the parent Evidence.",
    ],
    unknowns: [],
  };
  // Include the sealed digest and reserve the longest numeric coverage fields
  // before adding rows. Output transport may impose a smaller separate limit.
  let bytes = jsonValueByteLength(
    {
      ...result,
      view_digest: "0".repeat(64),
      coverage: {
        status: "complete-within-view",
        examined: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        next_offset: Number.MAX_SAFE_INTEGER,
        exhausted: false,
      },
    },
    PAGE_BYTES,
  );
  const tooLarge = () =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "memory",
        "Recorded array view exceeds the 1 MiB page allowance.",
        { maximum_page_bytes: PAGE_BYTES },
        {
          retryable: false,
          remediationAction:
            "The selected path or one recorded value exceeds the 1,048,576-byte analysis-view page allowance. Retrieve or export the complete parent Evidence, or read it from the caller-supplied Evidence file or bundle.",
        },
      ),
    );
  if (bytes > PAGE_BYTES) return tooLarge();
  const end = Math.min(value.length, view.offset + view.limit);
  for (let i = view.offset; i < end; i++) {
    const row = value[i] as JsonValue;
    const comma = rows.length === 0 ? 0 : 1;
    const size = jsonValueByteLength(row, PAGE_BYTES - bytes - comma);
    if (bytes + comma + size > PAGE_BYTES) {
      if (rows.length === 0) return tooLarge();
      break;
    }
    bytes += comma + size;
    rows.push(row);
  }
  return ok({
    ...result,
    coverage: pageViewCoverage(view.offset, rows.length, value.length),
  });
};
