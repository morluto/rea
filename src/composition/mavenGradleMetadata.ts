import type { MavenGradleMetadataPort } from "../ports/java/MavenGradleMetadataPort.js";
import { MavenGradleMetadataService } from "../application/java/MavenGradleMetadataService.js";
import { MavenGradleMetadataProvider } from "../java/MavenGradleMetadataProvider.js";

/** Compose bundled Maven POM and Gradle module metadata inspection without Maven or Gradle. */
export const createMavenGradleMetadataService =
  (): MavenGradleMetadataService => {
    const provider: MavenGradleMetadataPort = new MavenGradleMetadataProvider();
    return new MavenGradleMetadataService(provider);
  };
