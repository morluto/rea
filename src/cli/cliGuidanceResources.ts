import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/**
 * Guidance descriptors owned by one CLI host. This owner is separate from the
 * guidance command so the executable can release it without loading guidance
 * access for commands that never used it.
 */
export class CliGuidanceResources {
  #retained: ArtifactResourceScope | undefined;

  resources(): ArtifactResourceScope {
    this.#retained ??= new ArtifactResourceScope();
    return this.#retained;
  }

  /** Release this host's descriptors, retaining failed cleanup for retry. */
  async close(): Promise<void> {
    const resources = this.#retained;
    if (resources === undefined) return;
    await resources.close();
    if (this.#retained === resources) this.#retained = undefined;
  }
}

/** Process CLI host used when a caller does not pass its own resources. */
export const processGuidanceResources = new CliGuidanceResources();

/** Release CLI-owned guidance descriptors, retaining failed cleanup for retry. */
export const closeCliGuidanceResources = (
  resources: CliGuidanceResources = processGuidanceResources,
): Promise<void> => resources.close();
