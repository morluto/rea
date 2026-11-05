import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

import { artifactMcpCall } from "../../scripts/lib/artifact-e2e.mjs";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url));

const setup = async () => {
  const root = await createTestTempDirectory(
    "rea-public-extraction-selection-",
  );
  const path = join(root, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("lib/selected.so", new TextReader("native fixture"));
  await writer.add("lib/other.so", new TextReader("other architecture"));
  await writer.add("res/2f.xml", new TextReader("lower"));
  await writer.add("res/2F.xml", new TextReader("upper"));
  const bytes = await writer.close();
  await writeFile(path, bytes);
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    USERPROFILE: root,
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "auto",
  };
  const run = async (command: string, flags: readonly string[] = []) => {
    const { stdout } = await execute(
      process.execPath,
      [cli, command, path, ...flags, "--json"],
      {
        env: environment,
        timeout: 30000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return parseEvidence(JSON.parse(stdout));
  };
  const inspected = artifactInspectionResultSchema.parse(
    (await run("inspect-artifact")).normalized_result,
  );
  const inventoryEvidence = inspected.substeps.find(
    ({ evidence }) => evidence.operation === "inventory_artifact",
  )?.evidence;
  if (inventoryEvidence === undefined)
    throw new Error("Missing inventory Evidence");
  const inventory = artifactInventoryResultSchema.parse(
    inventoryEvidence.normalized_result,
  );
  const occurrence = (path: string) => {
    const entry = inventory.occurrences.find(
      ({ logical_path }) => logical_path === path,
    );
    if (entry === undefined) throw new Error(`Missing occurrence: ${path}`);
    return entry.occurrence_id;
  };
  return { root, path, bytes, environment, run, inventory, occurrence };
};

it("extracts repeatable CLI selections into the exact requested destination", async () => {
  const data = await setup();
  const ids = [
    data.occurrence("lib/selected.so"),
    data.occurrence("lib/other.so"),
  ];
  const output = join(data.root, "chosen-output");
  const evidence = await data.run("extract-artifact", [
    "--output-root",
    output,
    ...ids.flatMap((id) => ["--occurrence-id", id]),
  ]);
  const result = artifactExtractionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(result.output_root).toBe(output);
  expect(result.artifacts.map(({ relative_path }) => relative_path)).toEqual([
    "lib/other.so",
    "lib/selected.so",
  ]);
  expect(result.extraction_manifest.selected_occurrence_ids).toEqual(
    [...ids].sort(),
  );
  expect(result.manifest).toEqual(data.inventory.manifest);
  expect(await readdir(output)).toEqual(["lib"]);
  expect(await readFile(join(output, "lib/selected.so"), "utf8")).toBe(
    "native fixture",
  );
});

it("keeps CLI/MCP selection identity, invalid-input refusals and committed output after close", async () => {
  const data = await setup();
  const id = data.occurrence("lib/selected.so");
  const cliResult = artifactExtractionResultSchema.parse(
    (
      await data.run("extract-artifact", [
        "--output-root",
        join(data.root, "cli-output"),
        "--occurrence-id",
        id,
      ])
    ).normalized_result,
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env: data.environment,
    stderr: "pipe",
  });
  const client = new Client({
    name: "extraction-selection-test",
    version: "1",
  });
  const output = join(data.root, "mcp-output");
  try {
    await client.connect(transport);
    const opened = await artifactMcpCall(client, {
      name: "open_binary",
      arguments: { path: data.path },
    });
    expect(opened.isError).not.toBe(true);
    const reply = await artifactMcpCall(client, {
      name: "extract_artifact",
      arguments: { output_root: output, occurrence_ids: [id] },
    });
    expect(reply.isError).not.toBe(true);
    const evidence = parseEvidence(reply.structuredContent);
    const result = artifactExtractionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.output_root).toBe(output);
    expect(result.extraction_manifest).toEqual(cliResult.extraction_manifest);
    expect(result.artifacts).toEqual(cliResult.artifacts);
    const invalidOutput = join(data.root, "invalid-output");
    const invalid = await artifactMcpCall(client, {
      name: "extract_artifact",
      arguments: {
        output_root: invalidOutput,
        occurrence_ids: [`occ_${"0".repeat(64)}`],
      },
    });
    expect(invalid.isError).toBe(true);
    await expect(lstat(invalidOutput)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const closed = await artifactMcpCall(client, {
      name: "close_binary",
      arguments: {},
    });
    expect(closed.isError).not.toBe(true);
  } finally {
    await client.close();
    await transport.close();
  }
  expect(await readFile(join(output, "lib/selected.so"), "utf8")).toBe(
    "native fixture",
  );
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  expect(digest(await readFile(data.path))).toBe(digest(data.bytes));
});
