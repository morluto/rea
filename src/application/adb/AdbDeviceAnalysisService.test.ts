import { chmod, readFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../../tests/support/workspace/workspaceFixture.js";
import { AdbProvider } from "../../adb/AdbProvider.js";

import { AdbDeviceAnalysisService } from "./AdbDeviceAnalysisService.js";
import type { AdbDeviceAnalysisPort } from "./AdbDeviceAnalysisPort.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";

const identity = { id: "adb", name: "Android Debug Bridge", version: null };

const execution = createAnalysisExecution(
  {
    client: {
      binary_path: "/usr/bin/adb",
      path_source: "path",
      version: "34.0.5-debian",
      installed_path: "/usr/bin/adb",
    },
    devices: [],
    may_have_started_adb_server: false,
  },
  identity,
);

const refusedPort: AdbDeviceAnalysisPort = {
  async inspectAvailability() {
    throw new Error("must not probe");
  },
  async close() {},
  async execute() {
    throw new Error("must not execute");
  },
};

it.each([
  [{}],
  [{ serial: "" }],
  [{ serial: "has space" }],
  [{ serial: "emulator-5554", scope: "unknown" }],
  [{ serial: "emulator-5554", extra: true }],
])("rejects invalid device selection before any effect: %j", async (input) => {
  const service = new AdbDeviceAnalysisService(refusedPort);
  expect(await service.execute("inspect_adb_device", input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it.each([
  [{ component: "example.app" }, ["component"]],
  [{ component: "example.app/" }, ["component"]],
  [
    { extras: [{ key: "count", type: "int", value: "2147483648" }] },
    ["extras", 0, "value"],
  ],
  [
    { extras: [{ key: "count", type: "int", value: "-2147483649" }] },
    ["extras", 0, "value"],
  ],
  [
    { extras: [{ key: "count", type: "long", value: "9223372036854775808" }] },
    ["extras", 0, "value"],
  ],
  [
    { extras: [{ key: "count", type: "long", value: "-9223372036854775809" }] },
    ["extras", 0, "value"],
  ],
] as const)(
  "rejects an unrepresentable activity argument before any effect: %j",
  async (input, path) => {
    const service = new AdbDeviceAnalysisService(refusedPort);
    const result = await service.execute("start_adb_activity", {
      serial: "fixture",
      action: "example.TEST",
      ...input,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError", issues: [{ path }] },
    });
  },
);

it("rejects an unknown operation before any effect", async () => {
  const service = new AdbDeviceAnalysisService(refusedPort);
  const result = await service.execute("unknown_adb_operation" as never, {});
  if (result.ok) throw new Error("Expected an unknown operation refusal");
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  if (!(result.error instanceof AnalysisInputError)) throw result.error;
  expect(result.error.operation).toBe("unknown_adb_operation");
  expect(result.error.issues).toContainEqual(
    expect.objectContaining({ path: ["operation"] }),
  );
});

it("composes observed Evidence with the caller parameters inline", async () => {
  const port: AdbDeviceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      expect(request).toEqual({
        operation: "list_adb_devices",
        input: {},
      });
      return ok(execution);
    },
  };
  const result = await new AdbDeviceAnalysisService(port).execute(
    "list_adb_devices",
    {},
  );
  if (!result.ok) throw new Error(result.error.message);
  const evidence = parseEvidence(result.value);
  expect(evidence.provider).toEqual(identity);
  expect(evidence.operation).toBe("list_adb_devices");
  expect(evidence.parameters).toEqual({});
  expect(evidence.confidence).toBe("observed");
});

it("preserves cancellation before execution", async () => {
  const controller = new AbortController();
  const cancellationReason = { source: "caller", operation: "shutdown" };
  controller.abort(cancellationReason);
  const service = new AdbDeviceAnalysisService(refusedPort);
  const result = await service.execute(
    "list_adb_devices",
    {},
    {
      signal: controller.signal,
    },
  );
  if (result.ok) throw new Error("Expected cancellation before execution");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(cancellationReason);
});

it.skipIf(process.platform === "win32").each([false, true])(
  "projects full transport facts through the shared client boundary (late abort %s)",
  async (lateAbort) => {
    const workspace = await createTestWorkspace("rea-adb-transport-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const lines = [
      "safe device model:Pixel transport_id:2147483648",
      "exact device model:Pixel transport_id:18446744073709551615",
      "invalid device model:Pixel transport_id:0",
      "missing device model:Pixel",
      "suffix device product:foo transport_id:7 model:Pixel transport_id:9",
    ];
    const logPath = workspace.path("commands.jsonl");
    const binary = await workspace.write(
      "adb",
      `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(logPath)},JSON.stringify(args)+'\\n');\nif(args[0]==='version')process.stdout.write('Android Debug Bridge version 1.0.41\\nVersion 35.0.2-inert\\n');\nelse if(args[0]==='devices'&&args[1]==='-l')process.stdout.write(${JSON.stringify(lines.join("\n") + "\n")});\nelse if(args[0]==='-s'&&args[1]==='exact'&&args[2]==='shell'&&args[3]==='getprop')process.stdout.write('[ro.build.version.sdk]: [34]\\n');\nelse throw Error('No other command authorized');\n`,
    );
    await chmod(binary, 0o755);
    const provider = new AdbProvider({ environment: { REA_ADB_PATH: binary } });
    onTestFinished(() => provider.close());
    const controller = new AbortController();
    const port: AdbDeviceAnalysisPort = {
      inspectAvailability: provider.inspectAvailability.bind(provider),
      close: provider.close.bind(provider),
      async execute(request, options) {
        const result = await provider.execute(request, options);
        if (lateAbort) controller.abort("after listing");
        return result.ok
          ? ok({
              ...result.value,
              rawResult: { fixture_observation: "retained verbatim" },
            })
          : result;
      },
    };
    const result = await new AdbDeviceAnalysisService(port).execute(
      "list_adb_devices",
      {},
      { signal: controller.signal },
    );
    const evidence = result.ok
      ? result.value
      : parseEvidence(result.error.partialObservation);
    expect(result.ok).toBe(!lateAbort);
    expect(evidence.normalized_result).toMatchObject({
      devices: [
        {
          serial: "safe",
          transport_id: 2147483648,
          transport_id_text: "2147483648",
          transport_id_status: "reported",
        },
        {
          serial: "exact",
          transport_id: null,
          transport_id_text: "18446744073709551615",
          transport_id_status: "reported",
        },
        {
          serial: "invalid",
          transport_id: null,
          transport_id_text: null,
          transport_id_status: "invalid",
        },
        {
          serial: "missing",
          transport_id: null,
          transport_id_text: null,
          transport_id_status: "not_reported",
        },
        {
          serial: "suffix",
          transport_id: 9,
          transport_id_text: "9",
          transport_id_status: "reported",
        },
      ],
    });
    expect(evidence.raw_result).toMatchObject({
      provider_raw_result: { fixture_observation: "retained verbatim" },
      transport_id_observations: [
        {
          row: 0,
          serial: "safe",
          source_token: "2147483648",
          source_line: lines[0],
        },
        {
          row: 1,
          serial: "exact",
          source_token: "18446744073709551615",
          source_line: lines[1],
        },
        {
          row: 2,
          serial: "invalid",
          source_token: "0",
          reason: "reserved_zero",
        },
        {
          row: 3,
          serial: "missing",
          source_token: null,
          reason: "not_reported",
        },
        { row: 4, serial: "suffix", source_token: "9" },
      ],
    });
    const inspected = await new AdbDeviceAnalysisService(provider).execute(
      "inspect_adb_device",
      { serial: "exact" },
    );
    expect(inspected.ok).toBe(true);
    expect(
      (await readFile(logPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    ).toContainEqual(["-s", "exact", "shell", "getprop"]);
  },
);
