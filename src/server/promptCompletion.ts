import { z } from "zod";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { PromptCompletionKind } from "../contracts/promptContracts.js";
import { artifactInventoryResultSchema } from "../domain/artifactGraph.js";
import { parseAddressedPage } from "../domain/hopperValues.js";
import {
  processCaptureSchema,
  validateProcessCapture,
} from "../domain/processCapture.js";

const COMPLETION_SCAN_LIMIT = 10_000;
const PROCEDURE_PAGE_SIZE = 500;
const MAX_COMPLETION_VALUE_LENGTH = 4_096;

const documentListSchema = z.array(z.string().min(1));
const providerStatusSchema = z.object({
  providers: z.array(z.object({ id: z.string().min(1) })),
});

interface CompletionContext {
  readonly arguments?: Readonly<Record<string, string>>;
}

/** Read-only session projection used by MCP prompt argument completers. */
export interface PromptCompletionSource {
  complete(
    kind: PromptCompletionKind,
    value: string,
    context?: CompletionContext,
  ): Promise<readonly string[]>;
}

/** Build bounded live completion over the active provider and session ledger. */
export const createPromptCompletionSource = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
): PromptCompletionSource => ({
  async complete(kind, value, context) {
    if (value.length > MAX_COMPLETION_VALUE_LENGTH) return [];
    const candidates = await completionCandidates(
      kind,
      analysis,
      session,
      context,
    );
    const prefix = normalize(value);
    return uniqueSorted(candidates)
      .filter((candidate) => normalize(candidate).startsWith(prefix))
      .slice(0, COMPLETION_SCAN_LIMIT);
  },
});

const completionCandidates = async (
  kind: PromptCompletionKind,
  analysis: AnalysisOperationPort,
  session: BinarySessionPort | undefined,
  context: CompletionContext | undefined,
): Promise<readonly string[]> => {
  switch (kind) {
    case "document":
      return documentCandidates(analysis);
    case "procedure":
      return procedureCandidates(analysis, context?.arguments?.document);
    case "provider":
      return providerCandidates(session);
    case "evidence":
    case "capture":
    case "manifest":
    case "occurrence":
      return evidenceCandidates(kind, session);
    case "unknown":
      return unknownCandidates(session);
  }
};

const documentCandidates = async (
  analysis: AnalysisOperationPort,
): Promise<readonly string[]> => {
  const result = await analysis.execute("list_documents", {});
  if (!result.ok) return [];
  const parsed = documentListSchema.safeParse(result.value.result);
  return parsed.success ? parsed.data.slice(0, COMPLETION_SCAN_LIMIT) : [];
};

const procedureCandidates = async (
  analysis: AnalysisOperationPort,
  document: string | undefined,
): Promise<readonly string[]> => {
  if (document !== undefined && document.length > MAX_COMPLETION_VALUE_LENGTH)
    return [];
  const byAddress = new Map<string, string>();
  let offset = 0;
  let exhaustive = false;
  while (byAddress.size < COMPLETION_SCAN_LIMIT / 2) {
    const result = await analysis.execute("list_procedures", {
      offset,
      limit: PROCEDURE_PAGE_SIZE,
      ...(document === undefined || document.length === 0 ? {} : { document }),
    });
    if (!result.ok) break;
    const parsed = parseAddressedPage(result.value.result);
    if (!parsed.ok) break;
    for (const item of parsed.value.items) {
      if (byAddress.size >= COMPLETION_SCAN_LIMIT / 2) break;
      if (!byAddress.has(item.address)) byAddress.set(item.address, item.name);
    }
    const nextOffset = parsed.value.nextOffset;
    if (!parsed.value.hasMore) {
      exhaustive = true;
      break;
    }
    if (nextOffset === null || nextOffset <= offset) break;
    offset = nextOffset;
  }

  const addressesByName = new Map<string, Set<string>>();
  for (const [address, name] of byAddress) {
    const addresses = addressesByName.get(name) ?? new Set<string>();
    addresses.add(address);
    addressesByName.set(name, addresses);
  }
  const candidates = [...byAddress.keys()];
  if (exhaustive)
    for (const [name, addresses] of addressesByName)
      if (addresses.size === 1 && name.length > 0) candidates.push(name);
  return candidates;
};

const providerCandidates = (
  session: BinarySessionPort | undefined,
): readonly string[] => {
  if (session === undefined) return [];
  const parsed = providerStatusSchema.safeParse(session.status());
  return parsed.success
    ? parsed.data.providers.map(({ id }) => id).slice(0, COMPLETION_SCAN_LIMIT)
    : [];
};

const evidenceCandidates = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  session: BinarySessionPort | undefined,
): readonly string[] => {
  if (session === undefined) return [];
  const candidates: string[] = [];
  for (const evidence of session.exportEvidenceBundle().records) {
    const remaining = COMPLETION_SCAN_LIMIT - candidates.length;
    candidates.push(...evidenceValues(kind, evidence).slice(0, remaining));
    if (candidates.length >= COMPLETION_SCAN_LIMIT) break;
  }
  return candidates;
};

type LedgerEvidence = ReturnType<
  BinarySessionPort["exportEvidenceBundle"]
>["records"][number];

const evidenceValues = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  evidence: LedgerEvidence,
): readonly string[] => {
  if (kind === "evidence") return [evidence.evidence_id];
  if (kind === "capture")
    return isProcessCaptureEvidence(evidence) ? [evidence.evidence_id] : [];
  if (evidence.operation !== "inventory_artifact") return [];
  const inventory = artifactInventoryResultSchema.safeParse(
    evidence.normalized_result,
  );
  if (!inventory.success) return [];
  if (kind === "manifest") return [inventory.data.manifest.manifest_id];
  return inventory.data.occurrences.items.map(({ occurrence_id: id }) => id);
};

const isProcessCaptureEvidence = (evidence: LedgerEvidence): boolean => {
  if (evidence.operation !== "capture_process_scenario") return false;
  const capture = processCaptureSchema.safeParse(evidence.normalized_result);
  return capture.success && validateProcessCapture(capture.data).length === 0;
};

const unknownCandidates = (
  session: BinarySessionPort | undefined,
): readonly string[] =>
  session === undefined
    ? []
    : session
        .listUnknowns()
        .filter(({ status }) => status !== "resolved")
        .map(({ unknown_id: id }) => id)
        .slice(0, COMPLETION_SCAN_LIMIT);

const uniqueSorted = (values: readonly string[]): string[] =>
  [
    ...new Set(
      values.filter(
        (value) =>
          value.length > 0 && value.length <= MAX_COMPLETION_VALUE_LENGTH,
      ),
    ),
  ].sort(compareText);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase();
