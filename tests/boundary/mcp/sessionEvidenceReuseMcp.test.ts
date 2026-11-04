import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import {
  withAdmittedAnalysis,
  type WithAdmittedAnalysis,
} from "../../../src/server/analysisAdmission.js";
import { registerEvidenceTools } from "../../../src/server/registerEvidenceTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["normal", "copied", "parameters", "forged", "source"] as const)(
  "preserves direct observation identity across the %s session boundary",
  async (mode) => {
    const provider = {
      id: "fixture",
      name: "Fixture analysis provider",
      version: "1",
    };
    const path = join(
      await createTestTempDirectory("rea-session-reuse-"),
      "fixture.com",
    );
    await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    let forged: Evidence | undefined;
    let source: Evidence | undefined;
    const router = createTestProviderRouter(
      () => ({
        execute: async () =>
          ok({
            ...createAnalysisExecution(["0x100"], provider, {
              ...(mode === "source" && source !== undefined
                ? { sourceEvidence: [source] }
                : {}),
            }),
            ...(mode === "forged" && forged !== undefined
              ? { evidenceId: forged.evidence_id }
              : {}),
          }),
        close: async () => ok(null),
      }),
      {
        resolveAnalysisProfile: async () =>
          ok({ profile: createAnalysisProfile(provider, {}) }),
      },
    );
    const session = new BinarySession(router);
    const opened = await session.open(path, { formatHint: "dos-com" });
    if (!opened.ok) throw opened.error;
    source = createEvidence(
      opened.value,
      provider,
      { operation: "health", parameters: {}, result: "source" },
      { immutable: true },
    );
    forged = createEvidence(
      opened.value,
      provider,
      {
        operation: "xrefs",
        parameters: { address: "0x100", document: "fixture" },
        result: ["0xabad1dea"],
      },
      { immutable: true },
    );
    if (mode === "forged") expect(session.recordEvidence(forged).ok).toBe(true);
    const base = withAdmittedAnalysis({ kind: "session", session });
    const admitted: WithAdmittedAnalysis = (name, signal, operation) =>
      base(name, signal, (port) =>
        operation({
          ...port,
          execute: async (op, args, options) => {
            const result = await port.execute(op, args, options);
            return mode === "copied" && op === "xrefs" && result.ok
              ? ok({ ...result.value, result: ["0x200"] })
              : result;
          },
        }),
      );
    const server = new EvidenceMcpServer(
      { name: "reuse-control", version: "1" },
      { capabilities: {} },
      session.recordEvidence.bind(session),
      createToolResultDelivery(undefined),
    );
    registerEvidenceTools(server, [toolContract("xrefs")], {
      logger: silentLogger,
      activeTarget: () => session.activeTarget(),
      recordEvidence: session.recordEvidence.bind(session),
      evidenceById: session.evidenceForAnalysis.bind(session),
      admitRecovery: session.admitRecoveryObservation.bind(session),
      withAdmittedAnalysis: admitted,
      ...(mode === "parameters"
        ? {
            parametersForExecution: (_operation, parameters) => ({
              ...parameters,
              address: "0x300",
            }),
          }
        : {}),
    });
    const client = new Client({ name: "reuse-control", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const response = await client.callTool({
        name: "xrefs",
        arguments: { address: "0x100", document: "fixture" },
      });
      expect(response.isError).not.toBe(true);
      const result = response.structuredContent as {
        normalized_result: string[];
        parameters: { address: string };
        evidence_id: string;
        evidence_links: string[];
      };
      expect(result.normalized_result).toEqual([
        mode === "copied" ? "0x200" : "0x100",
      ]);
      expect(result.parameters.address).toBe("0x100");
      if (mode === "forged")
        expect(result.evidence_id).not.toBe(forged.evidence_id);
      if (mode === "source")
        expect(result.evidence_links).toContain(source.evidence_id);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);
