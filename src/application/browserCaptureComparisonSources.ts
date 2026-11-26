import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  browserCaptureComparisonInputSchema,
  browserCaptureComparisonRequestSchema,
  type BrowserCaptureComparisonInput,
  type BrowserCaptureComparisonRequest,
} from "../domain/browserCaptureComparison.js";
import type { z } from "zod";
import type { retainedEvidenceReferenceSchema } from "../domain/evidenceReference.js";
import { isRecord } from "../kernel/isRecord.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "./EvidenceInputResolver.js";

const OPERATION = "compare_web_captures";

type Producer =
  | "inspect_web_page"
  | "discover_webmcp_tools"
  | "capture_browser_scenario";

/** A comparison input with every capture inline, and the Evidence it came from. */
export interface ResolvedBrowserCaptureComparison {
  readonly input: BrowserCaptureComparisonInput;
  /** Exact IDs of the complete retained records the comparison read. */
  readonly sources: readonly string[];
}

type RetainedEvidenceReference = z.output<
  typeof retainedEvidenceReferenceSchema
>;

const isReference = (value: unknown): value is RetainedEvidenceReference =>
  isRecord(value) && value.kind === "retained-evidence";

/**
 * The retained summary's parent, when `record` is the inspect_analysis_view
 * summary of a `producer` record; otherwise `record` itself.
 */
const completeRecordId = (
  record: { readonly operation: string; readonly normalized_result: unknown },
  producer: Producer,
): string | undefined => {
  if (record.operation !== "inspect_analysis_view") return undefined;
  const summary = record.normalized_result;
  return isRecord(summary) &&
    summary.kind === "summary" &&
    summary.parent_operation === producer &&
    typeof summary.parent_evidence_id === "string"
    ? summary.parent_evidence_id
    : undefined;
};

/** Whether a raw request names any capture by retained reference. */
const namesRetainedCapture = (raw: unknown): boolean => {
  if (!isRecord(raw)) return false;
  const side = (value: unknown) =>
    isRecord(value) &&
    (isReference(value.inspection) || isReference(value.webmcp));
  return (
    isReference(raw.before_scenario) ||
    isReference(raw.after_scenario) ||
    side(raw.before) ||
    side(raw.after)
  );
};

/**
 * Admit a raw comparison request. Inline captures parse once as the
 * comparison input. A request that names a capture by retained reference
 * parses as a request; each reference is replaced with the complete producer
 * observation it names, and the assembled request parses as the comparison
 * input, so every canonical field is still validated. A reference to a
 * summary reads its retained parent.
 */
export const admitBrowserCaptureComparison = (
  raw: unknown,
  lookup: EvidenceLookup | undefined,
): Result<ResolvedBrowserCaptureComparison, AnalysisError> => {
  if (!namesRetainedCapture(raw)) {
    const input = parseAnalysisInput(
      OPERATION,
      raw,
      browserCaptureComparisonInputSchema,
    );
    return input.ok ? ok({ input: input.value, sources: [] }) : input;
  }
  const parsed = parseAnalysisInput(
    OPERATION,
    raw,
    browserCaptureComparisonRequestSchema,
  );
  if (!parsed.ok) return parsed;
  return resolveBrowserCaptureComparison(parsed.value, lookup);
};

/**
 * Inline captures of a parsed request are the comparison input's own field
 * values: each request field is the input field's schema or a reference.
 */
const isInlineOnly = (
  request: BrowserCaptureComparisonRequest,
): request is BrowserCaptureComparisonInput => !namesRetainedCapture(request);

/**
 * Resolve an already parsed comparison request. Inline captures are reused
 * as parsed; references resolve as in admitBrowserCaptureComparison.
 */
export const resolveBrowserCaptureComparison = (
  request: BrowserCaptureComparisonRequest,
  lookup: EvidenceLookup | undefined,
): Result<ResolvedBrowserCaptureComparison, AnalysisError> => {
  if (isInlineOnly(request)) return ok({ input: request, sources: [] });
  const sources: string[] = [];
  const resolve = (
    value: unknown,
    path: readonly string[],
    producer: Producer,
  ): Result<unknown, AnalysisError> => {
    if (!isReference(value)) return ok(value);
    const selected = resolveEvidenceInput(value, lookup);
    if (!selected.ok) return selected;
    const parentId = completeRecordId(selected.value, producer);
    const complete =
      parentId === undefined
        ? selected
        : resolveEvidenceInput(
            { kind: "retained-evidence", evidence_id: parentId },
            lookup,
          );
    if (!complete.ok) return complete;
    if (complete.value.operation !== producer)
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: [...path],
            reason: "invalid_value",
            message: `Select retained ${producer} Evidence or its inspect_analysis_view summary; ${value.evidence_id} is ${selected.value.operation} Evidence.`,
          },
        ]),
      );
    sources.push(complete.value.evidence_id);
    return ok(complete.value.normalized_result);
  };
  let assembled: Record<string, unknown>;
  if ("before_scenario" in request) {
    const before = resolve(
      request.before_scenario,
      ["before_scenario"],
      "capture_browser_scenario",
    );
    if (!before.ok) return before;
    const after = resolve(
      request.after_scenario,
      ["after_scenario"],
      "capture_browser_scenario",
    );
    if (!after.ok) return after;
    assembled = {
      ...request,
      before_scenario: before.value,
      after_scenario: after.value,
    };
  } else {
    const side = (
      name: "before" | "after",
    ): Result<Record<string, unknown>, AnalysisError> => {
      const inspection = resolve(
        request[name].inspection,
        [name, "inspection"],
        "inspect_web_page",
      );
      if (!inspection.ok) return inspection;
      const webmcp = resolve(
        request[name].webmcp,
        [name, "webmcp"],
        "discover_webmcp_tools",
      );
      if (!webmcp.ok) return webmcp;
      return ok({ inspection: inspection.value, webmcp: webmcp.value });
    };
    const before = side("before");
    if (!before.ok) return before;
    const after = side("after");
    if (!after.ok) return after;
    assembled = { before: before.value, after: after.value };
  }
  const input = parseAnalysisInput(
    OPERATION,
    assembled,
    browserCaptureComparisonInputSchema,
  );
  return input.ok ? ok({ input: input.value, sources }) : input;
};
