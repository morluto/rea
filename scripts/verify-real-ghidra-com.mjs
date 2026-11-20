#!/usr/bin/env node
import { canonicalOutputSchema } from "./lib/canonical-output-schema.mjs";
import { closeVerifierResources } from "./lib/verifier-cleanup.mjs";
import assert from "node:assert/strict";
import {
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { nativeInstructionSchema } from "../dist/domain/native/nativeInstruction.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import {
  buildDosComFixture,
  buildRejectedDosComFixture,
} from "../tests/conformance/ghidra/dos-com-fixture.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { verifyGhidraAddressBoundaries } from "./lib/real-ghidra-address-boundaries.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import {
  createVerifierMcpOwner,
  VerifierStdioTransport,
} from "./lib/verifier-mcp-owner.mjs";

// This lane intentionally has no game paths, binary seeds or compiler dependency.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-com.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "verify:ghidra:com supports Linux/macOS hosts only; Windows P0 is PE x86-64 only.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "verify:ghidra:com prerequisite missing: GHIDRA_INSTALL_DIR (bring your own Ghidra).",
  );
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `verify:ghidra:com prerequisite unavailable: ${JSON.stringify(installation)}`,
  );
const captureDirectory = process.env.REA_COM_PROOF_CAPTURE_DIR;
if (captureDirectory !== undefined) {
  assert.ok(
    isAbsolute(captureDirectory),
    "REA_COM_PROOF_CAPTURE_DIR must be absolute",
  );
  await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
}
const packageRoot = process.env.REA_COM_PROOF_PACKAGE_ROOT;
if (packageRoot !== undefined && !isAbsolute(packageRoot))
  throw new Error("REA_COM_PROOF_PACKAGE_ROOT must be absolute");
const entrypoint =
  packageRoot === undefined
    ? fileURLToPath(new URL("./rea.mjs", import.meta.url))
    : join(packageRoot, "scripts", "rea.mjs");
const run = createVerifierRun();
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-com-proof-",
});
const workspace = workspaceFixture.path;
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const fixture = buildDosComFixture();
const targetPath = join(workspace, "fixture.com");
await writeFile(targetPath, fixture.bytes, { mode: 0o600 });
const sha256 = digest(fixture.bytes);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
};

