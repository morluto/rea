import { describe, expect, it } from "vitest";

import type { DoctorProviderInspection } from "./Doctor.js";
import { providerRegistrationEnvironment } from "./SetupRegistrationEnvironment.js";

const inspection = (
  overrides: Partial<DoctorProviderInspection> = {},
): DoctorProviderInspection => ({
  id: "fixture",
  configured: true,
  available: false,
  providerVersion: "1",
  registrationEnvironment: {
    REA_FIXTURE_PROVIDER_ROOT: "C:\\Tools\\Provider",
  },
  checks: [],
  ...overrides,
});

describe("provider registration settings", () => {
  it("retains valid published paths when runtime capabilities are unavailable", () => {
    expect(providerRegistrationEnvironment([inspection()])).toEqual({
      REA_FIXTURE_PROVIDER_ROOT: "C:\\Tools\\Provider",
    });
  });

  it("does not invent settings when the adapter cannot publish an installation", () => {
    expect(
      providerRegistrationEnvironment([
        inspection({ configured: false, registrationEnvironment: {} }),
      ]),
    ).toEqual({});
  });

  it("keeps available-provider settings unchanged", () => {
    expect(
      providerRegistrationEnvironment([inspection({ available: true })]),
    ).toEqual({ REA_FIXTURE_PROVIDER_ROOT: "C:\\Tools\\Provider" });
  });
});
