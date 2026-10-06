import { ArtifactOperationError } from "./artifactOperationError.js";

/** Publication failure retaining its input/output target and cleanup state. */
export class WebScriptExportError extends ArtifactOperationError {
  override readonly userMessage: string;
  override readonly cleanupIncomplete: boolean;
  override readonly cleanupResources: readonly string[];

  constructor(
    reason: ArtifactOperationError["reason"],
    target: string,
    diagnostic: string,
    residualPaths: readonly string[] = [],
  ) {
    super("export_web_scripts", reason);
    this.userMessage = `Script export failed for ${target}: ${diagnostic}`;
    this.cleanupResources = residualPaths;
    this.cleanupIncomplete = residualPaths.length > 0;
  }
}
