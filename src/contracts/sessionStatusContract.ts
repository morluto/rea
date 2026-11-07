import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";

/** Caller-selected binary_session projections. */
export const BINARY_SESSION_DETAILS = [
  "summary",
  "complete",
  "operation",
] as const;
export type BinarySessionDetail = (typeof BINARY_SESSION_DETAILS)[number];

/**
 * Fields a summary leaves out, as dotted paths through arrays. Each stays
 * available from the same session with detail: "complete".
 */
export const BINARY_SESSION_SUMMARY_OMITTED_FIELDS = [
  "analysis_provider_candidates.availability.remediation",
  "analysis_provider_candidates.availability.diagnostics",
  "analysis_provider_candidates.target_support.diagnostics",
  "analysis_provider_candidates.capabilities",
  "tool_availability.groups.surface",
  "tool_availability.groups.effects",
  "tool_availability.groups.annotations",
] as const;

/**
 * Fields the operation view leaves out. operation_candidates replaces the
 * candidate list, and tool_availability keeps only the requested tool. Each
 * stays available from the same session with detail: "complete".
 */
export const BINARY_SESSION_OPERATION_OMITTED_FIELDS = [
  "analysis_provider_candidates",
  "tool_availability.other_tools",
  "tool_availability.groups.surface",
  "tool_availability.groups.effects",
  "tool_availability.groups.annotations",
] as const;

/** Optional expectations used to compare the live session with its caller. */
export const binarySessionInputSchema = z
  .strictObject({
    detail: z
      .enum(BINARY_SESSION_DETAILS)
      .default("summary")
      .describe(
        "Start with summary (default): it keeps open state, the binding, current-route capabilities (including selected Ghidra checkpoint mode), each provider candidate's availability and target-support status, code and reason, and every tool's availability, reason and remediation; omitted_fields lists what it leaves out. Use operation, with the operation field, to compare deep-provider candidates for one tool. Request complete only when you need unavailable-candidate remediation, provider diagnostics, all candidate capabilities or static tool surface, effect and annotation flags.",
      ),
    operation: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Tool name to inspect, such as search_bytes; required with detail: \"operation\" and rejected otherwise. Reports each deep-provider candidate's readiness, target support and declaration of the tool's provider operations separately; it does not select or open a provider.",
      ),
    expected_package_version: z.string().min(1).optional(),
    expected_catalog_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    expected_server_path: absoluteLocalPathStringSchema
      .describe(
        "Absolute local filesystem path expected for the running server; relative paths are rejected.",
      )
      .optional(),
  })
  .refine(
    ({ detail, operation }) =>
      (detail === "operation") === (operation !== undefined),
    {
      message:
        'operation is required with detail: "operation" and is only accepted with it',
      path: ["operation"],
    },
  );
