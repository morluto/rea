// Explicit real-provider experiment, intentionally outside the portable test suite.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../dist/process/ProcessOwnership.js";
import { probe, retryCleanup } from "./probe.mjs";
import { createAnalysisExperiment } from "./analysis.mjs";

const root = await mkdtemp(join(tmpdir(), "rea-radare2-probe-"));
const artifact = join(root, "transport fixture");
const owners = new Set();
const r2 = process.env.REA_R2_COMMAND ?? "r2";
let typedAddress;
const commands = [
  "aa",
  { cmd: "aflj", json: true },
  "pdg @ main",
  "pdc @ main",
];

before(async () => {
  await runOwnedCommand(
    {
      command: process.env.CC ?? "cc",
      arguments: [
        "-O0",
        "-g",
        fileURLToPath(new URL("./fixture.c", import.meta.url)),
        "-o",
        artifact,
      ],
      runId: randomUUID(),
    },
    { timeoutMs: 30_000, diagnosticBytes: 1024 * 1024 },
  );
  const symbols = replies(
    await probe({
      transport: "exec",
      path: artifact,
      commands: [{ cmd: "isj", json: true }],
    }),
  )[0].res;
  typedAddress = `0x${BigInt(symbols.find((symbol) => symbol.name.endsWith("consume")).vaddr).toString(16)}`;
});

after(async () => {
  const pending = [];
  for (const owner of owners) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await owner.stop();
      if (result.status !== "incomplete") {
        owners.delete(owner);
        break;
      }
      await owner.waitForExit(1_000);
      if (attempt === 1)
        pending.push({ result, diagnostics: owner.snapshot() });
    }
  }
  assert.equal(
    await retryCleanup(),
    0,
    "Probe cleanup ownership is still retained",
  );
  assert.equal(
    owners.size,
    0,
    `HTTP server cleanup ownership is still retained: ${JSON.stringify(pending)}`,
  );
  await rm(root, { recursive: true, force: true });
});

function replies(result) {
  assert.equal(
    result.ok,
    true,
    result.ok
      ? ""
      : `${result.error.cause?.message}: ${JSON.stringify(result.error.partialObservation)}`,
  );
  return result.value.transcript.flatMap((entry) =>
    entry.r2pipe2 ? [entry.r2pipe2] : [],
  );
}

function verifyAnalysis(result) {
  const output = replies(result);
  assert.ok(
    output.some(
      (reply) =>
        Array.isArray(reply.res) &&
        reply.res.some((fn) => fn.name.includes("main")),
    ),
  );
  const pseudocode = output.filter(
    (reply) =>
      typeof reply.res === "string" &&
      reply.res.includes("REA radare2 transport fixture"),
  );
  assert.equal(
    pseudocode.length,
    2,
    "Both r2ghidra and pdc must produce pseudocode",
  );
  assert.ok(
    output.every((reply) => reply.command_outcome === "no_error_reported"),
  );
}

