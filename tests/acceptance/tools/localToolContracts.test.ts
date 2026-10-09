import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { itWithCaptureCapability as captureTest } from "../../boundary/process/processCaptureCapability.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));
const nul = "/tmp/selected\0filename";
const electron = {
  executable_path: "/tmp/Electron",
  application_path: "/tmp/main.js",
};
const pathRequests: readonly [string, Record<string, unknown>][] = [
  ["open_binary", { path: nul }],
  ["open_binary", { path: process.execPath, snapshot_path: nul }],
  ["close_binary", { snapshot_path: nul }],
  ["binary_session", { expected_server_path: nul }],
  ["export_evidence_bundle", { path: nul }],
  ["import_evidence_bundle", { path: nul }],
  ["inspect_managed_artifact", { path: nul }],
  ["inspect_android_package", { path: nul }],
  ["search_android_classes", { path: nul, query: "" }],
  ["inspect_android_class", { path: nul, class_name: "probe.Class" }],
  [
    "inspect_android_method",
    { path: nul, class_name: "probe.Class", method_name: "run" },
  ],
  ["trace_android_references", { path: nul, class_name: "probe.Class" }],
  ["inspect_firmware_regions", { path: nul }],
  ["extract_firmware", { path: nul, output_directory: "/tmp/out" }],
  ["extract_firmware", { path: "/tmp/firmware.bin", output_directory: nul }],
  ["inspect_plist", { path: nul }],
  ...[
    { kind: "function", name: "main\0suffix" },
    { kind: "function", name: "main", module: "lib.dylib\0suffix" },
    { kind: "objc-method", selector: "run\0suffix" },
    { kind: "objc-method", class_name: "Probe\0suffix", selector: "run" },
  ].map((breakpoint): [string, Record<string, unknown>] => [
    "observe_native_calls",
    { breakpoints: [breakpoint] },
  ]),
  [
    "observe_native_calls",
    {
      breakpoints: [{ kind: "function", name: "main" }],
      working_directory: nul,
    },
  ],
  [
    "observe_native_calls",
    { breakpoints: [{ kind: "function", name: "main" }], arguments: ["a\0b"] },
  ],
  ["analyze_javascript_application", { input_path: nul }],
  ["recover_javascript_sources", { path: nul, output_directory: "/tmp/out" }],
  [
    "recover_javascript_sources",
    { path: "/tmp/main.js", output_directory: nul },
  ],
  [
    "compare_bundles",
    { left_bundle_path: nul, right_bundle_path: "/tmp/right.json" },
  ],
  [
    "compare_bundles",
    { left_bundle_path: "/tmp/left.json", right_bundle_path: nul },
  ],
  [
    "capture_browser_scenario",
    {
      browser: { mode: "launch", executable_path: nul },
      start_url: { url: "http://127.0.0.1:1" },
      actions: [
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 0 },
      ],
    },
  ],
  ...["executable_path", "application_path", "application_root"].map(
    (key): [string, Record<string, unknown>] => [
      "capture_electron_scenario",
      { ...electron, [key]: nul },
    ],
  ),
  ["capture_electron_scenario", { ...electron, args: ["a\0b"] }],
  ["demangle_swift", { symbols: ["abc\0def"] }],
];

it("rejects OS-invalid local inputs through the real advertised MCP contracts", async () => {
  const { call } = await connectLocalToolsMcp();
  for (const [name, arguments_] of pathRequests) {
    const response = await call(name, arguments_);
    expect(response.isError, name).toBe(true);
    expect(JSON.stringify(response.content), name).toContain("NUL");
  }
  const relative = await call("extract_firmware", {
    path: "/tmp/firmware.bin",
    output_directory: "relative-output",
  });
  expect(relative.isError).toBe(true);
  expect(JSON.stringify(relative.content)).toContain(
    "absolute local filesystem path",
  );
});

