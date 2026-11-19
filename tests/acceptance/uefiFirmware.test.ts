import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { uefiResultSchemas } from "../../src/domain/uefi/uefiFirmwareAnalysis.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import {
  buildFfsFile,
  buildFv,
  buildImage,
  buildSection,
} from "../../tests/fixtures/uefiImage.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url));

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const DRIVER_GUID = "9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2";
const PAD_GUID = "fff12b8d-d7da-47f8-b4cf-1a0a2a1c1b1c";
const PAYLOAD = Buffer.from(
  "4d5a90000300000004000000ffff00020000000012345678hello-bios",
  "hex",
);

/**
 * One B550-shaped flash image: an erased lead-in with no volume at offset 0,
 * the platform volume at 0x1000 carrying two FFS files (one payload, one pad
 * file), and a second volume holding a third file.
 */
const PE_SECTION = buildSection(0x10, PAYLOAD);

const buildFlashImage = (): Buffer => {
  const payloadFile = buildFfsFile({
    guid: DRIVER_GUID,
    typeCode: 0x07,
    payload: PE_SECTION,
  });
  const padFile = buildFfsFile({
    guid: PAD_GUID,
    typeCode: 0xf0,
    payload: Buffer.alloc(0),
  });
  const trailingFile = buildFfsFile({
    guid: "0a8f1d2b-1111-2222-3333-445566778899",
    typeCode: 0x15,
    payload: Buffer.from("second volume module", "ascii"),
  });
  const body = buildImage({
    volumes: [
      buildFv({ files: [payloadFile, padFile] }).buffer,
      buildFv({ files: [trailingFile] }).buffer,
    ],
  });
  // An erased lead-in keeps the first volume away from offset 0.
  return Buffer.concat([Buffer.alloc(0x1000, 0xff), body]);
};

const extractFlashFileViaCli = async (
  root: string,
  imageName: string,
  offset: number,
) => {
  const cliExtraction = await execute(
    process.execPath,
    [
      cli,
      "extract-uefi-firmware",
      imageName,
      "cli-extracted",
      "--file-offset",
      String(offset),
      "--source-stream",
      "flash",
      "--json",
    ],
    { cwd: root },
  );
  return parseEvidence(JSON.parse(cliExtraction.stdout));
};

