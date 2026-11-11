import type { EspFlashSelection } from "../../domain/firmware/espFlashLocation.js";
import type { ArtifactIntegrityPolicyName } from "../../domain/artifactIntegrityPolicy.js";
import type { AsarHeaderAdmission } from "../../config/asarHeaderAdmission.js";
import type { AnalysisSettingsReader } from "../../domain/analysisSettings.js";
import type { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import type { ArtifactReaderLimits } from "../../domain/artifactReaderLimits.js";

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly readerLimits?: ArtifactReaderLimits | undefined;
  readonly resourceScope: ArtifactResourceScope;
  /** Identity of a previously admitted file root; directory roots have no file digest. */
  readonly expectedRootSha256?: string | undefined;
  /** Independently selected root spelling used only for ASAR companion lookup. */
  readonly selectedPath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly integrity?: ArtifactIntegrityPolicyName | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
  /** ASAR header/index admission resolved from the owner's environment; default when absent. */
  readonly asarHeaderAdmission?: AsarHeaderAdmission | undefined;
  /** Accepted operation snapshot. Format readers resolve runtime ceilings from it. */
  readonly analysisSettings?: AnalysisSettingsReader | undefined;
  /**
   * Caller inputs when the target was explicitly selected as an ESP flash
   * image; detection with defaults applies otherwise.
   */
  readonly espFlashSelection?: EspFlashSelection | undefined;
}
