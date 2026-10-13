import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  webNetworkCaptureRecordSchema,
  webNetworkCaptureBinaryDescriptorSchema,
  webNetworkCaptureSchema,
  webNetworkCaptureArtifactSchema,
  webNetworkCaptureDecoderSchema,
  WEB_NETWORK_CAPTURE_FORMATS,
  type WebNetworkCaptureRecord,
  type WebNetworkCapture,
} from "../webNetworkCapture.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  qlogSummarySchema,
  summarizeQlogCapture,
  projectQlogCapturePage,
} from "./qlogCaptureView.js";

/** Offsets page the parent's retained record order, preserving producer ordinals. */
export const captureViewRequestSchema = z.strictObject({
  kind: z.literal("capture"),
  detail: z.enum(["preview", "complete"]).default("preview"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

const previewSchema = webNetworkCaptureRecordSchema.extend({
  binary_fields: z.array(webNetworkCaptureBinaryDescriptorSchema),
});
export const captureViewItemsSchema = z.array(
  z.union([webNetworkCaptureRecordSchema, previewSchema]),
);

/** Count/identity overview; bodies and the archive member inventory stay in the parent. */
export const captureSummarySchema = z.strictObject({
  artifact: webNetworkCaptureArtifactSchema,
  decoder: webNetworkCaptureDecoderSchema,
  format: z.enum(WEB_NETWORK_CAPTURE_FORMATS),
  total_records: z.number().int().nonnegative(),
  retained_records: z.number().int().nonnegative(),
  runtime_attribution: z.literal("unknown"),
  qlog: qlogSummarySchema.optional(),
});

const object = (
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;

/** Select already parsed producer facts without interpreting HTTP or payload bytes again. */
const preview = (record: WebNetworkCaptureRecord) => {
  const source = object(record.reported);
  const reported: Record<string, JsonValue> = {};
  const selectedPointers = new Set<string>();
  if (source !== null) {
    for (const key of ["session_id", "name", "time", "startedDateTime", "type"])
      if (Object.hasOwn(source, key) && source[key] !== undefined) {
        reported[key] = source[key];
        selectedPointers.add(`/${key}`);
      }
    for (const key of ["request", "response"]) {
      const value = source[key];
      if (!Object.hasOwn(source, key) || value === undefined) continue;
      const fields = object(value);
      if (fields === null) {
        // Preserve a reported null/scalar instead of inventing HTTP fields.
        reported[key] = value;
        continue;
      }
      const selected: Record<string, JsonValue> = {};
      for (const field of [
        "method",
        "url",
        "httpVersion",
        "http_version",
        "status",
        "statusText",
        "reason",
      ])
        if (Object.hasOwn(fields, field) && fields[field] !== undefined) {
          selected[field] = fields[field];
          selectedPointers.add(`/${key}/${field}`);
        }
      reported[key] = selected;
    }
  }
  return {
    ...record,
    reported: source === null ? record.reported : reported,
    binary_fields: record.binary_fields.map(
      ({ content_base64: _content, ...field }) => field,
    ),
    numeric_literals:
      source === null
        ? record.numeric_literals
        : record.numeric_literals.filter(({ pointer }) =>
            selectedPointers.has(pointer),
          ),
  };
};

/** Authenticate the retained report and its subject at one owning boundary. */
const parseCaptureParent = (
  parent: AnalysisViewParent,
): Result<WebNetworkCapture, AnalysisError> => {
  const parsed = webNetworkCaptureSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  const report = parsed.data;
  if (
    report.artifact.sha256 !== null &&
    (parent.subject == null ||
      parent.subject.local_path !== report.artifact.path ||
      parent.subject.digest.sha256 !== report.artifact.sha256)
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Capture parent subject must identify the report's exact path and SHA-256.",
        },
      ]),
    );
  return ok(report);
};

/** Page immutable retained facts; no capture file, provider or network is consulted. */
export const projectWebNetworkCaptureView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (
    view.kind !== "summary" &&
    view.kind !== "capture" &&
    view.kind !== "qlog"
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Historical captures support summary, capture record pages, qlog fact pages and admitted api-surface views.",
        },
      ]),
    );
  const parsed = parseCaptureParent(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_web_network_capture" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: [
      ...new Set([
        ...parent.limitations,
        ...report.limitations,
        "Capture record pages cover the records selected into the parent Evidence, in that selected order; total_records counts the original decoded capture.",
      ]),
    ],
    unknowns: [
      "Historical records do not establish live runtime attribution or deployment authenticity.",
      ...(report.artifact.sha256 === null
        ? ["The explicitly excluded artifact digest remains unknown."]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        artifact: report.artifact,
        decoder: report.decoder,
        format: report.format,
        total_records: report.total_records,
        retained_records: report.records.length,
        runtime_attribution: report.runtime_attribution,
        ...(report.format === "qlog"
          ? { qlog: summarizeQlogCapture(report.qlog) }
          : {}),
      },
      coverage: completeWithinViewCoverage(
        report.records.length,
        report.records.length,
      ),
    });
  if (view.kind === "qlog") {
    if (report.format !== "qlog")
      return err(
        analysisViewInputError([
          {
            path: ["view", "kind"],
            reason: "invalid_value",
            message: "Qlog fact views require retained qlog Evidence.",
          },
        ]),
      );
    const projected = projectQlogCapturePage(report.qlog, view);
    return projected.ok
      ? ok({
          kind: "qlog",
          view,
          ...shared,
          ...projected.value,
          limitations: [
            ...shared.limitations,
            "Qlog fact pages retain all-recorded-events-before-selection scope. Exhausting a page does not establish network completeness, body recovery, retransmission or actual loss.",
          ],
        })
      : projected;
  }
  const records = report.records.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "capture",
    view,
    ...shared,
    items: captureViewItemsSchema.parse(
      view.detail === "complete" ? records : records.map(preview),
    ),
    coverage: pageViewCoverage(
      view.offset,
      records.length,
      report.records.length,
    ),
    limitations: [
      ...shared.limitations,
      ...(view.detail === "preview"
        ? [
            "Preview selects recorded headline fields and byte descriptors; headers, XML, bodies, message data and other fields remain in complete record pages. Missing preview fields do not establish their absence from the producer record.",
          ]
        : []),
    ],
  });
};