it("maps a flash image end to end through CLI inspection and MCP session inventory", async () => {
  const root = await createTestTempDirectory("rea-uefi-session-acceptance-");
  const image = buildFlashImage();
  const imagePath = join(root, "B550AORUSELITEV212.FIb");
  await writeFile(imagePath, image);

  const cliResult = await execute(process.execPath, [
    cli,
    "inspect-uefi-firmware",
    imagePath,
    "--json",
  ]);
  expect(cliResult.stderr, cliResult.stderr).toBe("");
  const cliEvidence = parseEvidence(JSON.parse(cliResult.stdout));
  const inspected = uefiResultSchemas.inspect_uefi_firmware.parse(
    cliEvidence.normalized_result,
  );
  expect(inspected.input_size).toBe(image.length);
  expect(inspected.flash_image.sha256).toBe(sha256(image));
  expect(inspected.flash_image.entry_basis).toBe("scanned");
  // 0x1000 lead volume, then the trailing volume right after the first block.
  expect(inspected.firmware_volumes.map((volume) => volume.offset)).toEqual([
    0x1000, 0x2000,
  ]);
  expect(inspected.unknown_regions.length).toBeGreaterThan(0);

  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path: imagePath });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);

  const inspectedSession = await call("inspect_artifact", {});
  expect(inspectedSession.isError, JSON.stringify(inspectedSession)).not.toBe(
    true,
  );
  const sessionEvidence = parseEvidence(inspectedSession.structuredContent);
  const sessionInspection = artifactInspectionResultSchema.parse(
    sessionEvidence.normalized_result,
  );
  const sessionInventoryEvidence = sessionInspection.substeps[0]?.evidence;
  if (sessionInventoryEvidence === undefined)
    throw new Error("MCP inspection did not retain inventory Evidence");
  const sessionInventory = artifactInventoryResultSchema.parse(
    sessionInventoryEvidence.normalized_result,
  );
  expect(sessionInventory.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  const rootOccurrence = sessionInventory.occurrences.find(
    (occurrence) => occurrence.parent_occurrence_id === null,
  );
  expect(rootOccurrence).toMatchObject({
    logical_path: ".",
    artifact_format: "uefi",
    artifact_kind: "resource",
  });
  expect(
    sessionInventory.occurrences.map((occurrence) => occurrence.logical_path),
  ).toEqual(
    expect.arrayContaining([
      "firmware-volume-0x1000",
      `firmware-volume-0x1000/ffs-file-${DRIVER_GUID}.bin`,
      `firmware-volume-0x1000/ffs-file-${PAD_GUID}.bin`,
      "firmware-volume-0x2000",
      "firmware-volume-0x2000/ffs-file-0a8f1d2b-1111-2222-3333-445566778899.bin",
    ]),
  );
  const payloadFileOffset = 0x1000 + 72;
  const driverOccurrence = sessionInventory.occurrences.find(
    (occurrence) =>
      occurrence.logical_path ===
      `firmware-volume-0x1000/ffs-file-${DRIVER_GUID}.bin`,
  );
  if (driverOccurrence === undefined)
    throw new Error("FFS occurrence is missing from the inventory");
  if (driverOccurrence.source_location === null)
    throw new Error("FFS occurrence lost its byte range");
  expect(driverOccurrence).toMatchObject({
    hash_status: "verified",
    source_location: {
      offset: payloadFileOffset,
      length: 24 + PE_SECTION.length,
    },
  });
  const sourceLocation = driverOccurrence.source_location;
  const driverNode = sessionInventory.nodes.find(
    (node) =>
      node.sha256 ===
      sha256(
        image.subarray(
          sourceLocation.offset,
          sourceLocation.offset + sourceLocation.length,
        ),
      ),
  );
  expect(driverNode).toBeDefined();

  const extractedSession = await call("extract_uefi_firmware", {
    path: imagePath,
    output_directory: join(root, "extracted"),
    target: { kind: "ffs-file", offset: sourceLocation.offset },
  });
  expect(extractedSession.isError, JSON.stringify(extractedSession)).not.toBe(
    true,
  );
  const extractEvidence = parseEvidence(extractedSession.structuredContent);
  const extractResult = uefiResultSchemas.extract_uefi_firmware.parse(
    extractEvidence.normalized_result,
  );
  expect(extractResult.selection).toMatchObject({
    offset: sourceLocation.offset,
    length: 24 + PE_SECTION.length,
    target_kind: "ffs-file",
  });
  expect(extractResult.files).toHaveLength(1);
  const publishedFile = extractResult.files[0];
  if (publishedFile === undefined) throw new Error("extraction lost its file");
  // The extractor publishes decoded payload with its own original byte range;
  // published bytes must equal exactly that image range.
  const publishedRange = publishedFile.original_file_range;
  if (publishedRange === null)
    throw new Error("flash payload lost its source range");
  expect(publishedFile.sha256).toBe(
    sha256(
      image.subarray(
        publishedRange.offset,
        publishedRange.offset + publishedRange.length,
      ),
    ),
  );
  const published = await readFile(publishedFile.path);
  expect(createHash("sha256").update(published).digest("hex")).toBe(
    publishedFile.sha256,
  );

  const cliExtractionEvidence = await extractFlashFileViaCli(
    root,
    basename(imagePath),
    sourceLocation.offset,
  );
  expect(cliExtractionEvidence).toMatchObject({
    caller_input_path: basename(imagePath),
    caller_input_paths: { output_directory: "cli-extracted" },
  });
  const cliExtracted = uefiResultSchemas.extract_uefi_firmware.parse(
    cliExtractionEvidence.normalized_result,
  );
  expect(cliExtracted.selection).toEqual(extractResult.selection);
  expect(cliExtracted.files.map((file) => file.sha256)).toEqual([
    publishedFile.sha256,
  ]);
});

it("never admits prose carrying a `_FVH` string as the flash image format", async () => {
  const root = await createTestTempDirectory("rea-uefi-probe-negative-");
  const path = join(root, "text-with-signature.txt");
  // A plain text file carrying `_FVH` must not claim the flash image format;
  // unrecognized files stay outside artifact admission entirely.
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from('"_FVH" appears inside prose', "ascii"),
      Buffer.alloc(0x1000, 0x20),
    ]),
  );
  let output = "";
  try {
    const cliResult = await execute(process.execPath, [
      cli,
      "inspect-artifact",
      path,
      "--json",
    ]);
    output = cliResult.stdout + cliResult.stderr;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
  expect(output, output).not.toContain('"uefi"');
});

it("keeps deep-provider analysis unavailable for the admitted uefi target", async () => {
  const root = await createTestTempDirectory("rea-uefi-deep-rejection-");
  const imagePath = join(root, "image.FIb");
  await writeFile(imagePath, buildFlashImage());
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path: imagePath });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  const deep = await call("analyze_function", { procedure: "main" });
  expect(deep.isError).toBe(true);
  const rejection = parseMcpToolError(deep);
  // Session-level rejection is typed, with per-provider reasons retained.
  expect(rejection.error).toMatchObject({
    code: "capability_unavailable",
    category: "unsupported_provider",
    details: {
      operation: "analyze_function",
      selection_reason: "target_unsupported",
      rejections: expect.arrayContaining([
        expect.objectContaining({
          code: expect.any(String),
          reason: expect.any(String),
        }),
      ]),
    },
  });
});

