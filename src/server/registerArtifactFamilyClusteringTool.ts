import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  clusterArtifactFamilies,
  withholdArtifactFamilyClusteringIndex,
  type ArtifactFamilyClusteringResult,
} from "../domain/artifactFamilyClustering.js";
import {
  createEvidence,
  immutableEvidence,
  type Evidence,
} from "../domain/evidence.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import type { MemberObservation } from "../domain/artifactFamilyClusteringIndex.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok } from "../domain/result.js";
import { resolveArtifactFamilyClusteringEvidence } from "../application/artifacts/ArtifactFamilyClusteringEvidence.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { encodeToolResult } from "./toolResultEncoding.js";
import { ARTIFACT_COMPARISON_PROVIDER } from "../domain/comparisonEvidenceIdentity.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import { runAdmittedToolOperation } from "./admittedToolOperation.js";

/**
 * Room for the result envelope, families, summary and Evidence fields inside
 * one successful response. The wire repeats the JSON as structured content
 * and as an escaped text copy, and escaping quotes and backslashes can push
 * that copy past the structured copy, so the index receives a third of the
 * remaining budget — the worst case where every byte escapes costs 3x — and a
 * preflight still measures the complete repeated form before anything is
 * recorded, retrying with the index withheld instead of failing a call whose
 * families could still ship.
 */
const INDEX_RESULT_HEADROOM_BYTES = 64 * 1024;

/** Build the derived Evidence one clustering call retains for this session. */
const buildClusteringEvidence = (
  result: ArtifactFamilyClusteringResult,
  contract: ReturnType<typeof toolContract<"cluster_artifacts">>,
  memberRoster: MemberObservation[],
  extraLimitations: readonly string[] = [],
): Evidence =>
  createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    ARTIFACT_COMPARISON_PROVIDER,
    {
      predicateType: "rea.artifact-family-clustering",
      operation: contract.name,
      parameters: {
        // The roster travels in caller order independent of family paging or a
        // withheld index, so reopening this record always recovers which label
        // named which member Evidence.
        members: memberRoster,
        shared_member_minimum: result.coverage.shared_member_minimum,
        // The retained record states its own page, so reopening this Evidence
        // never implies a wider family list than it holds.
        offset: result.coverage.families_offset,
        limit: result.coverage.families_limit,
      },
      result,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: [...result.limitations, ...extraLimitations],
      evidenceLinks: memberRoster.map((member) => member.evidence_id),
    },
  );

/** Register Evidence-backed deterministic artifact family clustering. */
export const registerArtifactFamilyClusteringTool = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  contract: ReturnType<typeof toolContract<"cluster_artifacts">>,
): void => {
  const admission = withAdmittedAnalysis({ kind: "session", session });
  const evidenceById = (evidenceId: string) =>
    session.evidenceForAnalysis?.(evidenceId) ??
    session.evidenceById(evidenceId);
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) =>
      runAdmittedToolOperation(
        server,
        admission,
        contract.name,
        context.mcpReq.signal,
        async () => {
          // Bound what the transport can actually carry: the wire repeats the
          // result as structured content and as an escaped text copy, so an
          // index of S bytes costs up to 3S and gets a third of the budget.
          const clusteringOptions = {
            ...(input.shared_member_minimum === undefined
              ? {}
              : { sharedMemberMinimum: input.shared_member_minimum }),
            indexBudgetBytes: Math.max(
              0,
              Math.floor(
                (server.delivery.resultBudgetBytes -
                  INDEX_RESULT_HEADROOM_BYTES) /
                  3,
              ),
            ),
            offset: input.offset,
            limit: input.limit,
          };
          let members: { label: string; evidence: Evidence }[];
          try {
            members = await Promise.all(
              input.members.map(async (member) => {
                const supplied =
                  "evidence_id" in member
                    ? member.evidence_id
                    : typeof member.evidence === "string"
                      ? member.evidence
                      : immutableEvidence(member.evidence);
                const resolved = await resolveArtifactFamilyClusteringEvidence(
                  supplied,
                  evidenceById,
                  member.label,
                );
                if (!resolved.ok) throw resolved.error;
                return { label: member.label, evidence: resolved.value };
              }),
            );
          } catch (cause: unknown) {
            if (cause instanceof AnalysisError)
              return server.delivery.toCallToolResult(err(cause), contract);
            throw cause;
          }
          const computed = await runDerivedOperation(
            context,
            contract.name,
            () => {
              const clustering = clusterArtifactFamilies(
                members,
                clusteringOptions,
              );
              const memberRoster = members.map((member) => ({
                label: member.label,
                evidence_id: member.evidence.evidence_id,
              }));
              let evidence = buildClusteringEvidence(
                clustering,
                contract,
                memberRoster,
              );
              // Measure the complete repeated wire form before anything is
              // recorded: when it cannot ship, withhold the member index this
              // call already computed so the caller still receives families
              // and coverage.member_index_withheld instead of a transport
              // error carrying no clustering result at all.
              const shipped = encodeToolResult(
                evidence,
                server.delivery.resultBudgetBytes,
                "structured-and-text",
                contract.returnsTargetContent,
              );
              if (!shipped.ok && !clustering.coverage.member_index_withheld) {
                // Withholding is a presentation change to a result this call
                // already computed: re-clustering with a zero index budget
                // would reparse and revalidate every nested inventory and
                // rebuild the examined-node map only to discard the rows it
                // produced, on exactly the largest responses.
                evidence = buildClusteringEvidence(
                  withholdArtifactFamilyClusteringIndex(clustering),
                  contract,
                  memberRoster,
                  [
                    "The complete response, including its repeated escaped text copy, measured over this transport's response budget before delivery, so this call withholds the member index instead of failing the call; the families and coverage above still ship and the complete inventory Evidence stays retained.",
                  ],
                );
              }
              return { members, evidence };
            },
          );
          if (!computed.ok)
            return server.delivery.toCallToolResult(computed, contract);
          const { evidence } = computed.value;
          for (const member of members) {
            const recorded = session.recordEvidence(member.evidence);
            if (!recorded.ok)
              return server.delivery.toCallToolResult(recorded, contract);
          }
          const recorded = session.recordEvidence(evidence);
          return server.delivery.toEvidenceToolResult(
            evidence,
            contract,
            // Unplaced members stay visible in the result itself; no residual
            // unknown is opened until a workflow needs one to be tracked.
            recorded.ok ? ok(evidence) : recorded,
          );
        },
      ),
  );
};
