import type {
  InspectPriResourcesInput,
  PriResources,
} from "../../domain/native/priResources.js";
import { decodePriFile } from "./PriFile.js";
import { priLimit } from "./PriLayout.js";
import { selectPriPage, serializedBytes } from "./PriSelection.js";
import { summarizePri, takeCensus } from "./PriSummary.js";

/** Complete result budget, including the summary and the selected page. */
const RESULT_BYTES = 8 * 1024 * 1024;

const LIMITATIONS = [
  "Static PRI index inspection: MRT runtime candidate resolution (qualifier matching, priority and fallback scoring) is not simulated; priorities and fallback scores are reported as stored.",
  "Text values are decoded from their stored encoding. EmbeddedData and unknown value types are identified by file range and SHA-256 only, and Path values name package files that are not read.",
  "Each response carries one caller-selected page of rows; page.total counts every row matching the selection.",
];

/** Decode one PRI file; return its summary and the caller-selected page, never a partial file. */
export const parsePriResources = async (
  bytes: Buffer,
  artifact: PriResources["artifact"],
  input: InspectPriResourcesInput,
  signal?: AbortSignal,
): Promise<PriResources> => {
  signal?.throwIfAborted();
  const file = await decodePriFile(bytes, signal);
  const census = await takeCensus(file.maps, signal);
  const page = await selectPriPage(file, input, signal);
  const report: PriResources = {
    artifact,
    ...summarizePri(file, census),
    page,
    limitations: LIMITATIONS,
  };
  signal?.throwIfAborted();
  if (serializedBytes(report, RESULT_BYTES) > RESULT_BYTES)
    priLimit(
      "PRI inspection result exceeds the 8 MiB result budget; no partial result was returned.",
    );
  return report;
};
