import { IDA_COMPATIBILITY_PROFILES } from "../../../../src/ida/IdaConfiguration.js";
import { expect, it } from "vitest";
import type { CapabilityDescriptor } from "../../../../src/ports/AnalysisProvider.js";
import { buildCapabilityInventory } from "../../../../src/application/CapabilityInventory.js";
import { providerCapabilitySets } from "../../../../src/application/binary/BinarySessionStatus.js";
import { idaCapabilities } from "../../../../src/ida/IdaProviderCapabilities.js";
import { IDA_OPERATIONS } from "../../../../src/ida/IdaProviderMetadata.js";
import { TOOL_CONTRACTS } from "../../../../src/contracts/toolContracts.js";

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  browserObservationEnabled: true,
  browserScenarioEnabled: true,
  electronObservationEnabled: true,
  v8InspectorObservationEnabled: true,
};

const contractNamed = (name: string) =>
  TOOL_CONTRACTS.find((contract) => contract.name === name);

it("audits every IDA operation's network transport without adding it to the session base", () => {
  for (const name of IDA_OPERATIONS) {
    expect(contractNamed(name)?.effects.accessesNetwork, name).toBe(true);
    expect(contractNamed(name)?.sessionEffects.accessesNetwork, name).toBe(
      false,
    );
  }
});

it("retains network cleanup effects in session discovery for lifecycle tools", () => {
  const entries = buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(
        idaCapabilities(IDA_COMPATIBILITY_PROFILES.modern, false),
      ),
    },
    enabledPolicy,
  );
  for (const name of [
    "open_binary",
    "open_bundle_resources",
    "close_binary",
    "reset_investigation",
    "start_rizin_debug_session",
    "close_rizin_debug_session",
    "close_gdb_session",
  ]) {
    expect(
      entries.find((entry) => entry.name === name),
      name,
    ).toMatchObject({
      effects: { accessesNetwork: true },
      annotations: { open_world: true },
    });
  }
});

it("keeps retryable IDA effects in composed discovery while preserving unavailability", () => {
  const ida = idaCapabilities(IDA_COMPATIBILITY_PROFILES.native, false);
  const statusFor = (runtimeUnavailable: boolean) => ({
    open: true,
    kind: "executable",
    capabilities: providerCapabilitySets(
      ida.map((descriptor) =>
        descriptor.operation === "analyze_function"
          ? {
              ...descriptor,
              available: false as const,
              reason: "Transient IDA failure",
              ...(runtimeUnavailable
                ? { runtimeUnavailable: true as const }
                : {}),
            }
          : descriptor,
      ),
    ),
  });
  const retryable = buildCapabilityInventory(
    statusFor(true),
    enabledPolicy,
  ).find(({ name }) => name === "inspect_native_api");
  expect(retryable).toMatchObject({
    available: false,
    reason: "provider_unavailable",
    effects: { accessesNetwork: true, changesUiState: true },
    annotations: { open_world: true },
  });
  const blocked = buildCapabilityInventory(
    statusFor(false),
    enabledPolicy,
  ).find(({ name }) => name === "inspect_native_api");
  expect(blocked).toMatchObject({
    available: false,
    effects: { accessesNetwork: false, changesUiState: false },
    annotations: { open_world: false },
  });
});

it.each([
  {
    profile: "native",
    stdio: false,
    showUi: true,
    launchesAndWrites: false,
  },
  {
    profile: "native",
    stdio: true,
    showUi: true,
    launchesAndWrites: true,
  },
  {
    profile: "modern",
    stdio: false,
    showUi: false,
    launchesAndWrites: true,
  },
] as const)(
  "audits and projects IDA effects for $profile (stdio=$stdio)",
  ({ profile, stdio, showUi, launchesAndWrites }) => {
    const descriptors = idaCapabilities(
      IDA_COMPATIBILITY_PROFILES[profile],
      stdio,
    );
    for (const { operation, effects } of descriptors) {
      expect(contractNamed(operation)?.effects, operation).toMatchObject({
        accessesNetwork: true,
        ...(effects.mayShowUi ? { changesUiState: true } : {}),
        ...(effects.launchesProcess ? { launchesProcess: true } : {}),
        ...(effects.mayWriteFilesystem ? { writesFilesystem: true } : {}),
      });
    }

    const entries = buildCapabilityInventory(
      {
        open: true,
        kind: "executable",
        capabilities: providerCapabilitySets(descriptors),
      },
      enabledPolicy,
    );
    for (const [names, changesUiState] of [
      [
        [
          "procedure_pseudo_code",
          "analyze_function",
          "batch_decompile",
          "decompile_all",
          "trace_native_values",
          "inspect_native_api",
        ],
        showUi,
      ],
      [
        [
          "procedure_assembly",
          "read_function_instructions",
          "list_procedures",
          "search_strings",
          "trace_feature",
        ],
        false,
      ],
    ] as const) {
      for (const name of names)
        expect(
          entries.find((entry) => entry.name === name),
          name,
        ).toMatchObject({
          effects: { changesUiState, accessesNetwork: true },
          annotations: { open_world: true },
        });
    }
    expect(
      entries.find(({ name }) => name === "procedure_assembly"),
    ).toMatchObject({
      effects: {
        launchesProcess: launchesAndWrites,
        writesFilesystem: launchesAndWrites,
      },
    });
  },
);

