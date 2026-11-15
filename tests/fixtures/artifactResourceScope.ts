import { onTestFinished } from "vitest";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";

/** Each caller owns its scope through test finalization, including retained retries. */
export const createTestArtifactResourceScope = (): ArtifactResourceScope => {
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  return resources;
};
