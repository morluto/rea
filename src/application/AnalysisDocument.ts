import type { AnalysisOperationPort } from "./AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseDocuments } from "../domain/hopperValues.js";
import { err, ok, type Result } from "../domain/result.js";

const executionOptions = (signal: AbortSignal | undefined) =>
  signal === undefined ? undefined : { signal };

/** Resolve an explicit or provider-selected document without guessing among candidates. */
export const resolveAnalysisDocument = async (
  analysis: AnalysisOperationPort,
  document: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<string, AnalysisError>> => {
  if (document !== undefined) return ok(document);
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError("current_document"));
  const current = await analysis.execute(
    "current_document",
    {},
    executionOptions(signal),
  );
  if (!current.ok) {
    if (!(current.error instanceof AnalysisCapabilityUnavailableError))
      return current;
    const listed = await analysis.execute(
      "list_documents",
      {},
      executionOptions(signal),
    );
    if (!listed.ok) return listed;
    const parsed = parseDocuments(listed.value.result);
    if (!parsed.ok)
      return err(
        new AnalysisOutputError(
          "list_documents",
          "expected one document identity when resolving a headless provider",
          { cause: parsed.error },
        ),
      );
    if (parsed.value.length !== 1)
      return err(
        new AnalysisOutputError(
          "list_documents",
          `expected exactly one document identity for a provider without current-document selection, received ${parsed.value.length}`,
        ),
      );
    const [documentName] = parsed.value;
    if (documentName === undefined || documentName.length === 0)
      return err(
        new AnalysisOutputError(
          "list_documents",
          "provider returned no document identity",
        ),
      );
    return ok(documentName);
  }
  return typeof current.value.result === "string" &&
    current.value.result.length > 0
    ? ok(current.value.result)
    : err(
        new AnalysisOutputError(
          "current_document",
          "expected a nonempty document identity string",
        ),
      );
};
