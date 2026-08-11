import { CATALOG_IDENTITY } from "../catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { DoctorHost } from "./Doctor.js";

/** Healthy recording host for focused doctor and projection tests. */
export const createDoctorHostFixture = (
  overrides: Partial<DoctorHost> = {},
): DoctorHost => ({
  platform: "darwin",
  architecture: "x64",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve("14.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: (path) => Promise.resolve(path.includes("Hopper")),
  executable: (path) => Promise.resolve(path.includes("Hopper")),
  supportedLinuxHopper: () => Promise.resolve(true),
  linuxDemoRuntimeCheck: () =>
    Promise.resolve({
      name: "hopper-demo-runtime",
      ok: true,
      classification: "healthy",
    }),
  brewHopperPath: () => Promise.resolve(undefined),
  manualHopperPaths: () => Promise.resolve([]),
  installedSkillIdentity: () =>
    Promise.resolve({
      version: PRODUCT_IDENTITY.skillVersion,
      toolCount: CATALOG_IDENTITY.counts.mcp_tools,
      catalogDigest: CATALOG_IDENTITY.digests.combined_sha256,
    }),
  ...overrides,
});
