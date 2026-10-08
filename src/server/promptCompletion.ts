import type { EvidenceReader } from "../application/investigation/InvestigationRecordPort.js";
import { z } from "zod";

import { uniqueSorted } from "../domain/canonicalOrdering.js";
import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/binary/BinarySession.js";
import type { PromptCompletionKind } from "../contracts/promptContracts.js";
import { artifactInventoryResultSchema } from "../domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../domain/artifactInspection.js";
import { parseProcessCapture } from "../domain/process/processCapture.js";

const documentListSchema = z.array(z.string().min(1));
const providerStatusSchema = z.object({
  providers: z.array(z.object({ id: z.string().min(1) })),
  analysis_provider_candidates: z
    .array(z.object({ provider: z.object({ id: z.string().min(1) }) }))
    .optional(),
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

/** Build live completion over the active provider and session ledger. */
export const createPromptCompletionSource = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
): PromptCompletionSource => ({
  async complete(kind, value, context) {
    const candidates = await completionCandidates(
      kind,
      analysis,
      session,
      context,
    );
    const prefix = normalize(value);
    const nonEmpty = candidates.filter((candidate) => candidate.length > 0);
    return uniqueSorted(nonEmpty).filter((candidate) =>
      normalize(candidate).startsWith(prefix),
    );
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
  return parsed.success ? parsed.data : [];
};

const procedureCandidates = async (
  analysis: AnalysisOperationPort,
  document: string | undefined,
): Promise<readonly string[]> => {
  const byAddress = new Map<string, string>();
  const input =
    document === undefined || document.length === 0 ? {} : { document };
  const result = await analysis.execute("list_procedures", input);
  if (result.ok) {
    const parsed = z
      .array(z.object({ address: z.string(), value: z.string() }))
      .safeParse(result.value.result);
    if (parsed.success)
      for (const item of parsed.data)
        if (!byAddress.has(item.address))
          byAddress.set(item.address, item.value);
  }

  const addressesByName = new Map<string, Set<string>>();
  for (const [address, name] of byAddress) {
    const addresses = addressesByName.get(name) ?? new Set<string>();
    addresses.add(address);
    addressesByName.set(name, addresses);
  }
  const candidates = [...byAddress.keys()];
  for (const [name, addresses] of addressesByName)
    if (addresses.size === 1 && name.length > 0) candidates.push(name);
  return candidates;
};

const providerCandidates = (
  session: BinarySessionPort | undefined,
): readonly string[] => {
  if (session === undefined) return [];
  const parsed = providerStatusSchema.safeParse(session.status());
  if (!parsed.success) return [];
  const candidates =
    (parsed.data.analysis_provider_candidates?.length ?? 0) > 0
      ? (parsed.data.analysis_provider_candidates?.map(
          ({ provider }) => provider.id,
        ) ?? [])
      : parsed.data.providers.map(({ id }) => id);
  return ["auto", ...candidates];
};

const evidenceCandidates = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  session: BinarySessionPort | undefined,
): readonly string[] => {
  if (session === undefined) return [];
  const candidates: string[] = [];
  for (const evidence of session.exportEvidenceBundle().records)
    candidates.push(...evidenceValues(kind, evidence));
  return candidates;
};

type LedgerEvidence = ReturnType<
  EvidenceReader["exportEvidenceBundle"]
>["records"][number];

const evidenceValues = (
  kind: "evidence" | "capture" | "manifest" | "occurrence",
  evidence: LedgerEvidence,
): readonly string[] => {
  if (kind === "evidence") return [evidence.evidence_id];
  if (kind === "capture")
    return isProcessCaptureEvidence(evidence) ? [evidence.evidence_id] : [];
  const inventoryResult =
    evidence.operation === "inventory_artifact"
      ? evidence.normalized_result
      : evidence.operation === "inspect_artifact"
        ? (() => {
            const inspection = artifactInspectionResultSchema.safeParse(
              evidence.normalized_result,
            );
            return inspection.success
              ? inspection.data.substeps[0]?.evidence.normalized_result
              : undefined;
          })()
        : undefined;
  if (inventoryResult === undefined) return [];
  const inventory = artifactInventoryResultSchema.safeParse(inventoryResult);
  if (!inventory.success) return [];
  if (kind === "manifest") return [inventory.data.manifest.manifest_id];
  return inventory.data.occurrences.map(({ occurrence_id: id }) => id);
};

const isProcessCaptureEvidence = (evidence: LedgerEvidence): boolean => {
  if (evidence.operation !== "capture_process_scenario") return false;
  try {
    parseProcessCapture(evidence.normalized_result);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof TypeError || cause instanceof z.ZodError) return false;
    throw cause;
  }
};

const unknownCandidates = (
  session: BinarySessionPort | undefined,
): readonly string[] =>
  session === undefined
    ? []
    : session
        .listUnknowns()
        .filter(({ status }) => status !== "resolved")
        .map(({ unknown_id: id }) => id);

const normalize = (value: string): string =>
  value.normalize("NFKC").toLowerCase();
