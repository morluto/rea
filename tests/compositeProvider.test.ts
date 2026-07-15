import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { CompositeProvider } from "../src/application/CompositeProvider.js";
import type {
  AnalysisOperation,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../src/application/AnalysisProvider.js";
import { createAnalysisExecution } from "../src/application/AnalysisProvider.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { ok } from "../src/domain/result.js";

const target: BinaryTarget = {
  path: "/fixture",
  kind: "database",
  format: "analysis-database",
  sha256: "0".repeat(64),
};

describe("composite analysis provider", () => {
  it("routes disjoint operations and does not start children during health", async () => {
    const hopperCalls: string[] = [];
    const nativeCalls: string[] = [];
    const hopper = provider("hopper", "address_name", hopperCalls);
    const native = provider("native", "analyze_function", nativeCalls);
    const composite = new CompositeProvider([hopper, native]);
    const client = composite.createClient(target);

    expect(await client.execute("health", {})).toEqual({
      ok: true,
      value: {
        result: null,
        rawResult: null,
        provider: {
          id: "composite:hopper+native",
          name: "REA composite analysis provider",
          version: null,
        },
        limitations: [],
        locations: [],
        subject: null,
      },
    });
    expect(hopperCalls).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(await client.execute("address_name", {})).toEqual({
      ok: true,
      value: createAnalysisExecution("hopper:address_name", hopper.identity()),
    });
    expect(await client.execute("analyze_function", {})).toEqual({
      ok: true,
      value: createAnalysisExecution(
        "native:analyze_function",
        native.identity(),
      ),
    });
    expect(hopperCalls).toEqual(["address_name"]);
    expect(nativeCalls).toEqual(["analyze_function"]);
    expect(await client.execute("list_names", {})).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });

  it("publishes exact operation provenance and rejects ambiguous routes", () => {
    const hopper = provider("hopper", "address_name", []);
    const native = provider("native", "analyze_function", []);
    const session = new BinarySession(new CompositeProvider([hopper, native]));
    expect(session.providerIdentity("address_name").id).toBe("hopper");
    expect(session.providerIdentity("analyze_function").id).toBe("native");
    expect(session.providerIdentity("binary_overview").id).toBe("hopper");
    expect(session.providerIdentity().id).toBe("composite:hopper+native");
    expect(
      () =>
        new CompositeProvider([
          hopper,
          provider("duplicate", "address_name", []),
        ]),
    ).toThrow(/Multiple providers declare operation address_name/u);
  });
});

const provider = (
  id: string,
  operation: Exclude<AnalysisOperation, "health">,
  calls: string[],
): AnalysisProvider => {
  const identity: ProviderIdentity = { id, name: id, version: "1" };
  return {
    identity: () => identity,
    capabilities: () => [capability(identity, operation)],
    createClient: () => ({
      execute: (called) => {
        calls.push(called);
        return Promise.resolve(
          ok(createAnalysisExecution(`${id}:${called}`, identity)),
        );
      },
      close: () => Promise.resolve(),
    }),
  };
};

const capability = (
  providerIdentity: ProviderIdentity,
  operation: Exclude<AnalysisOperation, "health">,
): CapabilityDescriptor => ({
  provider: providerIdentity,
  operation,
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: { maxResults: null, maxPayloadBytes: 1_000_000, timeoutMs: 5_000 },
  limitations: [],
});
