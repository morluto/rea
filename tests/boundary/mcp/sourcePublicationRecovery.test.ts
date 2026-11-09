import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../../../src/domain/analysisObservation.js";
import { UNRETAINED_EVIDENCE_EXPORT_GUIDANCE } from "../../../src/domain/analysisErrorPresentation.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { safeParseEvidence } from "../../../src/domain/evidenceValidation.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";

const assertPublication = ({
  error,
  source,
  primary,
  sourceKind,
  primaryKind,
  preexisting,
  differentPath,
  selectedPath,
  session,
}: {
  error: ReturnType<typeof parseMcpToolError>["error"];
  source: Evidence;
  primary: Evidence | undefined;
  sourceKind:
    | "small"
    | "invalid"
    | "invalid-id"
    | "invalid-json"
    | "invalid-null"
    | "large"
    | "large-limited";
  primaryKind: "small" | "large";
  preexisting: boolean;
  differentPath: boolean;
  selectedPath: string;
  session: BinarySession;
}): void => {
  expect(error.code).toBe(
    sourceKind === "invalid" ||
      sourceKind === "invalid-id" ||
      sourceKind === "invalid-json" ||
      sourceKind === "invalid-null"
      ? "evidence_integrity_mismatch"
      : "resource_constraint",
  );
  if (error.code === "resource_constraint") {
    expect(error.remediation.action).toContain(
      UNRETAINED_EVIDENCE_EXPORT_GUIDANCE,
    );
  }
  if (sourceKind === "small")
    expect(error.details).toMatchObject({
      partial_observation: {
        kind: "unretained-evidence",
        evidence: { evidence_id: source.evidence_id },
      },
    });
  if (sourceKind === "large" || sourceKind === "large-limited")
    expect(error.details).toMatchObject({
      partial_observation_omitted: {
        reason: "mcp-response-limit",
        evidence_id: source.evidence_id,
      },
    });
  if (
    sourceKind === "invalid" ||
    sourceKind === "invalid-id" ||
    sourceKind === "invalid-json" ||
    sourceKind === "invalid-null"
  )
    expect(error.details).not.toHaveProperty("partial_observation");
  if (preexisting && differentPath)
    expect(error.details).toMatchObject({
      completed_observation: {
        kind: "unretained-evidence",
        evidence: {
          evidence_id: primary!.evidence_id,
          subject: { local_path: selectedPath },
        },
      },
    });
  else if (preexisting)
    expect(error.details).toMatchObject({
      completed_observation: {
        kind: "retained-evidence",
        source_closure: "not-established",
        evidence_id: primary!.evidence_id,
      },
    });
  else if (sourceKind === "invalid-id" || sourceKind === "invalid-null")
    expect(error.details).toMatchObject({
      completed_observation: {
        kind: "unretained-observation",
        source_closure: "not-established",
        observation: {
          operation: "address_name",
          result: "completed primary",
        },
      },
    });
  else if (primaryKind === "small") {
    expect(error.details).toMatchObject({
      completed_observation: {
        kind: "unretained-evidence",
        source_closure: "not-established",
        evidence: {
          operation: "address_name",
          normalized_result: "completed primary",
        },
      },
    });
    const details = error.details;
    if (details === undefined) throw new Error("Expected error details");
    const record = (details.completed_observation as { evidence: unknown })
      .evidence;
    const parsed = safeParseEvidence(record);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.evidence_links).toEqual([source.evidence_id]);
    expect(session.hasEvidence(parsed.value.evidence_id)).toBe(false);
  } else
    expect(error.details).toMatchObject({
      completed_observation_omitted: {
        reason: "mcp-response-limit",
        retention: "unretained",
      },
    });
};

