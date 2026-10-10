import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = { id: "apktool", name: "Apktool", version: "2.7.0-dirty" };

const clientIdentity = {
  command: "/usr/bin/apktool",
  command_source: "path",
  apktool_version: "2.7.0-dirty",
};

const results: Readonly<Record<string, unknown>> = {
  inspect_apktool_client: { client: clientIdentity },
  decode_android_resources: {
    client: clientIdentity,
    target: {
      path: "/targets/probe.apk",
      bytes: 8524,
      sha256: "a".repeat(64),
    },
    metadata: {
      version_name: "1.2.3",
      version_code: "7",
      min_sdk_version: "24",
      target_sdk_version: "34",
      package_name: "com.rea.apktool.probe",
    },
    manifest:
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rea.apktool.probe"/>',
    strings: [{ name: "app_name", value: "ApktoolProbe" }],
    locale: null,
    locales: ["de"],
    decoded_file_count: 5,
    coverage: "complete",
  },
};

it("advertises exact valid Apktool schemas and records inline evidence through MCP", async () => {
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      return ok(createAnalysisExecution(results[request.operation], identity));
    },
  };
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { apktoolAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "apktool-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const operationNames = [
    "inspect_apktool_client",
    "decode_android_resources",
  ] as const;
  for (const name of operationNames) expect(names, name).toContain(name);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of operationNames) {
    const contract = toolContract(name);
    const listed = tools.find((tool) => tool.name === name);
    expect(listed, name).toBeTruthy();
    if (listed?.inputSchema === undefined) continue;
    const validate = ajv.compile(
      JSON.parse(JSON.stringify(listed.inputSchema)),
    );
    for (const example of contract.examples)
      expect(validate(example.input), `${name} example`).toBe(true);
    expect(validate({ unknown_argument: true }), `${name} rejects`).toBe(false);
  }

  const decoded = await client.callTool({
    name: "decode_android_resources",
    arguments: { path: "/targets/probe.apk" },
  });
  expect(decoded.isError).not.toBe(true);
  const text = (decoded.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const evidence = parseEvidence(JSON.parse(text));
  expect(evidence.provider.id).toBe("apktool");
  expect(evidence.normalized_result).toMatchObject({
    metadata: { package_name: "com.rea.apktool.probe", version_name: "1.2.3" },
    coverage: "complete",
  });
});
