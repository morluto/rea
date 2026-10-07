import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it as test, onTestFinished } from "vitest";
import { access } from "node:fs/promises";
import { ANDROID_TOOL_CONTRACTS } from "../../../src/contracts/android/androidToolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";

const it = test.skipIf(process.platform === "win32");

it("publishes and executes all APK contracts with inline Evidence and no active binary", async () => {
  const { provider, apk, launches } = await createJadxProtocolFixture();
  const session = createTestBinarySession(() => {
    throw new Error("APK analysis must not acquire a deep binary provider");
  });
  const server = createServer(session, session, { androidAnalysis: provider });
  const client = new Client({
    name: "android-contract-regression",
    version: "1",
  });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = await client.listTools();
  for (const contract of ANDROID_TOOL_CONTRACTS) {
    const wire = advertised.tools.find((tool) => tool.name === contract.name);
    expect(wire?.annotations).toMatchObject(contract.annotations);
    expect(contract.effects).toMatchObject({
      mutatesTarget: false,
      launchesProcess: true,
      writesFilesystem: true,
      accessesNetwork: false,
    });
    const input = {
      path: apk,
      ...(contract.name === "search_android_classes"
        ? { query: "Target" }
        : {}),
      ...(contract.name === "inspect_android_class" ||
      contract.name === "inspect_android_method" ||
      contract.name === "trace_android_references"
        ? { class_name: "fixture.Target" }
        : {}),
      ...(contract.name === "inspect_android_method"
        ? { method_name: "onCreate" }
        : {}),
    };
    const response = await client.callTool({
      name: contract.name,
      arguments: input,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const result = contract.outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(result.evidence);
    expect(result.result).toEqual(evidence.normalized_result);
    expect(result.evidence_id).toBe(evidence.evidence_id);
    expect(evidence.operation).toBe(contract.name);
    expect(evidence.raw_result).not.toBeNull();
  }
  expect(launches).toHaveLength(5);
  await verifyJadxFixtureCleanup(launches);
});

it("cleans an active engine when the MCP client disconnects", async () => {
  const { provider, apk, launches } = await createJadxProtocolFixture("stall");
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected native provider acquisition");
  });
  const server = createServer(session, session, { androidAnalysis: provider });
  const client = new Client({
    name: "android-disconnect-regression",
    version: "1",
  });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const pending = client
    .callTool({ name: "inspect_android_package", arguments: { path: apk } })
    .catch(() => undefined);
  await expect.poll(() => launches.length).toBe(1);
  await client.close();
  await pending;
  await expect
    .poll(async () => {
      const workspace = launches[0]?.cwd;
      if (workspace === undefined) return false;
      try {
        await access(workspace);
        return false;
      } catch (cause) {
        return (
          cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        );
      }
    })
    .toBe(true);
  await verifyJadxFixtureCleanup(launches);
});
