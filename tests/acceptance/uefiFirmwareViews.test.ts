import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { UEFI_FILE_ROW_SECTION_LIMIT } from "../../src/domain/analysisView/uefiFirmwareView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { uefiResultSchemas } from "../../src/domain/uefi/uefiFirmwareAnalysis.js";
import {
  buildFfsFile,
  buildFv,
  buildImage,
  buildSection,
} from "../fixtures/uefiImage.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const DEMO_GUID = "9e21fd93-9c72-4c15-8c4b-e77f9db8d4d2";
const OTHER_GUID = "0a8f1d2b-1111-2222-3333-445566778899";
const PE32_BODY = Buffer.from("MZ demo driver body", "ascii");

const uiSection = (name: string): Buffer =>
  buildSection(0x15, Buffer.from(`${name}\0`, "utf16le"));

const buildNamedDriverImage = (): Buffer =>
  buildImage({
    volumes: [
      buildFv({
        files: [
          buildFfsFile({
            guid: DEMO_GUID,
            typeCode: 0x07,
            payload: Buffer.concat([
              buildSection(0x10, PE32_BODY),
              uiSection("DemoDxe"),
            ]),
          }),
          buildFfsFile({
            guid: OTHER_GUID,
            typeCode: 0x07,
            payload: Buffer.concat([
              buildSection(0x10, Buffer.from("MZ other", "ascii")),
              uiSection("OtherDxe"),
            ]),
          }),
          buildFfsFile({
            guid: "fff12b8d-d7da-47f8-b4cf-1a0a2a1c1b1c",
            typeCode: 0xf0,
            payload: Buffer.alloc(0),
          }),
        ],
      }).buffer,
    ],
  });

const inspectionResult = (structured: unknown) =>
  toolContract("inspect_uefi_firmware").outputSchema.parse(structured)
    .normalized_result;

it("summarizes UEFI firmware by default and finds a named driver for extraction", async () => {
  const root = await createTestTempDirectory("rea-uefi-views-");
  const path = join(root, "flash.fd");
  await writeFile(path, buildNamedDriverImage());
  const { call } = await connectLocalToolsMcp();

  const summarized = await call("inspect_uefi_firmware", { path });
  expect(summarized.isError, JSON.stringify(summarized.content)).not.toBe(true);
  const summary = inspectionResult(summarized.structuredContent);
  if (!("kind" in summary) || summary.kind !== "summary")
    throw new Error("Default delivery must be the retained summary");
  expect(summary.summary).toMatchObject({
    volume_count: 1,
    top_level_volume_count: 1,
    file_count: 3,
    named_file_count: 2,
    section_count: 4,
    volume_depths: [{ depth: 0, count: 1 }],
  });
  expect(summary.summary.file_types).toEqual(
    expect.arrayContaining([
      { name: "driver", count: 2 },
      { name: "pad", count: 1 },
    ]),
  );

  const found = await call("inspect_uefi_firmware", {
    path,
    view: { kind: "uefi-firmware", collection: "files", ui_names: ["DemoDxe"] },
  });
  expect(found.isError, JSON.stringify(found.content)).not.toBe(true);
  const page = inspectionResult(found.structuredContent);
  if (!("kind" in page) || page.kind !== "uefi-firmware")
    throw new Error("A selected view must return its page");
  expect(page.coverage).toMatchObject({ status: "page", total: 1 });
  expect(page.items).toMatchObject([
    {
      guid: DEMO_GUID,
      ui_string: "DemoDxe",
      section_count: 2,
      sections: [
        {
          type_name: "pe32",
          header_length: 4,
          length: 4 + PE32_BODY.length,
          sha256: sha256(PE32_BODY),
          source_stream: null,
          truncated: false,
          malformed: false,
        },
        { type_name: "user-interface" },
      ],
    },
  ]);
  const [file] = page.items as { logical_path: string; offset: number }[];
  if (file === undefined) throw new Error("The named driver is missing");

  const sections = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: page.parent_evidence_id },
    view: {
      kind: "uefi-firmware",
      collection: "sections",
      file_path: file.logical_path,
      type_names: ["pe32"],
    },
  });
  expect(sections.isError, JSON.stringify(sections.content)).not.toBe(true);
  expect(
    parseEvidence(sections.structuredContent).normalized_result,
  ).toMatchObject({
    kind: "uefi-firmware",
    items: [
      {
        type_name: "pe32",
        length: 4 + PE32_BODY.length,
        file_logical_path: file.logical_path,
      },
    ],
  });

  const absent = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: page.parent_evidence_id },
    view: {
      kind: "uefi-firmware",
      collection: "files",
      guids: [OTHER_GUID],
      ui_names: ["DemoDxe"],
    },
  });
  expect(
    parseEvidence(absent.structuredContent).normalized_result,
  ).toMatchObject({
    items: [],
    coverage: { status: "empty", total: 0 },
  });

  const extracted = await call("extract_uefi_firmware", {
    path,
    output_directory: join(root, "out"),
    target: { kind: "ffs-file", offset: file.offset, source_stream: null },
  });
  expect(extracted.isError, JSON.stringify(extracted.content)).not.toBe(true);
  const extraction = uefiResultSchemas.extract_uefi_firmware.parse(
    parseEvidence(extracted.structuredContent).normalized_result,
  );
  const pe32 = extraction.files.find(
    (entry) => entry.size === PE32_BODY.length,
  );
  expect(pe32?.sha256).toBe(sha256(PE32_BODY));
  if (pe32 === undefined) throw new Error("The PE32 body was not extracted");
  expect(sha256(await readFile(pe32.path))).toBe(sha256(PE32_BODY));
});

