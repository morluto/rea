import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import type { AdbDeviceAnalysisPort } from "../../../src/application/adb/AdbDeviceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = { id: "adb", name: "Android Debug Bridge", version: null };

const clientIdentity = {
  binary_path: "/usr/bin/adb",
  path_source: "path",
  version: "34.0.5-debian",
  installed_path: "/usr/bin/adb",
};

const results: Readonly<Record<string, unknown>> = {
  inspect_adb_client: {
    client: clientIdentity,
    contacted_adb_server: false,
  },
  list_adb_devices: {
    client: clientIdentity,
    devices: [
      {
        serial: "emulator-5554",
        state: "device",
        transport: "tcp",
        product: "sdk_gphone64_x86_64",
        model: "sdk_gphone64_x86_64",
        device: "emu64xa",
        transport_id: 1,
        kind: "emulator",
        kind_basis: "emulator_serial_prefix",
      },
    ],
    may_have_started_adb_server: false,
  },
  inspect_adb_device: {
    client: clientIdentity,
    serial: "emulator-5554",
    properties: [{ name: "ro.build.version.sdk", value: "34" }],
    property_count: 1,
    emulator_observed: true,
  },
  list_adb_packages: {
    client: clientIdentity,
    serial: "emulator-5554",
    scope: "third_party",
    packages: [
      {
        package_name: "com.example",
        base_apk_device_path: "/data/app/x/base.apk",
      },
    ],
    unparsed_lines: [],
    coverage: "complete",
  },
  pull_adb_package: {
    client: clientIdentity,
    serial: "emulator-5554",
    package_name: "com.example",
    output_directory: "/tmp/rea-pulls",
    artifacts: [
      {
        device_path: "/data/app/x/base.apk",
        file_name: "base.apk",
        local_path: "/tmp/rea-pulls/com.example/base.apk",
        bytes: 2048,
        sha256: "a".repeat(64),
        role: "base",
        role_basis: "file_name",
      },
    ],
    failures: [],
    coverage: "complete",
  },
};

it("advertises exact valid ADB schemas and records inline evidence through MCP", async () => {
  const provider: AdbDeviceAnalysisPort = {
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
    { adbDeviceAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "adb-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const operationNames = [
    "inspect_adb_client",
    "list_adb_devices",
    "inspect_adb_device",
    "list_adb_packages",
    "pull_adb_package",
  ] as const;
  for (const name of operationNames) expect(names, name).toContain(name);

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const name of operationNames) {
    const contract = toolContract(name);
    const listed = tools.find((tool) => tool.name === name);
    expect(listed, name).toBeTruthy();
    if (listed?.inputSchema === undefined) continue;
    expect(() =>
      ajv.compile(JSON.parse(JSON.stringify(listed.inputSchema))),
    ).not.toThrow();
    expect(listed.inputSchema).toEqual(
      JSON.parse(JSON.stringify(contract.inputSchema)),
    );
  }

  const pulled = await client.callTool({
    name: "pull_adb_package",
    arguments: {
      serial: "emulator-5554",
      package: "com.example",
      output_directory: "/tmp/rea-pulls",
    },
  });
  expect(pulled.isError).not.toBe(true);
  const text = (pulled.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  const evidence = parseEvidence(JSON.parse(text));
  expect(evidence.provider.id).toBe("adb");
  expect(evidence.operation).toBe("pull_adb_package");
  expect(evidence.normalized_result).toMatchObject({
    artifacts: [{ file_name: "base.apk", role: "base", bytes: 2048 }],
    coverage: "complete",
  });
});

it("rejects invalid tool input before reaching the provider", async () => {
  const provider: AdbDeviceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      throw new Error("must not execute");
    },
  };
  const server = createServer(
    {
      kind: "session",
      session: createTestBinarySession(() => {
        throw new Error("must not start");
      }),
    },
    { adbDeviceAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "adb-boundary-invalid", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const rejected = await client.callTool({
    name: "inspect_adb_device",
    arguments: { serial: "bad serial" },
  });
  expect(rejected.isError).toBe(true);
  const text = (rejected.content as { readonly text?: string }[])
    .map((part) => part.text ?? "")
    .join("");
  expect(text).toContain("invalid_input");
});