it("retains an opaque volume and reports only the unparsed ranges in the selected extraction scope", async () => {
  const root = await createTestTempDirectory("rea-uefi-opaque-volume-");
  const path = join(root, "mixed.fd");
  const nvDataGuid = "fff12b8d-7696-4c8b-a985-2747075b4f50";
  const valid = buildFv({
    fileSystemGuid: "54731207-5c41-4cbd-b5e5-cd26d80770b1",
    files: [
      buildFfsFile({ guid: DRIVER_GUID, typeCode: 0x07, payload: PE_SECTION }),
    ],
  });
  const opaque = buildFv({
    fileSystemGuid: nvDataGuid,
    // These bytes could be walked as FFS if the volume GUID were ignored.
    files: [
      buildFfsFile({ guid: DRIVER_GUID, typeCode: 0x07, payload: PE_SECTION }),
    ],
  });
  const opaqueOffset = valid.buffer.length;
  const suffix = Buffer.from("vendor footer");
  const suffixOffset = opaqueOffset + opaque.buffer.length;
  await writeFile(path, Buffer.concat([valid.buffer, opaque.buffer, suffix]));

  const { call } = await connectLocalToolsMcp();
  const { normalized_result: inspection } = parseEvidence(
    (await call("inspect_uefi_firmware", { path })).structuredContent,
  );
  const inspected = uefiResultSchemas.inspect_uefi_firmware.parse(inspection);
  expect(inspected.coverage).toBe("partial");
  expect(inspected.firmware_volumes).toMatchObject([
    { offset: 0, ffs_files: [{ guid: DRIVER_GUID }] },
    { offset: opaqueOffset, file_system_guid: nvDataGuid, ffs_files: [] },
  ]);
  expect(inspected.unknown_regions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        classification: "unsupported-file-system",
        sha256: sha256(opaque.buffer.subarray(opaque.headerLength)),
        offset: opaqueOffset + opaque.headerLength,
        length: opaque.buffer.length - opaque.headerLength,
      }),
    ]),
  );

  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  const inventoryEvidence = parseEvidence(
    (await call("inspect_artifact", {})).structuredContent,
  );
  const inventory = artifactInventoryResultSchema.parse(
    artifactInspectionResultSchema.parse(inventoryEvidence.normalized_result)
      .substeps[0]?.evidence?.normalized_result,
  );
  const opaquePath = `firmware-volume-0x${opaqueOffset.toString(16)}`;
  expect(
    inventory.occurrences
      .filter(({ logical_path }) => logical_path.startsWith(opaquePath))
      .map(({ logical_path }) => logical_path),
  ).toEqual([opaquePath]);
  expect(inventory.coverage.status).toBe("unknown");

  const extract = async (
    name: string,
    target?: { kind: "volume"; offset: number },
  ) =>
    uefiResultSchemas.extract_uefi_firmware.parse(
      parseEvidence(
        (
          await call("extract_uefi_firmware", {
            path,
            output_directory: join(root, name),
            ...(target === undefined ? {} : { target }),
          })
        ).structuredContent,
      ).normalized_result,
    );
  const whole = await extract("whole");
  expect(whole.files.map(({ sha256 }) => sha256)).toEqual([sha256(PAYLOAD)]);
  expect(whole.coverage).toBe("partial");
  expect(whole.extraction_gaps).toMatchObject([
    {
      kind: "unparsed-region",
      logical_path: `flash/FV@0x${opaqueOffset.toString(16)}`,
      source_stream: null,
      range: {
        offset: opaqueOffset + opaque.headerLength,
        length: opaque.buffer.length - opaque.headerLength,
      },
    },
    {
      kind: "unparsed-region",
      logical_path: "flash",
      source_stream: null,
      range: { offset: suffixOffset, length: suffix.length },
    },
  ]);

  const selected = await extract("volume", { kind: "volume", offset: 0 });
  expect(selected.coverage).toBe("complete");
  expect(selected.extraction_gaps).toEqual([]);
  const selectedOpaque = await extract("opaque", {
    kind: "volume",
    offset: opaqueOffset,
  });
  expect(selectedOpaque.coverage).toBe("partial");
  expect(selectedOpaque.files).toEqual([]);
  expect(selectedOpaque.extraction_gaps).toEqual([whole.extraction_gaps[0]]);
});
