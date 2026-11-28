import { z } from "zod";

/**
 * Declared PE header and directory values that the Windows loader ignores or
 * caps. Readers accept these layouts and report what they disregarded; a
 * value the operation itself needs is still refused when it cannot be read.
 */
const PE_HEADER_ANOMALY_CODES = [
  "optional_header_size_below_fields",
  "directory_count_above_maximum",
  "size_of_headers_inconsistent",
  "directory_size_below_structure",
  "directory_size_past_file_backed_bytes",
] as const;

const peHeaderAnomalySchema = z.strictObject({
  code: z.enum(PE_HEADER_ANOMALY_CODES),
  message: z.string().min(1),
});
export type PeHeaderAnomaly = z.infer<typeof peHeaderAnomalySchema>;

export const peHeaderAnomaliesSchema = z
  .array(peHeaderAnomalySchema)
  .describe(
    "Declared header and directory values the Windows loader ignores or caps, read as the loader reads them instead of refused",
  );

/** A data-directory Size below the structure the loader reads at its RVA. */
export const peDirectorySizeAnomaly = (
  name: string,
  index: number,
  size: number,
  structureBytes: number,
): PeHeaderAnomaly => ({
  code: "directory_size_below_structure",
  message: `Data directory ${String(index)} (${name}) declares Size ${String(size)}, below its ${String(structureBytes)}-byte structure; the loader ignores this Size, so the structure was read at its RVA.`,
});
