import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { composeBinarySessionFromFactory } from "../../../src/application/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createInvestigationWorkspace } from "../../../src/domain/investigationWorkspace.js";
import { createResidualUnknown } from "../../../src/domain/residualUnknown.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

interface ResourceFixture {
  readonly evidence: ReturnType<typeof createEvidence>;
  readonly capture: ReturnType<typeof createEvidence>;
  readonly workspace: ReturnType<typeof createInvestigationWorkspace>;
  readonly unknown: ReturnType<BinarySession["recordUnknown"]>;
}

function seedResourceFixture(session: BinarySession): ResourceFixture {
  const evidence = createEvidence(undefined, provider, {
    operation: "resource_probe",
    parameters: {},
    result: { observed: true },
  });
  session.recordEvidence(evidence);
  const capture = createEvidence(undefined, provider, {
    operation: "capture_process_scenario",
    parameters: {},
    result: {
      frames: [{ sequence: 0, at_ms: 0, data: "ready" }],
      protocol_events: [],
      replay_transitions: [],
    },
  });
  session.recordEvidence(capture);
  const workspace = createInvestigationWorkspace(
    "resource test",
    createEvidenceBundle([]),
    [],
  );
  session.retainInvestigationWorkspace(workspace);
  const unknown = session.recordUnknown({
    approved: true,
    question: "Was every branch observed?",
    severity: "medium",
    domain: "control-flow",
    supporting_evidence_ids: [evidence.evidence_id],
    contradicting_evidence_ids: [],
    required_authority: "controlled-replay",
    required_confidence: "observed",
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  });
  expect(unknown.ok).toBe(true);
  return { evidence, capture, workspace, unknown };
}

async function verifyResourceProtocol(
  client: Client,
  fixture: ResourceFixture,
): Promise<void> {
  const { evidence, capture, workspace, unknown } = fixture;
  const templates = await client.listResourceTemplates();
  expect(templates.resourceTemplates).toContainEqual(
    expect.objectContaining({ uriTemplate: "rea://evidence/{evidenceId}" }),
  );
  expect(
    templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate),
  ).toEqual(
    expect.arrayContaining([
      "rea://artifact/{manifestId}/{collection}",
      "rea://function/{targetSha256}/{address}",
      "rea://evidence-bundle/{bundleDigest}",
      "rea://workspace/{workspaceId}/revision/{revision}",
    ]),
  );
  expect(templates.resourceTemplates).toContainEqual(
    expect.objectContaining({
      uriTemplate: "rea://evidence/{evidenceId}/section/{section}",
    }),
  );
  const listed = await client.listResources();
  expect(listed.resources).toContainEqual(
    expect.objectContaining({ uri: "rea://snapshot/current" }),
  );
  expect(listed.resources).not.toContainEqual(
    expect.objectContaining({
      uri: `rea://evidence/${evidence.evidence_id}`,
    }),
  );
  const read = await client.readResource({
    uri: `rea://evidence/${evidence.evidence_id}`,
  });
  expect(read.contents).toEqual([
    expect.objectContaining({
      uri: `rea://evidence/${evidence.evidence_id}`,
      mimeType: "application/json",
      text: expect.stringContaining(evidence.evidence_id),
    }),
  ]);
  const firstSnapshot = await client.callTool({
    name: "snapshot_evidence_bundle",
    arguments: {},
  });
  const secondSnapshot = await client.callTool({
    name: "snapshot_evidence_bundle",
    arguments: {},
  });
  expect(secondSnapshot.structuredContent).toEqual(
    firstSnapshot.structuredContent,
  );
  expect(firstSnapshot.content).toContainEqual(
    expect.objectContaining({
      type: "text",
      text: expect.stringContaining("Copy the opaque URI exactly"),
    }),
  );
  const bundleUri = z
    .object({ result: z.object({ bundle_uri: z.string() }) })
    .parse(firstSnapshot.structuredContent).result.bundle_uri;
  const retainedBundle = await client.readResource({ uri: bundleUri });
  expect(retainedBundle.contents[0]).toEqual(
    expect.objectContaining({
      uri: bundleUri,
      text: expect.stringContaining(evidence.evidence_id),
    }),
  );
  const terminal = await client.readResource({
    uri: `rea://evidence/${capture.evidence_id}/section/terminal`,
  });
  const workspaceResource = await client.readResource({
    uri: `rea://workspace/${workspace.workspace_id}/revision/${String(workspace.revision)}`,
  });
  expect(workspaceResource.contents[0]).toEqual(
    expect.objectContaining({
      text: expect.stringContaining(workspace.revision_digest),
    }),
  );
  expect(terminal.contents[0]).toEqual(
    expect.objectContaining({ text: expect.stringContaining("ready") }),
  );
  if (unknown.ok) {
    const unknownResource = await client.readResource({
      uri: `rea://unknown/${unknown.value.unknown_id}`,
    });
    expect(unknownResource.contents[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining(unknown.value.revision_digest),
      }),
    );
  }
  await expect(
    client.readResource({ uri: `rea://evidence/ev_${"0".repeat(64)}` }),
  ).rejects.toThrow(/not found/iu);
}

