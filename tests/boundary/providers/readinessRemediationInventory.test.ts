import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { CapabilityDescriptor } from "../../../src/application/AnalysisProvider.js";
import { buildCapabilityInventory } from "../../../src/application/CapabilityInventory.js";
import { providerCapabilitySets } from "../../../src/application/binary/BinarySessionStatus.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import {
  existingProjectCapabilities,
  windowsP0Capabilities,
} from "../../../src/ghidra/GhidraProviderCapabilities.js";
import { IdaProvider } from "../../../src/ida/IdaProvider.js";
import { readKunaConfiguration } from "../../../src/kuna/KunaConfiguration.js";
import { KunaProvider } from "../../../src/kuna/KunaProvider.js";
import { kunaCapabilities } from "../../../src/kuna/KunaProviderCapabilities.js";
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
    expect(availability.remediation).toContain("REA_IDA_MCP_CONFIG");
    expect(availability.remediation).toContain("environment that starts REA");
    expect(availability.remediation).not.toBe(availability.reason);
    const inventory = openTargetInventory(capabilities);
    for (const name of ["analyze_function", "procedure_pseudo_code"])
      expect(inventory.get(name)).toMatchObject({
        available: false,
        reason: "provider_unavailable",
        remediation: availability.remediation,
      });
    // Every declared operation is unavailable only through that readiness.
    for (const capability of capabilities.filter(
      (candidate) => !candidate.available,
    ))
      expect(capability, capability.operation).toMatchObject({
        availabilityCode: availability.code,
        reason: availability.reason,
        readinessGated: true,
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
    expect(owner.error.remediation).toContain(setting);
    expect(owner.error.remediation).not.toBe(owner.error.reason);

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

const readinessGatedOperations = (
  capabilities: readonly CapabilityDescriptor[],
): readonly string[] =>
  capabilities
    .filter((capability) => !capability.available && capability.readinessGated)
    .map(({ operation }) => operation);

it("marks every Kuna operation readiness-gated only while Kuna is unavailable", () => {
  const unavailable = kunaCapabilities({
    status: "unavailable",
    code: "not_configured",
    reason: "Set REA_KUNA_COMMAND.",
    remediation: "Set REA_KUNA_COMMAND and restart REA.",
    diagnostics: {},
  });
  expect(readinessGatedOperations(unavailable)).toEqual(
    unavailable.map(({ operation }) => operation),
  );
  expect(
    readinessGatedOperations(
      kunaCapabilities({
        status: "available",
        code: null,
        reason: null,
        diagnostics: {},
      }),
    ),
  ).toEqual([]);
});

it("keeps Ghidra's Windows edit ban unmarked when the shared readiness code matches", () => {
  // Windows readiness can itself be unsupported_host, the same code the P0
  // edit ban uses; only the readiness-gated operations carry the mark.
  const capabilities = windowsP0Capabilities({
    available: false,
    reason: "Windows native controls need x64 Windows.",
    failureStage: "host",
    code: "unsupported_host",
    remediation: "Use Windows x64.",
    proof: "not-applicable",
  });
  for (const capability of capabilities) {
    if (capability.available) throw new Error("Readiness must gate reads");
    expect(capability.availabilityCode, capability.operation).toBe(
      "unsupported_host",
    );
    expect(capability.readinessGated === true, capability.operation).toBe(
      !capability.effects.mutatesArtifact,
    );
  }
  expect(capabilities.some(({ effects }) => effects.mutatesArtifact)).toBe(
    true,
  );
  // A ready Windows host keeps the edit ban and marks nothing.
  expect(
    readinessGatedOperations(windowsP0Capabilities({ available: true })),
  ).toEqual([]);
});

it("marks a Windows existing-project rejection as readiness only for reads", () => {
  const capabilities = existingProjectCapabilities("win32");
  const gated = new Set(readinessGatedOperations(capabilities));
  for (const capability of capabilities)
    expect(gated.has(capability.operation), capability.operation).toBe(
      !capability.effects.mutatesArtifact,
    );
  expect(
    readinessGatedOperations(existingProjectCapabilities("linux")),
  ).toEqual([]);
});
