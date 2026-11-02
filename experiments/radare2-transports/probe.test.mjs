// Synthetic fault injection through the actual transports and process owner.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { resolvedAnalysisError } from "../../dist/domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../dist/domain/analysisErrorCore.js";
import { systemProcessOwnershipHost } from "../../dist/process/ProcessOwnershipObservation.js";
import { DarwinProcessOwnershipInspectionError } from "../../dist/process/DarwinProcessRunTokenReader.js";
import { probe, retryCleanup } from "./probe.mjs";
import { createAnalysisExperiment } from "./analysis.mjs";
import { viewObservation } from "./analysis-view.mjs";
import { retryNativeByteCleanup } from "./native-bytes.mjs";

const root = await mkdtemp(join(tmpdir(), "rea-transport-faults-"));
const executable = join(root, "fault-provider");
before(async () => {
  await runOwnedCommand(
    {
      command: process.env.CC ?? "cc",
      arguments: [
        fileURLToPath(new URL("./transport-fault-fixture.c", import.meta.url)),
        "-o",
        executable,
      ],
      runId: randomUUID(),
    },
    { timeoutMs: 30_000, diagnosticBytes: 1024 * 1024 },
  );
});
after(async () => {
  assert.equal(await retryCleanup(), 0);
  await rm(root, { recursive: true, force: true });
});

function fixture(transport, mode) {
  const ready = join(root, randomUUID());
  return {
    ready,
    connection: { transport, path: executable, executable },
    options: {
      timeoutMs: 5_000,
      environment: {
        ...process.env,
        REA_FAULT_MODE: mode,
        REA_FAULT_TRANSPORT: transport,
        REA_FAULT_READY: ready,
      },
    },
  };
}
async function waitReady(path, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
    await delay(10);
  }
  throw new Error("Fault provider did not start");
}
function cleaned(result) {
  assert.equal(result.ok, false);
  assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
  const diagnostics = result.error.partialObservation.transcript.find(
    (entry) => entry.provider_diagnostics,
  );
  assert.ok(diagnostics);
  const { exitCode, signal } = diagnostics.provider_diagnostics;
  assert.ok(Number.isInteger(exitCode) || typeof signal === "string");
}

async function ownedHost(args, environment = process.env) {
  const launched = await spawnOwnedProviderProcess({
    command: process.execPath,
    arguments: args,
    runId: randomUUID(),
    hostEnvironment: environment,
    stdin: "pipe",
  });
  const owner = new ProviderProcessSupervisor(
    {
      ...launched,
      ownsProcessLifetime: true,
      cleanup:
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership)),
    },
    { maxDiagnosticBytes: 1024 * 1024 },
  );
  return { launched, owner };
}

void test("server shutdown during configuration or connect never leaves an open stdio peer", async () => {
  for (const phase of ["configuration", "connect"])
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const configuration = join(root, randomUUID() + ".json");
      const hook = join(root, randomUUID() + ".mjs");
      await writeFile(
        configuration,
        JSON.stringify({ connection: { transport: "exec", path: executable } }),
      );
      await writeFile(
        hook,
        `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { setTimeout as delay } from "node:timers/promises";
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
      const stop = async () => { process.kill(process.pid, ${JSON.stringify(signal)}); await delay(50); };
      ${
        phase === "configuration"
          ? `
      const read = fs.readFile;
      fs.readFile = async (...args) => {
        if (args[0] === ${JSON.stringify(configuration)}) await stop();
        return read(...args);
      };
      syncBuiltinESMExports();`
          : `
      const start = StdioServerTransport.prototype.start;
      StdioServerTransport.prototype.start = async function (...args) {
        await start.apply(this, args);
        await stop();
      };`
      }
    `,
      );
      const { launched, owner } = await ownedHost([
        "--import",
        hook,
        fileURLToPath(new URL("./analysis-server.mjs", import.meta.url)),
        configuration,
      ]);
      try {
        // Keep the parent's pipe open throughout shutdown, as a live MCP peer would.
        assert.equal(
          await owner.waitForExit(3000),
          true,
          JSON.stringify(owner.snapshot()),
        );
        assert.equal(
          launched.process.exitCode,
          signal === "SIGINT" ? 130 : 143,
        );
      } finally {
        launched.process.stdin.end();
        assert.notEqual((await owner.stop()).status, "incomplete");
      }
    }
});

