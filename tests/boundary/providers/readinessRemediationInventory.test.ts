import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { CapabilityDescriptor } from "../../../src/application/AnalysisProvider.js";
import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import { providerCapabilitySets } from "../../../src/application/binary/BinarySessionStatus.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { IdaProvider } from "../../../src/ida/IdaProvider.js";
import { readKunaConfiguration } from "../../../src/kuna/KunaConfiguration.js";
import { KunaProvider } from "../../../src/kuna/KunaProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { inspectKunaProviderOwned } from "./kuna/kunaResourceScope.js";

// A controlled open target exercises only the final discovery projection.
const openTargetInventory = (capabilities: readonly CapabilityDescriptor[]) =>
  new Map(
    buildCapabilityInventory(
      {
        open: true,
        kind: "executable",
        format: "elf",
        capabilities: providerCapabilitySets(capabilities),
      },
      { processCaptureEnabled: true },
    ).map((entry) => [entry.name, entry]),
  );

it("carries an unreadable IDA registration's launch-environment repair into discovery", async () => {
  const root = await createTestTempDirectory("rea-ida-discovery-repair-");
  const config = parseConfig({
    REA_IDA_MCP_CONFIG: join(root, "missing.json"),
  });
  if (!config.ok) throw config.error;
  const connect = vi.fn(() => {
    throw new Error("Readiness must not connect to IDA");
  });
  const provider = new IdaProvider(config.value, {}, connect);
  try {
    const { availability, capabilities } =
      await provider.inspectReadinessSnapshot();
    if (availability.status !== "unavailable")
      throw new Error("A missing registration must be unavailable");
    expect(availability.remediation).toContain(
      "Correct REA_IDA_MCP_CONFIG in the environment that starts REA",
    );
    expect(availability.remediation).not.toBe(availability.reason);
    const inventory = openTargetInventory(capabilities);
    for (const name of ["analyze_function", "procedure_pseudo_code"])
      expect(inventory.get(name)).toMatchObject({
        available: false,
        reason: "provider_unavailable",
        remediation: availability.remediation,
      });
    expect(connect).not.toHaveBeenCalled();
  } finally {
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});

it.skipIf(process.platform === "win32").each([
  { setting: "REA_KUNA_JOBS", value: "33" },
  { setting: "REA_KUNA_TIMEOUT_MS", value: "0" },
  { setting: "REA_KUNA_CACHE_DIR", value: "relative" },
])(
  "keeps the Kuna configuration owner's repair for invalid $setting through discovery and doctor",
  async ({ setting, value }) => {
    // Configuration validation refuses the setting before any command probe.
    const environment = {
      REA_KUNA_COMMAND: "/audit/not-invoked/kuna",
      [setting]: value,
    };
    const owner = readKunaConfiguration(environment);
    if (owner.ok) throw new Error(`${setting}=${value} must be refused`);
    expect(owner.error.remediation).toBe(
      `Correct ${setting} to meet the reported constraint, or unset it to use its default. Restart REA after changing the environment.`,
    );

    const provider = new KunaProvider(environment);
    expect(provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      reason: owner.error.reason,
      remediation: owner.error.remediation,
    });
    const inventory = openTargetInventory(provider.capabilities());
    for (const name of ["analyze_function", "procedure_pseudo_code"])
      expect(inventory.get(name)).toMatchObject({
        available: false,
        reason: "provider_unavailable",
        remediation: owner.error.remediation,
      });

    // The doctor path already reports the same owner repair.
    const doctor = await inspectKunaProviderOwned(environment);
    expect(doctor.checks[0]).toMatchObject({
      ok: false,
      remediation: owner.error.remediation,
    });
  },
);
