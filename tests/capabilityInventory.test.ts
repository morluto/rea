import { describe, expect, it } from "vitest";

import { buildCapabilityInventory } from "../src/application/CapabilityInventory.js";

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  evidenceFileRoots: 1,
  investigationInputRoots: 1,
  browserObservationEnabled: true,
  electronObservationEnabled: true,
  javascriptReplayEnabled: true,
  managedRuntimeEnabled: true,
};

const status = (
  options: {
    readonly open?: boolean;
    readonly kind?: "executable" | "database" | "archive" | "artifact";
    readonly capabilities?: readonly {
      readonly operation: string;
      readonly available: boolean;
      readonly reason: string | null;
      readonly availability_code?: string;
    }[];
  } = {},
) => ({
  open: options.open ?? false,
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  capabilities: [...(options.capabilities ?? [])],
});

const entry = (
  name: string,
  sessionStatus: ReturnType<typeof status>,
  policy = enabledPolicy,
) => {
  const found = buildCapabilityInventory(sessionStatus, policy).find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`missing capability ${name}`);
  return found;
};

describe("capability inventory", () => {
  it.each([
    {
      label: "requires a target",
      name: "current_address",
      sessionStatus: status(),
      reason: "target_required",
      remediation: "open_binary",
    },
    {
      label: "rejects an incompatible target family",
      name: "current_address",
      sessionStatus: status({ open: true, kind: "archive" }),
      reason: "target_unsupported",
      remediation: "native executable",
    },
    {
      label: "reports a missing provider operation",
      name: "current_address",
      sessionStatus: status({ open: true, kind: "executable" }),
      reason: "provider_missing",
      remediation: "provider",
    },
    {
      label: "distinguishes an unsupported host",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: false,
            availability_code: "unsupported_host",
            reason: "Operation requires macOS",
          },
        ],
      }),
      reason: "unsupported_host",
      remediation: "macOS",
    },
    {
      label: "retains a provider failure",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: false,
            reason: "Provider session is unhealthy",
          },
        ],
      }),
      reason: "provider_unavailable",
      remediation: "unhealthy",
    },
    {
      label: "reports an available provider operation",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: true,
            reason: null,
          },
        ],
      }),
      reason: "available",
      remediation: null,
    },
  ])("$label", ({ name, sessionStatus, reason, remediation }) => {
    const availability = entry(name, sessionStatus);
    expect(availability).toMatchObject({
      reason,
      available: reason === "available",
    });
    if (remediation === null) expect(availability.remediation).toBeNull();
    else expect(availability.remediation).toContain(remediation);
  });

  it.each([
    ["capture_process_scenario", { processCaptureEnabled: false }],
    ["inspect_web_page", { browserObservationEnabled: false }],
    ["inspect_electron_page", { electronObservationEnabled: false }],
    ["run_controlled_replay", { javascriptReplayEnabled: false }],
    ["plan_managed_runtime_correlation", { managedRuntimeEnabled: false }],
  ] as const)("reports stable policy denial for %s", (name, override) => {
    const availability = entry(name, status(), {
      ...enabledPolicy,
      ...override,
    });
    expect(availability).toMatchObject({
      available: false,
      reason: "policy_disabled",
    });
    expect(availability.remediation).toEqual(expect.any(String));
    expect(availability.remediation?.length).toBeGreaterThan(0);
  });

  it("gives every unavailable public tool an actionable remediation", () => {
    const inventory = buildCapabilityInventory(status(), {
      ...enabledPolicy,
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      investigationInputRoots: 0,
      browserObservationEnabled: false,
      electronObservationEnabled: false,
      javascriptReplayEnabled: false,
      managedRuntimeEnabled: false,
    });
    for (const availability of inventory)
      if (!availability.available) {
        expect(availability.reason).not.toBe("available");
        expect(availability.remediation).toEqual(expect.any(String));
        expect(availability.remediation?.length).toBeGreaterThan(0);
      }
  });
});
