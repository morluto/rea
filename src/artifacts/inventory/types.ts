import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import type { ArtifactResourceScope } from "../ArtifactResourceScope.js";

/** Resolved integrity behavior admitted to the artifact scanner. */
export type ArtifactIntegrityPolicy =
  | { readonly mode: "fail" }
  | { readonly mode: "record-and-continue" };

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
};

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly resourceScope: ArtifactResourceScope;
  /** Identity of a previously admitted file root; directory roots have no file digest. */
  readonly expectedRootSha256?: string | undefined;
  /** Independently selected root spelling used only for ASAR companion lookup. */
  readonly selectedPath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly integrity?: ArtifactIntegrityPolicy | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
  /** ASAR header/index admission resolved from the owner's environment; default when absent. */
  readonly asarHeaderAdmission?: AsarHeaderAdmission | undefined;
}