it.each([
  {
    source: "small",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "invalid",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "invalid-id",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "invalid-json",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "invalid-null",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "large",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "large-limited",
    primary: "small",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "small",
    primary: "large",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "large",
    primary: "large",
    preexisting: false,
    differentPath: false,
  },
  {
    source: "large",
    primary: "small",
    preexisting: true,
    differentPath: false,
  },
  { source: "large", primary: "small", preexisting: true, differentPath: true },
] as const)(
  "retains independently bounded primary and source failure ($source source, $primary primary, preexisting: $preexisting, different path: $differentPath)",
  async ({
    source: sourceKind,
    primary: primaryKind,
    preexisting,
    differentPath,
  }) => {
    const identity = { id: "fixture", name: "Fixture", version: "1" };
    const base = createEvidence(
      undefined,
      identity,
      {
        operation: "health",
        parameters: {},
        result:
          sourceKind === "large" || sourceKind === "large-limited"
            ? "s".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536)
            : "source fact",
      },
      { immutable: true },
    );
    const source =
      sourceKind === "invalid"
        ? { ...base, normalized_result: "tampered" }
        : sourceKind === "invalid-null"
          ? (null as unknown as typeof base)
          : sourceKind === "invalid-json"
            ? ({
                ...base,
                normalized_result: undefined,
              } as unknown as typeof base)
            : sourceKind === "invalid-id"
              ? { ...base, evidence_id: "not-a-valid-id" }
              : base;
    const result =
      primaryKind === "large"
        ? "p".repeat(STDIO_DEFAULT_MAX_BUFFER_SIZE + 65536)
        : "completed primary";
    const path = join(
      await createTestTempDirectory("rea-source-publication-"),
      "fixture.com",
    );
    await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(() => ({
      execute: async () =>
        ok(
          createAnalysisExecution(result, identity, {
            sourceEvidence: [source],
          }),
        ),
      close: async () => ok(null),
    }));
    const records = new InvestigationRecords({
      maximumRepresentationBytes: preexisting ? 20000 : 0,
      ...(sourceKind === "large-limited"
        ? { availableAuthenticationBytes: () => 200000 }
        : {}),
    });
    const session = new BinarySession(router, records);
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "source-publication", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const target = session.activeTarget();
      if (target === undefined) throw new Error("Expected open target");
      const primary = preexisting
        ? createAnalysisExecutionEvidence(
            "address_name",
            { document: "fixture", address: "0x100" },
            {
              ...createAnalysisExecution(result, identity, {
                sourceEvidence: [source],
              }),
              subject: differentPath
                ? { ...target, path: `${path}.old` }
                : target,
            },
            "observed",
          )
        : undefined;
      if (primary !== undefined)
        expect(session.recordEvidence(primary).ok).toBe(true);
      const response = await client.callTool(
        {
          name: "address_name",
          arguments: { document: "fixture", address: "0x100" },
        },
        { timeout: 120000 },
      );
      expect(response.isError).toBe(true);
      const error = parseMcpToolError(response).error;
      assertPublication({
        error,
        source,
        primary,
        sourceKind,
        primaryKind,
        preexisting,
        differentPath,
        selectedPath: path,
        session,
      });
      expect(records.statistics().evidenceRecords).toBe(preexisting ? 1 : 0);
      expect(
        (
          await client.callTool({
            name: "get_evidence_bundle",
            arguments: { detail: "summary" },
          })
        ).isError,
      ).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
  120000,
);

