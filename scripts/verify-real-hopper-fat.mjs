import { canonicalOutputSchema } from "./lib/canonical-output-schema.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { runOwnedCommand } from "../dist/process/OwnedCommand.js";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import { snapshotHopperRuntime } from "./lib/real-hopper-cleanup.mjs";
import { closeVerifierResources } from "./lib/verifier-cleanup.mjs";
import { HOPPER_TARGET_LEASE_DIRECTORY } from "../dist/process/HopperLease.js";
import { parseConfig } from "../dist/config/parseConfig.js";
import { selectedHopperLauncherPath } from "../dist/hopperPaths/HopperLauncherDiscovery.js";
import {
  verifyHopperSourceBinding,
  relocateSingleFatSlice,
} from "./lib/real-hopper-source-binding.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const verifierRun = createVerifierRun();
// xcrun resolves clang and lipo before a workspace exists. A failed probe must
// not allocate a root, so it uses the same short-lived owner as requireLaneToolchain.
const probeOwnedCommand = async (command, arguments_) => {
  const snapshot = await runOwnedCommand(
    {
      command,
      arguments: arguments_,
      cwd: process.cwd(),
      env: process.env,
      runId: `rea-hopper-fat-probe-${randomUUID()}`,
      expectedCommand: null,
      sweepTokenOwnedProcesses: true,
    },
    { timeoutMs: null, diagnosticBytes: 1024 * 1024 },
  );
  return snapshot.stdout.text;
};
const verifyFat64 = process.argv[2] === "--fat64";
assert.deepEqual(process.argv.slice(2), verifyFat64 ? ["--fat64"] : []);
if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error(
    "Hopper FAT verification requires macOS arm64 or x64 and its installed clang/lipo toolchain",
  );
const config = parseConfig(process.env);
if (!config.ok) throw config.error;
const hopperLauncherPath = selectedHopperLauncherPath(
  config.value.hopperLauncherPath,
  process.platform,
  process.env,
);
await access(hopperLauncherPath, constants.X_OK).catch((cause) => {
  throw new Error(
    `Hopper FAT verification requires the configured executable: ${hopperLauncherPath}`,
    { cause },
  );
});
const toolPaths = {};
for (const command of ["clang", "lipo"])
  toolPaths[command] = (
    await probeOwnedCommand("xcrun", ["--find", command]).catch((cause) => {
      throw new Error(`Hopper FAT verification requires ${command}`, { cause });
    })
  ).trim();
const sdk = (
  await probeOwnedCommand("xcrun", [
    "--sdk",
    "macosx",
    "--show-sdk-path",
  ]).catch((cause) => {
    throw new Error(
      "Hopper FAT verification requires the installed macOS SDK",
      { cause },
    );
  })
).trim();