// The CLI shares one command owner, created before the lane starts a tool.
const commands = await createVerifierCommands();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-com-proof", version: "1" });
let stderr = "";
let connected = false;
let verifierRun;
let report;
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
workspaceFixture.releaseAfter(async () => {
  await closeVerifierResources([
    async () => {
      if (connected) await call("close_binary", {});
    },
    () => client.close(),
    () => transport.close(),
  ]);
  assert.deepEqual(
    (await readdir(runtime)).filter((name) => name.startsWith("rea-ghidra-")),
    [],
    "Owned Ghidra runtime survived close",
  );
  verifierRun = await completeVerifierRun(run);
  assertVerifierCleanupComplete(verifierRun.process_lineage);
});
await withVerifierFixture(workspaceFixture, async () => {
  let failure;
  try {
    await client.connect(transport);
    connected = true;
    const fallbackImport = await verifyRejectedCom();

    const untyped = await client.callTool({
      name: "open_binary",
      arguments: { path: targetPath, provider_id: "ghidra" },
    });
    assert.equal(
      untyped.isError,
      true,
      "Headerless bytes were guessed as COM without explicit interpretation",
    );
    const target = await call("open_binary", {
      path: targetPath,
      provider_id: "ghidra",
      format: "dos-com",
    });
    assert.equal(target.format, "dos-com");
    assert.equal(target.architecture, "x86");
    assert.equal(target.sha256, sha256);
    const image = await call("inspect_native_load_image");
    assert.equal(
      image.status,
      "verified",
      JSON.stringify(image.checks?.filter((c) => !c.matched)),
    );
    assert.equal(image.format, "dos-com");
    assert.equal(image.header_bytes, 0);
    assert.equal(image.module_bytes, fixture.bytes.length);
    assert.equal(image.loader, fixture.loader);
    assert.equal(image.load_address, fixture.load_address);
    assert.equal(image.loader_fallback, undefined);
    assert.equal(image.entry.linear_address, fixture.entry);
    assert.equal(image.entry.offset, 256);
    assert.deepEqual(
      image.observations.entry_context[0].registers.map((register) => [
        register.name,
        register.value_hex,
      ]),
      ["CS", "DS", "ES", "SS"].map((name) => [name, "0x0"]),
    );
    const memory = await call("read_bytes", {
      address: fixture.entry,
      length: fixture.bytes.length,
    });
    assert.equal(memory.bytes_hex, fixture.bytes.toString("hex"));
    assert.equal(memory.complete, true);
    const mapping = await call("address_to_file_offset", {
      address: fixture.near,
    });
    assert.equal(mapping.file_offset, 32);
    const psp = await call("read_bytes", { address: "0x0", length: 16 });
    assert.equal(psp.bytes_hex, "00".repeat(16));
    assert.equal(psp.complete, true);
    const oldSegment = await call("read_bytes", {
      address: "0x10000",
      length: 16,
    });
    assert.equal(oldSegment.returned_bytes, 0);
    assert.equal(oldSegment.complete, false);
    const tail = await call("read_bytes", { address: fixture.tail, length: 8 });
    assert.equal(tail.returned_bytes, 2);
    assert.equal(tail.complete, false);
    const procedures = await call("list_procedures");
    assert.ok(procedures.some((p) => p.address === fixture.entry));
    assert.ok(procedures.some((p) => p.address === fixture.near));
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: fixture.entry,
        detail: "complete",
      }),
    );
    assert.ok(dossier.pseudocode.trim().length > 0);
    assert.equal(dossier.procedure.body.available, true);
    const instruction = await call("inspect_native_instruction", {
      address: fixture.entry,
    });
    assert.equal(
      instruction.bytes.replaceAll(" ", "").toLowerCase(),
      fixture.entry_hex,
    );
    // This NOP follows the entry's terminating INT 20h and is not reached by
    // either function. It remains valid instruction bytes outside the listing.
    const unlistedAddress = fixture.unlisted;
    const unlistedBytes = await call("read_bytes", {
      address: unlistedAddress,
      length: 1,
    });
    assert.equal(unlistedBytes.bytes_hex, "90");
    const unlistedResponse = await client.callTool({
      name: "inspect_native_instruction",
      arguments: { address: unlistedAddress },
    });
    const unlistedEvidence = parseEvidence(
      requireMcpOutput(unlistedResponse, "inspect_native_instruction"),
    );
    const unlisted = unlistedEvidence.normalized_result;
    assert.equal(unlisted.status, "not-in-listing");
    assert.equal(unlisted.bytes, null);
    assert.ok(
      unlisted.limitations.some((item) =>
        item.includes("did not attempt a decode"),
      ),
    );
    const tools = (await client.listTools()).tools;
    const advertised = tools.find(
      (tool) => tool.name === "inspect_native_instruction",
    );
    assert.ok(advertised);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    assert.equal(
      ajv.validateSchema(canonicalOutputSchema(advertised.name)),
      true,
    );
    assert.equal(
      ajv.validate(
        canonicalOutputSchema(advertised.name),
        unlistedResponse.structuredContent,
      ),
      true,
      JSON.stringify(ajv.errors),
    );
    // Evidence format 1 has no legacy `undecodable` status: an unlisted
    // address is `not-in-listing`, and the relabelled record is refused.
    assert.equal(nativeInstructionSchema.safeParse(unlisted).success, true);
    assert.equal(
      nativeInstructionSchema.safeParse({ ...unlisted, status: "undecodable" })
        .success,
      false,
    );
    const contextDefinition = tools.find(
      (tool) => tool.name === "inspect_address_context",
    );
    assert.ok(contextDefinition);
    const documents = await call("list_documents");
    assert.equal(documents.length, 1);
    const document = documents[0];
    for (const input of [
      { address: fixture.entry, document: `${document}-not-a-program` },
      { address: "not-an-address", document },
    ]) {
      const direct = requireMcpToolError(
        await client.callTool({ name: "address_name", arguments: input }),
      );
      const response = await client.callTool(
        { name: "inspect_address_context", arguments: input },
        { timeout: 240000, toolDefinition: contextDefinition },
      );
      const context = requireMcpLifecycleResult(
        response,
        "inspect_address_context",
      );
      assert.equal(context.name.state, "unavailable");
      assert.equal(context.name.error.code, "invalid_request");
      assert.deepEqual(
        context.name.error.details.issues,
        direct.details.issues,
      );
      assert.equal(context.name.reason, direct.message);
      assert.equal(context.name.remediation, direct.remediation.action);
    }
    assert.equal(
      (await call("resolve_native_call_targets", { address: unlistedAddress }))
        .status,
      "unavailable",
    );
    assert.deepEqual(
      (await cli("inspect-native-instruction", unlistedAddress))
        .normalized_result,
      unlisted,
    );
    const cliImage = await cli("inspect-native-load-image");
    const stable = (x) => ({
      ...x,
      observations: {
        ...x.observations,
        source_files: x.observations.source_files.map(
          ({ name: _name, ...file }) => file,
        ),
      },
    });
    assert.deepEqual(stable(cliImage.normalized_result), stable(image));
    assert.deepEqual(
      (
        await cli("read-bytes", fixture.entry, [
          "--length",
          String(fixture.bytes.length),
        ])
      ).normalized_result,
      memory,
    );
    assert.deepEqual(
      (await cli("address-to-file-offset", fixture.near)).normalized_result,
      mapping,
    );
    const changes = {
      procedure: fixture.entry,
      name: "rea_entry",
      comment: "Regular\nUnicode 註記",
      inline_comment: "Inline finding",
    };
    // Prime provider inventories and the session snapshot before edits.
    await call("list_names");
    const updated = await call("annotate_native_function", changes);
    assert.equal(updated.annotations.name, changes.name);
    assert.equal(updated.annotations.comment, changes.comment);
    assert.equal(updated.annotations.inline_comment, changes.inline_comment);
    assert.equal(updated.dossier.procedure.name, changes.name);
    assert.ok(updated.dossier.pseudocode.includes(changes.name));
    // Exercise the documented recovery through the public MCP catalog on real
    // Ghidra, rather than assuming the provider exposes direct comment methods.
    const contextCall = async (name, args) => {
      const definition = tools.find((tool) => tool.name === name);
      assert.ok(definition, `${name} must be advertised`);
      const response = await client.callTool(
        { name, arguments: args },
        { timeout: 240000, toolDefinition: definition },
      );
      return requireMcpOutput(response, name);
    };
    const context = (
      await contextCall("inspect_address_context", {
        address: fixture.entry,
      })
    ).result;
    assert.equal(context.procedure.state, "available");
    assert.equal(context.procedure.value.found, true);
    for (const facet of [context.comment, context.inline_comment]) {
      assert.equal(facet.state, "unavailable");
      assert.match(
        facet.remediation,
        /analyze_function.*parent_evidence_id.*inspect_analysis_view/u,
      );
    }
    assert.match(context.bookmarks.remediation, /binary_session/u);
    const summary = parseEvidence(
      await contextCall("analyze_function", {
        procedure: context.procedure.value.procedure.address,
      }),
    ).normalized_result;
    const comments = parseEvidence(
      await contextCall("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: summary.parent_evidence_id,
        },
        view: { kind: "native", facet: "comments" },
      }),
    ).normalized_result;
    for (const [kind, text] of [
      ["comment", changes.comment],
      ["inline", changes.inline_comment],
    ])
      assert.ok(
        comments.item.some(
          (item) =>
            item.address === context.procedure.value.query_address &&
            item.kind === kind &&
            item.text === text,
        ),
      );
    const outside = (
      await contextCall("inspect_address_context", {
        address: unlistedAddress,
      })
    ).result;
    assert.equal(outside.procedure.state, "available");
    assert.equal(outside.procedure.value.found, false);
    assert.equal(outside.comment.state, "unavailable");
    assert.match(outside.comment.remediation, /binary_session/u);
    assert.equal(
      await call("procedure_address", { procedure: changes.name }),
      fixture.entry,
    );
    assert.equal(
      await call("address_name", { address: fixture.entry }),
      changes.name,
    );
    assert.ok(
      (await call("list_procedures")).some((p) => p.value === changes.name),
    );
    assert.ok((await call("list_names")).some((p) => p.value === changes.name));
    assert.equal(
      (
        await call("analyze_function", {
          procedure: fixture.entry,
          detail: "complete",
        })
      ).procedure.name,
      changes.name,
    );
    const rejected = await client.callTool({
      name: "annotate_native_function",
      arguments: {
        procedure: fixture.entry,
        comment: "MUST ROLL BACK",
        name: "invalid name\n",
      },
    });
    assert.equal(
      rejected.isError,
      true,
      "Ghidra accepted an invalid function name",
    );
    const retained = await call("annotate_native_function", {
      procedure: fixture.entry,
      name: changes.name,
    });
    assert.equal(
      retained.annotations.comment,
      changes.comment,
      "Failed edit leaked its earlier comment write",
    );
    assert.equal(retained.annotations.inline_comment, changes.inline_comment);
    assert.equal(retained.dossier.procedure.name, changes.name);
    await verifyGhidraAddressBoundaries(client, fixture.entry, cli);
    const cleared = await call("annotate_native_function", {
      procedure: fixture.entry,
      comment: "",
      inline_comment: "",
    });
    assert.equal(cleared.annotations.comment, null);
    assert.equal(cleared.annotations.inline_comment, null);
    assert.ok(
      !cleared.dossier.comments.some((c) => c.address === fixture.entry),
    );
    assert.equal(
      (
        await call("read_bytes", {
          address: fixture.entry,
          length: fixture.bytes.length,
        })
      ).bytes_hex,
      fixture.bytes.toString("hex"),
    );
    assert.equal((await call("inspect_native_load_image")).status, "verified");
    const cliAnnotated = await cli("annotate-native-function", fixture.entry, [
      "--name",
      changes.name,
      "--comment",
      changes.comment,
      "--inline-comment",
      changes.inline_comment,
    ]);
    assert.deepEqual(cliAnnotated.normalized_result, updated);
    if (captureDirectory !== undefined)
      await writeFile(
        join(captureDirectory, "image.json"),
        JSON.stringify(image, null, 2),
        { mode: 0o600 },
      );
    await call("close_binary");
    assert.equal(digest(await readFile(targetPath)), sha256);
    report = {
      ok: true,
      mocked: false,
      lane: "ghidra-com",
      packaged_artifact: packageRoot !== undefined,
      host: process.platform,
      provider: { id: "ghidra", version: installation.providerVersion },
      target: { format: "dos-com", sha256, bytes: fixture.bytes.length },
      load_image: {
        status: image.status,
        checks: image.checks.length,
        loader: image.loader,
        load_address: image.load_address,
        entry: fixture.entry,
        entry_context: image.observations.entry_context,
      },
      loader_fallback: fallbackImport,
      transport: { cli: true, stdio_mcp: true },
      memory_evidence: {
        complete_file_read: true,
        source_offset: 32,
        placeholder_psp_zero: true,
        old_segment_unmapped: true,
        partial_read_bytes: 2,
      },
      functions: { entry: true, near: true, pseudocode_nonempty: true },
      annotations: {
        atomic_rollback: true,
        fresh_inventories: true,
        fresh_decompiler: true,
        clear_comments: true,
        cli_mcp_parity: true,
        address_context_comment_recovery: true,
      },
      context_input_errors_preserved: true,
      original_unchanged: true,
      address_truncation_rejected: true,
      limitations: image.limitations,
    };
  } catch (error) {
    if (stderr.trim()) process.stderr.write(stderr);
    failure = error;
  } finally {
    try {
      await workspaceFixture.closeEarly([() => commands.close()]);
    } catch (cause) {
      failure =
        failure === undefined
          ? cause
          : new AggregateError(
              [failure, cause],
              "COM verification and command cleanup both failed",
            );
    }
  }
  if (failure !== undefined) {
    workspaceFixture.retain(
      `COM verification failed; retained workspace: ${workspace}`,
    );
    throw failure;
  }
});
assert.ok(report);
verifierRun = await completeVerifierRun(run);
process.stdout.write(
  JSON.stringify({
    verifier_run: verifierRun,
    ...report,
    cleanup: "complete",
  }) + "\n",
);
async function verifyRejectedCom() {
  const rejectedFixture = buildRejectedDosComFixture();
  const rejectedPath = join(workspace, "rejected.com");
  await writeFile(rejectedPath, rejectedFixture.bytes, { mode: 0o600 });
  const fallbackOwner = createVerifierMcpOwner();
  workspaceFixture.releaseAfter(() => fallbackOwner.close());
  const rejectedClient = new Client({
    name: "rea-real-com-fallback",
    version: "1",
  });
  const rejectedTransport = new VerifierStdioTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const connection = await fallbackOwner.open(
    rejectedClient,
    rejectedTransport,
  );
  try {
    const opened = await rejectedClient.callTool(
      {
        name: "open_binary",
        arguments: {
          path: rejectedPath,
          provider_id: "ghidra",
          format: "dos-com",
        },
      },
      { timeout: 240000 },
    );
    const session = requireMcpLifecycleResult(opened, "open_binary");
    assert.equal(session.format, "dos-com");
    const response = await rejectedClient.callTool(
      { name: "inspect_native_load_image", arguments: {} },
      { timeout: 240000 },
    );
    const evidence = parseEvidence(
      requireMcpOutput(response, "inspect_native_load_image"),
    );
    const image = evidence.normalized_result;
    assert.equal(image.status, "verified");
    assert.equal(image.loader, rejectedFixture.loader);
    assert.equal(image.load_address, rejectedFixture.load_address);
    assert.deepEqual(image.loader_fallback, {
      loader: "ComLoader",
      reason: rejectedFixture.fallback_reason,
    });
    assert.equal(image.entry.linear_address, rejectedFixture.entry);
    assert.equal(
      evidence.analysis_profile.parameters.loader,
      rejectedFixture.loader,
    );
    assert.equal(
      evidence.analysis_profile.parameters.load_address,
      rejectedFixture.load_address,
    );
    assert.deepEqual(evidence.analysis_profile.parameters.loader_fallback, {
      loader: "ComLoader",
      reason: rejectedFixture.fallback_reason,
    });
    return {
      loader: image.loader,
      load_address: image.load_address,
      reason: image.loader_fallback.reason,
      entry: image.entry.linear_address,
    };
  } finally {
    await rejectedClient
      .callTool({ name: "close_binary", arguments: {} }, { timeout: 240000 })
      .catch(() => undefined);
    await fallbackOwner.closeConnection(connection);
  }
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function call(name, args = {}) {
  const value = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  if (["open_binary", "close_binary"].includes(name))
    return requireMcpLifecycleResult(value, name);
  const evidence = parseEvidence(requireMcpOutput(value, name));
  assert.equal(evidence.subject.identity.sha256, sha256);
  return evidence.normalized_result;
}
async function cli(command, address, options = []) {
  const { stdout } = await commands.exec(
    process.execPath,
    [
      entrypoint,
      command,
      targetPath,
      ...(address === undefined ? [] : [address]),
      ...options,
      "--target-format",
      "dos-com",
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(stdout));
  assert.equal(evidence.subject.identity.sha256, sha256);
  assert.equal(evidence.subject.identity.format, "dos-com");
  assert.equal(evidence.analysis_profile.parameters.loader, fixture.loader);
  assert.equal(
    evidence.analysis_profile.parameters.load_address,
    fixture.load_address,
  );
  assert.equal(evidence.analysis_profile.parameters.loader_fallback, undefined);
  assert.equal(
    evidence.analysis_profile.parameters.language_id,
    "x86:LE:16:Real Mode",
  );
  assert.equal(evidence.analysis_profile.parameters.entry_offset, "0x100");
  assert.equal(digest(await readFile(targetPath)), sha256);
  return evidence;
}