describe("evidence MCP resources", () => {
  it("publishes mutable snapshot changes for every Evidence mutation", () => {
    const session = composeBinarySessionFromFactory(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    let updates = 0;
    session.onAnalysisSnapshotChanged(() => {
      updates += 1;
    });
    const first = createEvidence(undefined, provider, {
      operation: "notification_probe",
      parameters: {},
      result: 1,
    });
    expect(session.recordEvidence(first)).toEqual({ ok: true, value: "added" });
    expect(session.recordEvidence(first)).toEqual({
      ok: true,
      value: "duplicate",
    });
    const importedUnknown = createResidualUnknown(
      {
        approved: true,
        question: "Does an imported unknown publish a snapshot update?",
        severity: "low",
        domain: "notifications",
        supporting_evidence_ids: [first.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      },
      first.evidence_id,
      first.subject?.digest.sha256 ?? null,
    );
    expect(
      session.importEvidenceBundle(
        createEvidenceBundle([first], [importedUnknown]),
      ),
    ).toEqual({ ok: true, value: 0 });
    const imported = createEvidence(undefined, provider, {
      operation: "import_notification_probe",
      parameters: {},
      result: 2,
    });
    expect(
      session.importEvidenceBundle(createEvidenceBundle([imported])),
    ).toEqual({ ok: true, value: 1 });
    expect(
      session.recordUnknown({
        approved: true,
        question: "Does mutation publish a snapshot update?",
        severity: "low",
        domain: "notifications",
        supporting_evidence_ids: [first.evidence_id],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
      }).ok,
    ).toBe(true);
    expect(updates).toBe(4);
  });

  it("contains observer failures after committing a mutation", () => {
    const session = composeBinarySessionFromFactory(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    session.onAnalysisSnapshotChanged(() => {
      throw new Error("fixture observer failure");
    });
    expect(() =>
      session.recordEvidence(
        createEvidence(undefined, provider, {
          operation: "observer_failure_probe",
          parameters: {},
          result: true,
        }),
      ),
    ).not.toThrow();
  });
});

describe("evidence bundle resources", () => {
  it("retains bundles without eviction and rejects a seventeenth digest", () => {
    const session = composeBinarySessionFromFactory(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const first = session.snapshotEvidenceBundle();
    expect(first.ok).toBe(true);
    for (let index = 0; index < 15; index += 1) {
      session.recordEvidence(
        createEvidence(undefined, provider, {
          operation: `retention_probe_${String(index)}`,
          parameters: {},
          result: index,
        }),
      );
      expect(session.snapshotEvidenceBundle().ok).toBe(true);
    }
    session.recordEvidence(
      createEvidence(undefined, provider, {
        operation: "retention_probe_overflow",
        parameters: {},
        result: true,
      }),
    );
    expect(session.snapshotEvidenceBundle()).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceLimitError", limit: "records", maximum: 16 },
    });
    if (first.ok) {
      expect(session.retainedEvidenceBundle(first.value.bundleDigest)).toEqual(
        expect.any(String),
      );
      expect(session.releaseEvidenceBundle(first.value.bundleDigest)).toBe(
        true,
      );
      expect(session.releaseEvidenceBundle(first.value.bundleDigest)).toBe(
        false,
      );
      expect(session.snapshotEvidenceBundle().ok).toBe(true);
    }
  });

  it("lists and reads only evidence owned by the current session", async () => {
    const session = composeBinarySessionFromFactory(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const fixture = seedResourceFixture(session);
    const server = createServer(session, session);
    const client = new Client({
      name: "evidence-resource-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await verifyResourceProtocol(client, fixture);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  }, 10_000);
});