const workspace = await VerifierFixture.open({
  prefix: "hopper-fat-",
  private: false,
});
const directory = workspace.path;
const commands = await createVerifierCommands();
const retainWorkspace = (message, options) => {
  workspace.retain(message);
  return new Error(message, options);
};
const hostFatArchitecture = process.arch === "arm64" ? "arm64" : "x86_64";
const source = fileURLToPath(
  new URL("../tests/conformance/c/fixture.c", import.meta.url),
);
const arm = join(directory, "c-arm64");
const intel = join(directory, "c-x86_64");
const fat = join(directory, "c-fat");
const fat64 = join(directory, "c-fat64");
const singleFat = join(directory, "c-single-fat");
const extraFat64 = [];
const invalidFat64 = [];
let preparedImagePath;
const before = (
  await snapshotHopperRuntime("/tmp", HOPPER_TARGET_LEASE_DIRECTORY)
).paths;
const client = new Client({ name: "hopper-fat-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js"],
  env: {
    ...process.env,
    REA_ANALYSIS_PROVIDER: "hopper",
    HOPPER_LOADER_ARGS_JSON: "[]",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const observations = [];
const sourceBinding = [];
let primaryFailure;
try {
  await commands.exec(toolPaths.clang, [
    "-isysroot",
    sdk,
    "-arch",
    "arm64",
    "-O0",
    "-fno-inline",
    source,
    "-o",
    arm,
  ]);
  await commands.exec(toolPaths.clang, [
    "-isysroot",
    sdk,
    "-arch",
    "x86_64",
    "-O0",
    "-fno-inline",
    source,
    "-o",
    intel,
  ]);
  await commands.exec(toolPaths.lipo, ["-create", arm, intel, "-output", fat]);
  if (verifyFat64)
    await commands.exec(toolPaths.lipo, [
      "-create",
      arm,
      intel,
      "-fat64",
      "-output",
      fat64,
    ]);
  await commands.exec(toolPaths.lipo, [
    "-create",
    process.arch === "arm64" ? arm : intel,
    "-output",
    singleFat,
  ]);
  if (verifyFat64) {
    const original = await readFile(fat64);
    const swapped = Buffer.from(original);
    swapped.writeUInt32BE(0xbfbafeca, 0);
    swapped.writeUInt32LE(original.readUInt32BE(4), 4);
    for (let index = 0; index < original.readUInt32BE(4); index++) {
      const offset = 8 + index * 32;
      for (const field of [0, 4, 24, 28])
        swapped.writeUInt32LE(
          original.readUInt32BE(offset + field),
          offset + field,
        );
      for (const field of [8, 16])
        swapped.writeBigUInt64LE(
          original.readBigUInt64BE(offset + field),
          offset + field,
        );
    }
    const little = join(directory, "c-fat64-little-endian");
    await writeFile(little, swapped);
    extraFat64.push(little);
    const single = join(directory, "c-single-fat64");
    await commands.exec(toolPaths.lipo, [
      "-create",
      process.arch === "arm64" ? arm : intel,
      "-fat64",
      "-output",
      single,
    ]);
    extraFat64.push(single);
    for (const [name, refusal, mutate] of [
      [
        "reserved",
        {
          reason: "FAT64 architecture 0 has a nonzero reserved field",
        },
        (bytes) => bytes.writeUInt32BE(1, 36),
      ],
      [
        "range",
        {
          reason: "FAT architecture 0 slice range extends beyond the file",
          constraint: "file_format_rejected",
        },
        (bytes) => bytes.writeBigUInt64BE(BigInt(bytes.length), 24),
      ],
      [
        "identity",
        {
          reason:
            "FAT architecture 0 CPU type/subtype disagrees with its Mach-O header",
          constraint: "file_format_rejected",
        },
        (bytes) => bytes.writeUInt32BE(bytes.readUInt32BE(12) + 1, 12),
      ],
      [
        "overlap",
        { reason: "FAT slices overlap" },
        (bytes) => {
          const firstOffset = bytes.readBigUInt64BE(16);
          const secondOffset = bytes.readBigUInt64BE(48);
          const earlier = firstOffset < secondOffset ? 8 : 40;
          const laterOffset =
            firstOffset < secondOffset ? secondOffset : firstOffset;
          const earlierOffset =
            firstOffset < secondOffset ? firstOffset : secondOffset;
          bytes.writeBigUInt64BE(
            laterOffset - earlierOffset + 16n,
            earlier + 16,
          );
        },
      ],
    ]) {
      const bytes = Buffer.from(original);
      mutate(bytes);
      const path = join(directory, `c-fat64-invalid-${name}`);
      await writeFile(path, bytes);
      invalidFat64.push({ path, refusal });
    }
    const hostBytes = await readFile(process.arch === "arm64" ? arm : intel);
    const secondOffset = Math.ceil((16384 + hostBytes.length) / 16384) * 16384;
    const ambiguous = Buffer.alloc(secondOffset + hostBytes.length);
    ambiguous.writeUInt32BE(0xcafebabf, 0);
    ambiguous.writeUInt32BE(2, 4);
    for (const [index, offset] of [16384, secondOffset].entries()) {
      const base = 8 + index * 32;
      ambiguous.writeUInt32BE(hostBytes.readUInt32LE(4), base);
      ambiguous.writeUInt32BE(hostBytes.readUInt32LE(8), base + 4);
      ambiguous.writeBigUInt64BE(BigInt(offset), base + 8);
      ambiguous.writeBigUInt64BE(BigInt(hostBytes.length), base + 16);
      ambiguous.writeUInt32BE(14, base + 24);
      hostBytes.copy(ambiguous, offset);
    }
    const path = join(directory, "c-fat64-ambiguous");
    await writeFile(path, ambiguous);
    invalidFat64.push({
      path,
      refusal: {
        reason: `FAT binary declares several ${hostFatArchitecture} slices; no slice was selected`,
        constraint: "file_format_rejected",
      },
    });
  }
  await client.connect(transport);
  assert.ok(transport.pid !== null);
  const catalog = await client.listTools();
  const call = async (name, args = {}) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 180_000 },
    );
    const result = requireMcpOperationResult(reply, name);
    assert.ok(
      catalog.tools.some((tool) => tool.name === name),
      `${name} is not advertised`,
    );
    const schema = canonicalOutputSchema(name);
    assert.equal(
      ajv.validate(schema, reply.structuredContent),
      true,
      JSON.stringify(ajv.errors),
    );
    return result;
  };
  const cliMappings = new Map();
  for (const path of [
    arm,
    intel,
    fat,
    singleFat,
    ...(verifyFat64 ? [fat64, ...extraFat64] : []),
  ]) {
    console.error(`Verifying Hopper source-file mappings for ${path}`);
    const file = await readFile(path);
    const sourceHash = createHash("sha256").update(file).digest("hex");
    await call("open_binary", { path });
    const procedures = await call("list_procedures");
    const entry = procedures.find((item) => item.value.endsWith("rea_entry"));
    assert.ok(entry, "compiler fixture omitted rea_entry");
    let entryMapping;
    for (const address of [
      entry.address,
      `0x${(BigInt(entry.address) + 1n).toString(16)}`,
    ]) {
      const mapping = await call("address_to_file_offset", { address });
      if (address === entry.address) entryMapping = mapping;
      const bytes = await call("read_bytes", { address, length: 16 });
      assert.equal(
        mapping.file_offset,
        mapping.image_base_file_offset + mapping.provider_file_offset,
      );
      assert.equal(mapping.source_path, path);
      assert.equal(bytes.complete, true);
      assert.equal(
        file
          .subarray(mapping.file_offset, mapping.file_offset + 16)
          .toString("hex"),
        bytes.bytes_hex,
      );
      if (
        path === fat ||
        path === singleFat ||
        path === fat64 ||
        extraFat64.includes(path)
      ) {
        assert.ok(
          mapping.image_base_file_offset > 0,
          "FAT mapping omitted its physical slice offset",
        );
        assert.notEqual(
          file
            .subarray(
              mapping.provider_file_offset,
              mapping.provider_file_offset + 16,
            )
            .toString("hex"),
          bytes.bytes_hex,
          "fixture did not distinguish image-relative and original-file coordinates",
        );
      } else assert.equal(mapping.image_base_file_offset, 0);
      if (path === fat || path === fat64) {
        cliMappings.set(path, { mapping, address });
      }
      observations.push({ path, address, ...mapping, matched_bytes: 16 });
    }
    if (path === fat64 || extraFat64.includes(path)) {
      const session = await call("binary_session");
      assert.equal(session.path, path);
      assert.equal(session.sha256, sourceHash);
      const profile = session.analysis_provider_binding.analysis_profile;
      assert.equal(
        profile.parameters.prepared_image.method,
        "fat64_thin_slice",
      );
      assert.equal(
        profile.parameters.prepared_image.source_offset,
        observations.at(-1).image_base_file_offset,
      );
      const document = await call("current_document");
      await call("set_comment", {
        address: entry.address,
        comment: "source-bound FAT64 preparation",
      });
      await call("open_binary", { path });
      assert.deepEqual(
        (await call("binary_session")).analysis_provider_binding
          .analysis_profile,
        profile,
      );
      assert.equal(await call("current_document"), document);
      assert.equal(
        await call("comment", { address: entry.address }),
        "source-bound FAT64 preparation",
      );
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      sourceHash,
      "native analysis modified source executable bytes",
    );
    sourceBinding.push({
      path,
      ...(await verifyHopperSourceBinding({
        client,
        call,
        path,
        file,
        address: entry.address,
        mapping: entryMapping,
        ...(path === singleFat || path.endsWith("c-single-fat64")
          ? { relocate: relocateSingleFatSlice }
          : {}),
      })),
    });
    await call("close_binary");
  }
  for (const { path, refusal } of invalidFat64) {
    const reply = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    // Admission failures are BinaryTargetError file_format_rejected.
    // Reserved and overlap survive admission and fail in resolveHopperMachOImage,
    // which returns BinaryTargetError with no constraint. Both classify as
    // target_unavailable and keep the producer reason on details.reason.
    const refused = requireMcpToolError(reply);
    assert.partialDeepStrictEqual(refused, {
      code: "target_unavailable",
      details: {
        path,
        reason: refusal.reason,
        ...(refusal.constraint === undefined
          ? {}
          : { constraint: refusal.constraint }),
      },
    });
    if (refusal.constraint === undefined)
      assert.equal(refused.details?.constraint, undefined);
  }
  if (verifyFat64) {
    await call("open_binary", { path: fat64 });
    await call("list_procedures");
    const session = await call("binary_session");
    const runId = session.analysis_run?.run_id;
    assert.ok(
      typeof runId === "string" && runId.length > 0,
      "Missing analysis run identity",
    );
    const resources = await snapshotHopperRuntime(
      "/tmp",
      HOPPER_TARGET_LEASE_DIRECTORY,
      runId,
    );
    const unresolvedNew = [...resources.unresolvedSessions].filter(
      (path) => !before.has(path),
    );
    assert.deepEqual(
      unresolvedNew,
      [],
      "Cannot identify a prepared image while new Hopper resource ownership is unresolved",
    );
    for (const root of resources.confirmedSessions) {
      if (before.has(root)) continue;
      const image = join(root, "image.macho");
      if (
        await access(image).then(
          () => true,
          () => false,
        )
      )
        preparedImagePath = image;
    }
    assert.ok(
      preparedImagePath,
      "prepared native image was not owned by this session",
    );
    await client.close();
    await transport.close();
    await assert.rejects(access(preparedImagePath), { code: "ENOENT" });
  }
  for (const [path, expected] of cliMappings) {
    const cliResult = await commands.exec(
      process.execPath,
      [
        "scripts/rea.mjs",
        "address-to-file-offset",
        path,
        expected.address,
        "--provider",
        "hopper",
        "--format",
        "json",
      ],
      {
        timeout: 180_000,
        env: { ...process.env, HOPPER_LOADER_ARGS_JSON: "[]" },
      },
    );
    const cli = JSON.parse(cliResult.stdout);
    assert.deepEqual(cli.normalized_result, expected.mapping);
  }
} catch (cause) {
  primaryFailure = cause;
}
let hopperCleanupFailure;
try {
  await workspace.closeEarly([
    async () => {
      try {
        await closeVerifierResources([
          () => client.close(),
          () => transport.close(),
        ]);
      } catch (cause) {
        throw new Error(
          `Hopper cleanup failed; fixture retained at ${directory}`,
          { cause },
        );
      }
      try {
        const retained = [
          ...(
            await snapshotHopperRuntime("/tmp", HOPPER_TARGET_LEASE_DIRECTORY)
          ).paths,
        ].filter((path) => !before.has(path));
        assert.deepEqual(
          retained,
          [],
          "Hopper resources remain or are unresolved",
        );
      } catch (cause) {
        throw new Error(
          `Hopper resource verification failed; fixture retained at ${directory}`,
          { cause },
        );
      }
    },
  ]);
} catch (cause) {
  hopperCleanupFailure = cause;
}
if (hopperCleanupFailure !== undefined)
  primaryFailure =
    primaryFailure === undefined
      ? hopperCleanupFailure
      : new AggregateError(
          [primaryFailure, hopperCleanupFailure],
          "Hopper FAT verification and Hopper cleanup both failed",
        );
