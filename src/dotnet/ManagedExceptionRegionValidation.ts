import type { ManagedExceptionRegion } from "./ManagedMemberInspectorCore.js";
import type { ExceptionRegionParseResult } from "./ManagedMemberInstructionDecoder.js";

const clauseFlagsIssue = (region: ManagedExceptionRegion): string | null =>
  [0, 1, 2, 4].includes(region.flags)
    ? null
    : `Exception clause has unsupported flags 0x${region.flags.toString(16)}`;

const methodExtentIssue = (
  start: number,
  length: number,
  ilSize: number,
  name: "try" | "handler",
): string | null =>
  start <= ilSize && length <= ilSize - start
    ? null
    : `Exception clause ${name} range leaves the method IL body`;

const filterOrderingIssue = (
  region: ManagedExceptionRegion,
  ilSize: number,
): string | null => {
  if (region.flags !== 1) return null;
  const offset = region.filter_offset;
  return offset !== null && offset < ilSize && offset < region.handler_offset
    ? null
    : "Exception clause filter must start before its handler within the method IL body";
};

const clauseIssue = (
  region: ManagedExceptionRegion,
  ilSize: number,
): string | null =>
  clauseFlagsIssue(region) ??
  methodExtentIssue(region.try_offset, region.try_length, ilSize, "try") ??
  methodExtentIssue(
    region.handler_offset,
    region.handler_length,
    ilSize,
    "handler",
  ) ??
  filterOrderingIssue(region, ilSize);

/** Validate EH extents and instruction boundaries while retaining each clause. */
export const validateExceptionRegionRanges = (
  parsed: ExceptionRegionParseResult,
  ilSize: number,
): ExceptionRegionParseResult => {
  if (parsed.status === "malformed") return parsed;
  for (const region of parsed.regions) {
    const issue = clauseIssue(region, ilSize);
    if (issue !== null)
      return { status: "malformed", regions: parsed.regions, issue };
  }
  return parsed;
};
