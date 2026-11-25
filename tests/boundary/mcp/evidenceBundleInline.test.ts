import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  safeParseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { ANALYSIS_SNAPSHOT_TARGET } from "../../../src/domain/analysisSnapshot.fixture.js";

import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../../../src/domain/process/processCaptureExample.js";
import { PROCESS_PROVIDER } from "../../../src/domain/process/processEvidenceProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

it("preserves BOM recovery through public bundle import", async () => {
  const root = await createTestTempDirectory("rea-bundle-bom-mcp-");
  const path = join(root, "bundle.json");
  await writeFile(path, `\uFEFF${JSON.stringify(createEvidenceBundle([]))}`);
  const session = createTestBinarySession(() => {
    throw new Error("bundle import must not start a provider");
  });
  const { client, server } = await connectEvidenceMcp("bundle-bom", session);
  try {
    const response = await client.callTool({
      name: "import_evidence_bundle",
      arguments: { path },
    });
    expect(parseMcpToolError(response)).toMatchObject({
      error: {
        code: "evidence_integrity_mismatch",
        details: {
          path,
          reason: "invalid-json",
          content_issues: [{ reason: "invalid_format" }],
        },
        remediation: {
          action: expect.stringMatching(
            /byte-order mark.*UTF-8 without a byte-order mark/iu,
          ),
        },
      },
    });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("retains complete Evidence across rejected and successful MCP bundle imports", async () => {
  const root = await createTestTempDirectory("rea-evidence-bundle-mcp-");
  const {
    session: sourceSession,
    evidence,
    subject,
  } = createBundleSourceSession(root);
  const targetSession = createTestBinarySession(() => {
    throw new Error("bundle import must not start a provider");
  });
  expect(targetSession.recordEvidence(evidence).ok).toBe(true);
  const source = await connectEvidenceMcp("bundle-source", sourceSession);
  const target = await connectEvidenceMcp("bundle-target", targetSession);
  const bundlePath = join(root, "exported.json");

  try {
    const contents = await exportFixtureBundle(source.client, bundlePath);
    const bundle = parseEvidenceBundle(JSON.parse(contents));
    const evidenceIndex = bundle.records.findIndex(
      ({ evidence_id }) => evidence_id === evidence.evidence_id,
    );
    expect(bundle.records[evidenceIndex]).toEqual(evidence);
    expect(bundle.artifacts).toContainEqual({
      digest: { sha256: subject.sha256 },
      format: "gamecube-dol",
      architecture: "powerpc",
    });
    expect(bundle.unknowns).toHaveLength(1);
    expect(await getBundle(source.client)).toEqual(bundle);
    const initial = createEvidenceBundle([evidence]);
    expect(await getBundle(target.client)).toEqual(initial);

    for (const [label, path] of unsupportedBundleFields(evidenceIndex)) {
      const candidate = structuredClone(bundle);
      setPath(candidate, path, "unsupported-metadata");
      expect(safeParseEvidenceBundle(candidate), label).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-bundle",
          cause: {
            issues: expect.arrayContaining([
              {
                code: "unrecognized_keys",
                path: path.slice(0, -1),
                keys: [path.at(-1)],
                message: expect.any(String),
              },
            ]),
          },
        },
      });
    }

    const malformed = structuredClone(bundle);
    setPath(
      malformed,
      ["records", evidenceIndex, "subject", "identity", "future_field"],
      "unsupported-metadata",
    );
    const malformedPath = join(root, "malformed.json");
    await writeFile(malformedPath, JSON.stringify(malformed));
    const rejected = await target.client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: malformedPath },
    });
    expect(parseMcpToolError(rejected)).toMatchObject({
      error: { code: "evidence_integrity_mismatch" },
    });
    expect(await getBundle(target.client)).toEqual(initial);

    const imported = await target.client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: bundlePath },
    });
    expect(structured(imported).result).toEqual({
      imported: bundle.records.length - 1,
      unknowns_added: 1,
      total: bundle.records.length,
    });
    expect(await getBundle(target.client)).toEqual(bundle);
    const targetExportPath = join(root, "round-trip.json");
    structured(
      await target.client.callTool({
        name: "export_evidence_bundle",
        arguments: { path: targetExportPath },
      }),
    );
    expect(await readFile(targetExportPath, "utf8")).toBe(contents);
  } finally {
    await Promise.allSettled([
      source.client.close(),
      source.server.close(),
      sourceSession.close(),
      target.client.close(),
      target.server.close(),
      targetSession.close(),
    ]);
  }
});

