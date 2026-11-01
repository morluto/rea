import { describe, expect, it, onTestFinished } from "vitest";

import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../../../tests/fixtures/binarySession.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ok } from "../../domain/result.js";
import type {
  AnalysisOperation,
  AnalysisProvider,
  CapabilityDescriptor,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import { buildCapabilityInventory } from "../CapabilityInventory.js";
import { offeredOperationAlternatives } from "../OperationAlternatives.js";

const IDENTITY = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const;
const GENERIC =
  "This analysis is unavailable for the current target. Choose another analysis or target.";

/** The owning formatter's remediation for exactly these offered tools. */
const remediationFor = (operation: string, offered: readonly string[]) =>
  offeredOperationAlternatives(operation, (alternative) =>
    offered.includes(alternative),
  )?.remediation;

const capability = (
  operation: Exclude<AnalysisOperation, "health">,
  available = true,
): CapabilityDescriptor => ({
  provider: IDENTITY,
  operation,
  ...(available
    ? ({ available: true, reason: null } as const)
    : ({
        available: false,
        reason: `${operation} needs a loaded listing`,
      } as const)),
  cachePolicy: "live",
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

/** A deep provider whose declared operations alone decide the offers. */
const openSession = async (capabilities: readonly CapabilityDescriptor[]) => {
  const provider: AnalysisProvider = {
    identity: () => IDENTITY,
    resolveAnalysisProfile: () =>
      Promise.resolve(
        ok({ profile: createAnalysisProfile(IDENTITY, { fixture: true }) }),
      ),
    capabilities: () => capabilities,
    createClient: () => ({
      execute: (operation) => Promise.resolve(observed(operation)),
      close: () => Promise.resolve(ok(null)),
    }),
  };
  const session = createTestBinarySession(provider);
  onTestFinished(async () => {
    expect(await session.close()).toEqual({ ok: true, value: null });
  });
  const [target] = await createBinarySessionTargets();
  expect((await session.open(target)).ok).toBe(true);
  return session;
};

const refusal = async (
  session: Awaited<ReturnType<typeof openSession>>,
  operation: "next_address" | "prev_address",
  options?: ExecutionOptions,
) => {
  const result = await session.execute(operation, {}, options);
  if (result.ok) throw new Error(`${operation} unexpectedly succeeded`);
  return projectAnalysisError(result.error);
};

const offeredInDiscovery = async (
  session: Awaited<ReturnType<typeof openSession>>,
  isToolAdvertised?: (name: string) => boolean,
) =>
  buildCapabilityInventory(
    await session.status(),
    { processCaptureEnabled: false },
    isToolAdvertised,
  )
    .filter(({ name }) => name === "next_address" || name === "prev_address")
    .map((tool) => (tool.available ? undefined : tool.alternatives));

describe("undeclared navigation refusals", () => {
  it("describe only offered tools, what none establishes and the provider choice", () => {
    const offered = offeredOperationAlternatives(
      "prev_address",
      (alternative) => alternative === "procedure_assembly",
    );
    expect(offered?.operations).toEqual(["procedure_assembly"]);
    expect(offered?.remediation).toContain("procedure_assembly (");
    expect(offered?.remediation).not.toMatch(
      /inspect_native_instruction|read_function_instructions/u,
    );
    expect(offered?.remediation).toContain("executed control flow");
    expect(offered?.remediation).toContain("prev_address itself");
    expect(
      offeredOperationAlternatives("list_procedures", () => true),
    ).toBeUndefined();
  });

  it("offer only alternatives the provider makes available", async () => {
    const session = await openSession([
      capability("inspect_native_instruction", false),
      capability("read_function_instructions"),
      capability("procedure_assembly"),
    ]);
    for (const operation of ["next_address", "prev_address"] as const)
      expect(await refusal(session, operation)).toMatchObject({
        code: "capability_unavailable",
        remediation: {
          action: remediationFor(operation, [
            "read_function_instructions",
            "procedure_assembly",
          ]),
        },
        details: {
          provider_id: "fixture",
          operation,
          alternatives: ["read_function_instructions", "procedure_assembly"],
        },
      });
    expect(await offeredInDiscovery(session)).toEqual([
      ["read_function_instructions", "procedure_assembly"],
      ["read_function_instructions", "procedure_assembly"],
    ]);
  });

  it("offer only alternatives the caller advertises", async () => {
    const session = await openSession([
      capability("read_function_instructions"),
      capability("procedure_assembly"),
    ]);
    const withoutListing = (operation: string) =>
      operation !== "read_function_instructions";
    const narrowed = await refusal(session, "next_address", {
      isOperationAdvertised: withoutListing,
    });
    expect(narrowed.details?.alternatives).toEqual(["procedure_assembly"]);
    expect(narrowed.remediation.action).toBe(
      remediationFor("next_address", ["procedure_assembly"]),
    );
    expect(await offeredInDiscovery(session, withoutListing)).toEqual([
      ["procedure_assembly"],
      ["procedure_assembly"],
    ]);

    const hidden = (operation: string) =>
      operation !== "read_function_instructions" &&
      operation !== "procedure_assembly";
    const generic = await refusal(session, "prev_address", {
      isOperationAdvertised: hidden,
    });
    expect(generic.remediation.action).toBe(GENERIC);
    expect(generic.details).not.toHaveProperty("alternatives");
    expect(await offeredInDiscovery(session, hidden)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keep a declared operation's own unavailability reason", async () => {
    const session = await openSession([
      capability("next_address", false),
      capability("read_function_instructions"),
    ]);
    const declared = await refusal(session, "next_address");
    expect(declared).toMatchObject({
      code: "capability_unavailable",
      remediation: { action: GENERIC },
      details: { reason: "next_address needs a loaded listing" },
    });
    expect(declared.details).not.toHaveProperty("alternatives");
    const [next, previous] = await offeredInDiscovery(session);
    expect(next).toBeUndefined();
    expect(previous).toEqual(["read_function_instructions"]);
  });
});
