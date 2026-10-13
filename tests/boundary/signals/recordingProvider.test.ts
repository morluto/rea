import { signalDecodersSchema } from "../../../src/domain/signals/signalDecoders.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import { it, expect, onTestFinished } from "vitest";
import { writeFile, readdir, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { readStableArtifact } from "../../../src/artifacts/readStableArtifact.js";
import { SigrokRecordingProvider } from "../../../src/signals/SigrokRecordingProvider.js";
import { SignalRecordingService } from "../../../src/application/signals/SignalRecordingService.js";
import {
  decodeSignalRecordingInputSchema,
  signalRecordingSchema,
} from "../../../src/domain/signals/signalRecording.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createDeferred } from "../../fixtures/binarySession.js";

// A command-boundary simulator: real process ownership/filesystem, not real sigrok coverage.
const fixture = async (mode = "ok", failCleanup = false) => {
  const directory = await createTestTempDirectory("rea-signal-test-");
  const path = join(directory, "recorded bytes.vcd");
  await writeFile(path, "recording bytes");
  const script = join(directory, "producer.mjs");
  await writeFile(
    script,
    `import {readFileSync, writeFileSync, chmodSync, truncateSync} from 'node:fs';
if (process.argv.includes('--version')) { console.log(${JSON.stringify(mode)} === 'bad-version' ? 'sigrok-cli 0.7.1' : 'sigrok-cli 0.7.2\\nlibsigrokdecode 0.5.3'); console.error('version warning'); }
else if (${JSON.stringify(mode)} === 'bad-version') console.log('unexpected version fallback');
else if (${JSON.stringify(mode)} === 'nonzero') { console.error('invalid decoder'); process.exitCode = 1; }
else if (${JSON.stringify(mode)} === 'malformed-copy') { chmodSync('recording', 0o600); writeFileSync('recording', 'changed'); }
else if (${JSON.stringify(mode)} === 'oversized-copy') { chmodSync('recording', 0o600); truncateSync('recording', 32 * 1024 * 1024 + 1); }
else if (${JSON.stringify(mode)} === 'line-budget') process.stdout.write('ID: uart' + '\\n'.repeat(65536));
else if (${JSON.stringify(mode)} === 'overflow') process.stdout.write('x'.repeat(5 * 1024 * 1024));
else if (${JSON.stringify(mode)} === 'wait') { console.log('ready'); setInterval(() => {}, 1000); }
else if (${JSON.stringify(mode)} === 'many') process.stdout.write(Array.from({length:90},(_,i)=>'line '+(i+1)+'\\r\\n').join(''));
else if (process.argv.includes('--list-supported')) { console.log('Supported hardware drivers:\\n  ignored Device\\nSupported protocol decoders:\\n  uart                 Universal Asynchronous Receiver/Transmitter\\n  i2c                  Inter-Integrated Circuit\\n'); console.error('catalog warning'); }
else if (process.argv.includes('--show')) console.log('ID: uart\\nOptions:\\n- baudrate: Baud rate (default 115200)\\n- parity: Parity');
else { if(readFileSync('recording', 'utf8') !== 'recording bytes') throw Error('wrong copy'); console.log('10-20 uart-1: 42'); console.error('producer warning'); }
`,
  );
  await chmod(script, 0o700);
  const configuredCommand =
    mode === "symlink" ? join(directory, "configured-tool") : script;
  if (mode === "symlink") await symlink(script, configuredCommand);
  const controller = new AbortController();
  let calls = 0;
  let mayClean = !failCleanup;
  const acquired = createDeferred<void>();
  const release = createDeferred<void>();
  const provider = new SigrokRecordingProvider(
    {
      ...process.env,
      REA_SIGROK_COMMAND: configuredCommand,
      REA_SIGROK_PRLIMIT_COMMAND: configuredCommand,
    },
    async (input) => {
      calls++;
      if (mode === "file-limit" && !input.arguments.includes("--version")) {
        const stdout = { text: "", bytes: 0, observedBytes: 0 };
        const stderr = {
          text: "before file limit\n",
          bytes: 18,
          observedBytes: 18,
        };
        throw new OwnedCommandFailure("process", "Synthetic SIGXFSZ snapshot", {
          stdout,
          stderr,
          exitCode: null,
          signal: "SIGXFSZ",
        });
      }
      const spawned = await spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: [script, ...input.arguments],
        expectedCommand: process.execPath,
      });
      if (mode === "wait" && !input.arguments.includes("--version"))
        spawned.process.stdout?.once("data", () => controller.abort());
      return spawned;
    },
    async () => {
      if (mode === "workspace-full")
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      const root = await PrivateRuntimeRoot.create({
        parent: directory,
        prefix: "decoder-",
      });
      if (mode === "gated") {
        acquired.resolve();
        await release.promise;
      }
      if (mode === "snapshot-write-failure")
        await writeFile(join(root.path, "recording"), "already exists");
      return {
        path: root.path,
        close: async () => {
          if (!mayClean) throw new Error("cleanup fixture failure");
          await root.close();
        },
      };
    },
    "linux",
    async (...args) => {
      if (mode === "oversized-tool" && calls === 2 && args[0] === script) {
        const { truncate } = await import("node:fs/promises");
        await truncate(script, 64 * 1024 * 1024 + 1);
      }
      if (mode === "post-run-abort" && calls === 2) controller.abort();
      return readStableArtifact(...args);
    },
    async (limits) => ({ ...limits, file_bytes: 1048576 }),
  );
  onTestFinished(async () => {
    release.resolve();
    mayClean = true;
    await provider.close();
  });
  const service = new SignalRecordingService(provider);
  return {
    service,
    directory,
    path,
    controller,
    calls: () => calls,
    acquired: acquired.promise,
    release: () => release.resolve(),
    allowCleanup: () => {
      mayClean = true;
    },
  };
};

