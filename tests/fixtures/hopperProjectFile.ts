import { createTestTempFile } from "./temporaryDirectory.js";

/** Write the placeholder .hop file used by tests with a simulated provider. */
export const createStubHopperProject = (prefix: string): Promise<string> =>
  createTestTempFile(prefix, "fixture.hop", "fixture");
