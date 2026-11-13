import { expect, it, vi } from "vitest";
import {
  isCallToolResult,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from "@modelcontextprotocol/server";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../tests/fixtures/binarySession.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import { registerArtifactComparisonTool } from "./registerArtifactComparisonTool.js";

it.each([false, true])(
  "retains the completed artifact comparison and source closure (terminal cancellation=%s)",
  async (cancel) => {
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls));
    const resources = new ArtifactResourceScope();
    const delivery = new ToolResultDelivery(1024 * 1024);
    const partial = vi.spyOn(
      ToolResultDelivery.prototype,
      "toPartialErrorToolResult",
    );
    const server = new EvidenceMcpServer(
      { name: "artifact-comparison-retention", version: "1" },
      {},
      session.recordEvidence.bind(session),
      delivery,
    );
    const registration = vi.spyOn(server, "registerTool");
    registerArtifactComparisonTool(
      server,
      session,
      toolContract("compare_artifacts"),
      resources,
    );
    // This named registration always has its contract's input schema.
    const callback = registration.mock.calls[0]?.[2] as
      | ToolCallback<StandardSchemaWithJSON>
      | undefined;
    if (callback === undefined)
      throw new Error("Comparison was not registered");
    const controller = new AbortController();
    const reason = { requested: "stop-after-comparison" };
    let completed = false;
    const context = {
      mcpReq: {
        signal: controller.signal,
        _meta: { progressToken: "artifact-comparison" },
        notify: async (notification) => {
          const message = notification.params?.message;
          if (typeof message === "string" && message.startsWith("complete:")) {
            completed = true;
            if (cancel) controller.abort(reason);
          }
        },
      },
    } as ServerContext;
    try {
      const result = await callback(
        {
          left: ARTIFACT_COMPARISON_EXAMPLE.left,
          right: ARTIFACT_COMPARISON_EXAMPLE.right,
        },
        context,
      );
      if (!isCallToolResult(result))
        throw new Error("Expected a completed tool result");
      expect(completed).toBe(true);
      expect(calls).toEqual([]);
      const records = session.immutableEvidenceBundle().records;
      const comparison = records.find(
        ({ operation }) => operation === "compare_artifacts",
      );
      expect(comparison).toMatchObject({
        predicate_type: "rea.artifact-comparison",
        evidence_links: expect.arrayContaining([
          ARTIFACT_COMPARISON_EXAMPLE.left.evidence_id,
          ARTIFACT_COMPARISON_EXAMPLE.right.evidence_id,
        ]),
      });
      expect(
        records.filter(({ operation }) => operation === "compare_artifacts"),
      ).toHaveLength(1);
      expect(records).toContainEqual(ARTIFACT_COMPARISON_EXAMPLE.left);
      expect(records).toContainEqual(ARTIFACT_COMPARISON_EXAMPLE.right);
      if (cancel) {
        const failure = partial.mock.calls[0]?.[0];
        expect(failure?.cause).toBe(reason);
        expect(failure?.partialObservation).toEqual(comparison);
        expect(
          JSON.parse(
            result.content.find((part) => part.type === "text")?.text ?? "null",
          ),
        ).toMatchObject({
          error: {
            code: "cancelled",
            details: {
              partial_observation: {
                kind: "retained-evidence",
                evidence_id: comparison?.evidence_id,
              },
            },
          },
        });
      } else {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(comparison);
      }
    } finally {
      partial.mockRestore();
      await resources.close();
      await session.close();
      await server.close();
    }
  },
);