it("refuses new acquisition after provider shutdown", async () => {
  const f = await fixture();
  await f.service.close();
  expect(
    await f.service.decode({ path: f.path, decoders: "uart" }),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(f.calls()).toBe(0);
});

it("pages literal output without changing decoder arguments or normalizing text", async () => {
  const f = await fixture("many");
  for (const [options, first, count] of [
    [{}, 1, 50],
    [{ line_offset: 50, line_limit: 30 }, 51, 30],
    [{ line_limit: null }, 1, 90],
    [{ line_offset: 100 }, 101, 0],
  ] as const) {
    const result = await f.service.decode({
      path: f.path,
      decoders: "uart",
      ...options,
    });
    if (!result.ok) throw result.error;
    const report = signalRecordingSchema.parse(result.value.normalized_result);
    expect(report.annotations_text).toBe(
      Array.from({ length: count }, (_, i) => `line ${first + i}\r\n`).join(""),
    );
    expect(report.output_window.total_lines).toBe(90);
    expect(report.output_window.returned_lines).toBe(count);
    expect(report.tool.arguments).toEqual([
      "--dont-scan",
      "--input-file=recording",
      "--protocol-decoders=uart",
      "--protocol-decoder-samplenum",
    ]);
  }
});

it("bounds admission without queuing additional snapshots or delaying cancellation", async () => {
  const f = await fixture("gated");
  const input = { path: f.path, decoders: "uart" };
  const first = f.service.decode(input);
  await f.acquired;
  const second = f.service.decode(input);
  const cancelled = f.service.decode(input, { signal: AbortSignal.abort() });
  f.release();
  expect(await first).toMatchObject({ ok: true });
  expect(await second).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "capacity" },
  });
  expect(await cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(f.calls()).toBe(2);
  expect(await f.service.decode(input)).toMatchObject({ ok: true });
});

