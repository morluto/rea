import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  assertRecoveryCleanup,
  recoveryFixture,
} from "../../fixtures/javascript-recovery/provider.js";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "advertises and executes recovery through the named SDK contract without a binary target",
  async () => {
    const fixture = await recoveryFixture();
    const session = createTestBinarySession(() => {
      throw new Error("no binary provider should start");
    });
    const server = createServer(session, session, {
      javascriptRecovery: fixture.provider,
    });
    const client = new Client({ name: "recovery-contract", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const advertised = tools.tools.find(
      (tool) => tool.name === "recover_javascript_sources",
    );
    if (advertised === undefined || advertised.outputSchema === undefined)
      throw new Error("recovery tool must advertise both schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const args = { path: fixture.path, output_directory: fixture.output };
    expect(ajv.validate(inputSchema, args)).toBe(true);
    const response = await client.callTool({
      name: "recover_javascript_sources",
      arguments: args,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      ajv.validate(outputSchema, response.structuredContent),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const parsed = toolContract(
      "recover_javascript_sources",
    ).outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(parsed.evidence);
    expect(parsed.result).toEqual(evidence.normalized_result);
    expect(parsed.evidence_id).toBe(evidence.evidence_id);
    await assertRecoveryCleanup(fixture.launches);
  },
);