const createBundleSourceSession = (root: string) => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const subject = {
    path: join(root, "game.dol"),
    sha256: "d".repeat(64),
    format: "gamecube-dol",
    architecture: "powerpc",
  } as const;
  const evidence = createEvidence(subject, provider, {
    operation: "observe",
    parameters: { caller: { note: "preserve" } },
    result: { producer: { extension: "preserve" } },
    analysisProfile: createAnalysisProfile(provider, {
      loader: { mode: "full" },
    }),
    environment: {
      id: "fixture-linux",
      platform: "linux",
      architecture: "x86_64",
      isolation: "process",
    },
    locations: [{ kind: "address", address: "0x1000" }],
  });
  const session = createTestBinarySession(() => {
    throw new Error("bundle export must not start a provider");
  });
  expect(session.recordEvidence(evidence).ok).toBe(true);
  for (const extra of [
    createEvidence(ANALYSIS_SNAPSHOT_TARGET, provider, {
      operation: "controlled_replay",
      parameters: {},
      result: { completed: true },
      authority: "controlled-replay",
    }),
    createEvidence(unknownTarget("not-observed"), PROCESS_PROVIDER, {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: EMPTY_PROCESS_CAPTURE_EXAMPLE,
      confidence: "observed",
      authority: "controlled-replay",
    }),
  ])
    expect(session.recordEvidence(extra).ok).toBe(true);
  return { session, evidence, subject };
};

const exportFixtureBundle = async (
  client: Client,
  path: string,
): Promise<string> => {
  const unknown = await client.callTool({
    name: "record_unknown",
    arguments: {
      question: "Does this remain unknown?",
      severity: "medium",
      domain: "bundle-format",
      required_authority: null,
      required_confidence: "derived",
      required_environment: null,
      recommended_probes: [{ operation: "observe", rationale: "Inspect it." }],
      relationships: [],
    },
  });
  expect(unknown.isError).not.toBe(true);
  const exported = await client.callTool({
    name: "export_evidence_bundle",
    arguments: { path },
  });
  expect(exported.isError).not.toBe(true);
  return readFile(path, "utf8");
};

const unsupportedBundleFields = (
  evidenceIndex: number,
): readonly [string, readonly (string | number)[]][] => [
  ["bundle envelope", ["schema_version"]],
  ["record provider", ["records", evidenceIndex, "provider", "future_field"]],
  ["provider manifest", ["providers", 0, "future_field"]],
  ["record subject", ["records", evidenceIndex, "subject", "future_field"]],
  [
    "subject identity",
    ["records", evidenceIndex, "subject", "identity", "future_field"],
  ],
  ["artifact manifest", ["artifacts", 0, "future_field"]],
  [
    "record environment",
    ["records", evidenceIndex, "environment", "future_field"],
  ],
  ["environment manifest", ["environments", 0, "future_field"]],
  [
    "source location",
    ["records", evidenceIndex, "locations", 0, "future_field"],
  ],
  ["scenario manifest", ["scenarios", 0, "future_field"]],
  ["capture manifest", ["captures", 0, "future_field"]],
  [
    "analysis profile",
    ["records", evidenceIndex, "analysis_profile", "future_field"],
  ],
  [
    "profile provider",
    ["records", evidenceIndex, "analysis_profile", "provider", "future_field"],
  ],
  ["unknown revision", ["unknowns", 0, "future_field"]],
  ["unknown probe", ["unknowns", 0, "recommended_probes", 0, "future_field"]],
];

const connectEvidenceMcp = async (
  name: string,
  session: ReturnType<typeof createTestBinarySession>,
) => {
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name, version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
};

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object in exported Evidence bundle");
  return value as Record<string, unknown>;
};

const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new Error("Expected array in Evidence bundle");
  return value;
};

const setPath = (
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void => {
  const [last, ...parents] = [...path].reverse();
  if (last === undefined) throw new Error("Expected a nonempty bundle path");
  const target = parents
    .reverse()
    .reduce<unknown>(
      (current, segment) =>
        typeof segment === "number"
          ? array(current)[segment]
          : object(current)[segment],
      root,
    );
  object(target)[String(last)] = value;
};

const structured = (result: Awaited<ReturnType<Client["callTool"]>>) => {
  if (result.isError === true) throw parseMcpToolError(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("Missing structured MCP result");
  return result.structuredContent as Record<string, unknown>;
};

const getBundle = async (client: Client) =>
  structured(
    await client.callTool({ name: "get_evidence_bundle", arguments: {} }),
  ).result;