it("decodes an immutable copy, preserves options and warnings, and releases its directory", async () => {
  const f = await fixture();
  const result = await f.service.decode({
    path: f.path,
    decoders: "uart:rx=RX:baudrate=9600",
    annotations: "uart=rx-data",
  });
  if (!result.ok) throw result.error;
  const report = signalRecordingSchema.parse(result.value.normalized_result);
  expect(report.annotations_text).toBe("10-20 uart-1: 42\n");
  expect(report.diagnostics).toBe("producer warning\n");
  expect(report.tool.version_diagnostics).toBe("version warning\n");
  expect(report.selection.input_format).toBeNull();
  expect(report.tool.arguments).toEqual([
    "--dont-scan",
    "--input-file=recording",
    "--protocol-decoders=uart:rx=RX:baudrate=9600",
    "--protocol-decoder-samplenum",
    "--protocol-decoder-annotations=uart=rx-data",
  ]);
  expect((await readdir(f.directory)).sort()).toEqual([
    "producer.mjs",
    "recorded bytes.vcd",
  ]);
});

it.each([
  ["nonzero", "ProviderAdapterError"],
  ["malformed-copy", "AnalysisArtifactChangedError"],
  ["overflow", "AnalysisResourceConstraintError"],
  ["wait", "AnalysisCancelledError"],
])(
  "preserves %s failure and releases the process and snapshot",
  async (mode, tag) => {
    const f = await fixture(mode);
    const result = await f.service.decode(
      { path: f.path, decoders: "uart" },
      { signal: f.controller.signal },
    );
    if (result.ok) throw new Error("Expected decoder failure");
    expect(result.error._tag).toBe(tag);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(
      (await readdir(f.directory)).filter((name) =>
        name.startsWith("decoder-"),
      ),
    ).toEqual([]);
  },
);

it("retains a completed observation and cleanup ownership for retry", async () => {
  const f = await fixture("ok", true);
  const result = await f.service.decode({ path: f.path, decoders: "uart" });
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toMatchObject({
    operation: "decode_signal_recording",
  });
  const retry = await f.service.decode({ path: f.path, decoders: "uart" });
  expect(retry.ok).toBe(false);
  expect(f.calls()).toBe(2);
  f.allowCleanup();
  await f.service.close();
  expect(
    (await readdir(f.directory)).filter((name) => name.startsWith("decoder-")),
  ).toEqual([]);
});

it("rejects cancelled and invalid requests before any provider work", async () => {
  const f = await fixture();
  for (const input of [
    { path: "relative.vcd", decoders: "uart" },
    { path: f.path, decoders: "uart", driver: "demo" },
  ]) {
    const result = await f.service.decode(input);
    expect(result.ok).toBe(false);
  }
  const result = await f.service.decode(
    { path: f.path, decoders: "uart" },
    { signal: AbortSignal.abort() },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(f.calls()).toBe(0);
});

it("retains a completed observation when cancellation arrives at the service boundary", async () => {
  const f = await fixture();
  const input = decodeSignalRecordingInputSchema.parse({
    path: f.path,
    decoders: "uart",
    input_format: null,
    annotations: null,
  });
  const execution = await f.service.provider.decode(input);
  if (!execution.ok) throw execution.error;
  const service = new SignalRecordingService({
    inspectDecoders: async () => {
      throw new Error("Unexpected discovery call");
    },
    decode: async () => {
      f.controller.abort();
      return execution;
    },
    close: async () => {},
  });
  const result = await service.decode(input, { signal: f.controller.signal });
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    operation: "decode_signal_recording",
    normalized_result: { annotations_text: "10-20 uart-1: 42\n" },
  });
});

it.each([
  ["workspace-full", "AnalysisResourceConstraintError"],
  ["snapshot-write-failure", "ProviderAdapterError"],
])(
  "reports %s against the private workspace, not the selected input",
  async (mode, tag) => {
    const f = await fixture(mode);
    const result = await f.service.decode({ path: f.path, decoders: "uart" });
    if (result.ok) throw new Error("Expected workspace failure");
    expect(result.error._tag).toBe(tag);
    if (result.error._tag === "ProviderAdapterError")
      expect(result.error).toMatchObject({
        diagnostics: {
          stage: "workspace",
          system_code: "EEXIST",
        },
      });
    if (result.error._tag === "AnalysisResourceConstraintError")
      expect(result.error).toMatchObject({
        reportedLimits: {
          system_code: "ENOSPC",
        },
      });
    expect(f.calls()).toBe(mode === "workspace-full" ? 0 : 1);
    expect(
      (await readdir(f.directory)).filter((name) =>
        name.startsWith("decoder-"),
      ),
    ).toEqual([]);
  },
);

