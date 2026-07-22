import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { createEvidence } from "../src/domain/evidence.js";
import { observed } from "./fixtures/analysisExecution.js";
import { createServer } from "../src/server/createServer.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import { createInvestigationWorkspace } from "../src/domain/investigationWorkspace.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

describe("evidence MCP resources", () => {
  it("lists and reads only evidence owned by the current session", async () => {
    const session = new BinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
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
    const server = createServer(session, session);
    const client = new Client({ name: "evidence-resource-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

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
          "rea://snapshot/{snapshotDigest}",
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
        const active = await client.readResource({
          uri: "rea://unknowns/active",
        });
        expect(active.contents[0]).toEqual(
          expect.objectContaining({
            text: expect.stringContaining(unknown.value.unknown_id),
          }),
        );
      }
      await expect(
        client.readResource({ uri: `rea://evidence/ev_${"0".repeat(64)}` }),
      ).rejects.toThrow(/not found/iu);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});