it("omits effects of IDA calls hidden behind unavailable workflow prerequisites", () => {
  const entries = buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(
        idaCapabilities(IDA_COMPATIBILITY_PROFILES.native, false),
      ),
    },
    enabledPolicy,
  );
  // Without a name inventory, find_xrefs_to_name resolves names through the
  // procedure lookup, so it is reachable and declares IDA's effects.
  expect(
    entries.find((entry) => entry.name === "find_xrefs_to_name"),
  ).toMatchObject({
    available: true,
    effects: { accessesNetwork: true },
    annotations: { open_world: true },
  });
  for (const name of ["get_navigation_context"]) {
    expect(contractNamed(name)?.effects, name).toMatchObject({
      accessesNetwork: false,
      launchesProcess: false,
      writesFilesystem: false,
    });
    expect(
      entries.find((entry) => entry.name === name),
      name,
    ).toMatchObject({
      available: false,
      effects: {
        accessesNetwork: false,
        launchesProcess: false,
        writesFilesystem: false,
      },
      annotations: { open_world: false },
    });
  }
});

it("advertises reachable IDA calls through native UI tracing", () => {
  const ida = idaCapabilities(IDA_COMPATIBILITY_PROFILES.native, false);
  const source = ida[0];
  if (source === undefined) throw new Error("IDA capability fixture is empty");
  const metadata = {
    ...source,
    provider: { id: "native-fixture", name: "Native fixture", version: "1" },
    operation: "inspect_native_dispatch_metadata" as const,
    effects: {
      ...source.effects,
      launchesProcess: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      mayShowUi: false,
    },
  };
  expect(contractNamed("trace_native_ui_action")?.effects).toMatchObject({
    accessesNetwork: true,
    launchesProcess: true,
    writesFilesystem: true,
  });
  expect(contractNamed("trace_native_ui_action")?.sessionEffects).toMatchObject(
    {
      accessesNetwork: false,
      launchesProcess: false,
      writesFilesystem: false,
    },
  );
  const status = (capabilities: readonly CapabilityDescriptor[]) => ({
    open: true,
    kind: "executable",
    capabilities: providerCapabilitySets(capabilities),
  });
  const withoutMetadata = buildCapabilityInventory(status(ida), enabledPolicy);
  expect(
    withoutMetadata.find((entry) => entry.name === "trace_native_ui_action"),
  ).toMatchObject({
    effects: { accessesNetwork: false },
    annotations: { open_world: false },
  });
  const withMetadata = buildCapabilityInventory(
    status([...ida, metadata]),
    enabledPolicy,
  );
  expect(
    withMetadata.find((entry) => entry.name === "trace_native_ui_action"),
  ).toMatchObject({
    effects: { accessesNetwork: true },
    annotations: { open_world: true },
  });
});

it("includes reachable IDA document and procedure effects in address-context discovery", () => {
  const ida = idaCapabilities(IDA_COMPATIBILITY_PROFILES.modern, false);
  expect(contractNamed("inspect_address_context")?.effects).toMatchObject({
    accessesNetwork: true,
    launchesProcess: true,
    writesFilesystem: true,
  });
  expect(
    contractNamed("inspect_address_context")?.sessionEffects,
  ).toMatchObject({
    accessesNetwork: false,
    launchesProcess: false,
    writesFilesystem: false,
  });
  const entryFor = (capabilities: readonly CapabilityDescriptor[]) =>
    buildCapabilityInventory(
      {
        open: true,
        kind: "executable",
        capabilities: providerCapabilitySets(capabilities),
      },
      enabledPolicy,
    ).find((entry) => entry.name === "inspect_address_context");
  expect(entryFor(ida)).toMatchObject({
    effects: {
      accessesNetwork: true,
      launchesProcess: true,
      writesFilesystem: true,
    },
    annotations: { open_world: true },
  });
  for (const operation of ["list_documents", "resolve_containing_procedure"]) {
    expect(
      entryFor(ida.filter((descriptor) => descriptor.operation === operation)),
      operation,
    ).toMatchObject({
      effects: { accessesNetwork: true },
      annotations: { open_world: true },
    });
  }
  const local = ida.map((descriptor) => ({
    ...descriptor,
    effects: {
      ...descriptor.effects,
      mayAccessNetwork: false,
      launchesProcess: false,
      mayWriteFilesystem: false,
    },
  }));
  expect(entryFor(local)).toMatchObject({
    effects: {
      accessesNetwork: false,
      launchesProcess: false,
      writesFilesystem: false,
    },
    annotations: { open_world: false },
  });
});
