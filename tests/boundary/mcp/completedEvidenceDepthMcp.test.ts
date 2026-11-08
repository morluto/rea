import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  MAX_JSON_DEPTH,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { withAdmittedAnalysis } from "../../../src/server/analysisAdmission.js";
import { registerEvidenceTools } from "../../../src/server/registerEvidenceTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["raw-result", "profile"] as const)(
  "retains a completed observation with ceiling-depth %s through the named MCP contract",
  async (field) => {
    const provider = { id: "fixture", name: "Depth fixture", version: "1" };
    let deep: JsonValue = "leaf";
    for (let depth = 0; depth < MAX_JSON_DEPTH; depth++) deep = { child: deep };
    const execution = createAnalysisExecution("entry", provider, {
      ...(field === "raw-result"
        ? { rawResult: deep }
        : {
            analysisProfile: createAnalysisProfile(
              provider,
              deep as Record<string, JsonValue>,
            ),
          }),
    });
    const path = join(
      await createTestTempDirectory("rea-completed-depth-"),
      "fixture.com",
    );
    await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const records = new InvestigationRecords({
      availableAuthenticationBytes: () => Number.MAX_SAFE_INTEGER,
    });
    const session = new BinarySession(
      createTestProviderRouter(() => ({
        execute: async () => ok(execution),
        close: async () => ok(null),
      })),
      records,
    );
    const opened = await session.open(path, { formatHint: "dos-com" });
    if (!opened.ok) throw opened.error;
    const server = new EvidenceMcpServer(
      { name: "completed-depth", version: "1" },
      { capabilities: {} },
      session.recordEvidence.bind(session),
      createToolResultDelivery(undefined),
    );
    const contract = OFFICIAL_TOOL_CONTRACTS.find(
      ({ name }) => name === "address_name",
    );
    if (contract === undefined)
      throw new Error("Missing address_name contract");
    registerEvidenceTools(server, [contract], {
      logger: silentLogger,
      activeTarget: () => session.activeTarget(),
      recordEvidence: session.recordEvidence.bind(session),
      admitRecovery: session.admitRecoveryObservation.bind(session),
      withAdmittedAnalysis: withAdmittedAnalysis({ kind: "session", session }),
    });
    const client = new Client({ name: "completed-depth", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const definition = (await client.listTools()).tools.find(
        ({ name }) => name === "address_name",
      );
      if (definition === undefined)
        throw new Error("Named tool was not advertised");
      const response = await client.callTool(
        {
          name: "address_name",
          arguments: { address: "0x100", document: "fixture" },
        },
        { toolDefinition: definition },
      );
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      expect(evidence.normalized_result).toBe("entry");
      expect(
        JSON.stringify(
          field === "raw-result"
            ? evidence.raw_result
            : evidence.analysis_profile?.parameters,
        ),
      ).toBe(JSON.stringify(deep));
      expect(session.hasEvidence(evidence.evidence_id)).toBe(true);
      expect(JSON.stringify(session.evidenceById(evidence.evidence_id))).toBe(
        JSON.stringify(evidence),
      );
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);
