// Explicit compatibility experiment, not a provider or a public CLI/MCP registration.
// Reuses #3521's implementation without copying its process or protocol ownership.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAnalysisExecution } from "../../dist/application/AnalysisProvider.js";
import { createEvidence, parseEvidence } from "../../dist/domain/evidence.js";
import { functionInstructionWindowSchema } from "../../dist/domain/hopperValues.js";
import { runOwnedCommand } from "../../dist/process/OwnedCommand.js";
import { address, decodeGraph } from "./analysis-values.mjs";

const PIN = "16b98bd1f1205564b66f942b9f21e11e925282e8";
const checkout = process.env.REA_R2_SESSION_CHECKOUT;
if (!checkout)
  throw new Error(
    "Select the built #3521 checkout with REA_R2_SESSION_CHECKOUT",
  );

const provider = {
  id: "radare2.shared-contract-experiment",
  name: "Radare2 shared-contract experiment",
  version: "0",
};
const root = await mkdtemp(join(tmpdir(), "rea-r2-shared-session-"));
const targetPath = join(root, "selected artifact with spaces");
let manager;
let sessionId;
let initialDigest;
let procedure;
let authenticateSource;
const sourceEvidence = [];
const limitations = [
  "Isolated compatibility experiment; no REA admission, provider selection, ledger or public CLI/MCP workflow is exercised.",
  "Instructions describe radare2's currently recovered function graph. Discovery completeness and complete body ranges remain unknown.",
  "The owned session was opened on the selected path; file digests before and after do not prove an unpatched analysis database or atomic filesystem snapshot.",
];

async function run(command, arguments_) {
  return runOwnedCommand(
    { command, arguments: arguments_, runId: randomUUID() },
    { timeoutMs: 30_000, diagnosticBytes: 1024 * 1024 },
  );
}

async function digest() {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(targetPath)) hash.update(bytes);
  return hash.digest("hex");
}

