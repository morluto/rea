import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { immutableEvidence, type Evidence } from "../../domain/evidence.js";
import { clusterArtifactFamilies } from "../../domain/artifactFamilyClustering.js";
import { readJsonFile } from "../JsonFiles.js";

/**
 * Cluster artifact inventories supplied as Evidence JSON files. The CLI has no
 * session, so each member is one complete Evidence document read from disk;
 * retained references and summaries stay MCP-only.
 */
export const clusterArtifactEvidenceCommand = async (input: {
  readonly memberPaths: readonly string[];
  readonly sharedMemberMinimum?: number;
  readonly offset: number;
  readonly limit: number;
}): Promise<Result<JsonValue, AnalysisError>> => {
  try {
    const members: { readonly label: string; readonly evidence: Evidence }[] =
      [];
    // Read in the caller's order so the reported labels match the supplied
    // paths, and seal each document before the next read: only the sealed
    // Evidence stays live, so a member set of large inventories never holds
    // every decoded document alongside its sealed copy.
    for (const path of input.memberPaths) {
      const document = await readJsonFile(path);
      if (!document.ok) return document;
      members.push({
        // The path is the caller's own label; it is never parsed as identity.
        label: path,
        // Sealing on admission makes the domain's own authentication pass a
        // snapshot hit instead of a second full re-hash of the inventory.
        evidence: immutableEvidence(document.value),
      });
    }
    const clustered = clusterArtifactFamilies(members, {
      ...(input.sharedMemberMinimum === undefined
        ? {}
        : { sharedMemberMinimum: input.sharedMemberMinimum }),
      offset: input.offset,
      limit: input.limit,
    });
    return ok(
      jsonValueSchema.parse({
        ...clustered,
        // The CLI has no session ledger to retain the roster in, so the
        // caller's path-to-Evidence mapping travels in the output itself; MCP
        // keeps the same roster in its retained record's parameters instead.
        // It survives the inputs that carry no index rows at all: a set whose
        // inventories are all graph-derived, or an index withheld on budget.
        members: members.map(({ label, evidence }) => ({
          label,
          evidence_id: evidence.evidence_id,
        })),
      }),
    );
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Artifact family clustering failed", {
        cause,
      }),
    );
  }
};
