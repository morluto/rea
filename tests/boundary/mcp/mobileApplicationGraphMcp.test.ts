import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { afterEach, expect, it } from "vitest";

import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createServer } from "../../../src/server/createServer.js";

const { runProviderAnalysis } = createDirectAnalysis({});

const resources: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.close();
});

async function connect() {
  const session = createTestBinarySession(() => {
    throw new Error("mobile graph projection must not launch a provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "mobile-application-graph-test",
    version: "1",
  });
  resources.push(client, server, session);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return client;
}

const writeApk = async (directory: string): Promise<string> => {
  const path = join(directory, "Fixture.apk");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "AndroidManifest.xml",
    new Uint8ArrayReader(Uint8Array.from([3, 0, 8, 0])),
  );
  await writer.add(
    "classes.dex",
    new Uint8ArrayReader(
      Uint8Array.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0]),
    ),
  );
  await writeFile(path, await writer.close());
  return path;
};

const writeIpa = async (directory: string): Promise<string> => {
  const path = join(directory, "Fixture.ipa");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "Payload/Fixture.app/Info.plist",
    new TextReader("<plist></plist>"),
  );
  await writer.add(
    "Payload/Fixture.app/Fixture",
    new Uint8ArrayReader(
      Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
    ),
  );
  await writeFile(path, await writer.close());
  return path;
};

it("advertises and executes Android and Apple inventory projections", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  expect(names.has("project_android_application_graph")).toBe(true);
  expect(names.has("project_apple_application_graph")).toBe(true);

  const root = await createTestTempDirectory("rea-mobile-graph-mcp-");
  const apkInventory = parseEvidence(
    await runProviderAnalysis(await writeApk(root), "inventory_artifact", {}),
  );
  const android = await client.callTool({
    name: "project_android_application_graph",
    arguments: { inventory_evidence: [apkInventory] },
  });
  if (android.isError === true)
    throw new Error(JSON.stringify(android, null, 2));
  expect(android.structuredContent).toMatchObject({
    operation: "project_android_application_graph",
    provider: { id: "rea-android-application" },
  });

  const ipaInventory = parseEvidence(
    await runProviderAnalysis(await writeIpa(root), "inventory_artifact", {}),
  );
  const apple = await client.callTool({
    name: "project_apple_application_graph",
    arguments: { inventory_evidence: [ipaInventory] },
  });
  if (apple.isError === true) throw new Error(JSON.stringify(apple, null, 2));
  expect(apple.structuredContent).toMatchObject({
    operation: "project_apple_application_graph",
    provider: { id: "rea-apple-application" },
  });
});
