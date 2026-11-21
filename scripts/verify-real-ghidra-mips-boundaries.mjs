#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { assertMipsLoadedImage } from "../tests/conformance/ghidra/mips-checks.mjs";
import { buildMips1Fixture } from "../tests/conformance/ghidra/mips1-fixture.mjs";
import {
  createGhidraVerifierMcpOperations,
  resolveGhidraVerifierTimeouts,
} from "./lib/ghidra-verifier-timeouts.mjs";
import {
  requireMcpOperationResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createOwnedMcpStdioTransport } from "./lib/owned-mcp-stdio.mjs";
import { prepareVerifierTokenCleanup } from "./lib/verifier-token-cleanup.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import {
  analysisProfilesEqual,
  committedProvidersEqual,
} from "../dist/domain/analysisProfile.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { cliOperationFailurePayload } from "../dist/cliLogging.js";
import { analysisErrorProjectionSchema } from "../dist/contracts/errorSchemas.js";
import {
  ANALYSIS_EVIDENCE_PREDICATE,
  evidenceSubjectIdentity,
  parseEvidence,
} from "../dist/domain/evidence.js";

// Static source-owned controls. Never execute an ELF or acquire a toolchain.
if (!["darwin", "linux"].includes(process.platform))
  throw new Error(
    "MIPS boundary verification requires a Linux/macOS Ghidra host with verified process lineage.",
  );
if (!process.env.GHIDRA_INSTALL_DIR || !process.env.JAVA_HOME)
  throw new Error(
    "Supply GHIDRA_INSTALL_DIR and JAVA_HOME for the MIPS32 positive control.",
  );