it("refuses unsupported hosts before launching or allocating a workspace", async () => {
  const provider = new SigrokRecordingProvider(
    { REA_SIGROK_COMMAND: process.execPath },
    async () => {
      throw new Error("Must not launch");
    },
    async () => {
      throw new Error("Must not allocate");
    },
    "darwin",
  );
  const result = await new SignalRecordingService(provider).decode({
    path: "/recording.vcd",
    decoders: "uart",
  });
  if (result.ok) throw new Error("Expected host refusal");
  expect(result.error).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining("Linux"),
  });
});

it("preserves complete Evidence when aborted during post-run integrity checks", async () => {
  const f = await fixture("post-run-abort");
  const result = await f.service.decode(
    { path: f.path, decoders: "uart" },
    { signal: f.controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    normalized_result: {
      annotations_text: "10-20 uart-1: 42\n",
      diagnostics: "producer warning\n",
    },
  });
  expect(
    (await readdir(f.directory)).filter((name) => name.startsWith("decoder-")),
  ).toEqual([]);
});
it("preserves configured symlink paths separately from resolved tool identities", async () => {
  const f = await fixture("symlink");
  const result = await f.service.decode({ path: f.path, decoders: "uart" });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toMatchObject({
    tool: {
      configured_path: join(f.directory, "configured-tool"),
      path: join(f.directory, "producer.mjs"),
    },
    resource_limiter: {
      configured_path: join(f.directory, "configured-tool"),
      path: join(f.directory, "producer.mjs"),
    },
  });
});

it.each(["oversized-copy", "oversized-tool"])(
  "identifies the mutated %s without blaming the admitted source",
  async (mode) => {
    const f = await fixture(mode);
    const result = await f.service.decode({ path: f.path, decoders: "uart" });
    if (result.ok) throw new Error("Expected changed artifact");
    expect(result.error).toMatchObject({
      _tag: "AnalysisArtifactChangedError",
      path:
        mode === "oversized-tool"
          ? join(f.directory, "producer.mjs")
          : expect.stringMatching(/decoder-.*[/\\]recording$/u),
    });
    expect(
      (await readdir(f.directory)).filter((name) =>
        name.startsWith("decoder-"),
      ),
    ).toEqual([]);
  },
);
it("preserves termination signal and effective file ceiling as a resource failure", async () => {
  const f = await fixture("file-limit");
  const result = await f.service.decode({ path: f.path, decoders: "uart" });
  if (result.ok) throw new Error("Expected resource failure");
  expect(result.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "file-size",
    reportedLimits: { file_bytes: 1048576 },
    capturedOutput: { signal: "SIGXFSZ", stderr: "before file limit\n" },
  });
});

