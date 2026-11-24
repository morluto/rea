import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type { ManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import {
  managedTableRowCounts,
  unresolvedModuleMetadata,
  type ManagedMetadataInventory,
} from "../domain/managed/managedMetadataInventory.js";

import { managedModuleRow } from "../domain/managed/managedModuleIdentity.js";

/** Shared artifact and token identity facts for successful managed PE projections. */
export const managedPeInspectionEnvelope = (
  target: BinaryTarget,
  byteLength: number,
  layout: ManagedMetadataLayout,
  identity: Pick<ManagedMetadataInventory, "module" | "unresolvedModuleName">,
  issues: readonly ManagedParseIssue[],
) => {
  const { module } = identity;
  const metadata = {
    status: issues.length === 0 ? ("complete" as const) : ("partial" as const),
    version: layout.version,
    table_row_counts: managedTableRowCounts(layout),
    ...unresolvedModuleMetadata(identity),
  };
  return {
    artifact: {
      path: target.path,
      sha256: target.sha256,
      byte_length: byteLength,
      format: "pe" as const,
    },
    module,
    metadata,
    identity_scope: {
      token_identity: "build-local" as const,
      requires_artifact_sha256: target.sha256,
      requires_mvid: managedModuleRow({ module, metadata })?.mvid ?? null,
    },
  };
};