it("reports omission when the primary cannot be safely authenticated", async () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const source = createEvidence(
    undefined,
    identity,
    { operation: "health", parameters: {}, result: "source" },
    { immutable: true },
  );
  const path = join(
    await createTestTempDirectory("rea-recovery-headroom-"),
    "fixture.com",
  );
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(() => ({
    execute: async () =>
      ok(
        createAnalysisExecution("primary", identity, {
          sourceEvidence: [source],
        }),
      ),
    close: async () => ok(null),
  }));
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 0,
    availableAuthenticationBytes: () => 0,
  });
  const session = new BinarySession(router, records);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "recovery-headroom", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path, format: "dos-com" },
        })
      ).isError,
    ).not.toBe(true);
    const response = await client.callTool({
      name: "address_name",
      arguments: { document: "fixture", address: "0x100" },
    });
    const error = parseMcpToolError(response).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        partial_observation: {
          kind: "unretained-evidence",
          evidence: { evidence_id: source.evidence_id },
        },
        completed_observation_omitted: {
          reason: "insufficient-authentication-headroom",
          source_closure: "not-established",
        },
      },
    });
    expect(error.details).not.toHaveProperty("completed_observation");
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("accounts for a wide source ID list before constructing recovery Evidence", async () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const source = createEvidence(
    undefined,
    identity,
    { operation: "health", parameters: {}, result: "source" },
    { immutable: true },
  );
  const path = join(
    await createTestTempDirectory("rea-wide-recovery-"),
    "fixture.com",
  );
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const sources = Array.from({ length: 5000 }, () => source);
  const router = createTestProviderRouter(() => ({
    execute: async () =>
      ok(
        createAnalysisExecution("primary", identity, {
          sourceEvidence: sources,
        }),
      ),
    close: async () => ok(null),
  }));
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 0,
    availableAuthenticationBytes: () => 100000,
  });
  const session = new BinarySession(router, records);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "wide-recovery", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path, format: "dos-com" },
        })
      ).isError,
    ).not.toBe(true);
    const response = await client.callTool({
      name: "address_name",
      arguments: { document: "fixture", address: "0x100" },
    });
    const error = parseMcpToolError(response).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        completed_observation_omitted: {
          reason: "insufficient-authentication-headroom",
          source_closure: "not-established",
        },
      },
    });
    expect(error.details).not.toHaveProperty("completed_observation");
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it.each(["compact", "full"] as const)(
  "reports omitted primary when a retained provider source precedes an authentication refusal (%s)",
  async (profile) => {
    const identity = { id: "fixture", name: "Fixture", version: "1" };
    const source = createEvidence(
      undefined,
      identity,
      { operation: "health", parameters: {}, result: "historical source" },
      { immutable: true },
    );
    const path = join(
      await createTestTempDirectory("rea-source-primary-headroom-"),
      "fixture.com",
    );
    await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const router = createTestProviderRouter(() => ({
      execute: async () =>
        ok(
          createAnalysisExecution("completed primary", identity, {
            sourceEvidence: [source],
          }),
        ),
      close: async () => ok(null),
    }));
    const records = new InvestigationRecords({
      maximumRepresentationBytes: 1000000,
      availableAuthenticationBytes: () => 0,
    });
    const session = new BinarySession(router, records);
    const server = createServer(
      { kind: "session", session },
      {
        environment: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    );
    const client = new Client({
      name: "source-primary-headroom",
      version: "1",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path, format: "dos-com" },
          })
        ).isError,
      ).not.toBe(true);
      const response = await client.callTool({
        name: "address_name",
        arguments: { document: "fixture", address: "0x100" },
      });
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response).error).toMatchObject({
        code: "resource_constraint",
        details: {
          completed_observation_omitted: {
            reason: "insufficient-authentication-headroom",
            source_closure: "not-established",
          },
        },
      });
      expect(records.statistics().evidenceRecords).toBe(1);
      expect(session.hasEvidence(source.evidence_id)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

it("accounts for source links before admitting a completed direct observation", async () => {
  const identity = { id: "fixture", name: "Fixture", version: "1" };
  const source = createEvidence(
    undefined,
    identity,
    { operation: "health", parameters: {}, result: "source" },
    { immutable: true },
  );
  const path = join(
    await createTestTempDirectory("rea-wide-primary-admission-"),
    "fixture.com",
  );
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(() => ({
    execute: async () =>
      ok(
        createAnalysisExecution("primary", identity, {
          sourceEvidence: Array.from({ length: 5000 }, () => source),
        }),
      ),
    close: async () => ok(null),
  }));
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 1000000,
    availableAuthenticationBytes: () => 100000,
  });
  const session = new BinarySession(router, records);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "wide-primary-admission", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path, format: "dos-com" },
        })
      ).isError,
    ).not.toBe(true);
    const response = await client.callTool({
      name: "address_name",
      arguments: { document: "fixture", address: "0x100" },
    });
    expect(response.isError).toBe(true);
    const error = parseMcpToolError(response).error;
    expect(error).toMatchObject({
      code: "resource_constraint",
      details: {
        completed_observation_omitted: {
          reason: "insufficient-authentication-headroom",
          source_closure: "not-established",
        },
      },
    });
    expect(error.details?.reported_limits).toMatchObject({
      available_heap_bytes: 100000,
    });
    const reported = error.details?.reported_limits as
      | { projected_value_bytes: number }
      | undefined;
    expect(reported?.projected_value_bytes).toBeGreaterThan(100000);
    expect(records.statistics().evidenceRecords).toBe(1);
    expect(session.hasEvidence(source.evidence_id)).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