for (const transport of ["exec", "r2pipe", "r2mcp"]) {
  void test(`real ${transport}: JSON, decompilers, diagnostics and owned cleanup`, async () => {
    const selected =
      transport === "exec"
        ? [{ cmd: "aa; aflj", json: true }, "aa; pdg @ main", "aa; pdc @ main"]
        : commands;
    const result = await probe({
      transport,
      path: artifact,
      commands: selected,
    });
    verifyAnalysis(result);
    assert.equal(result.value.cleanup, "complete");
    if (transport !== "exec") {
      assert.ok(
        result.value.transcript.some(
          (entry) =>
            typeof entry.provider_diagnostics?.stderr.text === "string",
        ),
      );
    }
  });
  void test(`real ${transport}: analyst CFG, inferred types, layouts and value dependencies`, async () => {
    const experiment = createAnalysisExperiment(
      { transport, path: artifact, settings: { "bin.relocs.apply": true } },
      {
        prelude: [
          '"td struct rea_layout { char tag; int values[3]; long long end; };"',
        ],
      },
    );
    const analyzed = await experiment.analyze({
      procedure: typedAddress,
      recover_types: true,
    });
    assert.equal(analyzed.ok, true, analyzed.error?.cause?.message);
    const fn = analyzed.value.result;
    assert.ok(fn.basic_blocks.length >= 3);
    assert.ok(
      fn.basic_blocks.every((block) => BigInt(block.end) > BigInt(block.start)),
    );
    assert.ok(fn.esil.coverage.lifted_instructions > 0);
    assert.ok(fn.high_pcode.def_use.length > 0);
    assert.ok(fn.recovered_types.types.length > 0);
    assert.equal(fn.high_pcode.procedure.address, typedAddress);
    const type = await experiment.inspectType({ type: "rea_layout" });
    assert.equal(type.ok, true, type.error?.cause?.message);
    assert.deepEqual(
      type.value.result.fields.map((field) => [
        field.offset_bytes,
        field.size_bytes,
      ]),
      [
        [0, 1],
        [4, 12],
        [16, 8],
      ],
    );
    assert.equal(
      type.value.result.size_bytes,
      null,
      "Do not guess aggregate trailing padding",
    );
    const traced = await experiment.trace({
      procedure: typedAddress,
      parameter: 0,
      max_nodes: 1000,
    });
    assert.equal(traced.ok, true, traced.error?.cause?.message);
    assert.ok(traced.value.result.operations.length > 0);
    assert.equal(traced.value.result.selection_status, "observed");
    assert.equal(experiment.view(traced.value.parent_observation_id).ok, true);
    const unknown = await experiment.trace({
      procedure: typedAddress,
      parameter: 99,
    });
    assert.equal(unknown.ok, true);
    assert.equal(unknown.value.result.selection_status, "unknown");
    assert.ok(
      unknown.value.result.unknowns.some((reason) =>
        reason.includes("parameter"),
      ),
    );
    assert.equal(experiment.release(analyzed.value.observation_id), true);
    assert.equal(experiment.view(analyzed.value.observation_id).ok, false);
    const invalid = await experiment.analyze({ procedure: "0x4;!unexpected" });
    assert.equal(invalid.ok, false);
    const aborted = await experiment.analyze(
      { procedure: typedAddress },
      { signal: AbortSignal.abort() },
    );
    assert.equal(aborted.ok, false);
    if (transport === "r2pipe") {
      const limited = createAnalysisExperiment(
        { transport, path: artifact },
        { maxRetainedBytes: 0 },
      );
      const rejected = await limited.readBytes({
        address: typedAddress,
        length: 4,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error._tag, "AnalysisResourceConstraintError");
      assert.equal(
        rejected.error.partialObservation.result.bytes_hex.length,
        8,
      );
      assert.equal(
        rejected.error.partialObservation.target.sha256_before.length,
        64,
      );
      assert.ok(rejected.error.partialObservation.raw.transcript.length);
    }
  });
}

void test("numeric decoding preserves native strings and unsafe JSON literals", async () => {
  for (const transport of ["exec", "r2pipe", "r2mcp"]) {
    const result = await probe({
      transport,
      path: artifact,
      commands: [{ cmd: "?e 9007199254740993", json: true }],
    });
    assert.equal(replies(result)[0].res, "9007199254740993");
    assert.deepEqual(
      result.value.transcript.find((entry) => entry.r2pipe2)?.numeric_literals,
      [
        {
          pointer: "/res",
          producer_type: "json-number",
          literal: "9007199254740993",
        },
      ],
    );
    if (transport === "exec") continue;
    await verifyStringNumbers({ transport, path: artifact });
  }
});

void test("analyst MCP advertises valid schemas and pages retained producer facts", async () => {
  const configuration = join(root, "analysis.json");
  await writeFile(
    configuration,
    JSON.stringify({ connection: { transport: "r2pipe", path: artifact } }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./analysis-server.mjs", import.meta.url)),
      configuration,
    ],
    env: { ...process.env, REA_R2_COMMAND: r2, R2_COLOR: "0", R2_UTF8: "0" },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({
    name: "radare2-capability-verifier",
    version: "0",
  });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const validator = new Ajv2020({ strict: false, validateFormats: false });
    for (const tool of catalog.tools) {
      assert.equal(validator.validateSchema(tool.inputSchema), true);
      assert.equal(validator.validateSchema(tool.outputSchema), true);
    }
    const call = async (name, args) => {
      const contract = catalog.tools.find((tool) => tool.name === name);
      assert.ok(contract, `Missing named contract ${name}`);
      assert.equal(validator.validate(contract.inputSchema, args), true);
      const reply = await client.callTool({ name, arguments: args });
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      assert.equal(
        validator.validate(contract.outputSchema, reply.structuredContent),
        true,
      );
      return reply.structuredContent.observation;
    };
    const analyzed = await call("analyze_function", {
      procedure: typedAddress,
    });
    assert.ok(analyzed.result.high_pcode.summary.operations > 0);
    assert.equal(analyzed.result.high_pcode.operations, undefined);
    await verifyBytePages(call);
    const page = await call("view_radare2_observation", {
      observation_id: analyzed.observation_id,
      facet: "flow_operations",
      limit: 1,
    });
    assert.equal(page.result.length, 1);
    assert.ok(page.next_offset > 0);
    assert.equal(page.coverage.producer, "r2ghidra-pdgx");
    assert.ok(page.coverage.unknowns.length);
    assert.ok(page.target.sha256_before);
    const traced = await call("trace_native_values", {
      procedure: typedAddress,
      parameter: 0,
    });
    assert.ok(traced.result.operations.length > 0);
    const firstInstruction = await call("view_radare2_observation", {
      observation_id: analyzed.observation_id,
      facet: "instructions",
      limit: 1,
    });
    const native = await call("trace_native_values", {
      ir: "esil",
      address: firstInstruction.result[0].address,
      instruction_count: 1,
      register: "sp",
    });
    assert.equal(native.result.ir, "esil-dfg-slice");
    assert.equal(native.result.coverage.instruction_count, 1);
    assert.equal(
      (
        await call("release_radare2_observation", {
          observation_id: analyzed.observation_id,
        })
      ).released,
      true,
    );
  } finally {
    await client.close();
  }
});

async function verifyBytePages(call) {
  const bytes = await call("read_bytes", {
    address: typedAddress,
    length: 4,
  });
  assert.equal(bytes.result.bytes_hex.length, 8);
  assert.equal(bytes.result.returned_bytes, 4);
  assert.equal(bytes.result.complete, true);
  const bytePage = await call("view_radare2_observation", {
    observation_id: bytes.observation_id,
    facet: "byte_hex",
    limit: 2,
  });
  assert.equal(bytePage.result.length, 2);
  assert.equal(bytePage.coverage.complete, true);
  const rawBytePage = await call("view_radare2_observation", {
    observation_id: bytes.observation_id,
    facet: "raw",
    limit: 2,
  });
  assert.equal(rawBytePage.result.length, 2);
  assert.equal(rawBytePage.coverage.complete, true);
  assert.equal(
    rawBytePage.coverage.coverage.file_verification.native_bytes_match,
    true,
  );
}

async function verifyStringNumbers(selected) {
  const result = await probe({
    ...selected,
    commands: [
      "e cfg.json.num=string",
      { cmd: "?vi 18446744073709551615", json: false },
      { cmd: "aa;aflj", json: true },
    ],
  });
  const output = replies(result);
  assert.equal(output[1].value, "18446744073709551615");
  assert.equal(output[1].res, "-1\n");
  assert.equal(output[1].code, 0);
  const main = output[2].res.find((fn) => fn.name.includes("main"));
  assert.equal(typeof main.addr, "string");
  assert.ok(BigInt(main.addr) > 0n);
  assert.ok(result.value.transcript.every((entry) => !entry.numeric_literals));
}

void test("r2pipe2 retains native error status and logs", async () => {
  const result = await probe({
    transport: "r2pipe",
    path: artifact,
    commands: ["rea_invalid_probe_command", { cmd: "ij", json: true }],
  });
  const output = replies(result);
  assert.equal(output[0].command_outcome, "reported_error");
  assert.ok(output[0].logs.some((log) => log.type === "ERROR" && log.message));
  assert.equal(typeof output[1].res.bin.arch, "string");
});

void test("invalid native JSON preserves output on both old and corrected engines", async () => {
  const result = await probe({
    transport: "r2pipe",
    path: artifact,
    commands: [{ cmd: "?e definitely not JSON", json: true }],
  });
  if (result.ok) {
    const [reply] = replies(result);
    assert.equal(reply.error, true);
    assert.notEqual(reply.code, 0);
    assert.match(reply.res, /definitely not JSON/u);
  } else {
    assert.match(
      result.error.partialObservation.producer_observation.raw_reply,
      /definitely not JSON/u,
    );
  }
  assert.equal(await retryCleanup(), 0);
});

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}

