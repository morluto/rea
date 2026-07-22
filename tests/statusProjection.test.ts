import { describe, expect, it } from "vitest";

import {
  runCapabilityStatus,
  runProviderStatus,
} from "../src/application/DirectAnalysis.js";
import { projectDoctorReport } from "../src/application/DoctorProjection.js";
import { runDoctor, type DoctorHost } from "../src/application/Doctor.js";
import { CATALOG_IDENTITY } from "../src/catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../src/identity.js";

const doctorHost = (): DoctorHost => ({
  platform: "darwin",
  architecture: "x64",
  nodeVersion: "24.18.0",
  macosVersion: () => Promise.resolve("14.0"),
  linuxDistribution: () => Promise.resolve(undefined),
  validTarget: () => Promise.resolve(true),
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
});

describe("purpose-specific CLI projections", () => {
  it("keeps provider and capability summaries concise with explicit full detail", async () => {
    const providers = await runProviderStatus();
    const capabilities = await runCapabilityStatus();
    const full = await runCapabilityStatus(undefined, "full");

    expect(providers).toMatchObject({
      open: false,
      analysis_provider_candidates: expect.any(Array),
      server_identity: { catalog: { counts: expect.any(Object) } },
    });
    expect(JSON.stringify(providers)).not.toContain('"capabilities"');
    expect(JSON.stringify(providers)).not.toContain('"tools"');
    expect(capabilities).toMatchObject({
      summary: {
        total: expect.any(Number),
        available: expect.any(Number),
        unavailable: expect.any(Number),
      },
      capabilities: expect.any(Array),
    });
    expect(JSON.stringify(capabilities)).not.toContain('"effects"');
    expect(JSON.stringify(capabilities)).not.toContain('"limits"');
    expect(JSON.stringify(full)).toContain('"effects"');
    expect(JSON.stringify(full)).toContain('"catalog"');
  });

  it("omits the catalog tool array only from the default doctor projection", async () => {
    const report = await runDoctor(undefined, doctorHost());
    const summary = projectDoctorReport(report, "summary");
    const full = projectDoctorReport(report, "full");

    expect(summary).toMatchObject({
      healthy: true,
      environment_healthy: true,
      failed_scope_checks: [],
      informational_drift_count: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('"tools"');
    expect(JSON.stringify(full)).toContain('"tools"');
  });
});