const { VerifierCommandExitError } = await importVerifierSource(
  "./lib/verifier-command-owner.mts",
  import.meta.url,
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cli = fileURLToPath(new URL("./rea.mjs", import.meta.url));
// Only declared tool prerequisites and resource settings reach REA children.
// Ambient REA seeds, analyzer controls and session settings cannot alter controls.
const environment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "silent",
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  JAVA_HOME: process.env.JAVA_HOME,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
for (const setting of [
  "GHIDRA_HEADLESS_MAXMEM",
  "GHIDRA_MAXMEM",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS",
]) {
  if (process.env[setting] !== undefined)
    environment[setting] = process.env[setting];
}
const { requestOptions } = resolveGhidraVerifierTimeouts(environment);
const run = createVerifierRun();
const root = await mkdtemp(join(tmpdir(), "rea-mips-boundaries-"));
const env = { ...environment, TMPDIR: root, REA_PROCESS_RUN_ID: run.run_id };
const reports = [];
async function runControls(cleanup, commands) {
  const command = process.env.REA_MIPS_READELF ?? "readelf";
  const readelfOptions = {
    env: { PATH: env.PATH, LC_ALL: "C" },
    timeout: 10_000,
  };
  const versionOutput = await commands.exec(
    command,
    ["--version"],
    readelfOptions,
  );
  assert.match(
    versionOutput.stdout,
    /^GNU readelf\b/u,
    "This lane requires GNU readelf",
  );
  assert.equal(
    versionOutput.stderr.trim(),
    "",
    `readelf diagnostics: ${versionOutput.stderr}`,
  );
  const version = versionOutput.stdout.split("\n")[0];
  for (const byteOrder of ["little", "big"]) {
    const original = await buildMips1Fixture(root, byteOrder);
    const initial = await readFile(original.path);
    const legacy = Buffer.from(initial);
    const u32 = (bytes, offset, value) =>
      byteOrder === "little"
        ? bytes.writeUInt32LE(value, offset)
        : bytes.writeUInt32BE(value, offset);
    const u16 = (bytes, offset, value) =>
      byteOrder === "little"
        ? bytes.writeUInt16LE(value, offset)
        : bytes.writeUInt16BE(value, offset);
    u32(legacy, 36, 0x50000001); // Existing recordless MIPS32 lane.
    const legacyPath = join(root, `legacy-${byteOrder}.elf`);
    await writeFile(legacyPath, legacy);
    const gnu = Buffer.alloc(0x1200);
    legacy.copy(gnu);
    u32(gnu, 68, gnu.length);
    u32(gnu, 72, gnu.length);
    u16(gnu, 48, 6);
    u32(gnu, 0x1188 + 4, 0x6ffffff5);
    u32(gnu, 0x1188 + 16, 0x11d0);
    u32(gnu, 0x1188 + 20, 16);
    gnu[0x11d0] = 0x41;
    u32(gnu, 0x11d1, 15);
    gnu.write("gnu\0", 0x11d5, "ascii");
    gnu[0x11d9] = 1;
    u32(gnu, 0x11da, 7);
    gnu[0x11de] = 4; // Tag_GNU_MIPS_ABI_FP
    gnu[0x11df] = 3; // Soft float.
    const gnuPath = join(root, `gnu-fp-${byteOrder}.elf`);
    await writeFile(gnuPath, gnu);
    const attributes = await commands.exec(
      command,
      ["-A", gnuPath],
      readelfOptions,
    );
    assert.equal(
      attributes.stderr.trim(),
      "",
      `readelf diagnostics: ${attributes.stderr}`,
    );
    assert.match(attributes.stdout, /Tag_GNU_MIPS_ABI_FP.*Soft float/iu);
    const transport = await createOwnedMcpStdioTransport({
      command: process.execPath,
      arguments: [cli, "mcp"],
      hostEnvironment: env,
      cwd: process.cwd(),
      expectedCommand: null,
      sweepTokenOwnedProcesses: true,
    });
    // CLI commands run while this transport is live. Keep its owner separate
    // so command-scope cleanup cannot close the active MCP connection.
    const transportOwner = await createVerifierCommands();
    transportOwner.adopt(transport, "MIPS verifier MCP process");
    const client = new Client({ name: "rea-mips-boundaries", version: "1" });
    const mcp = createGhidraVerifierMcpOperations(client, requestOptions);
    const invoke = (name, args = {}) => mcp.callTool({ name, arguments: args });
    const call = async (name, args = {}) =>
      requireMcpOperationResult(await invoke(name, args), name);
    const currentGhidraSession = async () => {
      const status = await call("binary_session");
      assert.equal(status.open, true);
      assert.equal(status.analysis_provider_binding?.provider.id, "ghidra");
      assert.ok(
        status.analysis_run,
        "Ghidra session run receipt is unavailable",
      );
      return {
        run: status.analysis_run,
        binding: status.analysis_provider_binding,
      };
    };
    await withVerifierCleanup(async () => {
      await mcp.connect(transport);
      const refusals = {};
      for (const [control, path, pattern] of [
        [
          "declared_o32_mips1",
          original.path,
          /requires EF_MIPS_ARCH_32R2 for headers that declare an ABI/u,
        ],
        ["gnu_fp_attributes", gnuPath, /GNU floating-point ABI attribute/u],
      ]) {
        const mcpError = requireMcpToolError(
          await invoke("open_binary", { path, provider_id: "ghidra" }),
        );
        if (mcpError.code !== "capability_unavailable")
          throw new Error("MCP did not report an ordinary provider refusal", {
            cause: mcpError,
          });
        assert.match(JSON.stringify(mcpError), pattern);
        let reply;
        try {
          await commands.exec(
            process.execPath,
            [
              cli,
              "function",
              path,
              original.entry,
              "--provider",
              "ghidra",
              "--full-output",
              "--json",
            ],
            { env, timeout: requestOptions.timeout },
          );
        } catch (cause) {
          if (!(cause instanceof VerifierCommandExitError) || cause.code !== 1)
            throw cause;
          reply = JSON.parse(cause.snapshot.stdout.text);
        }
        assert.equal(
          reply?.ok,
          false,
          "CLI admitted an unsupported MIPS declaration or omitted its refusal",
        );
        const cliError = analysisErrorProjectionSchema.parse(
          cliOperationFailurePayload(reply),
        );
        if (cliError.code !== "capability_unavailable")
          throw new Error("CLI did not report an ordinary provider refusal", {
            cause: cliError,
          });
        assert.match(JSON.stringify(cliError), pattern);
        refusals[control] = { selected_path: path, cli: reply, mcp: mcpError };
      }
      const selectedSourcePath = await realpath(legacyPath);
      await call("open_binary", { path: legacyPath, provider_id: "ghidra" });
      // The session ID is authoritative before analyze_function can launch
      // Ghidra. Its token stays in the sweep even if that first call fails.
      const providerRunId = (await currentGhidraSession()).run.run_id;
      cleanup.registerProviderRun(providerRunId);
      const evidence = parseEvidence(
        requireMcpOutput(
          await invoke("analyze_function", {
            procedure: original.entry,
            detail: "complete",
          }),
          "analyze_function",
        ),
      );
      const { run: activeRun, binding: activeBinding } =
        await currentGhidraSession();
      assert.equal(activeRun.run_id, providerRunId);
      const providerLineage = activeRun.process_lineage.snapshots?.find(
        ({ provider }) => provider.id === "ghidra",
      )?.observation;
      const providerScope =
        providerLineage?.status === "verified"
          ? {
              leaderPid: providerLineage.launcher_pid,
              processGroupId: providerLineage.process_group_id,
              sampledProcessGroupIds: providerLineage.descendants.map(
                ({ process_group_id }) => process_group_id,
              ),
            }
          : undefined;
      // Capture native token-verified identities while the provider is live;
      // A public lineage snapshot is optional; native ownership is mandatory.
      await cleanup.retainProviderRun(providerRunId, providerScope);
      assert.equal(evidence.operation, "analyze_function");
      assert.equal(evidence.predicate_type, ANALYSIS_EVIDENCE_PREDICATE);
      assert.equal(evidence.parameters.procedure, original.entry);
      const sourceSha256 = digest(legacy);
      const subject = evidenceSubjectIdentity(evidence.subject);
      assert.deepEqual(
        subject,
        {
          digest: { sha256: sourceSha256 },
          format: "elf",
          architecture: "mips",
        },
        "MIPS dossier Evidence subject does not identify the exact ELF fixture",
      );
      assert.equal(
        evidence.subject.local_path,
        selectedSourcePath,
        "MIPS dossier Evidence path does not match the selected ELF fixture",
      );
      const dossier = functionDossierSchema.parse(evidence.normalized_result);
      assert.equal(BigInt(dossier.procedure.address), BigInt(original.entry));
      assert.ok(dossier.pseudocode.trim().length > 0);
      assert.ok(
        evidence.provider.id === "ghidra" && evidence.provider.version?.trim(),
        "MIPS dossier Evidence omitted a concrete Ghidra provider identity",
      );
      assert.ok(
        committedProvidersEqual(evidence.provider, activeBinding.provider),
        "MIPS dossier Evidence provider differs from the active Ghidra session",
      );
      const profile = evidence.analysis_profile;
      assert.ok(profile, "MIPS dossier Evidence omitted its analysis profile");
      const { mips_support_lane, mips_abi_basis } = profile.parameters;
      assert.equal(
        mips_support_lane,
        "elf32-exec-arch32-legacy-pinned-v1",
        "MIPS dossier Evidence reported the wrong support lane",
      );
      assert.equal(
        mips_abi_basis,
        "inferred-o32-assumption-v1",
        "MIPS dossier Evidence reported the wrong ABI basis",
      );
      assert.ok(
        analysisProfilesEqual(profile, activeBinding.analysis_profile),
        "MIPS dossier Evidence profile differs from the active Ghidra session",
      );
      // The provider's session limitations belong to the public Evidence;
      // the normalized function payload has its own local observations.
      const inferredO32Limitation = evidence.limitations.find((limitation) =>
        limitation.includes(
          "o32 calling conventions are an analysis assumption",
        ),
      );
      assert.ok(
        inferredO32Limitation,
        "Recordless MIPS dossier Evidence omitted its inferred o32 limitation",
      );
      const floatingPointLimitation = evidence.limitations.find((limitation) =>
        limitation.includes("Floating-point ABI semantics are unverified"),
      );
      assert.ok(
        floatingPointLimitation,
        "Recordless MIPS dossier Evidence omitted its floating-point ABI limitation",
      );
      const image = await call("inspect_native_load_image");
      assertMipsLoadedImage(image.observations, byteOrder, sourceSha256);
      const entryBytes = legacy.subarray(0x1000, 0x1018);
      const loaded = await call("read_bytes", {
        address: original.entry,
        length: entryBytes.length,
      });
      assert.equal(BigInt(loaded.address), BigInt(original.entry));
      assert.equal(loaded.requested_bytes, entryBytes.length);
      assert.equal(loaded.returned_bytes, entryBytes.length);
      assert.equal(loaded.complete, true);
      assert.equal(loaded.bytes_hex, entryBytes.toString("hex"));
      const providerRun = {
        control: "recordless_mips32",
        run_id: providerRunId,
        language_id: image.observations.language_id,
        dossier_evidence_id: evidence.evidence_id,
        selected_path: legacyPath,
        dossier_subject: {
          ...subject,
          local_path: evidence.subject.local_path,
        },
        dossier_entry: dossier.procedure.address,
        loaded_bytes: loaded,
        dossier_provider: evidence.provider,
        dossier_profile: {
          digest: profile.digest,
          mips_support_lane,
          mips_abi_basis,
        },
        dossier_abi_limitations: {
          inferred_o32: inferredO32Limitation,
          floating_point: floatingPointLimitation,
        },
        ...(providerScope === undefined
          ? { public_lineage: "not_observed" }
          : providerScope),
      };
      await call("close_binary");
      assert.deepEqual(await readFile(original.path), initial);
      assert.deepEqual(await readFile(gnuPath), gnu);
      assert.deepEqual(await readFile(legacyPath), legacy);
      reports.push({
        byte_order: byteOrder,
        provider_runs: [providerRun],
        refusals,
        readelf: { command, version, raw: attributes.stdout },
        existing_mips32_control:
          "real Ghidra dossier, pinned 32-bit import language and exact loaded bytes",
        hashes: {
          mips1: digest(initial),
          gnu: digest(gnu),
          legacy: digest(legacy),
        },
        source_unchanged: true,
        target_executed: false,
      });
    }, [() => client.close(), () => transportOwner.close()]);
  }
}
let tokenCleanup;
let completed;
let retainedCleanupOwner;
try {
  const cleanup = await prepareVerifierTokenCleanup(run);
  await withVerifierCleanup(async () => {
    const commands = await createVerifierCommands();
    return withVerifierCleanup(
      () => runControls(cleanup, commands),
      [() => commands.close()],
    );
  }, [
    async () => {
      tokenCleanup = await cleanup.verify();
      if (tokenCleanup.cleaned) return;
      const firstRetry = await cleanup.retryProviderCleanup(tokenCleanup);
      const retries = [firstRetry];
      if (!firstRetry.cleaned)
        retries.push(await cleanup.retryProviderCleanup(firstRetry));
      const finalRetry = retries.at(-1);
      if (!finalRetry.cleaned)
        retainedCleanupOwner = cleanup.retainPendingProviderCleanup(finalRetry);
      const diagnosticPath = join(root, "token-cleanup.json");
      const failure = Object.assign(
        new Error(
          `Token cleanup unverified: ${tokenCleanup.reason}; diagnostic: ${diagnosticPath}`,
        ),
        {
          verification: tokenCleanup,
          retries,
          ...(retainedCleanupOwner === undefined
            ? {}
            : { cleanupOwner: retainedCleanupOwner }),
        },
      );
      await withVerifierCleanup(() => {
        throw failure;
      }, [
        () =>
          writeFile(
            diagnosticPath,
            JSON.stringify(
              {
                verification: tokenCleanup,
                retries,
                retained_provider_evidence: cleanup.retainedProviderEvidence(),
              },
              null,
              2,
            ),
          ),
      ]);
    },
    () => (retainedCleanupOwner === undefined ? cleanup.close() : undefined),
    async () => {
      completed = await completeVerifierRun(run);
      assertVerifierCleanupComplete(completed.process_lineage);
    },
  ]);
} catch (cause) {
  const reportPath =
    reports.length > 0 ? join(root, "partial-reports.json") : undefined;
  const failure = Object.assign(
    new Error(
      `MIPS boundary verification failed; retained workspace: ${root}` +
        (reportPath === undefined ? "" : `; completed reports: ${reportPath}`),
      { cause },
    ),
    retainedCleanupOwner === undefined
      ? {}
      : { cleanupOwner: retainedCleanupOwner },
  );
  await withVerifierCleanup(
    () => {
      throw failure;
    },
    reportPath === undefined
      ? []
      : [
          () =>
            writeFile(
              reportPath,
              JSON.stringify({ ...run, status: "failed", reports }, null, 2),
            ),
        ],
  );
}
await rm(root, { recursive: true, force: true });
console.log(
  JSON.stringify(
    { ...completed, token_cleanup: tokenCleanup, status: "passed", reports },
    null,
    2,
  ),
);
