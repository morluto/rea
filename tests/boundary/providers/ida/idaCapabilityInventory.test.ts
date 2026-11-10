import { IDA_COMPATIBILITY_PROFILES } from "../../../../src/ida/IdaConfiguration.js";
import { expect, it } from "vitest";
import type { CapabilityDescriptor } from "../../../../src/application/AnalysisProvider.js";
import { buildCapabilityInventory } from "../../../../src/application/CapabilityInventory.js";
import { providerCapabilitySets } from "../../../../src/application/binary/BinarySessionStatus.js";
import { idaCapabilities } from "../../../../src/ida/IdaProviderCapabilities.js";
import { IDA_OPERATIONS } from "../../../../src/ida/IdaProviderMetadata.js";
import {
  TOOL_EFFECTS,
  toolSessionEffects,
} from "../../../../src/contracts/toolEffects.js";

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  browserObservationEnabled: true,
  browserScenarioEnabled: true,
  electronObservationEnabled: true,
  v8InspectorObservationEnabled: true,
};

it("audits every IDA operation's network transport without adding it to the session base", () => {
  for (const name of IDA_OPERATIONS) {
    expect(TOOL_EFFECTS[name]?.accessesNetwork, name).toBe(true);
    expect(toolSessionEffects(name).accessesNetwork, name).toBe(false);
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
  const ida = idaCapabilities(IDA_COMPATIBILITY_PROFILES.legacy, false);
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
  ["legacy", false],
  ["native", true],
  ["modern", true],
] as const)(
  "covers IDA provider effects in the global audit (%s, stdio=%s)",
  (profileName, stdio) => {
    for (const descriptor of idaCapabilities(
      IDA_COMPATIBILITY_PROFILES[profileName],
      stdio,
    )) {
      const audited = TOOL_EFFECTS[descriptor.operation];
      expect(audited, descriptor.operation).toBeDefined();
      if (descriptor.effects.mayAccessNetwork)
        expect(audited?.accessesNetwork, descriptor.operation).toBe(true);
      if (descriptor.effects.mayShowUi)
        expect(audited?.changesUiState, descriptor.operation).toBe(true);
      if (descriptor.effects.launchesProcess)
        expect(audited?.launchesProcess, descriptor.operation).toBe(true);
      if (descriptor.effects.mayWriteFilesystem)
        expect(audited?.writesFilesystem, descriptor.operation).toBe(true);
    }
  },
);

it.each([false, true])(
  "retains selected provider UI/process/network effects in direct and composed discovery (UI=%s)",
  (showUi) => {
    const input = {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(
        idaCapabilities(
          IDA_COMPATIBILITY_PROFILES[showUi ? "legacy" : "modern"],
          false,
        ),
      ),
    };
    const entries = buildCapabilityInventory(input, enabledPolicy);
    for (const name of [
      "procedure_pseudo_code",
      "procedure_assembly",
      "read_function_instructions",
      "analyze_function",
      "batch_decompile",
      "decompile_all",
      "trace_native_values",
      "inspect_native_api",
    ]) {
      expect(entries.find((entry) => entry.name === name)).toMatchObject({
        effects: {
          changesUiState: showUi,
          accessesNetwork: true,
        },
        annotations: { open_world: true },
      });
    }
    for (const name of ["list_procedures", "search_strings", "trace_feature"]) {
      expect(entries.find((entry) => entry.name === name)).toMatchObject({
        effects: { changesUiState: false, accessesNetwork: true },
        annotations: { open_world: true },
      });
    }
  },
);

it("omits effects of IDA calls hidden behind unavailable workflow prerequisites", () => {
  const entries = buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      capabilities: providerCapabilitySets(
        idaCapabilities(IDA_COMPATIBILITY_PROFILES.legacy, false),
      ),
    },
    enabledPolicy,
  );
  for (const name of ["find_xrefs_to_name", "get_navigation_context"]) {
    expect(TOOL_EFFECTS[name], name).toMatchObject({
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
  const ida = idaCapabilities(IDA_COMPATIBILITY_PROFILES.legacy, false);
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
  expect(TOOL_EFFECTS.trace_native_ui_action).toMatchObject({
    accessesNetwork: true,
    launchesProcess: true,
    writesFilesystem: true,
  });
  expect(toolSessionEffects("trace_native_ui_action")).toMatchObject({
    accessesNetwork: false,
    launchesProcess: false,
    writesFilesystem: false,
  });
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
  expect(TOOL_EFFECTS.inspect_address_context).toMatchObject({
    accessesNetwork: true,
    launchesProcess: true,
    writesFilesystem: true,
  });
  expect(toolSessionEffects("inspect_address_context")).toMatchObject({
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

it("keeps native attached UI effects limited to the operations that show them", () => {
  const input = {
    open: true,
    kind: "executable",
    capabilities: providerCapabilitySets(
      idaCapabilities(IDA_COMPATIBILITY_PROFILES.native, true),
    ),
  };
  const entries = buildCapabilityInventory(input, enabledPolicy);
  for (const [name, showUi] of [
    ["procedure_pseudo_code", true],
    ["analyze_function", true],
    ["procedure_assembly", false],
    ["read_function_instructions", false],
  ] as const) {
    expect(
      entries.find((entry) => entry.name === name),
      name,
    ).toMatchObject({
      effects: { changesUiState: showUi, accessesNetwork: true },
      annotations: { open_world: true },
    });
  }
});
