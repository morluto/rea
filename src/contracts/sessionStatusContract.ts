import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";

/** Caller-selected binary_session projections. */
export const BINARY_SESSION_DETAILS = ["summary", "complete"] as const;
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

/** Optional expectations used to compare the live session with its caller. */
export const binarySessionInputSchema = z.strictObject({
  detail: z
    .enum(BINARY_SESSION_DETAILS)
    .default("summary")
    .describe(
      "Start with summary (default): it keeps open state, the binding, current-route capabilities (including selected Ghidra checkpoint mode), each provider candidate's availability and target-support status, code and reason, and every tool's availability, reason and remediation; omitted_fields lists what it leaves out. Request complete only when you need unavailable-candidate remediation, provider diagnostics, candidate capabilities or static tool surface, effect and annotation flags.",
    ),
  refresh_candidates: z
    .boolean()
    .default(false)
    .describe(
      "Inspect current provider candidates for the active target without replacing or restarting the selected provider. Later transitions and analysis calls wait for inspection finalization. Omitted or false reports the retained selection observations.",
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
});