const ignoredOptions = [
  { terminal: { columns: 80, row: 12 } },
  { events: [{ type: "input", at_ms: 0, data: "x", secret: true }] },
  { events: [{ type: "resize", at_ms: 0, columns: 80, rows: 24, row: 12 }] },
  { events: [{ type: "signal", at_ms: 0, signal: "SIGTERM", pid: 1 }] },
  { normalization: { path: true } },
  { limits: { file_count: 1 } },
  {
    normalization: {
      patterns: [{ pattern: "x", replacement: "y", regex: true }],
    },
  },
];

captureTest(
  "rejects malformed process choices through CLI and MCP before launching the command",
  async () => {
    const root = await createTestTempDirectory("rea-local-contracts-");
    const marker = join(root, "launched");
    const scenario = {
      executable: process.execPath,
      arguments: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'launched')",
        marker,
      ],
    };
    const { call } = await connectLocalToolsMcp();
    const invalid = [
      ...ignoredOptions,
      ...["", "KEY=VALUE", "KEY\0VALUE", "REA_PROCESS_RUN_ID"].map((key) => ({
        environment: { [key]: "value" },
      })),
      { executable: `node\0` },
      { arguments: ["\0"] },
      { working_directory: "/tmp/dir\0" },
      { environment: { KEY: "\0" } },
      { filesystem_observation_paths: ["\0"] },
      { timeout_ms: 10, events: [{ type: "input", at_ms: 11, data: "late" }] },
      {
        events: [
          { type: "resize", at_ms: 2, columns: 80, rows: 24 },
          { type: "input", at_ms: 1, data: "out of order" },
        ],
      },
      ...["command_shims", "replay", "reactive", "checkpoints"].map(
        (field) => ({
          [field]: [],
        }),
      ),
    ];
    for (const options of invalid) {
      const request = { ...scenario, ...options };
      expect(
        (await call("capture_process_scenario", request)).isError,
        JSON.stringify(options),
      ).toBe(true);
      const path = join(root, "scenario.json");
      await writeFile(path, JSON.stringify(request));
      await expect(
        execute(process.execPath, [cli, "capture-process", path, "--json"]),
      ).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("invalid_request"),
      });
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const missing = join(root, "missing-executable");
    const failed = await call("capture_process_scenario", {
      executable: missing,
    });
    expect(failed.structuredContent).toMatchObject({
      error: {
        code: "process_capture_failed",
        message: expect.stringContaining(missing),
        details: { execution_failure: expect.stringContaining(missing) },
      },
    });
    await writeFile(
      join(root, "scenario.json"),
      JSON.stringify({ executable: missing }),
    );
    await expect(
      execute(process.execPath, [
        cli,
        "capture-process",
        join(root, "scenario.json"),
        "--json",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining(missing),
    });
  },
  60_000,
);