let commandCleanupFailure;
try {
  await workspace.closeEarly([() => commands.close()]);
} catch (cause) {
  commandCleanupFailure = cause;
}
if (commandCleanupFailure !== undefined)
  throw retainWorkspace(
    `Hopper FAT command cleanup failed; retained diagnostic workspace: ${directory}`,
    {
      cause:
        primaryFailure === undefined
          ? commandCleanupFailure
          : new AggregateError(
              [primaryFailure, commandCleanupFailure],
              "Hopper FAT verification and command cleanup both failed",
            ),
    },
  );
const completedVerifierRun = await completeVerifierRun(verifierRun);
try {
  assertVerifierCleanupComplete(completedVerifierRun.process_lineage);
} catch (cause) {
  throw retainWorkspace(
    `Cleanup unverified; retained diagnostic workspace: ${directory}`,
    {
      cause:
        primaryFailure === undefined
          ? cause
          : new AggregateError(
              [primaryFailure, cause],
              "Hopper FAT verification failed and cleanup was unverified",
            ),
    },
  );
}
if (primaryFailure !== undefined)
  throw retainWorkspace(
    `Hopper FAT verification failed; retained workspace: ${directory}`,
    { cause: primaryFailure },
  );
await workspace.release();
console.log(
  JSON.stringify(
    {
      observations,
      cliMcpParity: true,
      sourceBinding,
      fat64: verifyFat64 ? "verified" : "not_run",
      malformedFat64Rejected: invalidFat64.length,
      preparedImageRemovedOnMcpShutdown: preparedImagePath !== undefined,
      cleanShutdown: true,
    },
    null,
    2,
  ),
);