it("discovers decoders without reading a recording and retains installation provenance", async () => {
  const f = await fixture();
  for (const [input, expected] of [
    [
      { query: "UART" },
      {
        decoders: [
          { id: "uart", name: "Universal Asynchronous Receiver/Transmitter" },
        ],
        output_window: {
          examined: 2,
          matching: 1,
          returned: 1,
          has_more: false,
        },
      },
    ],
    [
      { limit: 1 },
      {
        decoders: [
          { id: "uart", name: "Universal Asynchronous Receiver/Transmitter" },
        ],
        output_window: { matching: 2, returned: 1, has_more: true },
      },
    ],
    [
      { offset: 1, limit: null },
      {
        decoders: [{ id: "i2c", name: "Inter-Integrated Circuit" }],
        output_window: { returned: 1, has_more: false },
      },
    ],
    [
      { decoder: "uart", query: "baud" },
      {
        help_lines: [
          { line_number: 3, text: "- baudrate: Baud rate (default 115200)" },
        ],
        output_window: { unit: "help-lines", examined: 4, matching: 1 },
      },
    ],
    [
      { query: "no-such-decoder" },
      {
        decoders: [],
        output_window: { examined: 2, matching: 0, returned: 0 },
      },
    ],
  ] as const) {
    const result = await f.service.inspectDecoders(input);
    if (!result.ok) throw result.error;
    const report = signalDecodersSchema.parse(result.value.normalized_result);
    expect(report).toMatchObject(expected);
    expect(result.value.operation).toBe("inspect_signal_decoders");
    expect(report.tool.version_diagnostics).toBe("version warning\n");
    expect(report.tool.arguments).toContain("--dont-scan");
    expect(
      report.tool.arguments.some((arg) => arg.startsWith("--input-file")),
    ).toBe(false);
  }
  expect(
    (await readdir(f.directory)).filter((name) => name.startsWith("decoder-")),
  ).toEqual([]);
});

it("attributes discovery admission failures to discovery while sharing the decoding slot", async () => {
  const f = await fixture("gated");
  const active = f.service.decode({ path: f.path, decoders: "uart" });
  await f.acquired;
  const busy = await f.service.inspectDecoders({});
  f.release();
  if (!(await active).ok) throw new Error("Decode failed");
  expect(busy).toMatchObject({
    ok: false,
    error: { operation: "inspect_signal_decoders", resource: "capacity" },
  });
  await f.service.close();
  expect(await f.service.inspectDecoders({})).toMatchObject({
    ok: false,
    error: {
      operation: "inspect_signal_decoders",
      _tag: "AnalysisCancelledError",
    },
  });
});

it.each([
  "bad-version",
  "nonzero",
  "overflow",
  "line-budget",
  "wait",
  "oversized-tool",
])("preserves discovery failure diagnostics: %s", async (mode) => {
  const f = await fixture(mode);
  const result = await f.service.inspectDecoders(
    {},
    { signal: f.controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(result.error).toMatchObject({
    operation: "inspect_signal_decoders",
  });
  if (mode === "line-budget") {
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    expect(result.error.capturedOutput?.stdout).toBe(
      "ID: uart" + "\n".repeat(65536),
    );
  }
  if (mode === "bad-version")
    expect(result.error.capturedOutput).toMatchObject({
      stdout: "sigrok-cli 0.7.1\n",
      stderr: "version warning\n",
    });
});

it("retains completed discovery when cleanup fails, then retries before accepting work", async () => {
  const f = await fixture("ok", true);
  const first = await f.service.inspectDecoders({ query: "uart" });
  expect(first).toMatchObject({
    ok: false,
    error: {
      operation: "inspect_signal_decoders",
      partialObservation: { operation: "inspect_signal_decoders" },
    },
  });
  await f.service.inspectDecoders({});
  await f.service.decode({ path: f.path, decoders: "uart" });
  expect(f.calls()).toBe(2);
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(f.service.close()).rejects.toMatchObject({
      operation: "inspect_signal_decoders",
      cleanupIncomplete: true,
    });
  f.allowCleanup();
  await f.service.close();
});

it("rejects ambiguous decoder selectors before launch and retains malformed help output", async () => {
  const f = await fixture();
  for (const decoder of ["uart:baudrate=1", "uart,spi", "uart\0"]) {
    expect(await f.service.inspectDecoders({ decoder })).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  }
  expect(f.calls()).toBe(0);
  expect(await f.service.inspectDecoders({ decoder: "spi" })).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      capturedOutput: { stdout: expect.stringContaining("ID: uart") },
    },
  });
});

it("retains completed discovery on cancellation during identity verification", async () => {
  const f = await fixture("post-run-abort");
  expect(
    await f.service.inspectDecoders(
      { query: "uart" },
      { signal: f.controller.signal },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      partialObservation: {
        operation: "inspect_signal_decoders",
        normalized_result: { decoders: [{ id: "uart" }] },
      },
    },
  });
});