it("returns complete UEFI Evidence on request and rejects a view with it", async () => {
  const root = await createTestTempDirectory("rea-uefi-views-complete-");
  const path = join(root, "flash.fd");
  await writeFile(path, buildNamedDriverImage());
  const { call } = await connectLocalToolsMcp();

  const complete = await call("inspect_uefi_firmware", {
    path,
    detail: "complete",
  });
  expect(complete.isError, JSON.stringify(complete.content)).not.toBe(true);
  const inspected = uefiResultSchemas.inspect_uefi_firmware.parse(
    parseEvidence(complete.structuredContent).normalized_result,
  );
  expect(inspected.firmware_volumes[0]?.ffs_files).toHaveLength(3);

  const refused = await call("inspect_uefi_firmware", {
    path,
    detail: "complete",
    view: { kind: "uefi-firmware", collection: "volumes" },
  });
  expect(parseMcpToolError(refused).error).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["view"] }] },
  });
});

it("keeps long section lists in the sections collection", async () => {
  const root = await createTestTempDirectory("rea-uefi-views-sections-");
  const path = join(root, "flash.fd");
  const sectionTotal = UEFI_FILE_ROW_SECTION_LIMIT + 3;
  await writeFile(
    path,
    buildImage({
      volumes: [
        buildFv({
          files: [
            buildFfsFile({
              guid: DEMO_GUID,
              typeCode: 0x02,
              payload: Buffer.concat(
                Array.from({ length: sectionTotal }, (_, index) =>
                  buildSection(0x19, Buffer.from(`raw ${String(index)}`)),
                ),
              ),
            }),
          ],
        }).buffer,
      ],
    }),
  );
  const { call } = await connectLocalToolsMcp();

  const found = await call("inspect_uefi_firmware", {
    path,
    view: { kind: "uefi-firmware", collection: "files", guids: [DEMO_GUID] },
  });
  expect(found.isError, JSON.stringify(found.content)).not.toBe(true);
  const page = inspectionResult(found.structuredContent);
  if (!("kind" in page) || page.kind !== "uefi-firmware")
    throw new Error("A selected view must return its page");
  const [file] = page.items as {
    logical_path: string;
    section_count: number;
    sections: unknown[];
  }[];
  expect(file?.section_count).toBe(sectionTotal);
  expect(file?.sections).toHaveLength(UEFI_FILE_ROW_SECTION_LIMIT);

  const rest = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: page.parent_evidence_id },
    view: {
      kind: "uefi-firmware",
      collection: "sections",
      file_path: file?.logical_path,
      offset: UEFI_FILE_ROW_SECTION_LIMIT,
    },
  });
  expect(parseEvidence(rest.structuredContent).normalized_result).toMatchObject(
    {
      coverage: { status: "page", total: sectionTotal, exhausted: true },
      items: [
        { source_index: UEFI_FILE_ROW_SECTION_LIMIT },
        { source_index: UEFI_FILE_ROW_SECTION_LIMIT + 1 },
        { source_index: UEFI_FILE_ROW_SECTION_LIMIT + 2 },
      ],
    },
  );
});