captureTest.each(["unknown", "truncated"] as const)(
  "captures real process choices and composes a %s self-comparison",
  async (status) => {
    const root = await createTestTempDirectory("rea-local-capture-");
    const { call } = await connectLocalToolsMcp();
    const captured = await call("capture_process_scenario", {
      executable: process.execPath,
      arguments: [
        "-e",
        `require('node:fs').writeFileSync('state','selected');console.log(process.env['app.setting'],process.env.MY_PASSWORD,process.env['REA_PROCESS_RUN_ID'+String.fromCharCode(10)]);${status === "truncated" ? "console.log('x'.repeat(5000))" : ""}`,
      ],
      working_directory: root,
      environment: {
        "app.setting": "value",
        "1": "numbered",
        MY_PASSWORD: "ordinary-evidence",
        "REA_PROCESS_RUN_ID\n": "caller-value",
      },
      filesystem_observation_paths: [root],
      limits: status === "truncated" ? { output_bytes: 128 } : {},
    });
    expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
    const capture = toolContract("capture_process_scenario").outputSchema.parse(
      captured.structuredContent,
    );
    const source = capture;
    if (status === "unknown")
      expect(
        capture.normalized_result.frames.map((frame) => frame.data).join(""),
      ).toContain("value ordinary-evidence caller-value");
    else expect(capture.normalized_result.truncated).toBe(true);
    const environment = await call("capture_process_scenario", {
      executable: "/usr/bin/printenv",
      arguments: ["1"],
      environment: { "1": "numbered" },
    });
    const environmentEnvelope = toolContract(
      "capture_process_scenario",
    ).outputSchema.parse(environment.structuredContent);
    const received = environmentEnvelope.normalized_result.frames
      .map((frame) => frame.data)
      .join("");
    expect(received).toBe("numbered\r\n");
    expect(await readFile(join(root, "state"), "utf8")).toBe("selected");
    expect(capture.normalized_result.filesystem_effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "created" })]),
    );
    expect(capture.normalized_result.cleanup).toMatchObject({
      owned_process_group: "verified",
      temporary_root: "removed",
    });
    const compared = await call("compare_process_captures", {
      left: source,
      right: source,
    });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    const comparison = toolContract(
      "compare_process_captures",
    ).outputSchema.parse(compared.structuredContent);
    expect(comparison.normalized_result.status).toBe(status);
    const verification = await call("verify_reconstruction", {
      specification: {
        name: "Self comparison retains uncertainty",
        claims: [
          {
            claim_id: "control",
            title: "Control capture",
            comparison_evidence_id: comparison.evidence_id,
            kind: "behavioral",
            dimension: "overall",
          },
        ],
      },
    });
    expect(verification.isError, JSON.stringify(verification)).not.toBe(true);
    expect(verification.structuredContent).toMatchObject({
      normalized_result: {
        status: "unknown",
        claims: {
          items: [
            {
              left_evidence_ids: [source.evidence_id],
              right_evidence_ids: [source.evidence_id],
              evidence_links: expect.arrayContaining([
                source.evidence_id,
                comparison.evidence_id,
              ]),
            },
          ],
        },
      },
    });
    const behavior = await call("find_changed_behavior", {
      comparisons: [comparison],
    });
    expect(behavior.isError, JSON.stringify(behavior)).not.toBe(true);
    expect(behavior.structuredContent).toMatchObject({
      normalized_result: { behavior_status: status },
    });
    const unknowns = await call("list_unknowns", {
      domain: "process-comparison",
    });
    expect(unknowns.structuredContent).toMatchObject({
      result: {
        items: [
          {
            status: "open",
            supporting_evidence_ids: [source.evidence_id],
            contradicting_evidence_ids: [],
          },
        ],
      },
    });
    const bundle = await call("get_evidence_bundle", {});
    expect(
      (await call("compare_process_captures", { left: source, right: source }))
        .isError,
    ).not.toBe(true);
    expect((await call("get_evidence_bundle", {})).structuredContent).toEqual(
      bundle.structuredContent,
    );
    const path = join(root, "capture.json");
    await writeFile(path, JSON.stringify(source));
    const cliComparison = await execute(process.execPath, [
      cli,
      "compare-process-captures",
      path,
      path,
      "--json",
    ]);
    expect(parseEvidence(JSON.parse(cliComparison.stdout))).toEqual(comparison);
  },
);

captureTest(
  "accepts NUL as actual terminal input while preserving capture defaults",
  async () => {
    const { call } = await connectLocalToolsMcp();
    const response = await call("capture_process_scenario", {
      executable: process.execPath,
      arguments: [
        "-e",
        "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once('data',bytes=>{console.log('stdin-byte:'+bytes[0]);process.exit(0)});console.log('ready')",
      ],
      events: [{ type: "input", at_ms: 1000, data: "\0" }],
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const capture = toolContract("capture_process_scenario").outputSchema.parse(
      response.structuredContent,
    );
    expect(
      capture.normalized_result.frames.map((frame) => frame.data).join(""),
    ).toContain("stdin-byte:0");
    expect(capture.normalized_result.manifest.scenario).toMatchObject({
      environment: {},
      filesystem_observation_paths: [],
      terminal: { columns: 80, rows: 24, scrollback: 1000 },
    });
    expect(capture.normalized_result.interaction_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input",
          data: "\0",
          outcome: "dispatched",
        }),
      ]),
    );
  },
);