function unwrap(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

async function command(text) {
  const reply = unwrap(await manager.execute(sessionId, text));
  // The pinned producer owns its Evidence digest convention. Current REA now
  // includes null relationship_coverage in that digest, unlike the older pin.
  authenticateSource(reply.evidence);
  sourceEvidence.push(reply.evidence);
  assert.equal(reply.result.completion_status, "complete");
  assert.equal(reply.result.output_truncated, false);
  assert.equal(reply.result.command_error, false);
  assert.equal(reply.result.command_code, 0);
  assert.ok(
    !reply.result.command_logs.some((log) =>
      ["ERROR", "FATAL"].includes(log.type),
    ),
    JSON.stringify(reply.result.command_logs),
  );
  assert.doesNotMatch(reply.result.output, /\x1b\[/u);
  return reply.result.output;
}

before(async () => {
  const revision = await run("git", ["-C", checkout, "rev-parse", "HEAD"]);
  assert.equal(revision.stdout.text.trim(), PIN, "Unexpected #3521 source pin");
  const modulePath = join(checkout, "dist/radare2/Radare2SessionManager.js");
  const moduleDigest = createHash("sha256")
    .update(await readFile(modulePath))
    .digest("hex");
  const { Radare2SessionManager } = await import(
    pathToFileURL(modulePath).href
  );
  ({ parseEvidence: authenticateSource } = await import(
    pathToFileURL(join(checkout, "dist/domain/evidence.js")).href
  ));
  // Environment is inherited by the child, never recorded in the experiment.
  manager = new Radare2SessionManager({
    ...process.env,
    R2_COLOR: "0",
    R2_UTF8: "0",
  });
  await run(process.env.CC ?? "cc", [
    "-O0",
    "-g",
    fileURLToPath(new URL("./fixture.c", import.meta.url)),
    "-o",
    targetPath,
  ]);
  initialDigest = await digest();
  sessionId = unwrap(await manager.start({ path: targetPath })).session_id;
  await command("e scr.utf8=0");
  // Explicit fixture discovery, once per retained core; not an adapter default.
  await command("aa");
  const functions = JSON.parse(await command("aflj @e:cfg.json.num=string"));
  const matches = functions.filter((fn) =>
    /^(?:sym\.|dbg\.)?_?main$/u.test(fn.name),
  );
  assert.equal(matches.length, 1, "The fixture must have one main procedure");
  procedure = address(matches[0].addr);
  console.log(
    JSON.stringify({
      source_revision: PIN,
      session_manager_sha256: moduleDigest,
      target_sha256: initialDigest,
      target_executed: false,
    }),
  );
});

after(async () => {
  // Keep failed cleanup ownership in the manager for retry; do not erase its input.
  if (manager) {
    await manager.closeAll();
    unwrap(await manager.retryCleanupFailures());
    if (sessionId) assert.equal(manager.status(sessionId), undefined);
  }
  await rm(root, { recursive: true, force: true });
});

void test("retained #3521 session feeds the shared instruction and Evidence contracts", async () => {
  const prior = manager.status(sessionId);
  assert.equal(prior.caller_selected_path, targetPath);
  assert.equal(prior.resolved_path, targetPath);
  // A marker proves state survives separate manager calls without reopening.
  await command("f rea_shared_session_marker=0x1234");
  const graph = decodeGraph(
    JSON.parse(await command(`agfj @ ${procedure} @e:cfg.json.num=string`)),
  );
  assert.equal(graph.procedure.address, procedure);
  assert.ok(graph.instructions.length > 0);
  const normalized = functionInstructionWindowSchema.parse({
    procedure: {
      address: procedure,
      name: graph.procedure.name,
      classification: null,
      body: {
        available: false,
        reason: "Complete body ranges are unverified.",
      },
    },
    instructions: graph.instructions.map((instruction) => {
      assert.equal(typeof instruction.assembly, "string");
      return `${instruction.address}: ${instruction.assembly}`;
    }),
    limitations,
  });
  assert.equal(
    (await command("?v rea_shared_session_marker")).trim(),
    "0x1234",
  );
  assert.equal(await digest(), initialDigest);
  const target = { path: targetPath, sha256: initialDigest, format: "file" };
  const execution = createAnalysisExecution(normalized, provider, {
    subject: target,
    rawResult: { source_revision: PIN, source_evidence: sourceEvidence },
    limitations,
    locations: [{ kind: "address", address: procedure }],
  });
  const evidence = createEvidence(target, provider, {
    operation: "read_function_instructions",
    parameters: { procedure },
    result: execution.result,
    rawResult: execution.rawResult,
    confidence: "derived",
    limitations: execution.limitations,
    locations: execution.locations,
    evidenceLinks: sourceEvidence.map((source) => source.evidence_id),
  });
  assert.deepEqual(parseEvidence(evidence).normalized_result, normalized);
  assert.equal(evidence.subject.digest.sha256, initialDigest);
  assert.equal(evidence.evidence_links.length, sourceEvidence.length);
  assert.throws(() =>
    parseEvidence({
      ...evidence,
      normalized_result: { ...normalized, instructions: [] },
    }),
  );
});

void test("cancelled queued read never dispatches and leaves retained state usable", async () => {
  const controller = new AbortController();
  const first = manager.execute(sessionId, "?v rea_shared_session_marker");
  const cancelled = manager.execute(
    sessionId,
    "f rea_shared_session_marker=0x9999",
    controller.signal,
  );
  const third = manager.execute(sessionId, "?v rea_shared_session_marker");
  controller.abort();
  assert.equal(unwrap(await first).result.output.trim(), "0x1234");
  const rejected = await cancelled;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error._tag, "AnalysisCancelledError");
  assert.equal(unwrap(await third).result.output.trim(), "0x1234");
  assert.equal(await digest(), initialDigest);
});
