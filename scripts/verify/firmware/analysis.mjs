import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { firmwareResultSchemas } from "../../../dist/domain/firmware/firmwareAnalysis.js";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { hashFirmwareFile } from "../../../dist/firmware/FirmwareFiles.js";

const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entrypoint = resolve(
  process.env.REA_FIRMWARE_TEST_ENTRYPOINT ??
    join(repository, "scripts/rea.mjs"),
);
if (process.platform !== "linux")
  throw new Error(
    "verify:firmware requires Linux; other hosts are not verified",
  );
for (const variable of ["REA_BINWALK_COMMAND", "REA_UNBLOB_COMMAND"]) {
  const path = process.env[variable];
  if (path === undefined)
    throw new Error(
      `verify:firmware requires ${variable}; see docs/firmware-analysis.md`,
    );
  await access(path);
}
try {
  await exec("7z", ["i"], { timeout: 10_000 });
} catch (cause) {
  throw new Error(
    "verify:firmware prerequisite unavailable: Unblob's gzip/USTAR fixture extraction requires 7z on PATH",
    { cause },
  );
}
const fixtureRoot = resolve(
  process.env.REA_FIRMWARE_FIXTURE_ROOT ??
    join(repository, "_reference/firmware-integration/generated"),
);
await access(join(fixtureRoot, "oracle.json")).catch((cause) => {
  throw new Error(
    "verify:firmware requires generated fixtures; run npm run fixtures:firmware",
    { cause },
  );
});
const oracle = JSON.parse(
  await readFile(join(fixtureRoot, "oracle.json"), "utf8"),
);
const path = join(fixtureRoot, "firmware.bin");
assert.equal(await hashFirmwareFile(path), oracle.sha256);
const root = await mkdtemp(join(tmpdir(), "rea-real-firmware-"));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined),
);
const client = new Client({ name: "rea-real-firmware-verifier", version: "1" });
const cli = async (args, env = environment) => {
  const response = await exec(
    process.execPath,
    [entrypoint, ...args, "--format", "json"],
    {
      env,
      cwd: repository,
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseEvidence(JSON.parse(response.stdout));
};
const call = async (name, args) => {
  const response = await client.callTool(
    { name, arguments: args },
    { timeout: 150_000 },
  );
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.ok(response.structuredContent !== undefined);
  return response.structuredContent;
};
const verifyRegions = (evidence) => {
  assert.equal(evidence.subject.digest.sha256, oracle.sha256);
  const result = firmwareResultSchemas.inspect_firmware_regions.parse(
    evidence.normalized_result,
  );
  const gzip = result.regions.find(
    (region) => region.signature === "gzip" && region.offset === oracle.offset,
  );
  assert.ok(
    gzip !== undefined,
    "Binwalk must find the independently generated gzip offset",
  );
  assert.equal(gzip.reported_size, oracle.length);
  assert.equal(gzip.size_basis, "provider_reported_validation_unknown");
  return result.regions.map(({ provider_id, ...region }) => region);
};
const verifyFiles = async (evidence) => {
  const result = firmwareResultSchemas.extract_firmware.parse(
    evidence.normalized_result,
  );
  assert.ok(result.chunks.some((chunk) => chunk.handler === "gzip"));
  for (const [suffix, expected] of Object.entries(oracle.files)) {
    const file = result.files.find((candidate) =>
      candidate.relative_path.endsWith(`/${suffix}`),
    );
    assert.ok(file !== undefined, `Missing extracted ${suffix}`);
    assert.equal(file.sha256, expected.sha256);
    assert.equal(file.size, expected.size);
    assert.equal(await hashFirmwareFile(file.path), expected.sha256);
    assert.equal(file.original_file_range, null);
    assert.equal(file.runtime_address, null);
  }
  return result;
};
try {
  const inspected = await cli(["inspect-firmware-regions", path]);
  const cliRegions = verifyRegions(inspected);
  const extracted = await cli([
    "extract-firmware",
    path,
    join(root, "cli-output"),
  ]);
  const cliFiles = await verifyFiles(extracted);
  assert.equal(cliFiles.coverage, "partial");
  assert.ok(
    cliFiles.chunks.some(
      (chunk) =>
        chunk.handler === null &&
        chunk.range.offset === 0 &&
        chunk.range.length === 64,
    ),
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      cwd: repository,
      env: environment,
      stderr: "pipe",
    }),
    { timeout: 30_000 },
  );
  const inspectedMcp = await call("inspect_firmware_regions", { path });
  const mcpEvidence = parseEvidence(inspectedMcp.evidence);
  assert.deepEqual(verifyRegions(mcpEvidence), cliRegions);
  const extractedMcp = await call("extract_firmware", {
    path,
    output_directory: join(root, "mcp-output"),
  });
  const mcpFiles = await verifyFiles(parseEvidence(extractedMcp.evidence));
  const contentIdentity = (result) =>
    result.files.map(({ relative_path, sha256, size }) => ({
      relative_path,
      sha256,
      size,
    }));
  assert.deepEqual(contentIdentity(mcpFiles), contentIdentity(cliFiles));
  const selected = await call("extract_firmware", {
    path,
    output_directory: join(root, "selected-output"),
    range: { offset: oracle.offset, length: oracle.length },
  });
  const selectedFiles = await verifyFiles(parseEvidence(selected.evidence));
  assert.equal(selectedFiles.selection.offset, oracle.offset);
  assert.equal(selectedFiles.selection.length, oracle.length);
  const depth = await call("extract_firmware", {
    path,
    output_directory: join(root, "depth-output"),
    max_depth: 1,
  });
  const depthResult = firmwareResultSchemas.extract_firmware.parse(
    depth.result,
  );
  assert.equal(depthResult.coverage, "partial");
  assert.ok(depthResult.depth_limited_paths.length > 0);
  console.log(
    "PASS real Binwalk/Unblob: CLI, MCP, independent offsets/digests, range extraction, unknown chunks and depth limits",
  );
  if (process.env.REA_FIRMWARE_VERIFY_EXT4 === "1") {
    const ext4 = join(fixtureRoot, "ext4.bin");
    await access(ext4);
    const response = await call("extract_firmware", {
      path: ext4,
      output_directory: join(root, "ext4-output"),
    });
    const result = firmwareResultSchemas.extract_firmware.parse(
      response.result,
    );
    assert.ok(result.chunks.some((chunk) => chunk.handler === "extfs"));
    assert.equal(result.coverage, "complete");
    for (const [suffix, expected] of Object.entries(oracle.files))
      assert.equal(
        result.files.find((file) => file.relative_path.endsWith(`/${suffix}`))
          ?.sha256,
        expected.sha256,
      );
    console.log("PASS real ext4 extraction with debugfs; no mounts");
    // Preserve the process-ownership utility while withholding all extractors.
    const withoutExtractors = join(root, "without-extractors");
    await access("/bin/ps");
    await mkdir(withoutExtractors);
    await symlink("/bin/ps", join(withoutExtractors, "ps"));
    const missing = await cli(
      ["extract-firmware", ext4, join(root, "missing-extractor-output")],
      { ...environment, PATH: withoutExtractors },
    );
    const partial = firmwareResultSchemas.extract_firmware.parse(
      missing.normalized_result,
    );
    assert.equal(partial.coverage, "partial");
    assert.ok(JSON.stringify(partial.diagnostics).includes("debugfs"));
    console.log(
      "PASS real missing-extractor diagnostics retained despite Unblob exit 1",
    );
  }
  if (process.env.REA_FIRMWARE_VERIFY_GHIDRA === "1") {
    if (process.env.GHIDRA_INSTALL_DIR === undefined)
      throw new Error(
        "Firmware Ghidra handoff requires GHIDRA_INSTALL_DIR and Java; see docs/ghidra.md",
      );
    const child = mcpFiles.files.find((file) =>
      file.relative_path.endsWith("/usr/bin/probe"),
    );
    assert.ok(child !== undefined);
    await call("open_binary", { path: child.path, provider_id: "ghidra" });
    const dossier = await call("analyze_function", {
      procedure: "firmware_probe",
    });
    const evidence = parseEvidence(dossier.evidence);
    assert.equal(
      evidence.subject.digest.sha256,
      oracle.files["usr/bin/probe"].sha256,
    );
    const pseudocode = await call("procedure_pseudo_code", {
      procedure: "firmware_probe",
    });
    assert.equal(parseEvidence(pseudocode.evidence).provider.id, "ghidra");
    assert.ok(
      JSON.stringify(evidence.normalized_result).includes("firmware_probe"),
    );
    await call("close_binary", {});
    console.log(
      "PASS real Ghidra handoff of the selected extracted host ELF, bound to its digest",
    );
  }
  assert.equal(
    await hashFirmwareFile(path),
    oracle.sha256,
    "Original firmware bytes must remain unchanged",
  );
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