void test("real HTTP: POST r2pipe2 to an existing session without taking ownership", async () => {
  // Reserve an available port, then release it before launching the owned fixture server.
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const launch = await spawnOwnedProviderProcess({
    command: r2,
    runId: randomUUID(),
    arguments: [
      "-N",
      "-q",
      "-e",
      "scr.color=0",
      "-e",
      "http.bind=127.0.0.1",
      "-c",
      `=h ${port}`,
      artifact,
    ],
  });
  const owner = new ProviderProcessSupervisor(
    {
      ...launch,
      ownsProcessLifetime: true,
      cleanup:
        launch.cleanup ?? (() => cleanupOwnedProcessGroup(launch.ownership)),
    },
    { maxDiagnosticBytes: 1024 * 1024 },
  );
  owners.add(owner);
  const endpoint = `http://127.0.0.1:${port}/cmd/`;
  // Only readiness is retried. Each selected command is dispatched once.
  const deadline = performance.now() + 10_000;
  for (;;) {
    try {
      await new Promise((accept, reject) => {
        const socket = connect({
          host: "127.0.0.1",
          port,
          signal: AbortSignal.timeout(250),
        });
        socket.once("connect", () => {
          socket.destroy();
          accept();
        });
        socket.once("error", reject);
      });
      break;
    } catch (cause) {
      if (performance.now() > deadline) throw cause;
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
  const result = await probe({ transport: "http", endpoint, commands });
  verifyAnalysis(result);
  assert.equal(result.value.cleanup, "external_session_unowned");
  const state = await probe({
    transport: "http",
    endpoint,
    commands: [{ cmd: "aflj", json: true }],
  });
  assert.ok(
    replies(state)[0].res.length > 0,
    "External analysis must remain available",
  );
  await verifyStringNumbers({ transport: "http", endpoint });
});

void test("HTTP preserves command bytes, status and URL; rejects redirects and remote hosts", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const bytes of request) body += bytes;
    requests.push({ url: request.url, body });
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/must-not-run" });
      response.end();
    } else if (request.url === "/malformed") {
      response.end("malformed native reply");
    } else {
      response.end(
        JSON.stringify({ res: "ok", error: false, code: 0, value: 0 }),
      );
    }
  });
  const port = await listen(server);
  try {
    const command = "?e spaces + & % ? # café";
    const endpoint = `http://localhost:${port}/cmd/custom?selection=one`;
    const result = await probe({
      transport: "http",
      endpoint,
      commands: [command],
    });
    assert.equal(replies(result)[0].res, "ok");
    assert.equal(result.value.input.endpoint, endpoint);
    assert.deepEqual(requests[0], {
      url: "/cmd/custom?selection=one",
      body: JSON.stringify({ cmd: command, json: false, trim: false }),
    });
    assert.equal(
      (
        await probe({
          transport: "http",
          endpoint: `http://127.0.0.1:${port}/redirect`,
          commands: [command],
        })
      ).ok,
      false,
    );
    assert.equal(
      requests.length,
      2,
      "A redirect must not dispatch another command",
    );
    const malformed = await probe({
      transport: "http",
      endpoint: `http://127.0.0.1:${port}/malformed`,
      commands: [command],
    });
    assert.equal(malformed.ok, false);
    assert.equal(
      malformed.error.partialObservation.producer_observation.raw_reply,
      "malformed native reply",
    );
    assert.equal(
      requests.length,
      3,
      "A malformed response must not replay the command",
    );
    assert.equal(
      (
        await probe({
          transport: "http",
          endpoint: "http://example.com/cmd",
          commands: [command],
        })
      ).ok,
      false,
    );
    assert.equal(requests.length, 3);
  } finally {
    await close(server);
  }
});

void test("HTTP cancellation after dispatch returns unknown completion without replay", async () => {
  const controller = new AbortController();
  let dispatched = 0;
  const server = createServer(async (request) => {
    for await (const _bytes of request) {
      /* wait for the complete submitted body */
    }
    dispatched++;
    controller.abort();
  });
  const port = await listen(server);
  try {
    const result = await probe(
      {
        transport: "http",
        endpoint: `http://127.0.0.1:${port}/cmd`,
        commands: ["?e once"],
      },
      { signal: controller.signal },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.partialObservation.completion, "unknown");
    assert.equal(dispatched, 1);
  } finally {
    await close(server);
  }
});
