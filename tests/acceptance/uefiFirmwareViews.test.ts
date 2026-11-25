import { sha256 } from "../support/sha256.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { UEFI_EXTRACTION_PREVIEW_FILES } from "../../src/domain/analysisView/uefiExtractionView.js";
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
const extractionResult = (structured: unknown) =>
  toolContract("extract_uefi_firmware").outputSchema.parse(structured)
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
  const extraction = extractionResult(extracted.structuredContent);
  if (!("kind" in extraction) || extraction.kind !== "summary")
    throw new Error("Default extraction delivery must be the retained summary");
  // A targeted extraction fits in the summary preview, so no page is needed.
  expect(extraction.summary.files_preview.omitted).toBe(0);
  const pe32 = extraction.summary.files_preview.items.find(
    (entry) => entry.size === PE32_BODY.length,
  );
  expect(pe32?.ffs_file).toMatchObject({
    guid: DEMO_GUID,
    ui_string: "DemoDxe",
    type_name: "driver",
  });
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

it("summarizes a whole-image extraction and pages its manifest", async () => {
  const root = await createTestTempDirectory("rea-uefi-extraction-views-");
  const path = join(root, "flash.fd");
  await writeFile(path, buildNamedDriverImage());
  const { call } = await connectLocalToolsMcp();

  const extracted = await call("extract_uefi_firmware", {
    path,
    output_directory: join(root, "whole"),
  });
  expect(extracted.isError, JSON.stringify(extracted.content)).not.toBe(true);
  const summary = extractionResult(extracted.structuredContent);
  if (!("kind" in summary) || summary.kind !== "summary")
    throw new Error("Default extraction delivery must be the retained summary");
  expect(summary.summary).toMatchObject({
    file_count: 4,
    gap_count: 1,
    gap_kinds: [{ name: "pad-file", count: 1 }],
    selection: { target_kind: "whole-image" },
  });
  expect(summary.summary.media_types).toEqual(
    expect.arrayContaining([
      { name: "application/vnd.microsoft.portable-executable", count: 2 },
      { name: null, count: 2 },
    ]),
  );

  const source = {
    kind: "retained-evidence",
    evidence_id: summary.parent_evidence_id,
  };
  const largest = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "uefi-extraction",
      collection: "files",
      media_types: ["application/vnd.microsoft.portable-executable"],
      order: "size-desc",
      limit: 1,
    },
  });
  expect(
    parseEvidence(largest.structuredContent).normalized_result,
  ).toMatchObject({
    kind: "uefi-extraction",
    coverage: { status: "page", total: 2, next_offset: 1 },
    items: [
      {
        size: PE32_BODY.length,
        sha256: sha256(PE32_BODY),
        ffs_file: { guid: DEMO_GUID, ui_string: "DemoDxe" },
      },
    ],
  });

  const owned = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "uefi-extraction",
      collection: "files",
      ffs_ui_names: ["OtherDxe"],
    },
  });
  expect(
    parseEvidence(owned.structuredContent).normalized_result,
  ).toMatchObject({
    coverage: { total: 2 },
    items: [
      { ffs_file: { guid: OTHER_GUID } },
      { ffs_file: { guid: OTHER_GUID } },
    ],
  });

  const gaps = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "uefi-extraction",
      collection: "gaps",
      gap_kinds: ["pad-file"],
    },
  });
  expect(parseEvidence(gaps.structuredContent).normalized_result).toMatchObject(
    { items: [{ kind: "pad-file" }], coverage: { total: 1 } },
  );

  const refused = await call("extract_uefi_firmware", {
    path,
    output_directory: join(root, "refused"),
    detail: "complete",
    view: { kind: "uefi-extraction", collection: "gaps" },
  });
  expect(parseMcpToolError(refused).error).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["view"] }] },
  });
});

it("previews the first extracted files and pages the rest in both orders", async () => {
  const root = await createTestTempDirectory("rea-uefi-extraction-pages-");
  const path = join(root, "flash.fd");
  const fileTotal = UEFI_EXTRACTION_PREVIEW_FILES + 4;
  const guidOf = (index: number) =>
    `0a8f1d2b-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
  await writeFile(
    path,
    buildImage({
      volumes: [
        buildFv({
          files: Array.from({ length: fileTotal }, (_, index) =>
            buildFfsFile({
              guid: guidOf(index),
              typeCode: 0x02,
              // Distinct sizes give an unambiguous size order.
              payload: buildSection(0x19, Buffer.alloc(16 + index * 4, index)),
            }),
          ),
        }).buffer,
      ],
    }),
  );
  const { call } = await connectLocalToolsMcp();

  const extracted = await call("extract_uefi_firmware", {
    path,
    output_directory: join(root, "out"),
  });
  expect(extracted.isError, JSON.stringify(extracted.content)).not.toBe(true);
  const summary = extractionResult(extracted.structuredContent);
  if (!("kind" in summary) || summary.kind !== "summary")
    throw new Error("Default extraction delivery must be the retained summary");
  expect(summary.summary.file_count).toBe(fileTotal);
  expect(summary.summary.files_preview.items).toHaveLength(
    UEFI_EXTRACTION_PREVIEW_FILES,
  );
  expect(summary.summary.files_preview.omitted).toBe(
    fileTotal - UEFI_EXTRACTION_PREVIEW_FILES,
  );
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.parent_evidence_id,
  };
  const page = async (view: Record<string, unknown>) =>
    parseEvidence(
      (
        await call("inspect_analysis_view", {
          source,
          view: { kind: "uefi-extraction", collection: "files", ...view },
        })
      ).structuredContent,
    ).normalized_result as {
      items: { source_index: number; size: number }[];
      coverage: { total: number; next_offset: number | null };
    };

  const rest = await page({ offset: UEFI_EXTRACTION_PREVIEW_FILES });
  expect(rest.items.map((row) => row.source_index)).toEqual(
    Array.from(
      { length: fileTotal - UEFI_EXTRACTION_PREVIEW_FILES },
      (_, index) => UEFI_EXTRACTION_PREVIEW_FILES + index,
    ),
  );
  expect(rest.coverage).toMatchObject({ total: fileTotal, next_offset: null });

  const sizes: number[] = [];
  const indices = new Set<number>();
  for (let offset: number | null = 0; offset !== null;) {
    const sized = await page({ order: "size-desc", offset, limit: 5 });
    expect(sized.coverage.total).toBe(fileTotal);
    for (const row of sized.items) {
      sizes.push(row.size);
      indices.add(row.source_index);
    }
    offset = sized.coverage.next_offset;
  }
  expect(indices.size).toBe(fileTotal);
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
});
