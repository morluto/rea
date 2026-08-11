import { describe, expect, it } from "vitest";

import { runCapabilityStatus, runProviderStatus } from "./DirectAnalysis.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { projectDoctorReport } from "./DoctorProjection.js";
import { runDoctor } from "./Doctor.js";

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
    const report = await runDoctor(
      undefined,
      createDoctorHostFixture({ validTarget: () => Promise.resolve(true) }),
    );
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
