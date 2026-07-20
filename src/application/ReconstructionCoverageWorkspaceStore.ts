import { InvestigationWorkspaceError } from "../domain/errors.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import {
  parseReconstructionCoverageWorkspace,
  serializeReconstructionCoverageWorkspace,
  type ReconstructionCoverageWorkspace,
} from "../domain/reconstructionCoverage.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readRevisionedWorkspace,
  writeRevisionedWorkspace,
  type RevisionedWorkspaceCodec,
} from "./InvestigationWorkspaceStore.js";

const codec: RevisionedWorkspaceCodec<ReconstructionCoverageWorkspace> = {
  parse: parseReconstructionCoverageWorkspace,
  serialize: serializeReconstructionCoverageWorkspace,
  validateNext: (current, next, expectedRevision) => {
    if ((current?.revision ?? null) !== expectedRevision)
      return err(
        new InvestigationWorkspaceError("update", "revision-conflict"),
      );
    if (current === null)
      return next.revision === 1 && next.previous_revision_sha256 === null
        ? ok(null)
        : err(new InvestigationWorkspaceError("update", "revision-conflict"));
    if (
      current.name !== next.name ||
      current.workspace_id !== next.workspace_id
    )
      return err(new InvestigationWorkspaceError("update", "name-conflict"));
    return next.revision === current.revision + 1 &&
      next.previous_revision_sha256 === current.revision_sha256
      ? ok(null)
      : err(new InvestigationWorkspaceError("update", "revision-conflict"));
  },
};

/** Read a validated reconstruction coverage workspace revision. */
export const readReconstructionCoverageWorkspace = (
  path: string,
  policy: EvidenceFilePolicy,
): Promise<
  Result<ReconstructionCoverageWorkspace | null, InvestigationWorkspaceError>
> => readRevisionedWorkspace(path, policy, codec);

/** Atomically append one reconstruction coverage workspace CAS revision. */
export const writeReconstructionCoverageWorkspace = (
  workspace: ReconstructionCoverageWorkspace,
  path: string,
  expectedRevision: number | null,
  policy: EvidenceFilePolicy,
): Promise<
  Result<
    { readonly path: string; readonly bytes: number },
    InvestigationWorkspaceError
  >
> =>
  writeRevisionedWorkspace({
    document: workspace,
    path,
    expectedRevision,
    policy,
    codec,
  });