for (const transport of ["r2pipe", "r2mcp"]) {
  void test(`${transport}: interrupted partial frame retains exact bytes and cleanup`, async () => {
    const { connection, options, ready } = fixture(transport, "partial");
    const controller = new AbortController();
    const pending = probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: controller.signal },
    );
    await waitReady(ready);
    await delay(100);
    controller.abort();
    const result = await pending;
    cleaned(result);
    const frame =
      result.error.partialObservation.producer_observation.unterminated_frame;
    assert.equal(frame.invalid_utf8, true);
    assert.deepEqual(
      Buffer.from(frame.base64, "base64"),
      Buffer.concat([Buffer.from('{"res":"partial-'), Buffer.from([255])]),
    );
    assert.equal(result.error.partialObservation.completion, "unknown");
  });
}

void test("captured environments replace ambient variables on every owned transport", async () => {
  const previous = process.env.REA_FAULT_OMITTED;
  process.env.REA_FAULT_OMITTED = "synthetic-ambient-value";
  try {
    for (const transport of ["exec", "r2pipe", "r2mcp"]) {
      const { connection, options, ready } = fixture(transport, "environment");
      delete options.environment.REA_FAULT_OMITTED;
      options.environment.REA_FAULT_SELECTED = "caller-selected";
      options.environment.REA_FAULT_ENV_REPORT = ready + ".environment";
      await probe({ ...connection, commands: ["ij"] }, options);
      assert.equal(
        await readFile(ready + ".environment", "utf8"),
        "absent\ncaller-selected\n",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.REA_FAULT_OMITTED;
    else process.env.REA_FAULT_OMITTED = previous;
  }
});

void test("MCP retains exact frames, full envelopes, notifications and catalog-authorized requests", async () => {
  const { connection, options } = fixture("r2mcp", "mcp-success");
  const result = await probe({ ...connection, commands: ["ij"] }, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const transcript = result.value.transcript;
  const frames = transcript
    .filter((entry) => entry.mcp_frame)
    .map((entry) => entry.mcp_frame);
  const envelopes = transcript
    .filter((entry) => entry.mcp_envelope)
    .map((entry) => entry.mcp_envelope);
  assert.equal(frames.length, 5);
  assert.deepEqual(
    frames.map((frame) => JSON.parse(frame.text)),
    envelopes,
  );
  assert.ok(frames[0].text.startsWith('{ "jsonrpc"'));
  assert.equal(envelopes[0].extra, "preserved");
  assert.equal(envelopes[0].result.serverInfo.name, "fixture");
  assert.equal(envelopes[0].result.protocolVersion, "2024-11-05");
  assert.equal(envelopes[1].params.data, "retained notification");
  const catalog = envelopes[2].result.tools.map((tool) => tool.name);
  const requests = transcript
    .filter((entry) => entry.mcp_request)
    .map((entry) => entry.mcp_request);
  assert.deepEqual(
    requests.filter((request) => request.id).map((request) => request.id),
    [1, 2, 3, 4],
  );
  assert.ok(
    requests
      .filter((request) => request.method === "tools/call")
      .every((request) => catalog.includes(request.params.name)),
  );
  assert.equal(
    transcript.find((entry) => entry.r2pipe2).r2pipe2.res,
    "native reply",
  );
});

void test("semantic HTTP endpoint refusals remain input errors before dispatch", async () => {
  for (const endpoint of [
    "https://127.0.0.1/cmd",
    "http://example.com/cmd",
    "http://127.0.0.1/cmd#fragment",
    "http://user:pass@127.0.0.1/cmd",
  ]) {
    const result = await probe({
      transport: "http",
      endpoint,
      commands: ["ij"],
    });
    assert.equal(result.error._tag, "AnalysisInputError");
    assert.equal(projectAnalysisError(result.error).code, "invalid_request");
    assert.deepEqual(result.error.issues, []);
    assert.deepEqual(result.error.partialObservation.transcript, []);
    assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
  }
});

void test("MCP binds unique valid named contracts and validates arguments before dispatch", async () => {
  const open = { name: "open_file", inputSchema: { type: "object" } };
  const command = { name: "run_command", inputSchema: { type: "object" } };
  for (const tools of [
    [
      open,
      command,
      {
        ...command,
        inputSchema: {
          type: "object",
          properties: { page_size: { type: "integer" } },
        },
      },
    ],
    [
      command,
      {
        ...command,
        inputSchema: {
          type: "object",
          properties: { page_size: { type: "integer" } },
        },
      },
      open,
    ].reverse(),
    [open, open, command],
    [open, { ...command, inputSchema: { type: "invalid" } }],
    [
      open,
      { ...command, inputSchema: { type: "object", required: "invalid" } },
    ],
    [
      {
        ...open,
        inputSchema: { type: "object", required: ["missing_argument"] },
      },
      command,
    ],
  ]) {
    const { connection, options } = fixture("r2mcp", "mcp-success");
    options.environment.REA_FAULT_CATALOG = JSON.stringify({ tools });
    const result = await probe({ ...connection, commands: ["ij"] }, options);
    assert.equal(result.ok, false);
    assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
    const transcript = result.error.partialObservation.transcript;
    assert.deepEqual(
      transcript.find((entry) => entry.mcp_envelope?.id === 2).mcp_envelope
        .result.tools,
      tools,
    );
    assert.ok(
      !transcript.some((entry) => entry.mcp_request?.method === "tools/call"),
    );
  }
});

void test("analysis projection retains XML capacity coverage beside complete producer replies", async () => {
  const xml =
    '<function name="f"><addr space="ram" offset="4096"/><ast><varnodes>' +
    "<addr/>".repeat(220_000) +
    "</varnodes></ast></function>";
  const replies = new Map([
    ["agfj @ 0x1000", [{ addr: 4096, name: "f", size: 4, blocks: [] }]],
    ["afsj @ 0x1000", {}],
    ["afvj @ 0x1000", {}],
    ["pdgx @ 0x1000", xml],
  ]);
  const server = createServer(async (request, response) => {
    let source = "";
    for await (const part of request) source += part;
    const { cmd } = JSON.parse(source);
    response.end(
      JSON.stringify({ error: false, code: 0, res: replies.get(cmd) }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const experiment = createAnalysisExperiment({
      transport: "http",
      endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
    });
    const result = await experiment.analyze({
      procedure: "0x1000",
      analysis: "none",
      decompiler: "none",
      value_flow: "r2ghidra",
    });
    assert.equal(result.error._tag, "AnalysisResourceConstraintError");
    const partial = JSON.parse(
      JSON.stringify(projectAnalysisError(result.error)),
    ).details.partial_observation;
    assert.equal(partial.replies[3].res, xml);
    assert.equal(partial.producer_observation.coverage, "partial");
    assert.equal(partial.producer_observation.retained_nodes, 216_000);
    assert.ok(partial.producer_observation.examined_elements > 216_000);
    assert.equal(partial.producer_observation.examined_operations, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

void test("preparation cancellation never adopts an opaque reason's unrelated cleanup", async (context) => {
  for (const transport of ["r2pipe", "r2mcp", "exec"]) {
    const { connection, options, ready } = fixture(transport, "completed");
    const controller = new AbortController();
    const reason = new AnalysisOutputError(
      "unrelated operation",
      "caller-owned reason",
      {
        cleanup: {
          reason: "unrelated retained owner",
          resources: ["unrelated-resource"],
        },
        partialObservation: { unrelated: true },
      },
    );
    const intercepted = context.mock.method(
      systemProcessOwnershipHost,
      "prepare",
      async (signal) => {
        controller.abort(reason);
        signal.throwIfAborted();
      },
    );
    try {
      const result = await probe(
        { ...connection, commands: ["ij"] },
        { ...options, signal: controller.signal },
      );
      assert.equal(result.error._tag, "AnalysisCancelledError");
      assert.equal(result.error.cause, reason);
      assert.equal(result.error.cleanupIncomplete, false);
      assert.deepEqual(result.error.cleanupResources, []);
      assert.equal(result.error.partialObservation.provider_partial, null);
      assert.equal(result.error.partialObservation.cleanup_owners_retained, 0);
      assert.equal(await retryCleanup(), 0);
      assert.equal(reason.cleanupIncomplete, true);
      assert.ok(
        !JSON.stringify(projectAnalysisError(result.error)).includes(
          "unrelated-resource",
        ),
      );
      await assert.rejects(readFile(ready), { code: "ENOENT" });
    } finally {
      intercepted.mock.restore();
    }
  }
});

void test("a distinct preparation failure stays primary when cancellation follows it", async (context) => {
  const { connection, options, ready } = fixture("r2pipe", "completed");
  const controller = new AbortController();
  const primary = new Error("physical preparation failure");
  const intercepted = context.mock.method(
    systemProcessOwnershipHost,
    "prepare",
    async () => {
      controller.abort(new Error("later caller cancellation"));
      throw primary;
    },
  );
  try {
    const result = await probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: controller.signal },
    );
    assert.equal(result.error._tag, "AnalysisOutputError");
    assert.equal(result.error.cause, primary);
    assert.equal(result.error.cleanupIncomplete, false);
    await assert.rejects(readFile(ready), { code: "ENOENT" });
  } finally {
    intercepted.mock.restore();
  }
});

void test("actual preparation cleanup retains its exact owner separately from the opaque cancellation reason", async (context) => {
  for (const transport of ["r2pipe", "exec"]) {
    const { connection, options, ready } = fixture(transport, "completed");
    const controller = new AbortController();
    const reason = new AnalysisOutputError("unrelated", "opaque reason", {
      cleanup: {
        reason: "unrelated cleanup",
        resources: ["unrelated-resource"],
      },
    });
    const cleanup = new AnalysisOutputError("prepare", "helper close denied", {
      cleanup: { reason: "owned helper cleanup", resources: ["owned-helper"] },
    });
    let denied = true;
    let closes = 0;
    const owner = {
      close: async () => {
        closes++;
        if (denied) throw new Error("injected helper cleanup denial");
      },
    };
    const failure = new DarwinProcessOwnershipInspectionError(
      "helper preparation cancelled",
      {
        cancellation: { reason },
        cleanupFailure: cleanup,
        cleanupOwner: owner,
      },
    );
    const intercepted = context.mock.method(
      systemProcessOwnershipHost,
      "prepare",
      async () => {
        controller.abort(reason);
        throw failure;
      },
    );
    try {
      const result = await probe(
        { ...connection, commands: ["ij"] },
        { ...options, signal: controller.signal },
      );
      assert.equal(
        projectAnalysisError(result.error).code,
        "cleanup_incomplete",
      );
      assert.deepEqual(result.error.cleanupResources, ["owned-helper"]);
      assert.equal(await retryCleanup(), 1);
      denied = false;
      assert.equal(await retryCleanup(), 0);
      assert.equal(closes, 2);
      assert.equal(result.error.cleanupIncomplete, false);
      assert.equal(cleanup.cleanupIncomplete, false);
      assert.equal(reason.cleanupIncomplete, true);
      assert.equal(resolvedAnalysisError(result.error).cause, reason);
      await assert.rejects(readFile(ready), { code: "ENOENT" });
    } finally {
      denied = false;
      await retryCleanup();
      intercepted.mock.restore();
    }
  }
});

for (const transport of ["exec", "r2pipe"]) {
  void test(`${transport}: failed cleanup stops the batch, blocks admission and resolves returned errors on retry`, async (context) => {
    const { connection, options } = fixture(transport, "completed");
    const owners = new Set();
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function () {
        owners.add(this);
        this.unref();
        return { status: "incomplete", reason: "injected cleanup denial" };
      },
    );
    try {
      const result = await probe(
        {
          ...connection,
          commands: transport === "exec" ? ["ij", "ij"] : ["ij"],
        },
        options,
      );
      assert.equal(result.ok, false);
      assert.equal(owners.size, 1);
      assert.equal(
        projectAnalysisError(result.error).code,
        "cleanup_incomplete",
      );
      const blocked = await probe({ ...connection, commands: ["ij"] }, options);
      assert.equal(blocked.ok, false);
      assert.equal(owners.size, 1);
      assert.equal(
        projectAnalysisError(blocked.error).code,
        "cleanup_incomplete",
      );
      assert.ok(result.error.cleanupResources.length);
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
      for (const failure of [result.error, blocked.error]) {
        assert.equal(failure.cleanupIncomplete, false);
        assert.notEqual(
          projectAnalysisError(failure).code,
          "cleanup_incomplete",
        );
      }
      assert.equal(
        (await probe({ ...connection, commands: ["ij"] }, options)).ok,
        true,
      );
    } finally {
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
    }
  });
}

void test("frame and transcript capacity failures preserve their tag, limits and partial observations", async () => {
  const { connection, options } = fixture("r2pipe", "overflow");
  const frame = await probe({ ...connection, commands: ["ij"] }, options);
  assert.equal(frame.error._tag, "AnalysisResourceConstraintError");
  assert.equal(frame.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
  assert.ok(
    frame.error.partialObservation.producer_observation.unterminated_frame
      .bytes > 0,
  );
  const exec = fixture("exec", "overflow");
  const output = await probe(
    { ...exec.connection, commands: ["ij"] },
    exec.options,
  );
  assert.equal(output.error._tag, "AnalysisResourceConstraintError");
  assert.equal(
    output.error.partialObservation.provider_partial.diagnosticTruncated,
    true,
  );
  let responseMiB = 9;
  const server = createServer((_request, response) =>
    response.end(
      JSON.stringify({
        error: false,
        code: 0,
        res: "x".repeat(responseMiB * 1024 * 1024),
      }),
    ),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probe({
      transport: "http",
      endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      commands: ["ij"],
    });
    assert.equal(result.error._tag, "AnalysisResourceConstraintError");
    assert.equal(result.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
    assert.ok(result.error.partialObservation.transcript.length);
    assert.equal(
      projectAnalysisError(result.error).details.reported_limits.max_bytes,
      16 * 1024 * 1024,
    );
    responseMiB = 17;
    const oversized = await probe({
      transport: "http",
      endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      commands: ["ij"],
    });
    assert.equal(oversized.error._tag, "AnalysisResourceConstraintError");
    assert.equal(oversized.error.reportedLimits.max_bytes, 16 * 1024 * 1024);
    assert.ok(
      oversized.error.partialObservation.producer_observation.output.bytes > 0,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

void test("cancellation during failed process cleanup preserves its exact reason after retry", async (context) => {
  for (const transport of ["exec", "r2pipe"]) {
    const { connection, options } = fixture(transport, "completed");
    const controller = new AbortController();
    const reason = { opaque: "cancel during final cleanup" };
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function () {
        controller.abort(reason);
        this.unref();
        return { status: "incomplete", reason: "injected cleanup denial" };
      },
    );
    try {
      const result = await probe(
        { ...connection, commands: ["ij"] },
        { ...options, signal: controller.signal },
      );
      assert.equal(
        projectAnalysisError(result.error).code,
        "cleanup_incomplete",
      );
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
      assert.equal(
        resolvedAnalysisError(result.error)._tag,
        "AnalysisCancelledError",
      );
      assert.equal(resolvedAnalysisError(result.error).cause, reason);
      assert.match(
        JSON.stringify(projectAnalysisError(result.error)),
        /completed-native-reply/u,
      );
    } finally {
      intercepted.mock.restore();
      assert.equal(await retryCleanup(), 0);
    }
  }
});

void test("a cancelled queued probe cannot admit a successor before the active owner finishes", async () => {
  const { connection, options, ready } = fixture("r2pipe", "blocked");
  const active = new AbortController();
  const pending = probe(
    { ...connection, commands: ["ij"] },
    { ...options, signal: active.signal },
  );
  const pid = await waitReady(ready);
  try {
    const reason = { opaque: "queued cancellation" };
    const cancelled = await probe(
      { ...connection, commands: ["ij"] },
      { ...options, signal: AbortSignal.abort(reason) },
    );
    assert.equal(cancelled.error.cause, reason);
    const next = fixture("exec", "completed");
    const successor = probe(
      { ...next.connection, commands: ["ij"] },
      next.options,
    );
    await delay(100);
    await assert.rejects(readFile(next.ready), { code: "ENOENT" });
    active.abort();
    await pending;
    assert.equal((await successor).ok, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    active.abort();
    await pending;
  }
});

for (const [resource, surface] of [
  ["process", "probe"],
  ["process", "analysis-server"],
  ["file", "analysis"],
  ["file", "analysis-server"],
]) {
  void test(`${surface}: ${resource} cleanup survives shutdown until retry succeeds`, async () => {
    const { connection, options, ready } = fixture("r2pipe", "linger");
    const release = join(root, randomUUID());
    const stopped = join(root, randomUUID());
    const hook = join(root, randomUUID() + ".mjs");
    await writeFile(
      hook,
      resource === "process"
        ? `
      import { existsSync, writeFileSync } from "node:fs";
      import { ProviderProcessSupervisor } from ${JSON.stringify(new URL("../../dist/process/ProviderProcess.js", import.meta.url).href)};
      const stop = ProviderProcessSupervisor.prototype.stop;
      ProviderProcessSupervisor.prototype.stop = async function (...args) {
        if (!existsSync(${JSON.stringify(release)})) {
          writeFileSync(${JSON.stringify(stopped)}, String(process.pid));
          this.unref();
          return { status: "incomplete", reason: "injected cleanup denial until release" };
        }
        return stop.apply(this, args);
      };
    `
        : `
      import fs from "node:fs/promises";
      import { existsSync, writeFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.open;
      fs.open = async (...args) => {
        const handle = await open(...args);
        if (args[0] === ${JSON.stringify(connection.path)}) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            if (!existsSync(${JSON.stringify(release)})) {
              writeFileSync(${JSON.stringify(stopped)}, String(process.pid));
              throw new Error("injected file close denial until release");
            }
            return close();
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
    `,
    );
    const configuration = join(root, randomUUID() + ".json");
    await writeFile(configuration, JSON.stringify({ connection }));
    const { launched, owner } = await ownedHost(
      [
        "--import",
        hook,
        fileURLToPath(new URL(`./${surface}.mjs`, import.meta.url)),
        surface === "probe"
          ? JSON.stringify({ ...connection, commands: ["ij"] })
          : surface === "analysis"
            ? JSON.stringify({
                connection,
                operation: "inspect_native_data_type",
                arguments: { type: "T" },
              })
            : configuration,
      ],
      options.environment,
    );
    try {
      if (surface === "analysis-server") {
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "shutdown-regression", version: "0" },
            },
          }) + "\n",
        );
        for (let n = 0; !owner.snapshot().stdout.text.includes('"id":1'); n++) {
          assert.ok(n < 500, JSON.stringify(owner.snapshot()));
          await delay(10);
        }
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n",
        );
        launched.process.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "inspect_native_data_type",
              arguments: { type: "T" },
            },
          }) + "\n",
        );
      }
      const providerPid =
        resource === "process" ? await waitReady(ready, 2000) : undefined;
      await waitReady(stopped, 2000);
      for (
        let n = 0;
        !owner.snapshot().stdout.text.includes("cleanup_incomplete");
        n++
      ) {
        assert.ok(n < 500, JSON.stringify(owner.snapshot()));
        await delay(10);
      }
      launched.process.stdin.end();
      if (surface !== "analysis-server") launched.process.kill("SIGTERM");
      await delay(1_200); // Cross an automatic retry with no open client input.
      assert.equal(launched.process.exitCode, null);
      if (providerPid !== undefined)
        assert.doesNotThrow(() => process.kill(providerPid, 0));
      await writeFile(release, "allow exact-owner cleanup");
      assert.equal(
        await owner.waitForExit(10_000),
        true,
        JSON.stringify(owner.snapshot()),
      );
      if (providerPid !== undefined)
        assert.throws(() => process.kill(providerPid, 0), { code: "ESRCH" });
      else await assert.rejects(readFile(ready), { code: "ENOENT" });
      assert.match(owner.snapshot().stdout.text, /cleanup_incomplete/u);
    } finally {
      await writeFile(release, "allow cleanup even if an assertion failed");
      launched.process.stdin.end();
      await owner.waitForExit(10_000);
      assert.notEqual((await owner.stop()).status, "incomplete");
    }
  });
}

void test("blocked pipe write cancels before releasing the analyst queue", async () => {
  const { connection, options, ready } = fixture("r2pipe", "blocked");
  const controller = new AbortController();
  const experiment = createAnalysisExperiment(connection, {
    ...options,
    prelude: ["x".repeat(2 * 1024 * 1024)],
  });
  const first = experiment.inspectType(
    { type: "T" },
    { signal: controller.signal },
  );
  const second = experiment.inspectType({ type: "invalid;command" });
  const pid = await waitReady(ready);
  await delay(100);
  controller.abort();
  assert.equal((await first).error._tag, "AnalysisCancelledError");
  assert.equal((await second).error._tag, "AnalysisInputError");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

void test("blocked pipe write observes the batch deadline", async () => {
  const { connection, options } = fixture("r2pipe", "blocked");
  const began = performance.now();
  const result = await probe(
    { ...connection, commands: ["x".repeat(2 * 1024 * 1024)] },
    { ...options, timeoutMs: 1_000 },
  );
  cleaned(result);
  assert.ok(performance.now() - began < 5_000);
});

void test("cancellation after provider cleanup retains completed replies and preserves earlier failures", async (context) => {
  for (const [mode, surface] of [
    ["completed", "probe"],
    ["invalid", "probe"],
    ["completed", "analysis"],
    ["invalid", "analysis"],
  ]) {
    const { connection, options } = fixture("r2pipe", mode);
    const controller = new AbortController();
    const reason = new Error("Caller cancelled after provider cleanup");
    const stop = ProviderProcessSupervisor.prototype.stop;
    const intercepted = context.mock.method(
      ProviderProcessSupervisor.prototype,
      "stop",
      async function (...args) {
        const result = await stop.apply(this, args);
        controller.abort(reason);
        return result;
      },
    );
    try {
      const result =
        surface === "probe"
          ? await probe(
              { ...connection, commands: ["ij"] },
              { ...options, signal: controller.signal },
            )
          : await createAnalysisExperiment(connection, options).inspectType(
              { type: "T" },
              { signal: controller.signal },
            );
      cleaned(result);
      if (mode === "completed") {
        assert.equal(result.error._tag, "AnalysisCancelledError");
        assert.equal(result.error.cause, reason);
        assert.equal(result.error.partialObservation.cleanup, "complete");
        assert.equal(
          result.error.partialObservation.transcript.find(
            (entry) => entry.r2pipe2,
          ).r2pipe2.res,
          "completed-native-reply",
        );
      } else {
        assert.equal(result.error._tag, "AnalysisOutputError");
        assert.match(result.error.cause.message, /invalid UTF-8/u);
      }
    } finally {
      intercepted.mock.restore();
    }
  }
});

for (const mode of ["timeout", "missing", "changed"]) {
  void test(`final hash ${mode} preserves completed replies and reports target status`, async () => {
    const { connection, options, ready } = fixture(
      "exec",
      `final-hash-${mode}`,
    );
    const path = join(root, randomUUID());
    const source = "selected target";
    await writeFile(path, source);
    const experiment = createAnalysisExperiment(
      { ...connection, path },
      {
        ...options,
        timeoutMs: mode === "timeout" ? 1_500 : 5_000,
        environment: { ...options.environment, REA_FAULT_TARGET: path },
      },
    );
    const result = await experiment.inspectType({ type: "T" });
    assert.equal(result.ok, false);
    assert.equal(
      result.error._tag,
      mode === "timeout"
        ? "AnalysisCancelledError"
        : mode === "changed"
          ? "AnalysisArtifactChangedError"
          : "AnalysisOutputError",
    );
    if (mode === "timeout")
      assert.equal(result.error.cause.name, "TimeoutError");
    else if (mode === "missing")
      assert.equal(result.error.cause.code, "ENOENT");
    // Exercise the same serializable error projection used by CLI and MCP.
    const projected = JSON.parse(
      JSON.stringify(projectAnalysisError(result.error)),
    );
    const partial = projected.details.partial_observation;
    assert.equal(partial.raw.cleanup, "complete");
    assert.equal(partial.replies[0].res, "completed-native-reply");
    assert.equal(partial.replies[0].command_outcome, "no_error_reported");
    assert.equal(partial.target.path, path);
    assert.equal(
      partial.target.sha256_before,
      createHash("sha256").update(source).digest("hex"),
    );
    if (mode === "changed") {
      assert.equal(projected.code, "artifact_changed");
      assert.equal(projected.retryable, true);
      assert.equal(result.error.path, path);
      assert.equal(
        partial.target.sha256_after,
        createHash("sha256")
          .update(source + " changed")
          .digest("hex"),
      );
    } else assert.equal(partial.target.sha256_after, null);
    assert.match(
      JSON.stringify(partial.raw.transcript),
      /completed-native-stderr/u,
    );
    const pid = await waitReady(ready);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(
      (await experiment.inspectType({ type: "invalid;command" })).error._tag,
      "AnalysisInputError",
    );
  });
}

for (const transport of ["exec", "r2pipe", "r2mcp", "http"]) {
  void test(`${transport}: invalid UTF-8 JSON cannot become normalized facts`, async () => {
    const { connection, options } = fixture(transport, "invalid");
    let server;
    let selected = connection;
    if (transport === "http") {
      server = createServer((_request, response) =>
        response.end(
          Buffer.concat([
            Buffer.from('{"error":false,"code":0,"res":"'),
            Buffer.from([255]),
            Buffer.from('"}'),
          ]),
        ),
      );
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      selected = {
        transport,
        endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
      };
    }
    try {
      const result = await probe({ ...selected, commands: ["ij"] }, options);
      assert.equal(result.ok, false);
      assert.match(result.error.cause.message, /invalid UTF-8/u);
      assert.ok(
        result.error.partialObservation.transcript.every(
          (entry) => !entry.r2pipe2,
        ),
      );
      const raw =
        result.error.partialObservation.producer_observation.raw_reply;
      assert.equal(raw.invalid_utf8 ?? raw.invalidUtf8, true);
      if (transport !== "exec")
        assert.ok(Buffer.from(raw.base64, "base64").includes(255));
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  });
}

void test("ESIL observations preserve partial coverage in pages and complete replies when retention fills", async () => {
  const instructions = [
    {
      addr: 4096,
      size: 4,
      type: "cmov",
      esil: "zf,?{,1,x0,=,}{,2,x0,=,}",
    },
  ];
  const replies = new Map([
    ["aoj 1 @ 0x1000", instructions],
    ['\'aegf "zf,?{,1,x0,=,}{,2,x0,=,}" x0', "1,x0,=\n"],
  ]);
  const commands = [];
  const server = createServer(async (request, response) => {
    let source = "";
    for await (const part of request) source += part;
    const { cmd } = JSON.parse(source);
    commands.push(cmd);
    response.end(
      JSON.stringify({
        error: !replies.has(cmd),
        code: replies.has(cmd) ? 0 : 1,
        res: replies.get(cmd) ?? "Unmodeled command",
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = {
    transport: "http",
    endpoint: `http://127.0.0.1:${server.address().port}/cmd`,
  };
  const input = {
    ir: "esil",
    address: "0x1000",
    instruction_count: 1,
    register: "x0",
  };
  try {
    const experiment = createAnalysisExperiment(connection);
    const observed = await experiment.trace(input);
    assert.equal(observed.ok, true);
    const { observation_id, result } = observed.value;
    const page = viewObservation(experiment, {
      observation_id,
      facet: "raw",
      offset: 0,
      limit: 100,
    });
    assert.equal(page.ok, true);
    assert.equal(page.value.coverage.status, "partial");
    assert.equal(page.value.coverage.coverage.instruction_count, 1);
    assert.deepEqual(page.value.coverage.coverage, result.coverage);
    assert.ok(page.value.coverage.coverage.partial_reasons.length);
    assert.deepEqual(
      page.value.coverage.target_consistency,
      result.target_consistency,
    );
    assert.equal(
      page.value.coverage.target_consistency.status,
      "unverified-external-core",
    );
    assert.equal(page.value.coverage.truncated, undefined);
    assert.equal(page.value.next_offset, 100);
    assert.equal(experiment.release(observation_id), true);
    assert.equal(experiment.view(observation_id).ok, false);

    const full = createAnalysisExperiment(connection, { maxRetainedBytes: 1 });
    const rejected = await full.trace(input);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error._tag, "AnalysisResourceConstraintError");
    assert.equal(rejected.error.reportedLimits.maximum_bytes, 1);
    const partial = JSON.parse(
      JSON.stringify(projectAnalysisError(rejected.error)),
    ).details.partial_observation;
    assert.deepEqual(partial.result.instructions, instructions);
    assert.equal(partial.result.reduced_expression, "1,x0,=\n");
    assert.ok(
      partial.result.command_outcomes.every(
        (outcome) => !Object.hasOwn(outcome, "value"),
      ),
    );
    assert.equal(
      partial.raw.instruction_observation.raw.cleanup,
      "external_session_unowned",
    );
    assert.equal(partial.raw.reduction_observation.replies[0].res, "1,x0,=\n");
    assert.deepEqual(commands, [...replies.keys(), ...replies.keys()]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
