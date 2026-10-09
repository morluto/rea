import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it as test, onTestFinished } from "vitest";
import { z } from "zod";
import { access } from "node:fs/promises";
import { ANDROID_TOOL_CONTRACTS } from "../../../src/contracts/android/androidToolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import type { AndroidAnalysisPort } from "../../../src/application/android/AndroidAnalysisPort.js";
import { silentLogger } from "../../../src/logger.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";

const it = test.skipIf(process.platform === "win32");

it("keeps a replacement server usable after the SDK discards its discovery probe", async () => {
  const { apk } = await createJadxProtocolFixture();
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const factories: Parameters<RuntimeDependencies["serve"]>[0][] = [];
  const providers: AndroidAnalysisPort[] = [];
  const runtime: RuntimeDependencies = {
    env: {},
    serve: (factory) => {
      factories.push(factory);
      return { close: async () => undefined };
    },
    createServer: (analysis, binary, options) => {
      if (options?.androidAnalysis === undefined)
        throw new Error("Expected owned Android provider");
      providers.push(options.androidAnalysis);
      return createServer(analysis, binary, options);
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(runtime, session, {
    logger: silentLogger,
    serverLogger: silentLogger,
    environment: runtime.env,
    delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    loadOptionalProviders: async () => ({}),
  });
  if (!transport.ok) throw new Error("Transport failed");
  const factory = factories[0];
  if (factory === undefined) throw new Error("Missing SDK server factory");
  const probe = await factory({ era: "modern" });
  await probe.close();
  const replacement = await factory({ era: "legacy" });
  const provider = providers[1];
  if (provider === undefined) throw new Error("Missing replacement provider");
  const target = await parseBinaryTarget(apk);
  if (!target.ok) throw target.error;
  try {
    expect(
      await provider.execute(target.value, {
        operation: "inspect_android_package",
        input: { path: apk },
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  } finally {
    await replacement.close();
    await transport.closeAndroid();
    await session.close();
  }
});

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
  const wireTools = new Map(advertised.tools.map((tool) => [tool.name, tool]));
  for (const contract of ANDROID_TOOL_CONTRACTS) {
    const wire = wireTools.get(contract.name);
    if (wire === undefined || wire.outputSchema === undefined)
      throw new Error(`Missing advertised output schema for ${contract.name}`);
    const validateOutput = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(z.record(z.string(), z.unknown()).parse(wire.outputSchema));
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
    expect(validateOutput(response.structuredContent)).toBe(true);
    const result = contract.outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(result);
    expect(evidence.operation).toBe(contract.name);
    expect(evidence.raw_result).not.toBeNull();
  }
  expect(launches).toHaveLength(1);
  await client.close();
  await server.close();
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
